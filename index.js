'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { spawn } = require('child_process');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 5000;

// ============================================================
// CONFIGURATION MANAGEMENT
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'bots.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[Config] Failed to load:', err.message);
    return { globalSettings: {}, bots: [] };
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Config] Failed to save:', err.message);
    return false;
  }
}

let config = loadConfig();

// ============================================================
// BOT PROCESS MANAGER
// ============================================================

/**
 * botProcesses  Map<botId, ProcessEntry>
 * botStatuses   Map<botId, StatusEntry>
 *
 * ProcessEntry  { process: ChildProcess|null, status: string, startTime: number }
 * StatusEntry   { id, name, status, connected, playerCount, … }
 */
const botProcesses = new Map();
const botStatuses  = new Map();

// Seed statuses — all bots start in "stopped" state on launch
config.bots.forEach(bc => {
  botStatuses.set(bc.id, createInitialStatus(bc));
});

function createInitialStatus(bc) {
  return {
    id:                bc.id,
    name:              bc.name,
    status:            'stopped',
    connected:         false,
    playerCount:       0,
    lastActivity:      Date.now(),
    reconnectAttempts: 0,
    uptime:            0,
    coordinates:       null,
    lastError:         null
  };
}

// ─── Start ───────────────────────────────────────────────────
function startBotInstance(botId) {
  const bc = config.bots.find(b => b.id === botId);
  if (!bc) {
    console.error(`[BotManager] Config not found: ${botId}`);
    return false;
  }

  // Tear down any existing process before starting fresh
  _killProcess(botId);

  console.log(`[BotManager] Starting bot: ${bc.name}`);

  const child = spawn('node', [path.join(__dirname, 'bot-worker.js')], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env:   { ...process.env, BOT_CONFIG: JSON.stringify(bc) }
  });

  botProcesses.set(botId, {
    process:   child,
    status:    'starting',
    startTime: Date.now()
  });

  child.on('message', msg => handleWorkerMessage(botId, msg));

  child.stdout.on('data', d => console.log(`[${bc.name}] ${d.toString().trim()}`));
  child.stderr.on('data', d => console.error(`[${bc.name}] ERR: ${d.toString().trim()}`));

  child.on('error', err => {
    console.error(`[${bc.name}] Process error:`, err.message);
    updateBotStatus(botId, { status: 'error', connected: false, lastError: err.message });
  });

  child.on('exit', (code, signal) => {
    console.log(`[${bc.name}] Exited — code=${code} signal=${signal}`);
    const entry = botProcesses.get(botId);
    if (entry) {
      entry.status  = 'stopped';
      entry.process = null;
    }
    updateBotStatus(botId, {
      status:    'stopped',
      connected: false,
      lastError: code !== 0 ? `Exited with code ${code}` : null
    });
  });

  return true;
}

// ─── Stop ────────────────────────────────────────────────────
/**
 * Stops a bot instance gracefully.
 * 1. Sends IPC STOP so the worker sets isRunning=false before doing anything else.
 * 2. Waits up to 3 s for graceful exit, then SIGTERM → SIGKILL.
 * @param {string}        botId
 * @param {Function|null} [callback]
 */
function stopBotInstance(botId, callback) {
  const entry = botProcesses.get(botId);

  if (!entry || !entry.process) {
    updateBotStatus(botId, { status: 'stopped', connected: false });
    callback?.();
    return;
  }

  console.log(`[BotManager] Stopping bot: ${botId}`);
  entry.status = 'stopping';
  updateBotStatus(botId, { status: 'stopping', connected: false });

  const proc = entry.process;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    entry.status  = 'stopped';
    entry.process = null;
    updateBotStatus(botId, { status: 'stopped', connected: false });
    callback?.();
  };

  // Ask worker to stop cleanly (worker will set isRunning=false immediately)
  try { proc.send({ type: 'STOP' }); } catch (_) { /* IPC channel already gone */ }

  // Settle once the process exits
  proc.once('exit', () => {
    clearTimeout(gracefulTimer);
    settle();
  });

  // Fallback: forceful termination
  const gracefulTimer = setTimeout(() => {
    if (proc.killed) { settle(); return; }
    console.log(`[BotManager] Graceful timeout — sending SIGTERM to ${botId}`);
    proc.kill('SIGTERM');

    setTimeout(() => {
      if (!proc.killed) {
        console.log(`[BotManager] SIGTERM ignored — sending SIGKILL to ${botId}`);
        proc.kill('SIGKILL');
      }
      settle();
    }, 5_000);
  }, 3_000);
}

