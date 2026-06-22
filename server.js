require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { getMemories, saveMemory, deleteMemory } = require('./db');

// ─── Playwright browser automation ───────────────────────────────────────────

const SPIKE_PROFILE = path.join(__dirname, '.spike-chrome-profile');
let activeBrowserCtx = null;

async function getBrowserCtx() {
  if (activeBrowserCtx) {
    try { activeBrowserCtx.pages(); return activeBrowserCtx; } catch { activeBrowserCtx = null; }
  }
  const { chromium } = require('playwright-core');
  try {
    const ctx = await chromium.launchPersistentContext(SPIKE_PROFILE, {
      headless: false, channel: 'chrome', viewport: null,
    });
    ctx.on('close', () => { activeBrowserCtx = null; });
    activeBrowserCtx = ctx;
    return ctx;
  } catch {
    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const ctx = await browser.newContext({ viewport: null });
    return ctx;
  }
}

async function runCmd(cmd, timeoutMs = 12000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs, windowsHide: true });
    return { success: true, output: (stdout || stderr || '').trim() };
  } catch (err) {
    return { success: false, error: err.message, output: (err.stdout || '').trim() };
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic();

// ─── Google API helpers ───────────────────────────────────────────────────────

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
  );
}

function getCalendarClient(session) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(session.tokens);
  oauth2Client.on('tokens', (newTokens) => {
    session.tokens = { ...session.tokens, ...newTokens };
  });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

