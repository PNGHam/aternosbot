
'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const mcProtocol = require('minecraft-protocol');

// ============================================================
// CONFIGURATION & STATE
// ============================================================
const config = JSON.parse(process.env.BOT_CONFIG || '{}');
const botId = config.id || 'unknown';

// Single Source of Truth for operation
let isRunning = false;

// Resources
let bot = null;
let intervals = []; // Stores all interval IDs
let timeouts = [];  // Stores all timeout IDs

// ============================================================
// IPC HANDLERS (The Control Interface)
// ============================================================
process.on('message', (msg) => {
  if (!msg) return;

  switch (msg.type) {
    case 'START':
      cmdStart();
      break;
    case 'STOP':
      cmdStop();
      break;
    case 'UPDATE_CONFIG':
      Object.assign(config, msg.config);
      // If running, we assume the user might want a restart, 
      // but strict state control implies we just update config for next run
      // or active modules. We won't force reconnect here to keep logic clean.
      break;
  }
});

function cmdStart() {
  if (isRunning) {
    console.log(`[${botId}] Start ignored: Already running`);
    return;
  }

  console.log(`[${botId}] Received START command`);
  isRunning = true;
  runEntrySequence();
}

function cmdStop() {
  if (!isRunning) {
    console.log(`[${botId}] Stop ignored: Already stopped`);
    return;
  }

  console.log(`[${botId}] Received STOP command`);
  
  // 1. Set flag immediately. This gates all subsequent logic.
  isRunning = false;

  // 2. Clean up resources
  performHardStop();
}

// ============================================================
// LIFECYCLE MANAGEMENT
// ============================================================

function runEntrySequence() {
  // Gatekeeper: If stopped before we could run, abort.
  if (!isRunning) return;

  // Cleanup previous artifacts just in case
  performHardStop();

  if (config.playerGuard?.enabled) {
    startPlayerGuard();
  } else {
    connectToServer();
  }
}

function performHardStop() {
  // Clear all timers
  intervals.forEach(clearInterval);
  timeouts.forEach(clearTimeout);
  intervals = [];
  timeouts = [];

  // Kill bot instance
  if (bot) {
    try {
      // Remove listeners to prevent 'end' or 'error' from triggering logic
      bot.removeAllListeners();
      bot.end();
    } catch (err) {
      // Ignore cleanup errors
    }
    bot = null;
  }

  sendStatusUpdate('stopped');
}

// ============================================================
// PLAYER GUARD (Pre-connection logic)
// ============================================================
function startPlayerGuard() {
  console.log(`[${botId}] Starting Player Guard`);

  const doPoll = () => {
    if (!isRunning) return;

    mcProtocol.ping({ host: config.serverIp, port: config.serverPort }, (err, response) => {
      if (!isRunning) return;

      if (err) {
        console.log(`[${botId}] Ping failed (server offline/blocking), connecting anyway.`);
        connectToServer();
        return;
      }

      const players = response?.players?.online || 0;
      sendStatusUpdate('polling', { playerCount: players });

      if (players === 0) {
        console.log(`[${botId}] Server empty. Connecting.`);
        connectToServer();
      } else {
        console.log(`[${botId}] Server occupied (${players}). Waiting...`);
        // Schedule next poll
        scheduleNextPoll();
      }
    });
  };

  doPoll();
}

function scheduleNextPoll() {
  if (!isRunning) return;
  const id = setTimeout(() => {
    // Remove self from timeout tracker after execution
    timeouts = timeouts.filter(t => t !== id); 
    startPlayerGuard(); // Re-run the check
  }, config.playerGuard?.pollInterval || 30000);
  timeouts.push(id);
}

// ============================================================
// CONNECTION LOGIC
// ============================================================
function connectToServer() {
  if (!isRunning) return;

  console.log(`[${botId}] Connecting to ${config.serverIp}:${config.serverPort}...`);
  sendStatusUpdate('connecting');

  try {
    bot = mineflayer.createBot({
      host: config.serverIp,
      port: config.serverPort || 25565,
      username: config.name,
      password: config.password,
      auth: config.authType || 'offline',
      version: config.serverVersion || false
    });

    bot.loadPlugin(pathfinder);

    // Handle Success
    bot.once('spawn', () => {
      if (!isRunning) {
        // Race condition: Stop clicked while connecting.
        performHardStop();
        return;
      }
      
      console.log(`[${botId}] Spawned successfully.`);
      onSpawn();
    });

    // Handle Disconnection
    bot.on('end', () => {
      console.log(`[${botId}] Connection ended.`);
      
      // Only reconnect if we are still supposed to be running
      if (isRunning) {
        scheduleReconnect();
      } else {
        performHardStop();
      }
    });

    // Handle Kick
    bot.on('kicked', (reason) => {
      console.log(`[${botId}] Kicked: ${reason}`);
      // If kicked, we treat it as an 'end' event for reconnection purposes
      // The 'end' event will fire next, triggering the logic above.
    });

    // Handle Errors
    bot.on('error', (err) => {
      console.error(`[${botId}] Bot Error: ${err.message}`);
      // Errors often precede 'end'. We let 'end' handle the reconnection logic.
    });

  } catch (err) {
    console.error(`[${botId}] Critical connection error: ${err.message}`);
    if (isRunning) scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!isRunning) return;

  const delay = 5000; // Simple fixed delay for robustness, can be exponential
  console.log(`[${botId}] Reconnecting in ${delay / 1000}s...`);
  sendStatusUpdate('reconnecting');

  const id = setTimeout(() => {
    timeouts = timeouts.filter(t => t !== id);
    connectToServer();
  }, delay);
  
  timeouts.push(id);
}

// ============================================================
// IN-GAME LOGIC (Modules)
// ============================================================
function onSpawn() {
  sendStatusUpdate('online');
  
  // Setup modules
  setupAntiAfk();
  setupMovement();
  
  // Notify Master
  process.send({ type: 'WEBHOOK_EVENT', botId, payload: { eventType: 'Connected', message: 'Bot connected successfully' } });
}

function setupAntiAfk() {
  if (!config.antiAfk?.enabled) return;

  const intervalId = setInterval(() => {
    if (!isRunning || !bot) return;
    
    if (config.antiAfk.swingArm) bot.swingArm();
    if (config.antiAfk.sneak) bot.setControlState('sneak', true);
  }, 10000);
  
  intervals.push(intervalId);
}

function setupMovement() {
  if (!config.movement?.enabled || !bot) return;

  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMove);

  if (config.movement.circleWalk?.enabled) {
    let angle = 0;
    const radius = config.movement.circleWalk.radius || 5;
    
    const walkInterval = setInterval(() => {
      if (!isRunning || !bot) return;
      
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
    }, 3000);

    intervals.push(walkInterval);
  }
}

// ============================================================
// UTILITIES
// ============================================================
function sendStatusUpdate(status, extra = {}) {
  process.send({
    type: 'STATUS_UPDATE',
    botId: botId,
    status: {
      status: status,
      connected: status === 'online',
      ...extra
    }
  });
}

// Notify parent we are ready to accept commands
process.send({ type: 'WORKER_READY', botId });
