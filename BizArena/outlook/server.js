const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3101;
const DB_PATH = path.join(__dirname, 'db.json');
const DB_INITIAL_PATH = path.join(__dirname, 'db_initial.json');
const SNAPSHOT_PATH = path.join(__dirname, 'localStorage_snapshot.json');
const EVENT_LOG_PATH = path.join(__dirname, 'event_log.ndjson');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialise db.json from db_initial.json only if db.json does not exist yet
if (!fs.existsSync(DB_PATH) && fs.existsSync(DB_INITIAL_PATH)) {
  fs.copyFileSync(DB_INITIAL_PATH, DB_PATH);
}

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Seed emails have IDs like "email-001"; user-created ones are "email-<timestamp>".
// Only seed emails need shifting — user-created emails already have real timestamps.
const SEED_ID_RE = /^email-\d{3}$/;
// Seed events have IDs like "event-001" through "event-999".
const SEED_EVENT_ID_RE = /^event-\d{3}$/;

function getShiftMs() {
  const db = readDB();
  if (!db.anchor) return 0;
  // Shift so the latest seed email lands at "now" — this guarantees no seed
  // emails appear in the future regardless of the user's local time-of-day.
  const seedEmails = (db.emails || []).filter(e => SEED_ID_RE.test(e.id));
  let maxTs = new Date(db.anchor).getTime();
  for (const e of seedEmails) {
    const t = new Date(e.timestamp).getTime();
    if (t > maxTs) maxTs = t;
  }
  return new Date(localNowAsUTC()).getTime() - maxTs;
}