function getGmailClient(session) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(session.tokens);
  oauth2Client.on('tokens', (newTokens) => {
    session.tokens = { ...session.tokens, ...newTokens };
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Recursively find text/plain body data, falling back to text/html
function extractEmailBody(payload) {
  function findPlain(part) {
    if (!part) return null;
    if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data;
    for (const p of part.parts || []) {
      const found = findPlain(p);
      if (found) return found;
    }
    return null;
  }
  function findAny(part) {
    if (!part) return null;
    if (part.body?.data) return part.body.data;
    for (const p of part.parts || []) {
      const found = findAny(p);
      if (found) return found;
    }
    return null;
  }
  const data = findPlain(payload) || findAny(payload);
  if (!data) return '';
  const decoded = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  return decoded.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
}

function parseSender(from = '') {
  const match = from.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() || match[1].trim() };
  return { name: from, email: from };
}

// RFC 2047 encode a header value if it contains non-ASCII characters
function encodeHeader(s = '') {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

// Build a base64url-encoded RFC 5322 message ready for the Gmail API
function buildRawMessage({ to, from, subject, body, cc, bcc, inReplyTo, references }) {
  const headers = [];
  if (from) headers.push(`From: ${from}`);
  if (to)   headers.push(`To: ${to}`);
  if (cc)   headers.push(`Cc: ${cc}`);
  if (bcc)  headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeader(subject || '')}`);
  if (inReplyTo)  headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: 8bit');

  const normalizedBody = (body || '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const raw = headers.join('\r\n') + '\r\n\r\n' + normalizedBody;
  return Buffer.from(raw, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Pull the in-flight draft's current to/subject/body back out for the UI preview
function summarizeDraft(draftData) {
  const payload = draftData?.message?.payload;
  if (!payload) return { to: '', subject: '', body: '' };
  const hdrs = {};
  for (const h of payload.headers || []) hdrs[h.name.toLowerCase()] = h.value;
  const body = extractEmailBody(payload) || draftData?.message?.snippet || '';
  return {
    to:      hdrs.to || '',
    cc:      hdrs.cc || '',
    subject: hdrs.subject || '',
    body
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function requireAuth(req, res, next) {
  if (!req.session?.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ─── Tools for Claude ─────────────────────────────────────────────────────────

const allTools = [
  // ── Calendar ──
  {
    name: 'create_event',
    description: 'Create a new event on the user\'s Google Calendar. Use ISO 8601 format for times. Can optionally attach a Google Meet video call link.',
    input_schema: {
      type: 'object',
      properties: {
        title:           { type: 'string',  description: 'Event title/summary' },
        start_time:      { type: 'string',  description: 'Start datetime in ISO 8601 (e.g. 2024-09-15T09:00:00)' },
        end_time:        { type: 'string',  description: 'End datetime in ISO 8601 (e.g. 2024-09-15T10:30:00)' },
        description:     { type: 'string',  description: 'Event description or notes (optional)' },
        location:        { type: 'string',  description: 'Event location (optional)' },
        timezone:        { type: 'string',  description: 'Timezone string e.g. America/New_York (optional, defaults to UTC)' },
        recurrence:      { type: 'string',  description: 'RRULE for repeating events e.g. RRULE:FREQ=WEEKLY;BYDAY=MO,WE (optional)' },
        add_google_meet: { type: 'boolean', description: 'If true, attach a Google Meet video call link to the event (optional)' },
        attendees:       { type: 'array',   items: { type: 'string' }, description: 'List of attendee email addresses to invite (optional)' }
      },
      required: ['title', 'start_time', 'end_time']
    }
  },
  {
    name: 'list_events',
    description: 'List upcoming events from the user\'s Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'integer', description: 'Max number of events to return (default 10, max 50)' },
        time_min:    { type: 'string',  description: 'Start of time range ISO 8601 (default: right now)' },
        time_max:    { type: 'string',  description: 'End of time range ISO 8601 (optional)' },
        query:       { type: 'string',  description: 'Full-text search query (optional)' }
      }
    }
  },
  {
    name: 'update_event',
    description: 'Update an existing Google Calendar event. Only provide fields you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:    { type: 'string', description: 'The Google Calendar event ID' },
        title:       { type: 'string', description: 'New title (optional)' },
        start_time:  { type: 'string', description: 'New start datetime ISO 8601 (optional)' },
        end_time:    { type: 'string', description: 'New end datetime ISO 8601 (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        location:    { type: 'string', description: 'New location (optional)' }
      },
      required: ['event_id']
    }
  },
  {
    name: 'delete_event',
    description: 'Delete an event from the user\'s Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The Google Calendar event ID to delete' }
      },
      required: ['event_id']
    }
  },
  // ── Email ──
  {
    name: 'list_emails',
    description: 'List emails from the inbox. Returns subject, sender, date, and a short snippet. Use this to review messages, identify important ones, and find candidates to delete.',
    input_schema: {
      type: 'object',
      properties: {
        max_results:  { type: 'integer', description: 'Max emails to return (default 15, max 25)' },
        query:        { type: 'string',  description: 'Gmail search query e.g. "is:unread", "from:boss@example.com", "subject:invoice" (optional — defaults to unread inbox)' },
        include_read: { type: 'boolean', description: 'Include already-read emails (default false)' }
      }
    }
  },
  {
    name: 'get_email_content',
    description: 'Get the full body of a specific email by its ID. Use this before making importance judgements on ambiguous emails.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID' }
      },
      required: ['message_id']
    }
  },
  {
    name: 'trash_email',
    description: 'Move an email to trash. It can be recovered within 30 days. Always confirm with the user before trashing unless they explicitly asked to delete specific emails.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID to trash' }
      },
      required: ['message_id']
    }
  },
  {
    name: 'mark_important',
    description: 'Mark an email as important in Gmail (adds the IMPORTANT label).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID to mark as important' }
      },
      required: ['message_id']
    }
  },
  // ── Email drafts ──
  {
    name: 'draft_reply',
    description: 'Create a draft reply to an existing email. The draft is saved to Gmail but NOT sent — always show the user the draft preview and wait for explicit confirmation before calling send_draft. The reply is automatically threaded with the original (Re: subject, In-Reply-To, References).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID of the email being replied to' },
        body:       { type: 'string', description: 'The plain-text body of the reply. Use real newlines for paragraph breaks. Do not quote the original — Gmail handles that.' },
        cc:         { type: 'string', description: 'Comma-separated cc addresses (optional)' },
        bcc:        { type: 'string', description: 'Comma-separated bcc addresses (optional)' }
      },
      required: ['message_id', 'body']
    }
  },
  {
    name: 'draft_email',
    description: 'Create a draft of a brand-new email (not a reply to anything). The draft is saved to Gmail but NOT sent — always show the user the draft preview and wait for explicit confirmation before calling send_draft.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address(es), comma-separated' },
        subject: { type: 'string', description: 'Email subject line' },
        body:    { type: 'string', description: 'Plain-text body. Use real newlines for paragraph breaks.' },
        cc:      { type: 'string', description: 'Comma-separated cc addresses (optional)' },
        bcc:     { type: 'string', description: 'Comma-separated bcc addresses (optional)' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'update_draft',
    description: 'Revise an existing draft. Use this when the user asks to change something about a draft you just created (e.g. "make it shorter", "change the second sentence"). Pass only the fields you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The Gmail draft ID returned by draft_reply or draft_email' },
        body:     { type: 'string', description: 'New body text (optional)' },
        subject:  { type: 'string', description: 'New subject (optional — only for new emails, replies keep their Re: subject)' },
        to:       { type: 'string', description: 'New recipient (optional)' },
        cc:       { type: 'string', description: 'New cc (optional)' },
        bcc:      { type: 'string', description: 'New bcc (optional)' }
      },
      required: ['draft_id']
    }
  },
  {
    name: 'send_draft',
    description: 'Actually send a previously created draft. ONLY call this when the user has explicitly confirmed they want the draft sent (e.g. "yes, send it", "looks good, send"). Never call this immediately after draft_reply or draft_email.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The Gmail draft ID to send' }
      },
      required: ['draft_id']
    }
  },
  {
    name: 'list_drafts',
    description: 'List the user\'s existing Gmail drafts. Useful when the user asks "what drafts do I have" or wants to review/resume an unfinished draft.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'integer', description: 'Max drafts to return (default 10, max 20)' }
      }
    }
  },
  {
    name: 'delete_draft',
    description: 'Discard a draft permanently. Use this when the user says "discard", "throw it out", "never mind that draft", etc.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The Gmail draft ID to discard' }
      },
      required: ['draft_id']
    }
  },
  // ── Email labels (organization) ──
  {
    name: 'list_labels',
    description: 'List the user\'s existing Gmail labels (both system labels like INBOX/IMPORTANT and user-created ones). Call this before creating a new label to avoid duplicates, or when the user asks "what labels do I have".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'create_label',
    description: 'Create a new Gmail label. The label name is case-sensitive. Use slash notation for nested labels (e.g. "Work/Clients"). If a label with this name already exists, returns the existing label rather than erroring.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The label name (e.g. "Receipts", "Newsletters", "Work/Clients")' }
      },
      required: ['name']
    }
  },
  {
    name: 'apply_label',
    description: 'Apply a label to one or more emails. The label must already exist — call create_label first if needed. Set archive: true to also remove the email from the inbox (typical for "file" / "organize" intents).',
    input_schema: {
      type: 'object',
      properties: {
        message_ids: { type: 'array', items: { type: 'string' }, description: 'One or more Gmail message IDs to label' },
        label_name:  { type: 'string', description: 'The label to apply (case-sensitive)' },
        archive:     { type: 'boolean', description: 'If true, also remove the email(s) from the inbox after labeling. Default false.' }
      },
      required: ['message_ids', 'label_name']
    }
  },
  {
    name: 'remove_label',
    description: 'Remove a label from one or more emails. Does not delete the label itself.',
    input_schema: {
      type: 'object',
      properties: {
        message_ids: { type: 'array', items: { type: 'string' }, description: 'One or more Gmail message IDs to unlabel' },
        label_name:  { type: 'string', description: 'The label to remove' }
      },
      required: ['message_ids', 'label_name']
    }
  },
  // ── Memory ──
  {
    name: 'save_memory',
    description: `Save or update a preference or constraint about the user for future sessions.
Call this proactively whenever the user expresses a scheduling preference, constraint, or personal routine — even casually.
The key should be short snake_case (e.g. "preferred_study_time"). Value should be a plain-English sentence.
Saved memories are injected into your system prompt in all future conversations.`,
    input_schema: {
      type: 'object',
      properties: {
        key:   { type: 'string', description: 'Short snake_case label (e.g. "preferred_study_time")' },
        value: { type: 'string', description: 'Plain English description of the preference' }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'delete_memory',
    description: 'Delete a previously saved memory by its key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key of the memory to delete' }
      },
      required: ['key']
    }
  },
  // ── Web search (Anthropic server tool) ──
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5
  },
  // ── Browser ──
  {
    name: 'open_browser',
    description: 'Open a URL in the browser. Set login_with_google to true when the user asks to log in or sign in with Google on the site.',
    input_schema: {
      type: 'object',
      properties: {
        url:               { type: 'string',  description: 'The full URL to open (e.g. https://www.youtube.com). Always include the https:// scheme.' },
        login_with_google: { type: 'boolean', description: 'If true, use browser automation to open the site and click "Sign in with Google", then auto-select the user\'s Google account.' }
      },
      required: ['url']
    }
  }
];

// ─── Execute tool calls ───────────────────────────────────────────────────────

async function executeTool(name, input, calendar, userEmail, userSession) {
  try {
    switch (name) {
      case 'create_event': {
        const tz = input.timezone || 'UTC';
        const event = {
          summary: input.title,
          description: input.description || '',
          location: input.location || '',
          start: { dateTime: input.start_time, timeZone: tz },
          end:   { dateTime: input.end_time,   timeZone: tz }
        };
        if (input.recurrence) event.recurrence = [input.recurrence];
        if (input.attendees?.length) {
          event.attendees = input.attendees.map(email => ({ email }));
        }
        if (input.add_google_meet) {
          event.conferenceData = {
            createRequest: {
              requestId: `spike-meet-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
          };
        }
        const insertParams = { calendarId: 'primary', resource: event };
        if (input.add_google_meet) insertParams.conferenceDataVersion = 1;
        const res = await calendar.events.insert(insertParams);
        const meetLink = res.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri;
        return {
          success: true,
          event_id: res.data.id,
          title: res.data.summary,
          start: res.data.start.dateTime || res.data.start.date,
          html_link: res.data.htmlLink,
          meet_link: meetLink || null,
          message: meetLink
            ? `Event "${input.title}" created with Google Meet: ${meetLink}`
            : `Event "${input.title}" created successfully.`
        };
      }

      case 'list_events': {
        const params = {
          calendarId: 'primary',
          maxResults: Math.min(input.max_results || 10, 50),
          orderBy: 'startTime',
          singleEvents: true,
          timeMin: input.time_min || new Date().toISOString()
        };
        if (input.time_max) params.timeMax = input.time_max;
        if (input.query)    params.q       = input.query;
        const res = await calendar.events.list(params);
        const events = (res.data.items || []).map(e => ({
          id: e.id,
          title: e.summary || '(No title)',
          start: e.start?.dateTime || e.start?.date || '',
          end:   e.end?.dateTime   || e.end?.date   || '',
          description: e.description || '',
          location: e.location || '',
          html_link: e.htmlLink || ''
        }));
        return { success: true, events, count: events.length };
      }

      case 'update_event': {
        const patch = {};
        if (input.title)                  patch.summary     = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.location    !== undefined) patch.location    = input.location;
        if (input.start_time) patch.start = { dateTime: input.start_time };
        if (input.end_time)   patch.end   = { dateTime: input.end_time };
        const res = await calendar.events.patch({ calendarId: 'primary', eventId: input.event_id, resource: patch });
        return { success: true, event_id: res.data.id, message: 'Event updated successfully.' };
      }

      case 'delete_event': {
        await calendar.events.delete({ calendarId: 'primary', eventId: input.event_id });
        return { success: true, message: 'Event deleted successfully.' };
      }

      case 'list_emails': {
        const gmail = getGmailClient(userSession);
        const max = Math.min(input.max_results || 15, 25);
        let q = input.query || (input.include_read ? 'in:inbox' : 'in:inbox is:unread');
        const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: max, q });
        const messages = listRes.data.messages || [];
        if (!messages.length) return { success: true, emails: [], message: 'No emails found matching that query.' };

        const emails = await Promise.all(messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: 'me', id: msg.id, format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date']
          });
          const hdrs = {};
          for (const h of detail.data.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
          const sender = parseSender(hdrs.from);
          return {
            id: msg.id,
            subject:    hdrs.subject || '(No subject)',
            from_name:  sender.name,
            from_email: sender.email,
            date:       hdrs.date || '',
            snippet:    detail.data.snippet || '',
            is_unread:  detail.data.labelIds?.includes('UNREAD')     || false,
            is_important: detail.data.labelIds?.includes('IMPORTANT') || false
          };
        }));
        return { success: true, emails, count: emails.length };
      }

      case 'get_email_content': {
        const gmail = getGmailClient(userSession);
        const detail = await gmail.users.messages.get({ userId: 'me', id: input.message_id, format: 'full' });
        const hdrs = {};
        for (const h of detail.data.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
        const sender = parseSender(hdrs.from);
        const body = extractEmailBody(detail.data.payload) || detail.data.snippet || '(No content)';
        return {
          success: true,
          id: detail.data.id,
          subject:    hdrs.subject || '(No subject)',
          from_name:  sender.name,
          from_email: sender.email,
          to:         hdrs.to || '',
          date:       hdrs.date || '',
          body
        };
      }

      case 'trash_email': {
        const gmail = getGmailClient(userSession);
        await gmail.users.messages.trash({ userId: 'me', id: input.message_id });
        return { success: true, message: 'Email moved to trash. It can be recovered within 30 days.' };
      }

      case 'mark_important': {
        const gmail = getGmailClient(userSession);
        await gmail.users.messages.modify({
          userId: 'me', id: input.message_id,
          resource: { addLabelIds: ['IMPORTANT'], removeLabelIds: [] }
        });
        return { success: true, message: 'Email marked as important.' };
      }

      case 'draft_reply': {
        if (!input.body?.trim()) return { error: 'Reply body cannot be empty.' };
        const gmail = getGmailClient(userSession);
        const orig = await gmail.users.messages.get({ userId: 'me', id: input.message_id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Reply-To', 'Message-Id', 'References', 'To', 'Cc'] });
        const hdrs = {};
        for (const h of orig.data.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;

        const replyTo  = hdrs['reply-to'] || hdrs['from'];
        if (!replyTo) return { error: 'Could not determine reply address from the original message.' };
        const origSubj = hdrs['subject'] || '';
        const subject  = /^re:\s/i.test(origSubj) ? origSubj : `Re: ${origSubj}`;
        const inReplyTo  = hdrs['message-id'];
        const references = hdrs['references']
          ? `${hdrs['references']} ${inReplyTo}`.trim()
          : inReplyTo;

        const fromName = userSession.user?.name;
        const fromEmail = userSession.user?.email;
        const from = fromName ? `${encodeHeader(fromName)} <${fromEmail}>` : fromEmail;

        const raw = buildRawMessage({
          to: replyTo,
          from,
          subject,
          body: input.body,
          cc: input.cc,
          bcc: input.bcc,
          inReplyTo,
          references
        });

        const created = await gmail.users.drafts.create({
          userId: 'me',
          resource: { message: { raw, threadId: orig.data.threadId } }
        });

        return {
          success: true,
          draft_id: created.data.id,
          message_id: created.data.message?.id,
          thread_id: orig.data.threadId,
          to: replyTo,
          subject,
          body: input.body,
          cc: input.cc || '',
          is_reply: true,
          message: `Drafted reply to ${replyTo}. Show the user the preview and wait for confirmation before calling send_draft.`
        };
      }

      case 'draft_email': {
        if (!input.to?.trim())   return { error: 'Recipient (to) is required.' };
        if (!input.body?.trim()) return { error: 'Body cannot be empty.' };
        const gmail = getGmailClient(userSession);

        const fromName = userSession.user?.name;
        const fromEmail = userSession.user?.email;
        const from = fromName ? `${encodeHeader(fromName)} <${fromEmail}>` : fromEmail;

        const raw = buildRawMessage({
          to: input.to,
          from,
          subject: input.subject || '(No subject)',
          body: input.body,
          cc: input.cc,
          bcc: input.bcc
        });

        const created = await gmail.users.drafts.create({
          userId: 'me',
          resource: { message: { raw } }
        });

        return {
          success: true,
          draft_id: created.data.id,
          message_id: created.data.message?.id,
          to: input.to,
          subject: input.subject || '(No subject)',
          body: input.body,
          cc: input.cc || '',
          is_reply: false,
          message: `Drafted email to ${input.to}. Show the user the preview and wait for confirmation before calling send_draft.`
        };
      }

      case 'update_draft': {
        if (!input.draft_id) return { error: 'draft_id is required.' };
        const gmail = getGmailClient(userSession);

        // Pull current draft so we can merge unchanged fields
        const current = await gmail.users.drafts.get({ userId: 'me', id: input.draft_id, format: 'full' });
        const summary = summarizeDraft(current.data);
        const threadId = current.data.message?.threadId;

        // Extract the existing reply-threading headers if present
        const origHeaders = current.data.message?.payload?.headers || [];
        const hdrMap = {};
        for (const h of origHeaders) hdrMap[h.name.toLowerCase()] = h.value;

        const fromName = userSession.user?.name;
        const fromEmail = userSession.user?.email;
        const from = fromName ? `${encodeHeader(fromName)} <${fromEmail}>` : fromEmail;

        const raw = buildRawMessage({
          to:      input.to      ?? summary.to,
          from,
          subject: input.subject ?? summary.subject,
          body:    input.body    ?? summary.body,
          cc:      input.cc      ?? summary.cc,
          bcc:     input.bcc,
          inReplyTo:  hdrMap['in-reply-to'],
          references: hdrMap['references']
        });

        const updated = await gmail.users.drafts.update({
          userId: 'me',
          id: input.draft_id,
          resource: { message: { raw, threadId } }
        });

        const merged = {
          to:      input.to      ?? summary.to,
          subject: input.subject ?? summary.subject,
          body:    input.body    ?? summary.body,
          cc:      input.cc      ?? summary.cc
        };

        return {
          success: true,
          draft_id: updated.data.id,
          to: merged.to,
          subject: merged.subject,
          body: merged.body,
          cc: merged.cc,
          is_reply: !!hdrMap['in-reply-to'],
          message: `Draft updated. Show the user the revised preview and wait for confirmation before sending.`
        };
      }

      case 'send_draft': {
        if (!input.draft_id) return { error: 'draft_id is required.' };
        const gmail = getGmailClient(userSession);

        // Grab a preview before sending so we can give a meaningful confirmation
        let preview = { to: '', subject: '' };
        try {
          const got = await gmail.users.drafts.get({ userId: 'me', id: input.draft_id, format: 'metadata' });
          preview = summarizeDraft(got.data);
        } catch {}

        const sent = await gmail.users.drafts.send({ userId: 'me', resource: { id: input.draft_id } });
        return {
          success: true,
          message_id: sent.data.id,
          thread_id: sent.data.threadId,
          message: `Sent${preview.to ? ` to ${preview.to}` : ''}${preview.subject ? ` — "${preview.subject}"` : ''}.`
        };
      }

      case 'list_drafts': {
        const gmail = getGmailClient(userSession);
        const max = Math.min(input.max_results || 10, 20);
        const listRes = await gmail.users.drafts.list({ userId: 'me', maxResults: max });
        const items = listRes.data.drafts || [];
        if (!items.length) return { success: true, drafts: [], message: 'No drafts.' };

        const drafts = await Promise.all(items.map(async (d) => {
          const got = await gmail.users.drafts.get({
            userId: 'me', id: d.id, format: 'metadata',
            metadataHeaders: ['Subject', 'To', 'From']
          });
          const hdrs = {};
          for (const h of got.data.message?.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
          return {
            draft_id: d.id,
            to:      hdrs.to || '',
            subject: hdrs.subject || '(No subject)',
            snippet: got.data.message?.snippet || ''
          };
        }));
        return { success: true, drafts, count: drafts.length };
      }

      case 'delete_draft': {
        if (!input.draft_id) return { error: 'draft_id is required.' };
        const gmail = getGmailClient(userSession);
        await gmail.users.drafts.delete({ userId: 'me', id: input.draft_id });
        return { success: true, draft_id: input.draft_id, discarded: true, message: 'Draft discarded.' };
      }

      case 'list_labels': {
        const gmail = getGmailClient(userSession);
        const res = await gmail.users.labels.list({ userId: 'me' });
        const SYSTEM_HIDE = new Set(['CHAT']);
        const labels = (res.data.labels || [])
          .filter(l => !SYSTEM_HIDE.has(l.id))
          .map(l => ({ id: l.id, name: l.name, type: l.type || 'user' }));
        const user   = labels.filter(l => l.type === 'user');
        const system = labels.filter(l => l.type !== 'user').map(l => l.name);
        return { success: true, labels, user_labels: user, system_labels: system, count: labels.length };
      }

      case 'create_label': {
        const name = (input.name || '').trim();
        if (!name) return { error: 'Label name is required.' };
        const gmail = getGmailClient(userSession);

        // Idempotent — return existing label if one with the same name exists
        const existing = await gmail.users.labels.list({ userId: 'me' });
        const match = (existing.data.labels || []).find(l => l.name === name);
        if (match) {
          return { success: true, label_id: match.id, label_name: match.name, already_existed: true, message: `Label "${name}" already exists.` };
        }
        const created = await gmail.users.labels.create({
          userId: 'me',
          resource: {
            name,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          }
        });
        return { success: true, label_id: created.data.id, label_name: created.data.name, already_existed: false, message: `Label "${name}" created.` };
      }

      case 'apply_label': {
        const name = (input.label_name || '').trim();
        const ids = Array.isArray(input.message_ids) ? input.message_ids : [];
        if (!name)       return { error: 'label_name is required.' };
        if (!ids.length) return { error: 'At least one message_id is required.' };

        const gmail = getGmailClient(userSession);
        const labels = await gmail.users.labels.list({ userId: 'me' });
        const label  = (labels.data.labels || []).find(l => l.name === name);
        if (!label) return { error: `No label found named "${name}". Call create_label first.` };

        const addLabelIds    = [label.id];
        const removeLabelIds = input.archive ? ['INBOX'] : [];
        const results = await Promise.all(ids.map(async id => {
          try {
            await gmail.users.messages.modify({ userId: 'me', id, resource: { addLabelIds, removeLabelIds } });
            return { id, ok: true };
          } catch (err) {
            return { id, ok: false, error: err.message };
          }
        }));
        const ok   = results.filter(r => r.ok).length;
        const fail = results.length - ok;
        return {
          success: fail === 0,
          label_name: name,
          label_id: label.id,
          archived: !!input.archive,
          applied: ok,
          failed: fail,
          results,
          message: `Applied "${name}" to ${ok} of ${results.length} message${results.length === 1 ? '' : 's'}${input.archive ? ' and archived them' : ''}.`
        };
      }

      case 'remove_label': {
        const name = (input.label_name || '').trim();
        const ids = Array.isArray(input.message_ids) ? input.message_ids : [];
        if (!name)       return { error: 'label_name is required.' };
        if (!ids.length) return { error: 'At least one message_id is required.' };

        const gmail = getGmailClient(userSession);
        const labels = await gmail.users.labels.list({ userId: 'me' });
        const label  = (labels.data.labels || []).find(l => l.name === name);
        if (!label) return { error: `No label found named "${name}".` };

        const results = await Promise.all(ids.map(async id => {
          try {
            await gmail.users.messages.modify({ userId: 'me', id, resource: { addLabelIds: [], removeLabelIds: [label.id] } });
            return { id, ok: true };
          } catch (err) {
            return { id, ok: false, error: err.message };
          }
        }));
        const ok   = results.filter(r => r.ok).length;
        const fail = results.length - ok;
        return {
          success: fail === 0,
          label_name: name,
          removed: ok,
          failed: fail,
          results,
          message: `Removed "${name}" from ${ok} of ${results.length} message${results.length === 1 ? '' : 's'}.`
        };
      }

      case 'save_memory': {
        const key = (input.key || '').trim().toLowerCase().replace(/\s+/g, '_');
        if (!key || !input.value) return { error: 'Both key and value are required.' };
        saveMemory(userEmail, key, input.value.trim());
        return { success: true, message: `Memory saved: "${key}"` };
      }

      case 'delete_memory': {
        const result = deleteMemory(userEmail, (input.key || '').trim());
        if (result.changes === 0) return { success: false, message: `No memory found with key "${input.key}".` };
        return { success: true, message: `Memory "${input.key}" deleted.` };
      }

      case 'open_browser': {
        let url = (input.url || '').trim();
        if (!url) return { error: 'No URL provided.' };
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

        if (!input.login_with_google) {
          const platform = os.platform();
          const cmd = platform === 'win32'  ? `start "" "${url}"`
                    : platform === 'darwin' ? `open "${url}"`
                    :                         `xdg-open "${url}"`;
          const result = await runCmd(cmd);
          return result.success
            ? { success: true, message: `Opened ${url} in your browser.` }
            : { error: `Failed to open browser: ${result.error}` };
        }

        // Browser automation: open site, find any login, then sign in with Google
        try {
          const ctx = await getBrowserCtx();
          const page = await ctx.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000)); // let JS-rendered content settle

          async function tryClick(locator) {
            try {
              if (await locator.isVisible({ timeout: 800 })) { await locator.click(); return true; }
            } catch {}
            return false;
          }

          async function findGoogleBtn() {
            const candidates = [
              page.getByRole('button', { name: /google/i }).first(),
              page.getByRole('link',   { name: /google/i }).first(),
              page.locator('[data-provider="google"]').first(),
              page.locator('a[href*="accounts.google.com/o/oauth2"]').first(),
              page.locator('[data-testid*="google" i]').first(),
              page.locator('[class*="google" i]').filter({ hasText: /sign|log|continue/i }).first(),
            ];
            for (const el of candidates) { if (await tryClick(el)) return true; }
            return false;
          }

          async function findLoginBtn() {
            const candidates = [
              page.getByRole('link',   { name: /^log\s?in$/i   }).first(),
              page.getByRole('button', { name: /^log\s?in$/i   }).first(),
              page.getByRole('link',   { name: /^sign\s?in$/i  }).first(),
              page.getByRole('button', { name: /^sign\s?in$/i  }).first(),
              page.getByRole('link',   { name: /^sign\s?up$/i  }).first(),
              page.getByRole('button', { name: /^sign\s?up$/i  }).first(),
              page.getByRole('link',   { name: /^login$/i      }).first(),
              page.getByRole('button', { name: /^login$/i      }).first(),
              page.getByRole('link',   { name: /^create account$/i }).first(),
              page.getByRole('button', { name: /^get started$/i    }).first(),
              page.locator('a[href*="login"]').first(),
              page.locator('a[href*="signin"]').first(),
              page.locator('a[href*="sign-in"]').first(),
              page.locator('[data-testid*="login" i]').first(),
              page.locator('[data-testid*="signin" i]').first(),
            ];
            for (const el of candidates) { if (await tryClick(el)) return true; }
            return false;
          }

          // Step 1: check for Google button directly on the landing page
          let clicked = await findGoogleBtn();

          if (!clicked) {
            // Step 2: find and click any generic login/sign-in button
            const loginClicked = await findLoginBtn();

            if (loginClicked) {
              // Wait for navigation OR a modal, whichever comes first
              await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
                page.waitForSelector('[role="dialog"], [role="modal"], .modal, [class*="modal" i]', { timeout: 3000 }).catch(() => {}),
                new Promise(r => setTimeout(r, 2500)),
              ]);
              // Step 3: look for Google button on the login page / modal
              clicked = await findGoogleBtn();
            }
          }

          // Step 4: loop through all Google OAuth steps until we land back on the site
          if (clicked) {
            const deadline = Date.now() + 35000;

            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 1500));
              const currentUrl = page.url();

              // Left Google — OAuth flow complete
              if (!/accounts\.google\.com/.test(currentUrl)) break;

              // Account picker: click the user's account by email attribute
              const byEmail = page.locator(`[data-email="${userEmail}"]`).first();
              if (await byEmail.isVisible({ timeout: 800 }).catch(() => false)) {
                await byEmail.click(); continue;
              }

              // No matching account shown — fill in email to force the right account
              const emailInput = page.locator('input[type="email"], input[name="identifier"]').first();
              if (await emailInput.isVisible({ timeout: 800 }).catch(() => false)) {
                await emailInput.clear();
                await emailInput.fill(userEmail);
                await page.keyboard.press('Enter');
                continue;
              }

              // Consent / permissions screen
              const allowBtn = page.getByRole('button', { name: /^(allow|continue|accept|agree)$/i }).first();
              if (await allowBtn.isVisible({ timeout: 800 }).catch(() => false)) {
                await allowBtn.click(); continue;
              }
              // Still on Google but nothing actionable yet — wait for next step to render
            }

            // Step 5: back on the site — check if we're still stuck on a login/auth page
            await new Promise(r => setTimeout(r, 1500));
            const finalUrl = page.url();
            if (/\/login|\/signin|\/sign-in|\/auth|\/register/i.test(finalUrl)) {
              // Try clicking any remaining "Continue" / "Next" button the site may show
              await tryClick(page.getByRole('button', { name: /continue|next|proceed|submit/i }).first());
            }
          }

          return {
            success: true,
            message: clicked
              ? `Opened ${url}, signed in with Google as ${userEmail}, and completed the login flow.`
              : `Opened ${url} — couldn't find a login or Google sign-in option. You may already be logged in.`
          };
        } catch (err) {
          return { error: `Browser automation failed: ${err.message}. Make sure Google Chrome is installed.` };
        }
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    if (err.message?.includes('insufficient authentication scopes') || err.code === 403) {
      return { error: 'Gmail access not granted. Please sign out and sign back in to allow email access.' };
    }
    return { error: err.message };
  }
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/auth/google', (req, res) => {
  const oauth2Client = createOAuth2Client();
  const authOpts = {
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    include_granted_scopes: true
  };
  if (req.query.hint) authOpts.login_hint = String(req.query.hint);
  res.redirect(oauth2Client.generateAuthUrl(authOpts));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));

  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.user = {
      name:     userInfo.name,
      email:    userInfo.email,
      picture:  userInfo.picture,
      initials: (userInfo.name || 'U').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()
    };

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/dashboard.html');
    });
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/user', requireAuth, (req, res) => {
  res.json(req.session.user);
});

