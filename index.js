'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================================
// CONFIGURATION MANAGEMENT
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'bots.json');

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[Config] Failed to load config:', err.message);
    return { globalSettings: {}, bots: [] };
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Config] Failed to save config:', err.message);
    return false;
  }
}

// Initialize config
let config = loadConfig();

// ============================================================
// BOT PROCESS MANAGER
// ============================================================
const botProcesses = new Map(); // botId -> { process, status, lastUpdate }
const botStatuses = new Map();   // botId -> status object

// Initialize statuses for all configured bots
config.bots.forEach(botConfig => {
  botStatuses.set(botConfig.id, {
    id: botConfig.id,
    name: botConfig.name,
    status: 'stopped',
    connected: false,
    playerCount: 0,
    lastActivity: Date.now(),
    reconnectAttempts: 0,
    uptime: 0,
    coordinates: null,
    errors: [],
    lastError: null
  });
});

function startBotInstance(botId) {
  const botConfig = config.bots.find(b => b.id === botId);
  if (!botConfig) {
    console.error(`[BotManager] Bot config not found: ${botId}`);
    return false;
  }

  // Stop existing process if running
  stopBotInstance(botId);

  console.log(`[BotManager] Starting bot: ${botConfig.name}`);

  const workerPath = path.join(__dirname, 'bot-worker.js');
  const child = spawn('node', [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      BOT_CONFIG: JSON.stringify(botConfig)
    }
  });

  const processInfo = {
    process: child,
    status: 'starting',
    lastUpdate: Date.now(),
    startTime: Date.now()
  };

  botProcesses.set(botId, processInfo);

  // Handle IPC messages from worker
  child.on('message', (msg) => {
    handleWorkerMessage(botId, msg);
  });

  // Handle stdout
  child.stdout.on('data', (data) => {
    console.log(`[${botConfig.name}] ${data.toString().trim()}`);
  });

  // Handle stderr
  child.stderr.on('data', (data) => {
    console.error(`[${botConfig.name}] ERROR: ${data.toString().trim()}`);
  });

  // Handle process exit
  child.on('exit', (code, signal) => {
    console.log(`[${botConfig.name}] Process exited with code ${code}, signal ${signal}`);

    const pInfo = botProcesses.get(botId);
    if (pInfo) {
      pInfo.status = 'stopped';
      pInfo.process = null;
    }

    updateBotStatus(botId, {
      status: 'stopped',
      connected: false,
      lastError: code !== 0 ? `Process exited with code ${code}` : null
    });
  });

  // Handle process error
  child.on('error', (err) => {
    console.error(`[${botConfig.name}] Process error:`, err.message);
    updateBotStatus(botId, {
      status: 'error',
      connected: false,
      lastError: err.message
    });
  });

  return true;
}

function stopBotInstance(botId, callback) {
  const pInfo = botProcesses.get(botId);

  if (!pInfo || !pInfo.process) {
    updateBotStatus(botId, { status: 'stopped', connected: false });
    if (callback) callback();
    return true;
  }

  console.log(`[BotManager] Stopping bot: ${botId}`);

  pInfo.status = 'stopping';
  updateBotStatus(botId, { status: 'stopping', connected: false });

  const proc = pInfo.process;
  let callbackCalled = false;

  const doCallback = () => {
    if (callbackCalled) return;
    callbackCalled = true;
    pInfo.status = 'stopped';
    pInfo.process = null;
    updateBotStatus(botId, { status: 'stopped', connected: false });
    if (callback) callback();
  };

  // Listen for process exit
  const onExit = () => {
    proc.removeListener('exit', onExit);
    doCallback();
  };
  proc.on('exit', onExit);

  // Send STOP message via IPC
  try {
    proc.send({ type: 'STOP' });
  } catch (e) {
    // IPC failed, force kill
  }

  // Force kill after timeout (3s for graceful, then SIGTERM/SIGKILL)
  const gracefulTimeout = setTimeout(() => {
    if (!proc.killed) {
      console.log(`[BotManager] Force killing bot: ${botId}`);
      proc.kill('SIGTERM');

      // Final fallback to SIGKILL after 5s
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
        doCallback();
      }, 5000);
    } else {
      doCallback();
    }
  }, 3000);

  // Clear timeout if process exits early
  proc.on('exit', () => {
    clearTimeout(gracefulTimeout);
  });

  return true;
}

