require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { getMemories, saveMemory, deleteMemory } = require('./db');

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
    description: 'Create a new event on the user\'s Google Calendar. Use ISO 8601 format for times.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Event title/summary' },
        start_time:  { type: 'string', description: 'Start datetime in ISO 8601 (e.g. 2024-09-15T09:00:00)' },
        end_time:    { type: 'string', description: 'End datetime in ISO 8601 (e.g. 2024-09-15T10:30:00)' },
        description: { type: 'string', description: 'Event description or notes (optional)' },
        location:    { type: 'string', description: 'Event location (optional)' },
        timezone:    { type: 'string', description: 'Timezone string e.g. America/New_York (optional, defaults to UTC)' },
        recurrence:  { type: 'string', description: 'RRULE for repeating events e.g. RRULE:FREQ=WEEKLY;BYDAY=MO,WE (optional)' }
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
        const res = await calendar.events.insert({ calendarId: 'primary', resource: event });
        return {
          success: true,
          event_id: res.data.id,
          title: res.data.summary,
          start: res.data.start.dateTime || res.data.start.date,
          html_link: res.data.htmlLink,
          message: `Event "${input.title}" created successfully.`
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
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
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

app.get('/api/memories', requireAuth, (req, res) => {
  try {
    res.json({ memories: getMemories(req.session.user.email) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

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

  const systemPrompt = `You are ScheduleAI, an intelligent and friendly assistant with direct access to ${req.session.user.name}'s Google Calendar and Gmail inbox.

You help manage schedules and emails — classes, study sessions, assignments, exams, and inbox triage.

You have ten tools: create_event, list_events, update_event, delete_event, list_emails, get_email_content, trash_email, mark_important, save_memory, delete_memory.

Calendar guidelines:
- Always use tools rather than guessing about the calendar
- When the user expresses a scheduling preference, habit, or constraint (even casually), immediately call save_memory
- Apply saved memories automatically — never schedule events that violate a known constraint
- Format times as "Monday, March 15 at 9:00 AM" — not raw ISO strings
- For recurring events use RRULE (e.g. RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR)

Email guidelines:
- When asked to check, review, or triage emails, call list_emails first to get the overview
- If an email's importance is unclear from the snippet, call get_email_content to read the full body before judging
- Classify emails clearly: mark important ones with mark_important, and recommend (but do not automatically trash) deletion candidates
- Good deletion candidates: newsletters the user didn't engage with, automated notifications, old promotions, duplicates, spam
- Important emails: anything from real people, deadlines, payments, official notices, or anything the user's contacts sent directly
- Before trashing, always confirm with the user unless they explicitly said "go ahead and delete"
- When listing emails, format them clearly — sender name, subject, and a one-line reason for your classification

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

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      response = await anthropic.messages.create({
        model: 'claude-opus-4-7',
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
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          }
        }
        messages.push({ role: 'user', content: toolResults });
      } else {
        break;
      }
    }

    const text = response.content.find(b => b.type === 'text')?.text || 'Done!';
    res.json({ message: text, role: 'assistant' });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀  ScheduleAI is running at http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('⚠️   GOOGLE_CLIENT_ID not set — copy .env.example to .env and fill in your credentials\n');
  }
});
