const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3102;

const DB_PATH = path.join(__dirname, 'db.json');
const DB_INITIAL_PATH = path.join(__dirname, 'db_initial.json');
const EVENT_LOG_PATH = path.join(__dirname, 'event_log.ndjson');
const SNAPSHOT_PATH = path.join(__dirname, 'localStorage_snapshot.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    // Compute offset so that the latest message timestamp maps to ~now
    const allTimestamps = data.messages.map(m => new Date(m.timestamp).getTime());
    const latestTs = Math.max(...allTimestamps);
    data.timestampOffsetMs = Date.now() - latestTs;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read db.json' });
  }
});

app.post('/save-state', (req, res) => {
  try {
    const { messages, reactions } = req.body;
    const current = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const updated = { ...current, messages, reactions: reactions || {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(updated, null, 2));
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save state' });
  }
});

app.post('/log-event', (req, res) => {
  try {
    const event = { ts: new Date().toISOString(), ...req.body };
    fs.appendFileSync(EVENT_LOG_PATH, JSON.stringify(event) + '\n');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log event' });
  }
});

app.post('/api/reset', (req, res) => {
  try {
    fs.copyFileSync(DB_INITIAL_PATH, DB_PATH);
    fs.writeFileSync(EVENT_LOG_PATH, '');
    fs.copyFileSync(DB_INITIAL_PATH, SNAPSHOT_PATH);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset' });
  }
});

app.get('/api/download/event-log', (req, res) => {
  res.download(EVENT_LOG_PATH, 'event_log.ndjson');
});

app.get('/api/download/snapshot', (req, res) => {
  res.download(SNAPSHOT_PATH, 'localStorage_snapshot.json');
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Teams app running at http://localhost:${PORT}`);
});