/** Hard-kills a process without waiting. Used before restart. */
function _killProcess(botId) {
  const entry = botProcesses.get(botId);
  if (!entry || !entry.process) return;
  try {
    entry.process.removeAllListeners();
    entry.process.kill('SIGKILL');
  } catch (_) {}
  entry.process = null;
  entry.status  = 'stopped';
}

// ─── Restart ─────────────────────────────────────────────────
function restartBotInstance(botId) {
  if (!config.bots.find(b => b.id === botId)) return false;

  stopBotInstance(botId, () => {
    setTimeout(() => startBotInstance(botId), 2_000);
  });

  return true;
}

// ─── IPC message router ──────────────────────────────────────
function handleWorkerMessage(botId, msg) {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'WORKER_READY': {
      console.log(`[BotManager] Worker ready: ${botId}`);
      const entry = botProcesses.get(botId);
      if (entry?.process) {
        entry.status = 'ready';
        // Send START — worker will set isRunning=true and begin connecting
        entry.process.send({ type: 'START' });
      }
      break;
    }
    case 'STATUS_UPDATE':
      if (msg.status) updateBotStatus(botId, msg.status);
      break;

    case 'WEBHOOK_EVENT':
      dispatchWebhook(botId, msg.payload);
      break;

    case 'BOT_STOPPED':
      updateBotStatus(botId, { status: 'stopped', connected: false });
      break;

    default:
      console.log(`[BotManager] Unknown message from ${botId}: ${msg.type}`);
  }
}

// ─── Status helpers ──────────────────────────────────────────
function updateBotStatus(botId, updates) {
  const current = botStatuses.get(botId);
  if (!current) {
    botStatuses.set(botId, { id: botId, ...updates, lastUpdate: Date.now() });
    return;
  }
  Object.assign(current, updates, { lastUpdate: Date.now() });
}

// ============================================================
// DISCORD WEBHOOK DISPATCHER
// ============================================================
const WEBHOOK_RETRY_ATTEMPTS = 3;
const WEBHOOK_RETRY_DELAY_MS = 5_000;

function dispatchWebhook(botId, payload) {
  const bc             = config.bots.find(b => b.id === botId);
  const webhookUrl     = bc?.webhookUrl || config.globalSettings?.webhookUrl;

  if (!webhookUrl || webhookUrl.includes('YOUR') || webhookUrl.includes('placeholder')) return;

  sendWebhookWithRetry(webhookUrl, payload, 0);
}

function sendWebhookWithRetry(webhookUrl, payload, attempt) {
  let urlParts;
  try { urlParts = new URL(webhookUrl); } catch (_) {
    console.error('[Webhook] Invalid URL:', webhookUrl);
    return;
  }

  const botName  = payload.botName || 'Unknown Bot';
  const protocol = webhookUrl.startsWith('https') ? https : http;

  const body = JSON.stringify({
    username: botName,
    embeds: [{
      title:       `Event: ${payload.eventType}`,
      description: payload.message || formatEventDescription(payload),
      color:       getEventColor(payload.eventType),
      timestamp:   payload.timestamp,
      fields: [
        { name: 'Server', value: payload.serverIP || 'Unknown', inline: true },
        { name: 'Bot',    value: botName,                        inline: true },
        ...(payload.playerCount != null
          ? [{ name: 'Players Online', value: String(payload.playerCount), inline: true }]
          : [])
      ],
      footer: { text: 'Minecraft Bot Manager' }
    }]
  });

  const options = {
    hostname: urlParts.hostname,
    port:     urlParts.port || (urlParts.protocol === 'https:' ? 443 : 80),
    path:     urlParts.pathname + urlParts.search,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };

  const req = protocol.request(options, res => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.warn(`[Webhook] HTTP ${res.statusCode} for ${payload.eventType}`);
    }
  });

  req.setTimeout(10_000, () => {
    req.destroy();
    console.error(`[Webhook] Timeout for ${payload.eventType}`);
  });

  req.on('error', err => {
    console.error(`[Webhook] Error (attempt ${attempt + 1}): ${err.message}`);
    if (attempt < WEBHOOK_RETRY_ATTEMPTS - 1) {
      setTimeout(() => sendWebhookWithRetry(webhookUrl, payload, attempt + 1), WEBHOOK_RETRY_DELAY_MS);
    } else {
      console.error(`[Webhook] Giving up after ${WEBHOOK_RETRY_ATTEMPTS} attempts`);
    }
  });

  req.write(body);
  req.end();
}