function handleWorkerMessage(botId, msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'WORKER_READY':
      console.log(`[BotManager] Worker ready: ${botId}`);
      const pInfo = botProcesses.get(botId);
      if (pInfo) {
        pInfo.status = 'ready';
        // Send START command
        pInfo.process.send({ type: 'START' });
      }
      break;

    case 'STATUS_UPDATE':
      if (msg.status) {
        updateBotStatus(botId, msg.status);
      }
      break;

    case 'WEBHOOK_EVENT':
      dispatchWebhook(botId, msg.payload);
      break;

    case 'BOT_STOPPED':
      updateBotStatus(botId, { status: 'stopped', connected: false });
      break;

    default:
      console.log(`[BotManager] Unknown message from ${botId}:`, msg.type);
  }
}

function updateBotStatus(botId, updates) {
  const status = botStatuses.get(botId);
  if (!status) {
    botStatuses.set(botId, { id: botId, ...updates });
    return;
  }

  Object.assign(status, updates);
  status.lastUpdate = Date.now();
}

function restartBotInstance(botId) {
  const botConfig = config.bots.find(b => b.id === botId);
  if (!botConfig) return false;

  stopBotInstance(botId, () => {
    setTimeout(() => startBotInstance(botId), 2000);
  });

  return true;
}

// ============================================================
// DISCORD WEBHOOK DISPATCHER
// ============================================================
const WEBHOOK_RETRY_ATTEMPTS = 3;
const WEBHOOK_RETRY_DELAY = 5000;
const pendingWebhooks = [];

// Non-blocking webhook dispatch with retry logic
function dispatchWebhook(botId, payload) {
  const botConfig = config.bots.find(b => b.id === botId);
  const globalSettings = config.globalSettings;

  // Determine webhook URL (instance takes precedence over global)
  let webhookUrl = botConfig?.webhookUrl || globalSettings.webhookUrl;

  if (!webhookUrl || webhookUrl.includes('YOUR') || webhookUrl.includes('placeholder')) {
    return; // No valid webhook configured
  }

  // Fire-and-forget: send asynchronously without awaiting
  sendWebhookWithRetry(webhookUrl, payload, 0);
}

function sendWebhookWithRetry(webhookUrl, payload, attempt) {
  const protocol = webhookUrl.startsWith('https') ? https : http;
  let urlParts;

  try {
    urlParts = new URL(webhookUrl);
  } catch (e) {
    console.error('[Webhook] Invalid URL:', webhookUrl);
    return;
  }

  const botConfig = config.bots.find(b => b.id === payload.botId) || {};
  const botName = payload.botName || botConfig.name || 'Unknown Bot';

  const embedData = {
    username: botName,
    embeds: [{
      title: `Event: ${payload.eventType}`,
      description: payload.message || formatEventDescription(payload),
      color: getEventColor(payload.eventType),
      timestamp: payload.timestamp,
      fields: [
        { name: 'Server', value: payload.serverIP || 'Unknown', inline: true },
        { name: 'Bot', value: botName, inline: true }
      ],
      footer: { text: 'Minecraft Bot Manager' }
    }]
  };

  // Add player count if available
  if (payload.playerCount !== null && payload.playerCount !== undefined) {
    embedData.embeds[0].fields.push({
      name: 'Players Online',
      value: String(payload.playerCount),
      inline: true
    });
  }

  const postData = JSON.stringify(embedData);

  const options = {
    hostname: urlParts.hostname,
    port: urlParts.port || (urlParts.protocol === 'https:' ? 443 : 80),
    path: urlParts.pathname + urlParts.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData, 'utf8')
    }
  };

  const req = protocol.request(options, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      // Success
    } else {
      console.log(`[Webhook] HTTP ${res.statusCode} for ${payload.eventType}`);
    }
  });

  req.on('error', (err) => {
    console.error(`[Webhook] Error (${payload.eventType}, ${botName}, attempt ${attempt + 1}): ${err.message}`);

    // Retry logic
    if (attempt < WEBHOOK_RETRY_ATTEMPTS - 1) {
      setTimeout(() => {
        sendWebhookWithRetry(webhookUrl, payload, attempt + 1);
      }, WEBHOOK_RETRY_DELAY);
    } else {
      console.error(`[Webhook] Failed after ${WEBHOOK_RETRY_ATTEMPTS} attempts: ${payload.eventType}`);
    }
  });

  req.setTimeout(10000, () => {
    req.destroy();
    console.error(`[Webhook] Timeout for ${payload.eventType}`);
  });

  req.write(postData);
  req.end();
}