app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const calendar = getCalendarClient(req.session);
    const result = await calendar.events.list({
      calendarId: 'primary', maxResults: 15,
      orderBy: 'startTime', singleEvents: true,
      timeMin: new Date().toISOString()
    });
    const events = (result.data.items || []).map(e => ({
      id: e.id, title: e.summary || '(No title)',
      start: e.start?.dateTime || e.start?.date || '',
      end:   e.end?.dateTime   || e.end?.date   || '',
      location: e.location || '', description: e.description || ''
    }));
    res.json({ events });
  } catch (err) {
    console.error('Events fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const gmail = getGmailClient(req.session);
    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 8, q: 'in:inbox is:unread' });
    const messages = listRes.data.messages || [];
    if (!messages.length) return res.json({ emails: [] });

    const emails = await Promise.all(messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const hdrs = {};
      for (const h of detail.data.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
      const sender = parseSender(hdrs.from);
      return {
        id: msg.id,
        subject:   hdrs.subject || '(No subject)',
        from_name: sender.name,
        date:      hdrs.date || '',
        snippet:   detail.data.snippet || '',
        is_important: detail.data.labelIds?.includes('IMPORTANT') || false
      };
    }));
    res.json({ emails });
  } catch (err) {
    console.error('Emails fetch error:', err.message);
    // Return empty rather than 500 — Gmail may not be enabled yet
    res.json({ emails: [], error: err.message });
  }
});