function formatEventDescription(payload) {
  const map = {
    Connected:       'Successfully connected to the server.',
    Disconnected:    `Disconnected. ${payload.reason ? `Reason: ${payload.reason}` : ''}`,
    PlayerOnServer:  `Player(s) detected. ${payload.playerNames ? `Players: ${payload.playerNames.join(', ')}` : ''}`,
    PlayerLeft:      'Server is now empty.',
    BotKicked:       `Kicked. Reason: ${payload.reason || 'Unknown'}`,
    BotReconnecting: `Reconnecting (attempt ${payload.attempt || 1}). Next in ${Math.floor((payload.delay || 0) / 1000)}s.`,
    ErrorOccurred:   `Error: ${payload.error || 'Unknown'}`,
    BotSpawned:      'Bot spawned in the world.',
    ServerFull:      'Server is full.',
    AuthFailed:      'Authentication failed.'
  };
  return map[payload.eventType] || `Event: ${payload.eventType}`;
}

function getEventColor(eventType) {
  const map = {
    Connected:       0x22c55e,
    Disconnected:    0xef4444,
    PlayerOnServer:  0xf59e0b,
    PlayerLeft:      0x22c55e,
    BotKicked:       0xef4444,
    BotReconnecting: 0x3b82f6,
    ErrorOccurred:   0xef4444,
    BotSpawned:      0x22c55e,
    ServerFull:      0xf59e0b,
    AuthFailed:      0xef4444
  };
  return map[eventType] || 0x6b7280;
}

// ============================================================
// SYSTEM MONITORING
// ============================================================
function getSystemInfo() {
  const cpus     = os.cpus();
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();

  let totalTick = 0, totalIdle = 0;
  cpus.forEach(cpu => {
    for (const t in cpu.times) totalTick += cpu.times[t];
    totalIdle += cpu.times.idle;
  });

  const processMem = process.memoryUsage();
  const mb = n => Math.round(n / 1024 / 1024);

  return {
    cpuUsage:      Math.round(((totalTick - totalIdle) / totalTick) * 1000) / 10,
    memory:        { total: mb(totalMem), used: mb(totalMem - freeMem), free: mb(freeMem), percentage: Math.round(((totalMem - freeMem) / totalMem) * 100) },
    processMemory: { heapUsed: mb(processMem.heapUsed), heapTotal: mb(processMem.heapTotal), rss: mb(processMem.rss) },
    uptime:        process.uptime(),
    platform:      os.platform(),
    hostname:      os.hostname(),
    loadAverage:   os.loadavg()
  };
}

// ============================================================
// EXPRESS MIDDLEWARE & ROUTES
// ============================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Unified status
app.get('/api/status', (_req, res) => {
  const botsData = config.bots.map(bc => {
    const status = botStatuses.get(bc.id) || {};
    const entry  = botProcesses.get(bc.id);
    return {
      id:                bc.id,
      name:              bc.name,
      serverIp:          bc.serverIp,
      serverPort:        bc.serverPort,
      enabled:           bc.enabled,
      running:           !!(entry?.process && !entry.process.killed),
      status:            status.status            || 'stopped',
      connected:         status.connected         || false,
      playerCount:       status.playerCount        || 0,
      lastActivity:      status.lastActivity,
      reconnectAttempts: status.reconnectAttempts  || 0,
      uptime:            status.uptime             || 0,
      coordinates:       status.coordinates        || null,
      lastError:         status.lastError          || null
    };
  });

  res.json({ system: getSystemInfo(), bots: botsData, timestamp: new Date().toISOString() });
});

// Bot CRUD
app.get('/api/bots', (_req, res) => res.json(config));

app.get('/api/bots/:id', (req, res) => {
  const bc = config.bots.find(b => b.id === req.params.id);
  bc ? res.json(bc) : res.status(404).json({ error: 'Bot not found' });
});