function formatEventDescription(payload) {
  const descriptions = {
    'Connected': `Successfully connected to the server.`,
    'Disconnected': `Disconnected from the server. ${payload.reason ? `Reason: ${payload.reason}` : ''}`,
    'PlayerOnServer': `Player(s) detected on server. ${payload.playerNames ? `Players: ${payload.playerNames.join(', ')}` : ''}`,
    'PlayerLeft': `Server is now empty.`,
    'BotKicked': `Bot was kicked from the server. Reason: ${payload.reason || 'Unknown'}`,
    'BotReconnecting': `Attempting to reconnect (attempt ${payload.attempt || 1}). Next retry in ${Math.floor((payload.delay || 0) / 1000)}s.`,
    'ErrorOccurred': `An error occurred: ${payload.error || 'Unknown error'}`,
    'BotSpawned': `Bot has spawned in the world.`,
    'ServerFull': `Bot was rejected - server is full.`,
    'AuthFailed': `Authentication failed. Check bot credentials.`
  };

  return descriptions[payload.eventType] || `Event: ${payload.eventType}`;
}

function getEventColor(eventType) {
  const colors = {
    'Connected': 0x22c55e,      // Green
    'Disconnected': 0xef4444,   // Red
    'PlayerOnServer': 0xf59e0b, // Amber
    'PlayerLeft': 0x22c55e,     // Green
    'BotKicked': 0xef4444,      // Red
    'BotReconnecting': 0x3b82f6, // Blue
    'ErrorOccurred': 0xef4444,  // Red
    'BotSpawned': 0x22c55e,     // Green
    'ServerFull': 0xf59e0b,     // Amber
    'AuthFailed': 0xef4444      // Red
  };

  return colors[eventType] || 0x6b7280; // Default gray
}

