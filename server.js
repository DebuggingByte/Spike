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

// ─── Google OAuth helper ──────────────────────────────────────────────────────

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

// ─── Calendar + memory tools for Claude ──────────────────────────────────────

const calendarTools = [
  {
    name: 'create_event',
    description: 'Create a new event on the user\'s Google Calendar. Use ISO 8601 format for times.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title/summary' },
        start_time: { type: 'string', description: 'Start datetime in ISO 8601 (e.g. 2024-09-15T09:00:00)' },
        end_time: { type: 'string', description: 'End datetime in ISO 8601 (e.g. 2024-09-15T10:30:00)' },
        description: { type: 'string', description: 'Event description or notes (optional)' },
        location: { type: 'string', description: 'Event location (optional)' },
        timezone: { type: 'string', description: 'Timezone string e.g. America/New_York (optional, defaults to UTC)' },
        recurrence: { type: 'string', description: 'RRULE for repeating events e.g. RRULE:FREQ=WEEKLY;BYDAY=MO,WE for every Mon & Wed (optional)' }
      },
      required: ['title', 'start_time', 'end_time']
    }
  },
  {
    name: 'list_events',
    description: 'List upcoming events from the user\'s Google Calendar. Call this to check the schedule.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'integer', description: 'Max number of events to return (default 10, max 50)' },
        time_min: { type: 'string', description: 'Start of time range ISO 8601 (default: right now)' },
        time_max: { type: 'string', description: 'End of time range ISO 8601 (optional)' },
        query: { type: 'string', description: 'Full-text search query to filter events (optional)' }
      }
    }
  },
  {
    name: 'update_event',
    description: 'Update an existing event on the user\'s Google Calendar. Only provide fields you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The Google Calendar event ID' },
        title: { type: 'string', description: 'New event title (optional)' },
        start_time: { type: 'string', description: 'New start datetime ISO 8601 (optional)' },
        end_time: { type: 'string', description: 'New end datetime ISO 8601 (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        location: { type: 'string', description: 'New location (optional)' }
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
  {
    name: 'save_memory',
    description: `Save or update a preference or constraint about the user for future sessions.
Call this proactively whenever the user expresses a scheduling preference, constraint, or personal routine — even casually.
Examples: "I prefer mornings", "no meetings on Fridays after 3pm", "lunch is always 12–1pm", "I dislike back-to-back meetings".
The key should be short snake_case (e.g. "preferred_study_time"). Value should be a full plain-English sentence.
Saved memories are injected into your system prompt in all future conversations.`,
    input_schema: {
      type: 'object',
      properties: {
        key:   { type: 'string', description: 'Short snake_case label for this memory (e.g. "preferred_study_time")' },
        value: { type: 'string', description: 'Plain English description of the preference or constraint' }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'delete_memory',
    description: 'Delete a previously saved memory by its key. Use when the user says a preference no longer applies or wants it removed.',
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

async function executeTool(name, input, calendar, userEmail) {
  try {
    switch (name) {
      case 'create_event': {
        const tz = input.timezone || 'UTC';
        const event = {
          summary: input.title,
          description: input.description || '',
          location: input.location || '',
          start: { dateTime: input.start_time, timeZone: tz },
          end: { dateTime: input.end_time, timeZone: tz }
        };
        if (input.recurrence) {
          event.recurrence = [input.recurrence];
        }
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
        if (input.query) params.q = input.query;
        const res = await calendar.events.list(params);
        const events = (res.data.items || []).map(e => ({
          id: e.id,
          title: e.summary || '(No title)',
          start: e.start?.dateTime || e.start?.date || '',
          end: e.end?.dateTime || e.end?.date || '',
          description: e.description || '',
          location: e.location || '',
          html_link: e.htmlLink || ''
        }));
        return { success: true, events, count: events.length };
      }

      case 'update_event': {
        const patch = {};
        if (input.title) patch.summary = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.location !== undefined) patch.location = input.location;
        if (input.start_time) patch.start = { dateTime: input.start_time };
        if (input.end_time) patch.end = { dateTime: input.end_time };
        const res = await calendar.events.patch({
          calendarId: 'primary',
          eventId: input.event_id,
          resource: patch
        });
        return { success: true, event_id: res.data.id, message: 'Event updated successfully.' };
      }

      case 'delete_event': {
        await calendar.events.delete({ calendarId: 'primary', eventId: input.event_id });
        return { success: true, message: 'Event deleted successfully.' };
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
      name: userInfo.name,
      email: userInfo.email,
      picture: userInfo.picture,
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
      calendarId: 'primary',
      maxResults: 15,
      orderBy: 'startTime',
      singleEvents: true,
      timeMin: new Date().toISOString()
    });
    const events = (result.data.items || []).map(e => ({
      id: e.id,
      title: e.summary || '(No title)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || '',
      description: e.description || ''
    }));
    res.json({ events });
  } catch (err) {
    console.error('Events fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/memories', requireAuth, (req, res) => {
  try {
    res.json({ memories: getMemories(req.session.user.email) });
  } catch (err) {
    console.error('Memories fetch error:', err.message);
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

  const systemPrompt = `You are ScheduleAI, an intelligent and friendly calendar assistant with direct access to ${req.session.user.name}'s Google Calendar.

You help manage schedules — especially classes, study sessions, assignments, exams, and any academic or personal events.

You have six tools: create_event, list_events, update_event, delete_event, save_memory, delete_memory.

Guidelines:
- Always use tools rather than guessing about the calendar
- When the user expresses a scheduling preference, habit, or constraint (even casually), immediately call save_memory to record it
- Apply saved memories automatically when scheduling — honor them without being asked, and never schedule events that violate a known constraint
- When creating events, confirm what was created with the date and time in plain English
- Format times as "Monday, March 15 at 9:00 AM" — not raw ISO strings
- When showing event lists, use clear formatting with bullet points
- Be concise but warm and helpful
- If the user describes a class schedule (e.g., "MWF 10-11am"), offer to create all the recurring events
- For recurring events, use RRULE in the recurrence field (e.g., RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR)

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
        tools: calendarTools,
        messages
      });

      if (response.stop_reason === 'end_turn') break;

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });

        const toolResults = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const result = await executeTool(block.name, block.input, calendar, req.session.user.email);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result)
            });
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