app.post('/api/bots', (req, res) => {
  const newBot = req.body;
  if (!newBot.name || !newBot.serverIp) {
    return res.status(400).json({ error: 'name and serverIp are required' });
  }

  newBot.id         = `bot-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  newBot.serverPort = newBot.serverPort || 25565;
  newBot.authType   = newBot.authType   || 'offline';
  newBot.enabled    = newBot.enabled    !== false;
  newBot.antiAfk    = newBot.antiAfk    || { enabled: true, sneak: true, swingArm: true };
  newBot.movement   = newBot.movement   || { enabled: true, circleWalk: { enabled: true, radius: 5 } };
  newBot.playerGuard = newBot.playerGuard || { enabled: true, evictOnPlayer: true };

  config.bots.push(newBot);

  if (!saveConfig(config)) {
    config = loadConfig();
    return res.status(500).json({ error: 'Failed to save config' });
  }

  botStatuses.set(newBot.id, createInitialStatus(newBot));
  res.status(201).json(newBot);
});

app.put('/api/bots/:id', (req, res) => {
  const idx = config.bots.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });

  const updates = { ...req.body };
  delete updates.id;

  config.bots[idx] = { ...config.bots[idx], ...updates };

  if (!saveConfig(config)) {
    config = loadConfig();
    return res.status(500).json({ error: 'Failed to save config' });
  }

  // Notify the running worker of config change
  const entry = botProcesses.get(req.params.id);
  if (entry?.process) {
    try { entry.process.send({ type: 'UPDATE_CONFIG', config: config.bots[idx], restart: true }); } catch (_) {}
  }

  res.json(config.bots[idx]);
});

app.delete('/api/bots/:id', (req, res) => {
  const botId = req.params.id;
  stopBotInstance(botId);

  const idx = config.bots.findIndex(b => b.id === botId);
  if (idx === -1) return res.status(404).json({ error: 'Bot not found' });

  config.bots.splice(idx, 1);
  botStatuses.delete(botId);
  botProcesses.delete(botId);

  if (!saveConfig(config)) {
    config = loadConfig();
    return res.status(500).json({ error: 'Failed to save config' });
  }

  res.json({ success: true });
});

// Bot control
app.post('/api/bots/:id/start', (req, res) => {
  const botId = req.params.id;
  if (!config.bots.find(b => b.id === botId)) return res.status(404).json({ error: 'Bot not found' });
  startBotInstance(botId)
    ? res.json({ success: true, message: 'Bot starting' })
    : res.status(500).json({ error: 'Failed to start bot' });
});

app.post('/api/bots/:id/stop', (req, res) => {
  stopBotInstance(req.params.id, () => res.json({ success: true, message: 'Bot stopped' }));
});

app.post('/api/bots/:id/restart', (req, res) => {
  const botId = req.params.id;
  if (!config.bots.find(b => b.id === botId)) return res.status(404).json({ error: 'Bot not found' });
  restartBotInstance(botId);
  res.json({ success: true, message: 'Bot restarting' });
});

// Settings
app.put('/api/settings', (req, res) => {
  config.globalSettings = { ...config.globalSettings, ...req.body };
  if (!saveConfig(config)) {
    config = loadConfig();
    return res.status(500).json({ error: 'Failed to save settings' });
  }
  res.json(config.globalSettings);
});

// Health / keepalive
app.get('/health', (_req, res) => res.json({
  status:  'running',
  uptime:  process.uptime(),
  bots:    config.bots.length,
  running: [...botProcesses.values()].filter(e => e.process && !e.process.killed).length
}));

app.get('/ping', (_req, res) => res.send('pong'));

// ============================================================
// SELF-PING (Render keepalive)
// ============================================================
(function startSelfPing() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) { console.log('[KeepAlive] Disabled — no RENDER_EXTERNAL_URL'); return; }

  const proto = url.startsWith('https') ? https : http;
  setInterval(() => {
    proto.get(`${url}/ping`, () => {}).on('error', err => {
      console.warn('[KeepAlive] Ping failed:', err.message);
    });
  }, 10 * 60 * 1_000);

  console.log('[KeepAlive] Self-ping started');
}());

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
function shutdown(signal) {
  console.log(`[System] ${signal} — shutting down`);
  botProcesses.forEach((_, botId) => stopBotInstance(botId));
  setTimeout(() => process.exit(0), 6_000); // allow workers to exit
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ============================================================
// START SERVER
// ============================================================
// Bots do NOT auto-connect on server start.
// Each bot must be started explicitly via the dashboard or API.
// ============================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  Minecraft Bot Manager v4.0');
  console.log(`  Dashboard: http://localhost:${server.address().port}`);
  console.log('='.repeat(50));
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Bots configured: ${config.bots.length} (none auto-started)`);
  console.log('='.repeat(50));
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`Port ${PORT} in use — retrying on ${PORT + 1}`);
    server.listen(PORT + 1, '0.0.0.0');
  } else {
    console.error('[Server] Fatal error:', err.message);
  }
});