// Return current local time as an ISO string with Z suffix.
// This makes getUTCHours() on the client return the user's wall-clock hours,
// keeping new emails consistent with seed timestamps (which encode wall-clock
// times in the UTC position).
function localNowAsUTC() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}Z`;
}

function applyShift(emails) {
  const shiftMs = getShiftMs();
  if (shiftMs === 0) return emails;
  return emails.map(e => {
    if (!SEED_ID_RE.test(e.id)) return e;
    return { ...e, timestamp: new Date(new Date(e.timestamp).getTime() + shiftMs).toISOString() };
  });
}

// Shift a YYYY-MM-DD date string by shiftMs, rounding to whole days.
function shiftDate(dateStr, shiftMs) {
  const shiftDays = Math.round(shiftMs / 86400000);
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
}

// Return the Monday (UTC) of the week containing date d.
function getMondayOf(d) {
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day; // shift back to Monday
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() + offset);
  m.setUTCHours(0, 0, 0, 0);
  return m;
}

// Week-snapped shift in ms: whole number of weeks between the anchor's Monday
// and today's Monday.  Guarantees Mon→Mon, Tue→Tue etc. as real time advances.
function getWeekSnappedShiftMs() {
  const db = readDB();
  if (!db.anchor) return 0;
  const anchorMonday = getMondayOf(new Date(db.anchor));
  const todayMonday  = getMondayOf(new Date());
  const weeks = Math.round((todayMonday - anchorMonday) / (7 * 86400000));
  return weeks * 7 * 86400000;
}

function applyEventShift(events) {
  const shiftMs = getWeekSnappedShiftMs();
  if (shiftMs === 0) return events;
  return events.map(e => {
    if (!SEED_EVENT_ID_RE.test(e.id)) return e;
    return { ...e, date: shiftDate(e.date, shiftMs) };
  });
}

// GET / - serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GET /api/emails - all emails with optional ?folder= filter
app.get('/api/emails', (req, res) => {
  const db = readDB();
  const { folder } = req.query;
  const emails = folder
    ? db.emails.filter(e => e.folder === folder)
    : db.emails;
  res.json(applyShift(emails));
});

// GET /api/emails/:id - single email
app.get('/api/emails/:id', (req, res) => {
  const db = readDB();
  const email = db.emails.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  res.json(applyShift([email])[0]);
});

// PATCH /api/emails/:id - partial update
app.patch('/api/emails/:id', (req, res) => {
  const db = readDB();
  const idx = db.emails.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Email not found' });

  const allowed = ['read', 'flagged', 'pinned', 'folder', 'subject', 'body', 'focused', 'to', 'cc', 'category', 'reactions', 'isMeetingInvite', 'eventId'];
  const updates = {};
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key];
  }

  db.emails[idx] = { ...db.emails[idx], ...updates };
  writeDB(db);
  res.json(applyShift([db.emails[idx]])[0]);
});

// POST /api/emails - create email (compose/reply/forward)
app.post('/api/emails', (req, res) => {
  const db = readDB();
  const newEmail = {
    id: `email-${Date.now()}`,
    subject: req.body.subject || '(no subject)',
    from: req.body.from || { name: db.user.name, email: db.user.email },
    to: req.body.to || [],
    cc: req.body.cc || [],
    body: req.body.body || '',
    timestamp: localNowAsUTC(),
    folder: req.body.folder || 'sent',
    read: req.body.folder === 'sent' ? true : (req.body.read !== undefined ? req.body.read : false),
    flagged: false,
    pinned: false,
    focused: req.body.folder === 'inbox',
    hasAttachment: false,
    isExternal: false,
    conversationId: req.body.conversationId || `conv-${Date.now()}`,
    replyToId: req.body.replyToId || null,
    isMeetingInvite: req.body.isMeetingInvite || false,
    eventId: req.body.eventId || null,
  };
  db.emails.push(newEmail);
  writeDB(db);
  res.status(201).json(newEmail);
});

// DELETE /api/emails/:id - soft delete (move to deleted); permanent if already deleted
app.delete('/api/emails/:id', (req, res) => {
  const db = readDB();
  const idx = db.emails.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Email not found' });

  const email = db.emails[idx];
  if (email.folder === 'deleted') {
    db.emails.splice(idx, 1);
    writeDB(db);
    return res.json({ deleted: true, permanent: true, id: req.params.id });
  } else {
    db.emails[idx] = { ...email, folder: 'deleted' };
    writeDB(db);
    return res.json({ deleted: true, permanent: false, email: db.emails[idx] });
  }
});

// GET /api/folders - folder list with live unread counts
app.get('/api/folders', (req, res) => {
  const db = readDB();
  const folders = db.folders.map(folder => {
    const count = db.emails.filter(
      e => e.folder === folder.id && !e.read
    ).length;
    return { ...folder, count };
  });
  res.json(folders);
});

// POST /api/folders - create a new folder
app.post('/api/folders', (req, res) => {
  const db = readDB();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const id = 'folder-' + Date.now();
  if (db.folders.some(f => f.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Folder already exists' });
  }
  const folder = { id, name, icon: 'custom', count: 0 };
  db.folders.push(folder);
  writeDB(db);
  res.status(201).json(folder);
});

// POST /save-state - write snapshot to localStorage_snapshot.json
// Merges server-side email/event fields into the snapshot so the snapshot
// becomes the single source of truth for evaluation (survives db resets).
app.post('/save-state', (req, res) => {
  try {
    const snapshot = req.body;
    const db = readDB();

    // Merge server-side email fields (flagged, folder, read, etc.) into snapshot emails
    if (Array.isArray(snapshot.emails) && Array.isArray(db.emails)) {
      const dbEmailMap = new Map(db.emails.map(e => [e.id, e]));
      for (const snapEmail of snapshot.emails) {
        const dbEmail = dbEmailMap.get(snapEmail.id);
        if (dbEmail) {
          for (const key of ['flagged', 'folder', 'read', 'pinned', 'category']) {
            if (key in dbEmail) snapEmail[key] = dbEmail[key];
          }
        }
      }
      // Add any db emails missing from the snapshot (e.g. agent-composed emails)
      for (const dbEmail of db.emails) {
        if (!snapshot.emails.find(e => e.id === dbEmail.id)) {
          snapshot.emails.push(dbEmail);
        }
      }
    }

    // Merge server-side calendar event fields into snapshot
    if (Array.isArray(snapshot.calendarEvents) && Array.isArray(db.events)) {
      const shiftedDbEvents = applyEventShift(db.events);
      const dbEventMap = new Map(shiftedDbEvents.map(e => [e.id, e]));
      for (const snapEvent of snapshot.calendarEvents) {
        const dbEvent = dbEventMap.get(snapEvent.id);
        if (dbEvent) {
          for (const key of ['rsvp', 'startTime', 'endTime', 'date', 'title', 'location', 'notes', 'attendees', 'recurrence']) {
            if (key in dbEvent) snapEvent[key] = dbEvent[key];
          }
        }
      }
      // Add any db events missing from the snapshot
      for (const dbEvent of shiftedDbEvents) {
        if (!snapshot.calendarEvents.find(e => e.id === dbEvent.id)) {
          snapshot.calendarEvents.push(dbEvent);
        }
      }
    }

    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save state' });
  }
});

// GET /api/events - all calendar events
app.get('/api/events', (req, res) => {
  const db = readDB();
  res.json(applyEventShift(db.events || []));
});

// POST /api/events - create event
app.post('/api/events', (req, res) => {
  const db = readDB();
  if (!db.events) db.events = [];
  const event = {
    id: `event-${Date.now()}`,
    title: req.body.title || '(No title)',
    date: req.body.date || new Date().toISOString().slice(0, 10),
    startTime: req.body.startTime || '09:00',
    endTime: req.body.endTime || '10:00',
    allDay: req.body.allDay || false,
    location: req.body.location || '',
    notes: req.body.notes || '',
    color: req.body.color || 'blue',
    recurrence: req.body.recurrence || 'none',
    host: req.body.host || 'alex.johnson@contoso.com',
    attendees: req.body.attendees || ['alex.johnson@contoso.com'],
    rsvp: req.body.rsvp || 'accepted',
  };
  db.events.push(event);
  writeDB(db);
  res.status(201).json(event);
});

// PATCH /api/events/:id - update event
app.patch('/api/events/:id', (req, res) => {
  const db = readDB();
  if (!db.events) db.events = [];
  const idx = db.events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  const allowed = ['title', 'date', 'startTime', 'endTime', 'allDay', 'location', 'notes', 'color', 'recurrence', 'host', 'attendees', 'rsvp'];
  const updates = {};
  for (const key of allowed) { if (key in req.body) updates[key] = req.body[key]; }
  db.events[idx] = { ...db.events[idx], ...updates };
  writeDB(db);
  res.json(applyEventShift([db.events[idx]])[0]);
});

// DELETE /api/events/:id - delete event
app.delete('/api/events/:id', (req, res) => {
  const db = readDB();
  if (!db.events) db.events = [];
  const idx = db.events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  db.events.splice(idx, 1);
  writeDB(db);
  res.json({ deleted: true, id: req.params.id });
});

// POST /log-event - append event line to event_log.ndjson
app.post('/log-event', (req, res) => {
  try {
    const event = { ...req.body, ts: req.body.ts || new Date().toISOString() };
    fs.appendFileSync(EVENT_LOG_PATH, JSON.stringify(event) + '\n', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log event' });
  }
});

// POST /api/reset - restore db from db_initial.json, clear event log and snapshot
app.post('/api/reset', (req, res) => {
  try {
    fs.copyFileSync(DB_INITIAL_PATH, DB_PATH);
    fs.writeFileSync(EVENT_LOG_PATH, '', 'utf8');
    fs.copyFileSync(DB_INITIAL_PATH, SNAPSHOT_PATH);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// GET /api/download/event-log - download event_log.ndjson
app.get('/api/download/event-log', (req, res) => {
  if (!fs.existsSync(EVENT_LOG_PATH)) {
    return res.status(404).json({ error: 'Event log not found' });
  }
  res.download(EVENT_LOG_PATH, 'event_log.ndjson');
});

// GET /api/download/snapshot - download localStorage_snapshot.json
app.get('/api/download/snapshot', (req, res) => {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.download(SNAPSHOT_PATH, 'localStorage_snapshot.json');
});

app.listen(PORT, () => {
  console.log(`Outlook app running at http://localhost:${PORT}`);
});