// ============================================================
// SYSTEM MONITORING (Node.js built-ins only)
// ============================================================
function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Calculate CPU usage (average across all cores)
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  const totalUsage = totalTick - totalIdle;
  const cpuUsage = (totalUsage / totalTick) * 100;

  // Process memory
  const processMem = process.memoryUsage();

  return {
    cpuUsage: Math.round(cpuUsage * 10) / 10,
    memory: {
      total: Math.round(totalMem / 1024 / 1024),
      used: Math.round(usedMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      percentage: Math.round((usedMem / totalMem) * 100)
    },
    processMemory: {
      heapUsed: Math.round(processMem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(processMem.heapTotal / 1024 / 1024),
      rss: Math.round(processMem.rss / 1024 / 1024)
    },
    uptime: process.uptime(),
    platform: os.platform(),
    hostname: os.hostname(),
    loadAverage: os.loadavg()
  };
}

// ============================================================
// EXPRESS ROUTES
// ============================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Main dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// UNIFIED STATUS ENDPOINT - System info + all bot statuses
app.get('/api/status', (req, res) => {
  const systemInfo = getSystemInfo();

  const botsData = [];
  config.bots.forEach(botConfig => {
    const status = botStatuses.get(botConfig.id) || {};
    const pInfo = botProcesses.get(botConfig.id);

    botsData.push({
      id: botConfig.id,
      name: botConfig.name,
      serverIp: botConfig.serverIp,
      serverPort: botConfig.serverPort,
      enabled: botConfig.enabled,
      running: !!(pInfo && pInfo.process && !pInfo.process.killed),
      status: status.status || 'stopped',
      connected: status.connected || false,
      playerCount: status.playerCount || 0,
      lastActivity: status.lastActivity,
      reconnectAttempts: status.reconnectAttempts || 0,
      uptime: status.uptime || 0,
      coordinates: status.coordinates,
      lastError: status.lastError
    });
  });

  res.json({
    system: systemInfo,
    bots: botsData,
    timestamp: new Date().toISOString()
  });
});

// Get all bot configurations
app.get('/api/bots', (req, res) => {
  res.json(config);
});

// Get single bot configuration
app.get('/api/bots/:id', (req, res) => {
  const botConfig = config.bots.find(b => b.id === req.params.id);
  if (!botConfig) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  res.json(botConfig);
});

// Add new bot configuration
app.post('/api/bots', (req, res) => {
  const newBot = req.body;

  // Validate required fields
  if (!newBot.name || !newBot.serverIp) {
    return res.status(400).json({ error: 'Name and server IP are required' });
  }

  // Generate unique ID
  newBot.id = 'bot-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

  // Set defaults
  newBot.serverPort = newBot.serverPort || 25565;
  newBot.authType = newBot.authType || 'offline';
  newBot.enabled = newBot.enabled !== false;

  // Ensure nested objects exist
  newBot.antiAfk = newBot.antiAfk || { enabled: true, sneak: true, swingArm: true };
  newBot.movement = newBot.movement || { enabled: true, circleWalk: { enabled: true, radius: 5 } };
  newBot.playerGuard = newBot.playerGuard || { enabled: true, evictOnPlayer: true };

  config.bots.push(newBot);

  if (saveConfig(config)) {
    // Initialize status
    botStatuses.set(newBot.id, {
      id: newBot.id,
      name: newBot.name,
      status: 'stopped',
      connected: false,
      playerCount: 0,
      lastActivity: Date.now()
    });

    res.status(201).json(newBot);
  } else {
    config = loadConfig(); // Reload on save failure
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Update bot configuration
app.put('/api/bots/:id', (req, res) => {
  const botId = req.params.id;
  const updates = req.body;

  const index = config.bots.findIndex(b => b.id === botId);
  if (index === -1) {
    return res.status(404).json({ error: 'Bot not found' });
  }

  // Don't allow ID changes
  delete updates.id;

  // Merge updates
  const existingBot = config.bots[index];
  config.bots[index] = { ...existingBot, ...updates };

  if (saveConfig(config)) {
    // Notify running process of config change
    const pInfo = botProcesses.get(botId);
    if (pInfo && pInfo.process) {
      pInfo.process.send({
        type: 'UPDATE_CONFIG',
        config: config.bots[index],
        restart: true // Request restart if running
      });
    }

    res.json(config.bots[index]);
  } else {
    config = loadConfig();
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Delete bot configuration
app.delete('/api/bots/:id', (req, res) => {
  const botId = req.params.id;

  // Stop bot if running
  stopBotInstance(botId);

  const index = config.bots.findIndex(b => b.id === botId);
  if (index === -1) {
    return res.status(404).json({ error: 'Bot not found' });
  }

  config.bots.splice(index, 1);
  botStatuses.delete(botId);
  botProcesses.delete(botId);

  if (saveConfig(config)) {
    res.json({ success: true, message: 'Bot deleted' });
  } else {
    config = loadConfig();
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Start bot instance
app.post('/api/bots/:id/start', (req, res) => {
  const botId = req.params.id;

  if (!config.bots.find(b => b.id === botId)) {
    return res.status(404).json({ error: 'Bot not found' });
  }

  const success = startBotInstance(botId);

  if (success) {
    res.json({ success: true, message: 'Bot starting' });
  } else {
    res.status(500).json({ error: 'Failed to start bot' });
  }
});

// Stop bot instance
app.post('/api/bots/:id/stop', (req, res) => {
  const botId = req.params.id;

  stopBotInstance(botId, () => {
    res.json({ success: true, message: 'Bot stopped' });
  });
});

// Restart bot instance
app.post('/api/bots/:id/restart', (req, res) => {
  const botId = req.params.id;

  if (!config.bots.find(b => b.id === botId)) {
    return res.status(404).json({ error: 'Bot not found' });
  }

  restartBotInstance(botId);
  res.json({ success: true, message: 'Bot restarting' });
});

// Update global settings
app.put('/api/settings', (req, res) => {
  const updates = req.body;

  config.globalSettings = { ...config.globalSettings, ...updates };

  if (saveConfig(config)) {
    res.json(config.globalSettings);
  } else {
    config = loadConfig();
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    bots: config.bots.length,
    running: Array.from(botProcesses.values()).filter(p => p.process && !p.process.killed).length
  });
});

// Ping endpoint for keepalive
app.get('/ping', (req, res) => {
  res.send('pong');
});

// ============================================================
// SELF-PING FOR RENDER
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    console.log('[KeepAlive] No RENDER_EXTERNAL_URL - self-ping disabled');
    return;
  }

  setInterval(() => {
    const protocol = renderUrl.startsWith('https') ? https : http;
    protocol.get(`${renderUrl}/ping`, () => {})
      .on('error', (err) => {
        console.log(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);

  console.log('[KeepAlive] Self-ping started');
}

startSelfPing();

// ============================================================
// CLEANUP ON EXIT
// ============================================================
process.on('SIGTERM', () => {
  console.log('[System] SIGTERM - shutting down gracefully');

  // Stop all bot processes
  botProcesses.forEach((pInfo, botId) => {
    stopBotInstance(botId);
  });

  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[System] SIGINT - shutting down');

  botProcesses.forEach((pInfo, botId) => {
    stopBotInstance(botId);
  });

  process.exit(0);
});

// ============================================================
// NO AUTO-START ON LAUNCH
// Bots must be manually started via the dashboard or API
// The 'enabled' flag indicates the bot config is active/available,
// NOT that it should auto-connect on app startup
// ============================================================

// ============================================================
// START SERVER
// ============================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  Minecraft Bot Manager v3.0');
  console.log('  Dashboard: http://localhost:' + server.address().port);
  console.log('='.repeat(50));
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Bots configured: ${config.bots.length}`);
  console.log('='.repeat(50));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const fallbackPort = PORT + 1;
    console.log(`Port ${PORT} in use - trying ${fallbackPort}`);
    server.listen(fallbackPort, '0.0.0.0');
  } else {
    console.error('Server error:', err.message);
  }
});
