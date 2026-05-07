const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3100;

const SNAPSHOT_FILE = path.join(__dirname, 'localStorage_snapshot.json');
const EVENT_LOG_FILE = path.join(__dirname, 'event_log.ndjson');
const DB_FILE = path.join(__dirname, 'db.json');
const DB_INITIAL_FILE = path.join(__dirname, 'db_initial.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// Return the Monday (UTC) of the week containing date d.
function getMondayOf(d) {
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() + offset);
  m.setUTCHours(0, 0, 0, 0);
  return m;
}

// Format a Date as YYYY-MM-DD (UTC).
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// Compute dynamic sprint dates so the active sprint (sprint-2) always covers today.
// Active sprint: starts on the Monday of the current 2-week sprint window, 14 days long.
// Completed sprint (sprint-1): the 2-week window immediately before the active one.
function applyDynamicSprintDates(sprints) {
  const today = new Date();
  const thisMonday = getMondayOf(today);

  // Determine which 2-week block from thisMonday covers today.
  // We want the active sprint to start on a Monday that is <= today and end on Sunday 13 days later.
  // Since getMondayOf always returns this week's Monday, and a sprint is 2 weeks,
  // check if today is in week 1 or week 2 of the current sprint window.
  // Sprint window starts on an "even" Monday (0, 2, 4... weeks from epoch Monday).
  const epochMonday = new Date('2000-01-03T00:00:00Z'); // a known Monday
  const weeksSinceEpoch = Math.floor((thisMonday - epochMonday) / (7 * 86400000));
  const sprintWeekOffset = weeksSinceEpoch % 2; // 0 if this Monday starts a sprint, 1 if mid-sprint

  const activeStart = new Date(thisMonday);
  activeStart.setUTCDate(activeStart.getUTCDate() - sprintWeekOffset * 7);

  const activeEnd = new Date(activeStart);
  activeEnd.setUTCDate(activeEnd.getUTCDate() + 13);

  const completedEnd = new Date(activeStart);
  completedEnd.setUTCDate(completedEnd.getUTCDate() - 1);

  const completedStart = new Date(completedEnd);
  completedStart.setUTCDate(completedStart.getUTCDate() - 13);

  return sprints.map(sprint => {
    if (sprint.id === 'sprint-2' && sprint.status === 'active') {
      return { ...sprint, startDate: toDateStr(activeStart), endDate: toDateStr(activeEnd) };
    }
    if (sprint.id === 'sprint-1' && sprint.status === 'completed') {
      return { ...sprint, startDate: toDateStr(completedStart), endDate: toDateStr(completedEnd) };
    }
    return sprint;
  });
}

// GET /api/data - returns db.json content with dynamic sprint dates
app.get('/api/data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (data.sprints) {
      data.sprints = applyDynamicSprintDates(data.sprints);
    }
    res.json(data);
  } catch (err) {
    console.error('Error reading db.json:', err);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// POST /save-state - persists state back to db.json so it survives page refresh
app.post('/save-state', (req, res) => {
  try {
    const { tasks, users, tags, sprints } = req.body;
    const current = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const updated = { ...current, tasks, users, tags, sprints };
    fs.writeFileSync(DB_FILE, JSON.stringify(updated, null, 2), 'utf8');
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error writing state:', err);
    res.status(500).json({ error: 'Failed to save state' });
  }
});

// POST /log-event - appends event line to event_log.ndjson
app.post('/log-event', (req, res) => {
  try {
    const event = {
      ts: new Date().toISOString(),
      ...req.body
    };
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(EVENT_LOG_FILE, line, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error writing event log:', err);
    res.status(500).json({ error: 'Failed to log event' });
  }
});

// POST /api/reset - restore db to initial seed, clear event log and snapshot
app.post('/api/reset', (req, res) => {
  try {
    const initial = fs.readFileSync(DB_INITIAL_FILE, 'utf8');
    fs.writeFileSync(DB_FILE, initial, 'utf8');
    if (fs.existsSync(EVENT_LOG_FILE)) fs.writeFileSync(EVENT_LOG_FILE, '', 'utf8');
    fs.copyFileSync(DB_INITIAL_FILE, SNAPSHOT_FILE);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error resetting:', err);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

// GET /api/download/event-log - download event_log.ndjson
app.get('/api/download/event-log', (req, res) => {
  if (!fs.existsSync(EVENT_LOG_FILE)) {
    return res.status(404).json({ error: 'Event log not found' });
  }
  res.download(EVENT_LOG_FILE, 'event_log.ndjson');
});

// GET /api/download/snapshot - download localStorage_snapshot.json
app.get('/api/download/snapshot', (req, res) => {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.download(SNAPSHOT_FILE, 'localStorage_snapshot.json');
});

// GET /api/download/all - return db_initial, event_log, and snapshot bundled as JSON
app.get('/api/download/all', (req, res) => {
  try {
    const bundle = {
      db_initial: JSON.parse(fs.readFileSync(DB_INITIAL_FILE, 'utf8')),
      event_log: fs.existsSync(EVENT_LOG_FILE)
        ? fs.readFileSync(EVENT_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [],
      snapshot: fs.existsSync(SNAPSHOT_FILE)
        ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))
        : null,
    };
    res.setHeader('Content-Disposition', 'attachment; filename="eval_bundle.json"');
    res.json(bundle);
  } catch (err) {
    console.error('Error creating bundle:', err);
    res.status(500).json({ error: 'Failed to create bundle' });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Scrum board running at http://localhost:${PORT}`);
  if (process.env.NO_OPEN_BROWSER === '1') {
    return;
  }
  // Auto-open browser
  const { exec } = require('child_process');
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') {
    cmd = `open http://localhost:${PORT}`;
  } else if (platform === 'win32') {
    cmd = `start http://localhost:${PORT}`;
  } else {
    cmd = `xdg-open http://localhost:${PORT}`;
  }
  exec(cmd, (err) => {
    if (err) console.log('Could not auto-open browser. Please navigate to http://localhost:' + PORT);
  });
});