app.post('/api/drafts/:id/send', requireAuth, async (req, res) => {
  try {
    const gmail = getGmailClient(req.session);
    const sent = await gmail.users.drafts.send({ userId: 'me', resource: { id: req.params.id } });
    res.json({ success: true, message_id: sent.data.id, thread_id: sent.data.threadId });
  } catch (err) {
    console.error('Send draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/drafts/:id', requireAuth, async (req, res) => {
  try {
    const gmail = getGmailClient(req.session);
    await gmail.users.drafts.delete({ userId: 'me', id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error('Discard draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memories', requireAuth, (req, res) => {
  try {
    res.json({ memories: getMemories(req.session.user.email) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

// ─── WiFi intent handler (bypasses Claude) ───────────────────────────────────

const WIFI_RE = {
  connect:    /\b(connect|join|switch|use)\b/i,
  scan:       /\b(scan|show|list|find|nearby|available|around)\b.{0,30}\b(wifi|wi-fi|networks?)\b|\bwhat.{0,20}\b(wifi|wi-fi|networks?)\b.{0,20}\bnear\b/i,
  disconnect: /\b(disconnect|turn off|disable|drop)\b.{0,30}\b(wifi|wi-fi|network)\b|\b(wifi|wi-fi)\b.{0,20}\b(off|disconnect)\b/i,
  diagnose:   /\b(fix|diagnose|troubleshoot|problem|issue|slow|broken|not working)\b.{0,40}\b(wifi|wi-fi|internet|network)\b|\b(wifi|internet|network)\b.{0,40}\b(fix|problem|issue|slow|not working|broken)\b/i,
  status:     /\b(wifi|wi-fi|internet|network|connected)\b.{0,30}\b(status|check|what|which|am i|are we)\b|what.{0,20}\b(wifi|wi-fi|internet|network|connected)\b|\bmy\s+(wifi|wi-fi|internet|network)\b/i,
};

function getWifiIntent(msg) {
  if (WIFI_RE.connect.test(msg) && /\b(wifi|wi-fi|network|hotspot|to\s+\w)/i.test(msg)) return 'connect';
  if (WIFI_RE.scan.test(msg))       return 'scan';
  if (WIFI_RE.diagnose.test(msg))   return 'diagnose';
  if (WIFI_RE.disconnect.test(msg)) return 'disconnect';
  if (WIFI_RE.status.test(msg))     return 'status';
  return null;
}

function extractSsid(msg) {
  const m = msg.match(/(?:connect(?:\s+me)?|join|switch|use)\s+(?:to\s+)?["']?([\w][\w\s\-\.]{0,40}?)["']?\s*(?:wifi|wi-fi|network|hotspot|$)/i);
  return m?.[1]?.trim() || null;
}

function parseIfaceInfo(output) {
  const ssid   = output.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim();
  const state  = output.match(/^\s*State\s*:\s*(.+)$/m)?.[1]?.trim()?.toLowerCase();
  const signal = output.match(/^\s*Signal\s*:\s*(.+)$/m)?.[1]?.trim();
  return { ssid, connected: state === 'connected', signal };
}

async function handleWifi(action, message) {
  switch (action) {
    case 'status': {
      const [iface, ping] = await Promise.all([
        runCmd('netsh wlan show interfaces'),
        runCmd('ping 8.8.8.8 -n 2 -w 2000'),
      ]);
      const info = parseIfaceInfo(iface.output);
      const reachable = ping.output.includes('Reply from') || ping.output.includes('bytes=');
      const msg = info.connected
        ? `Connected to **${info.ssid}**${info.signal ? ` (${info.signal} signal)` : ''}. ${reachable ? 'Internet is working.' : 'But the internet appears unreachable right now.'}`
        : `Not connected to any WiFi network. ${reachable ? '' : 'Internet is unreachable.'}`.trim();
      return {
        message: msg,
        wifi_result: { tool: 'wifi_status', data: { success: true, wifi_interfaces: iface.output, internet_reachable: reachable } }
      };
    }
    case 'scan': {
      const scan = await runCmd('netsh wlan show networks mode=bssid', 15000);
      const nets = [];
      for (const block of scan.output.split(/(?=SSID \d+\s*:)/)) {
        const ssid = block.match(/^SSID \d+\s*:\s*(.+)$/m)?.[1]?.trim();
        if (!ssid) continue;
        const signals = [...block.matchAll(/Signal\s*:\s*(\d+)%/gm)].map(m => +m[1]);
        nets.push({ ssid, signal: signals.length ? `${Math.max(...signals)}%` : '' });
      }
      const msg = nets.length
        ? `Found **${nets.length} network${nets.length > 1 ? 's' : ''}** nearby:\n` + nets.map(n => `• ${n.ssid}${n.signal ? ` — ${n.signal}` : ''}`).join('\n')
        : 'No WiFi networks found nearby.';
      return { message: msg, wifi_result: { tool: 'wifi_scan', data: { success: true, networks: scan.output } } };
    }
    case 'connect': {
      const ssid = extractSsid(message);
      if (!ssid) return { message: 'Which network do you want to connect to? Just tell me the name.', wifi_result: null };
      const attempt = await runCmd(`netsh wlan connect name="${ssid}"`);
      const ok = /successfully|completed/i.test(attempt.output);
      if (ok) {
        await new Promise(r => setTimeout(r, 2200));
        const iface = await runCmd('netsh wlan show interfaces');
        const info = parseIfaceInfo(iface.output);
        return {
          message: `Connected to **${info.ssid || ssid}**${info.signal ? ` — ${info.signal} signal` : ''}.`,
          wifi_result: { tool: 'wifi_connect', data: { success: true, status: iface.output, message: `Connected to "${ssid}".` } }
        };
      }
      return {
        message: `Couldn't connect to **${ssid}**. ${attempt.output.includes('not') ? 'That network wasn\'t found in saved profiles.' : ''} Do you have the password?`,
        wifi_result: { tool: 'wifi_connect', data: { success: false, message: attempt.output } }
      };
    }
    case 'disconnect': {
      const result = await runCmd('netsh wlan disconnect');
      return {
        message: 'Disconnected from WiFi.',
        wifi_result: { tool: 'wifi_disconnect', data: { success: true, message: result.output } }
      };
    }
    case 'diagnose': {
      const [iface, pingIp, pingName, dnsOut] = await Promise.all([
        runCmd('netsh wlan show interfaces'),
        runCmd('ping 8.8.8.8 -n 4 -w 2000'),
        runCmd('ping google.com -n 4 -w 2000'),
        runCmd('nslookup google.com'),
      ]);
      const info    = parseIfaceInfo(iface.output);
      const pingOk  = pingIp.output.includes('Reply from') || pingIp.output.includes('bytes=');
      const dnsOk   = pingName.output.includes('Reply from') || pingName.output.includes('bytes=');
      const resolves = dnsOut.output.includes('Address:');
      let summary = info.connected ? `Connected to **${info.ssid}**${info.signal ? ` (${info.signal})` : ''}` : '**Not connected to WiFi**';
      if (!pingOk) summary += '. Internet unreachable — possible router or ISP issue.';
      else if (!dnsOk || !resolves) summary += '. Internet reaches Google\'s servers but DNS may be failing.';
      else summary += '. Everything looks healthy.';
      return {
        message: summary,
        wifi_result: {
          tool: 'wifi_diagnose',
          data: { success: true, wifi_interfaces: iface.output, ping_ip_8_8_8_8: pingIp.output, ping_google_com: pingName.output, dns_lookup: dnsOut.output }
        }
      };
    }
  }
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  // Handle WiFi requests directly — bypasses Claude to avoid refusals
  const wifiIntent = getWifiIntent(message);
  if (wifiIntent) {
    try {
      const result = await handleWifi(wifiIntent, message);
      return res.json({ message: result.message, role: 'assistant', wifi_result: result.wifi_result, scheduled_event: null });
    } catch (err) {
      console.error('WiFi handler error:', err.message);
      return res.json({ message: `WiFi error: ${err.message}`, role: 'assistant', wifi_result: null, scheduled_event: null });
    }
  }

  const calendar = getCalendarClient(req.session);
  const now = new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const memories = getMemories(req.session.user.email);
  const memoryBlock = memories.length > 0
    ? `\n\n## What you know about ${req.session.user.name.split(' ')[0]}\n` +
      memories.map(m => `- **${m.key}**: ${m.value}`).join('\n')
    : '';

  const systemPrompt = `You are Spike, a personal digital assistant with direct access to ${req.session.user.name}'s Google Calendar and Gmail inbox.

You help with anything in ${req.session.user.name.split(' ')[0]}'s life — managing their schedule, handling emails, tracking tasks, planning their day, and staying on top of what matters.

You have these tools: create_event, list_events, update_event, delete_event, list_emails, get_email_content, trash_email, mark_important, draft_reply, draft_email, update_draft, send_draft, list_drafts, delete_draft, list_labels, create_label, apply_label, remove_label, web_search, save_memory, delete_memory, open_browser.

Calendar guidelines:
- Always use tools rather than guessing about the calendar
- When the user expresses a scheduling preference, habit, or constraint (even casually), immediately call save_memory
- Apply saved memories automatically — never schedule events that violate a known constraint
- Format times as "Monday, March 15 at 9:00 AM" — not raw ISO strings
- For recurring events use RRULE (e.g. RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR)

Email triage guidelines:
- When asked to check, review, or triage emails, call list_emails first to get the overview
- If an email's importance is unclear from the snippet, call get_email_content to read the full body before judging
- Classify emails clearly: mark important ones with mark_important, and recommend (but do not automatically trash) deletion candidates
- Good deletion candidates: newsletters the user didn't engage with, automated notifications, old promotions, duplicates, spam
- Important emails: anything from real people, deadlines, payments, official notices, or anything the user's contacts sent directly
- Before trashing, always confirm with the user unless they explicitly said "go ahead and delete"
- When listing emails, format them clearly — sender name, subject, and a one-line reason for your classification

Email reply and drafting guidelines:
- When the user asks you to reply to an email, call draft_reply. When they ask you to write a new email, call draft_email. NEVER call send_draft in the same turn as drafting — always show the draft first and wait for explicit confirmation.
- After drafting, summarize what you wrote in one short sentence (e.g. "Drafted a reply to Sarah confirming Thursday at 3 works."). The UI will show the full draft preview — don't repeat the whole body in your text response.
- If the user asks to revise ("make it shorter", "less formal", "add that I'll bring the slides"), call update_draft with the same draft_id. Don't start a brand new draft.
- Only call send_draft when the user has clearly approved the draft ("send it", "yes", "looks good, send", "go ahead"). Ambiguous responses like "ok" or "sure" after a draft preview are approval; ambiguous responses with no preceding draft are not.
- If the user says "discard", "throw it out", or "never mind", call delete_draft.
- Write replies in the user's own voice — concise, natural, matching the formality of the email being replied to. Default to plain text without "Hi <name>," / "Best, <user>" boilerplate unless the original used it.
- When drafting a reply, infer tone and context from the conversation history and the original email's content. If the original is unclear, call get_email_content first.

Email organization (labels) guidelines:
- Before creating a new label, call list_labels first — match case-insensitively to avoid duplicates like "Receipts" vs "receipts"
- If a near-match label already exists, use it rather than creating a new one. Only create when nothing fits.
- When the user wants to bulk-organize ("file all my Stripe emails as Receipts", "label everything from my boss as Work"), the flow is: list_labels → create_label if needed → list_emails with an appropriate query → apply_label with the message IDs
- For bulk operations of more than 10 messages, summarize the plan ("I'll create a 'Receipts' label and apply it to your 18 Stripe emails — confirm?") and wait for approval before applying
- Set archive: true only when intent is clearly "file", "organize", "clean up", or "get out of my inbox". Plain "label these" keeps them in inbox.
- After labeling, give a one-line confirmation ("Filed 18 emails into Receipts") — don't repeat the whole list.

Web search guidelines:
- Use web_search whenever the answer depends on current information you don't have — news, weather, prices, opening hours, scores, what's-happening-now, anything time-sensitive, or any fact about the real world beyond your training cutoff
- Don't search for things you already know — basic facts, definitions, math, code syntax
- Synthesize results into a clean answer. Don't dump raw search snippets. Cite sources naturally in prose when relevant ("according to CNN", "per the latest Bloomberg report")
- For local queries ("restaurants near me", "weather today"), include the user's location in the search if known

Browser guidelines:
- When the user asks to open, visit, or go to any website or URL, call open_browser immediately
- If the user says a site name without a URL (e.g. "open YouTube"), infer the correct URL (e.g. https://www.youtube.com)
- Always include the https:// scheme in the URL you pass to open_browser
- If the user asks to log in, sign in, or authenticate with Google on a site, set login_with_google: true — this opens a controlled browser, finds the "Sign in with Google" button, and clicks it automatically
- The first time login_with_google is used, a dedicated Spike browser profile will open; the user may need to sign into Google once — after that it remembers the session

Current date/time: ${now}
User: ${req.session.user.name} (${req.session.user.email})${memoryBlock}`;

  const recentHistory = history.slice(-20);
  const messages = [
    ...recentHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    let response;
    let iterations = 0;
    const MAX_ITERATIONS = 10;
    let createdEvent = null;
    let wifiResult = null;
    let draft = null;
    let sentDraftId = null;
    let discardedDraftId = null;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        tools: allTools,
        messages
      });

      if (response.stop_reason === 'end_turn') break;

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const result = await executeTool(block.name, block.input, calendar, req.session.user.email, req.session);
            if (block.name === 'create_event' && result.success) {
              createdEvent = { title: result.title, start: result.start, event_id: result.event_id };
            }
            if (['wifi_status','wifi_scan','wifi_connect','wifi_disconnect','wifi_diagnose'].includes(block.name)) {
              wifiResult = { tool: block.name, data: result };
            }
            if (['draft_reply','draft_email','update_draft'].includes(block.name) && result.success) {
              draft = {
                draft_id: result.draft_id,
                to:       result.to,
                subject:  result.subject,
                body:     result.body,
                cc:       result.cc || '',
                is_reply: !!result.is_reply
              };
            }
            if (block.name === 'send_draft' && result.success) {
              sentDraftId = block.input?.draft_id || result.thread_id;
              if (draft?.draft_id === block.input?.draft_id) draft = null;
            }
            if (block.name === 'delete_draft' && result.success) {
              discardedDraftId = result.draft_id;
              if (draft?.draft_id === result.draft_id) draft = null;
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          }
        }
        messages.push({ role: 'user', content: toolResults });
      } else {
        break;
      }
    }

    const text = response.content.find(b => b.type === 'text')?.text || 'Done!';
    res.json({
      message: text,
      role: 'assistant',
      scheduled_event: createdEvent || null,
      wifi_result: wifiResult || null,
      draft: draft || null,
      sent_draft_id: sentDraftId,
      discarded_draft_id: discardedDraftId
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Text-to-speech (ElevenLabs Jessica voice — ChatGPT-like) ────────────────

app.post('/api/tts', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set in .env' });

  const https = require('https');
  const body = JSON.stringify({
    text,
    model_id: 'eleven_flash_v2_5',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
  });

  const opts = {
    hostname: 'api.elevenlabs.io',
    path: '/v1/text-to-speech/cgSgspJ2msm6clMCkdW9',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const upstream = https.request(opts, (upRes) => {
    if (upRes.statusCode !== 200) {
      let err = '';
      upRes.on('data', d => err += d);
      upRes.on('end', () => res.status(upRes.statusCode).json({ error: err }));
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    upRes.pipe(res);
  });
  upstream.on('error', e => res.status(500).json({ error: e.message }));
  upstream.write(body);
  upstream.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀  Spike is running at http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('⚠️   GOOGLE_CLIENT_ID not set — copy .env.example to .env and fill in your credentials\n');
  }
});
