
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5000;
const CONFIG_PATH = path.join(__dirname, 'bots.json');

// ============================================================
// STATE & CONFIG
// ============================================================
let config = { globalSettings: {}, bots: [] };
const processes = new Map(); // botId -> { child, startTime }

// Load Config
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
} catch (err) {
  console.error('Failed to load config, starting empty.');
}

// ============================================================
// BOT PROCESS CONTROL
// ============================================================
function startBotProcess(botId) {
  const botConfig = config.bots.find(b => b.id === botId);
  if (!botConfig) return false;

  // Kill existing if any
  stopBotProcess(botId, true); // true = silent/force

  console.log(`[Manager] Spawning worker for ${botConfig.name}...`);

  const child = spawn('node', [path.join(__dirname, 'bot-worker.js')], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, BOT_CONFIG: JSON.stringify(botConfig) }
  });

  processes.set(botId, { child, startTime: Date.now() });

  // Handle Worker IPC
  child.on('message', (msg) => {
    handleWorkerMessage(botId, msg);
  });

  // Handle Logs
  child.stdout.on('data', (d) => console.log(`[${botConfig.name}] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => console.error(`[${botConfig.name}] ${d.toString().trim()}`));

  // Handle Crash
  child.on('exit', (code, signal) => {
    console.log(`[Manager] Process ${botId} exited (${code || signal})`);
    processes.delete(botId);
    // Optional: Auto-restart logic here if desired, but strictly we rely on user "Start"
  });

  // Handle Start Command Delay
  // We wait for WORKER_READY, but we can also just send START immediately 
  // since the worker queues messages in the 'message' event buffer.
  setTimeout(() => {
    try { child.send({ type: 'START' }); } catch (e) {}
  }, 500);

  return true;
}

function stopBotProcess(botId, force = false) {
  const pInfo = processes.get(botId);
  if (!pInfo) return true;

  console.log(`[Manager] Stopping worker ${botId}...`);
  
  try {
    // 1. Send STOP command (triggers isRunning = false in worker)
    pInfo.child.send({ type: 'STOP' });
  } catch (e) {}

  // 2. Force kill after 3 seconds if it hasn't exited
  const killTimer = setTimeout(() => {
    if (pInfo.child && !pInfo.child.killed) {
      console.log(`[Manager] Force killing ${botId}`);
      pInfo.child.kill('SIGKILL');
    }
  }, 3000);

  pInfo.child.once('exit', () => {
    clearTimeout(killTimer);
    processes.delete(botId);
  });

  if (force) {
    // If we are just cleaning up state, we might not want to wait, 
    // but generally we let the cleanup happen naturally.
  }

  return true;
}

// ============================================================
// IPC HANDLING
// ============================================================
function handleWorkerMessage(botId, msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'STATUS_UPDATE') {
    // In a real app, you would store this in memory for the API to read
    // For this rewrite, we just log or broadcast via WebSocket if implemented
    // console.log(`[Manager] Status update from ${botId}:`, msg.status);
  } 
  else if (msg.type === 'WEBHOOK_EVENT') {
    // Dispatch webhook (logic from original code)
    dispatchWebhook(botId, msg.payload);
  }
}

function dispatchWebhook(botId, payload) {
  const botConfig = config.bots.find(b => b.id === botId);
  const url = botConfig?.webhookUrl || config.globalSettings?.webhookUrl;
  
  if (!url || url.includes('placeholder')) return;

  const data = JSON.stringify({
    username: payload.botName || 'Bot',
    embeds: [{ title: payload.eventType, description: payload.message, color: 3447003 }]
  });

  const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
    if (res.statusCode >= 400) console.error(`Webhook failed: ${res.statusCode}`);
  });
  
  req.on('error', () => {}); // Fail silently
  req.write(data);
  req.end();
}

// ============================================================
// EXPRESS API
// ============================================================
app.use(express.json());
app.use(express.static('public'));

app.get('/api/bots', (req, res) => res.json(config));

app.post('/api/bots/:id/start', (req, res) => {
  if (startBotProcess(req.params.id)) res.json({ success: true });
  else res.status(500).json({ error: 'Failed to start' });
});

app.post('/api/bots/:id/stop', (req, res) => {
  if (stopBotProcess(req.params.id)) res.json({ success: true });
  else res.status(500).json({ error: 'Failed to stop' });
});

// ============================================================
// SERVER START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Manager listening on port ${PORT}`);
});
