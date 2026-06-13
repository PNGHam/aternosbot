'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;

// Bot configuration passed via environment variables (JSON stringified)
const botConfig = JSON.parse(process.env.BOT_CONFIG || '{}');
const botId = botConfig.id || 'unknown';

// State tracking
let bot = null;
let botState = {
  connected: false,
  playerCount: 0,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  coordinates: null,
  status: 'idle',
  errors: []
};

// Intervals and timeouts
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let playerGuardIntervalId = null;
let occupiedNotificationSent = false;
let disconnectedByPlayerDetection = false;
let spawnHandled = false;
let stopRequested = false;
let statusIntervalId = null;

// Discord rate limiting
let lastWebhookSend = 0;
const WEBHOOK_RATE_LIMIT_MS = 5000;

// ============================================================
// IPC MESSAGE HANDLING
// ============================================================
process.on('message', (msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'START':
      stopRequested = false;
      startPlayerGuardPolling();
      break;
    case 'STOP':
      stopBot();
      break;
    case 'GET_STATUS':
      sendStatus();
      break;
    case 'UPDATE_CONFIG':
      Object.assign(botConfig, msg.config);
      if (msg.restart && botState.connected) {
        stopBot(() => {
          stopRequested = false;
          setTimeout(() => startPlayerGuardPolling(), 2000);
        });
      }
      break;
    default:
      console.log(`[${botId}] Unknown IPC message type: ${msg.type}`);
  }
});

function sendStatus() {
  process.send({
    type: 'STATUS_UPDATE',
    botId: botId,
    status: {
      connected: botState.connected,
      playerCount: botState.playerCount,
      status: botState.status,
      lastActivity: botState.lastActivity,
      reconnectAttempts: botState.reconnectAttempts,
      uptime: Math.floor((Date.now() - botState.startTime) / 1000),
      coordinates: botState.coordinates,
      errors: botState.errors.slice(-10)
    }
  });
}

function dispatchWebhookEvent(eventType, additionalData = {}) {
  const payload = {
    eventType,
    timestamp: new Date().toISOString(),
    serverIP: `${botConfig.serverIp}:${botConfig.serverPort}`,
    botName: botConfig.name,
    ...additionalData
  };

  process.send({
    type: 'WEBHOOK_EVENT',
    botId: botId,
    payload
  });
}

// ============================================================
// STOP-STATE GUARD
// Returns true and logs a warning if the bot is stopped.
// Use this at the top of any function that must not run while stopped.
// ============================================================
function isStopped(context) {
  if (stopRequested) {
    console.log(`[${botId}] Skipping ${context} — bot is stopped`);
    return true;
  }
  return false;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function clearBotTimeouts() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
  if (statusIntervalId) {
    clearInterval(statusIntervalId);
    statusIntervalId = null;
  }
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  const baseDelay = botConfig.autoReconnectDelay || botConfig.autoReconnect?.delay || 3000;
  const maxDelay = botConfig.maxReconnectDelay || 30000;
  const attempts = botState.reconnectAttempts;

  const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

// ============================================================
// PLAYER GUARD - Pre-join polling
// ============================================================
const PLAYER_GUARD_POLL_INTERVAL = botConfig.playerGuard?.pollInterval || 30000;

function startPlayerGuardPolling() {
  if (isStopped('startPlayerGuardPolling')) return;

  if (playerGuardIntervalId) {
    console.log(`[${botId}] Player guard polling already active`);
    return;
  }

  isReconnecting = false;
  botState.status = 'polling';
  console.log(`[${botId}] Starting player guard polling`);

  const mc = require('minecraft-protocol');

  function checkAndJoin() {
    if (isStopped('checkAndJoin')) {
      stopPlayerGuardPolling();
      return;
    }

    if (!botConfig.playerGuard?.enabled) {
      stopPlayerGuardPolling();
      occupiedNotificationSent = false;
      createBot();
      return;
    }

    mc.ping(
      { host: botConfig.serverIp, port: botConfig.serverPort },
      (err, response) => {
        if (isStopped('ping callback')) {
          stopPlayerGuardPolling();
          return;
        }

        if (err) {
          console.log(`[${botId}] Ping failed — proceeding to connect`);
          stopPlayerGuardPolling();
          occupiedNotificationSent = false;
          createBot();
          return;
        }

        const onlinePlayers = response?.players?.online || 0;
        botState.playerCount = onlinePlayers;

        if (onlinePlayers === 0) {
          console.log(`[${botId}] Server is empty — joining`);
          stopPlayerGuardPolling();
          occupiedNotificationSent = false;
          createBot();
        } else {
          if (!occupiedNotificationSent) {
            console.log(`[${botId}] Server occupied (${onlinePlayers} player(s)) — waiting`);
            occupiedNotificationSent = true;
            dispatchWebhookEvent('PlayerOnServer', {
              playerCount: onlinePlayers,
              message: `Server occupied with ${onlinePlayers} player(s). Bot waiting.`
            });
          }
        }
      }
    );
  }

  checkAndJoin();
  playerGuardIntervalId = setInterval(checkAndJoin, PLAYER_GUARD_POLL_INTERVAL);
}

function stopPlayerGuardPolling() {
  if (playerGuardIntervalId) {
    clearInterval(playerGuardIntervalId);
    playerGuardIntervalId = null;
    console.log(`[${botId}] Player guard polling stopped`);
  }
}

// ============================================================
// BOT CREATION AND LIFECYCLE
// ============================================================
function createBot() {
  if (isStopped('createBot')) return;

  if (isReconnecting) {
    console.log(`[${botId}] Already reconnecting — skipping createBot`);
    return;
  }

  // Cleanup previous instance
  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {}
    bot = null;
  }

  console.log(`[${botId}] Connecting to ${botConfig.serverIp}:${botConfig.serverPort}`);
  botState.status = 'connecting';
  spawnHandled = false;

  try {
    const botVersion = botConfig.serverVersion?.trim() || false;

    bot = mineflayer.createBot({
      username: botConfig.name,
      password: botConfig.password || undefined,
      auth: botConfig.authType || 'offline',
      host: botConfig.serverIp,
      port: botConfig.serverPort,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 600000
    });

    bot.loadPlugin(pathfinder);

    // Connection timeout
    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (isStopped('connection timeout')) {
        try { bot.removeAllListeners(); bot.end(); } catch (e) {}
        bot = null;
        botState.status = 'stopped';
        return;
      }

      if (!botState.connected) {
        console.log(`[${botId}] Connection timed out — no spawn received`);
        dispatchWebhookEvent('ErrorOccurred', {
          error: 'Connection timeout - no spawn received',
          playerCount: null
        });
        try { bot.removeAllListeners(); bot.end(); } catch (e) {}
        bot = null;
        scheduleReconnect('timeout');
      }
    }, 150000);

    // Spawn handler
    bot.once('spawn', () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.status = 'connected';
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      botState.startTime = Date.now();
      isReconnecting = false;

      console.log(`[${botId}] Spawned successfully (version: ${bot.version})`);
      dispatchWebhookEvent('BotSpawned', { playerCount: 0, version: bot.version });

      if (botConfig.tryCreative) {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat('/gamemode spectator');
        }, 10000);
      }

      initializeModules();
      checkExistingPlayers();

      bot.on('playerJoined', (player) => handlePlayerJoined(player));
    });

    // Kicked handler
    bot.on('kicked', (reason) => {
      if (isStopped('kicked event')) return;

      const kickReason = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
      console.log(`[${botId}] Kicked: ${kickReason}`);

      botState.connected = false;
      botState.status = 'kicked';
      botState.errors.push({ type: 'kicked', reason: kickReason, time: Date.now() });
      clearAllIntervals();

      const reasonStr = kickReason.toLowerCase();
      const isFull = reasonStr.includes('full') || reasonStr.includes('capacity');
      const isAuthFail = reasonStr.includes('auth') || reasonStr.includes('login') || reasonStr.includes('password');
      const isThrottle = reasonStr.includes('throttl') || reasonStr.includes('wait before') || reasonStr.includes('too fast');

      if (isFull) {
        dispatchWebhookEvent('ServerFull', { playerCount: null });
      } else if (isAuthFail) {
        dispatchWebhookEvent('AuthFailed', { playerCount: null });
      } else {
        dispatchWebhookEvent('BotKicked', { reason: kickReason, playerCount: null });
      }

      if (isThrottle) {
        botState.reconnectAttempts += 2;
      }
    });

    // End handler
    bot.on('end', (reason) => {
      if (isStopped('end event')) {
        botState.connected = false;
        botState.status = 'stopped';
        return;
      }

      console.log(`[${botId}] Disconnected: ${reason || 'Unknown'}`);
      botState.connected = false;
      botState.status = 'disconnected';
      clearAllIntervals();
      spawnHandled = false;

      dispatchWebhookEvent('Disconnected', {
        reason: reason || 'Unknown',
        playerCount: botState.playerCount
      });

      if (disconnectedByPlayerDetection) {
        disconnectedByPlayerDetection = false;
        occupiedNotificationSent = false;
        isReconnecting = false;
        startPlayerGuardPolling();
      } else {
        scheduleReconnect('end');
      }
    });

    // Error handler
    bot.on('error', (err) => {
      if (isStopped('error event')) return;
      console.log(`[${botId}] Bot error: ${err.message}`);
      botState.errors.push({ type: 'error', message: err.message, time: Date.now() });
    });

    // Coords update
    bot.on('move', () => {
      if (bot && bot.entity) {
        botState.coordinates = {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z)
        };
      }
    });

  } catch (err) {
    console.log(`[${botId}] Failed to create bot: ${err.message}`);
    dispatchWebhookEvent('ErrorOccurred', { error: err.message, playerCount: null });
    if (!stopRequested) {
      scheduleReconnect('create_error');
    } else {
      botState.status = 'stopped';
    }
  }
}

function checkExistingPlayers() {
  if (!bot || !botState.connected) return;

  const existingPlayers = Object.values(bot.players).filter(p => p.username !== bot.username);
  if (existingPlayers.length > 0) {
    const names = existingPlayers.map(p => p.username).join(', ');
    console.log(`[${botId}] Players already online at spawn: ${names}`);

    dispatchWebhookEvent('PlayerOnServer', {
      playerCount: existingPlayers.length,
      playerNames: existingPlayers.map(p => p.username),
      message: `Players detected at spawn: ${names}`
    });

    if (botConfig.playerGuard?.evictOnPlayer) {
      disconnectedByPlayerDetection = true;
      botState.connected = false;
      clearAllIntervals();
      try { bot.end(); } catch (e) {}
    }
  }
}

function handlePlayerJoined(player) {
  if (isStopped('handlePlayerJoined')) return;
  if (!botState.connected || player.username === bot.username) return;

  botState.playerCount = Object.values(bot.players).filter(p => p.username !== bot.username).length;
  console.log(`[${botId}] Player joined: ${player.username} (${botState.playerCount} on server)`);

  dispatchWebhookEvent('PlayerOnServer', {
    playerCount: botState.playerCount,
    playerName: player.username,
    message: `Player ${player.username} joined the server`
  });

  if (botConfig.playerGuard?.evictOnPlayer) {
    disconnectedByPlayerDetection = true;
    botState.connected = false;
    clearAllIntervals();
    try { bot.end(); } catch (e) {}
  }
}

function scheduleReconnect(reason) {
  if (isStopped('scheduleReconnect')) {
    botState.status = 'stopped';
    return;
  }

  clearBotTimeouts();

  if (isReconnecting) return;

  isReconnecting = true;
  botState.reconnectAttempts++;
  botState.status = 'reconnecting';

  const delay = getReconnectDelay();
  console.log(`[${botId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${botState.reconnectAttempts}, reason: ${reason})`);

  dispatchWebhookEvent('BotReconnecting', {
    attempt: botState.reconnectAttempts,
    delay: delay,
    playerCount: null
  });

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    if (isStopped('reconnect timer')) {
      botState.status = 'stopped';
      return;
    }
    startPlayerGuardPolling();
  }, delay);
}

function stopBot(callback) {
  console.log(`[${botId}] Stopping bot`);

  // Set stop flag first to gate all async callbacks
  stopRequested = true;
  isReconnecting = false;

  // Cancel all pending timers and intervals immediately
  stopPlayerGuardPolling();
  clearBotTimeouts();
  clearAllIntervals();

  botState.status = 'stopped';
  botState.connected = false;
  botState.reconnectAttempts = 0;

  // Destroy bot instance — remove listeners before end() to prevent
  // the 'end' event from triggering reconnection logic
  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log(`[${botId}] Error during bot teardown: ${e.message}`);
    }
    bot = null;
  }

  if (callback) callback();

  process.send({ type: 'BOT_STOPPED', botId: botId });

  console.log(`[${botId}] Bot stopped — worker exiting`);
  setTimeout(() => process.exit(0), 500);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules() {
  if (!bot || !botState.connected) return;

  console.log(`[${botId}] Initializing modules`);

  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.allowFreeMotion = false;
  defaultMove.canDig = false;

  bot.pathfinder.setMovements(defaultMove);

  if (botConfig.autoAuth?.enabled && botConfig.autoAuth?.password) {
    initializeAutoAuth(botConfig.autoAuth.password);
  }

  if (botConfig.antiAfk?.enabled) {
    initializeAntiAfk();
  }

  if (botConfig.movement?.enabled !== false) {
    if (botConfig.movement?.circleWalk?.enabled) {
      initializeCircleWalk(defaultMove);
    }
    if (botConfig.movement?.randomJump?.enabled && !botConfig.movement?.circleWalk?.enabled) {
      initializeRandomJump();
    }
    if (botConfig.movement?.lookAround?.enabled) {
      initializeLookAround();
    }
  }

  if (botConfig.position?.enabled && !botConfig.movement?.circleWalk?.enabled) {
    bot.pathfinder.setGoal(new GoalBlock(
      botConfig.position.x,
      botConfig.position.y,
      botConfig.position.z
    ));
  }

  if (botConfig.combat?.attackMobs || botConfig.combat?.autoEat) {
    initializeCombat();
  }

  console.log(`[${botId}] Modules initialized`);
}

function initializeAutoAuth(password) {
  let authHandled = false;

  const tryAuth = (type) => {
    if (authHandled || !bot || !botState.connected) return;
    authHandled = true;
    bot.chat(type === 'register' ? `/register ${password} ${password}` : `/login ${password}`);
    console.log(`[${botId}] Auto-auth: ${type}`);
  };

  bot.on('messagestr', (message) => {
    if (authHandled) return;
    const msg = message.toLowerCase();
    if (msg.includes('/register') || msg.includes('register')) {
      tryAuth('register');
    } else if (msg.includes('/login') || msg.includes('login')) {
      tryAuth('login');
    }
  });

  setTimeout(() => {
    if (!authHandled && bot && botState.connected) {
      bot.chat(`/login ${password}`);
      authHandled = true;
    }
  }, 3000);
}

function initializeAntiAfk() {
  console.log(`[${botId}] Anti-AFK module active`);

  if (botConfig.antiAfk.swingArm) {
    addInterval(() => {
      if (stopRequested || !bot || !botState.connected) return;
      try { bot.swingArm(); } catch (e) {}
    }, 10000 + Math.floor(Math.random() * 50000));
  }

  if (botConfig.antiAfk.hotbarCycle) {
    addInterval(() => {
      if (stopRequested || !bot || !botState.connected) return;
      try {
        bot.setQuickBarSlot(Math.floor(Math.random() * 9));
      } catch (e) {}
    }, 30000 + Math.floor(Math.random() * 90000));
  }

  if (botConfig.antiAfk.sneak) {
    try { bot.setControlState('sneak', true); } catch (e) {}
  }

  if (!botConfig.movement?.circleWalk?.enabled) {
    addInterval(() => {
      if (stopRequested || !bot || !botState.connected) return;
      try {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        bot.setControlState('forward', true);
        setTimeout(() => {
          if (stopRequested || !bot) return;
          bot.setControlState('forward', false);
        }, 500 + Math.floor(Math.random() * 1500));
        botState.lastActivity = Date.now();
      } catch (e) {}
    }, 120000 + Math.floor(Math.random() * 360000));
  }
}

function initializeCircleWalk(defaultMove) {
  console.log(`[${botId}] Circle walk module active`);
  const radius = botConfig.movement.circleWalk.radius || 5;
  const speed = botConfig.movement.circleWalk.speed || 3000;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (stopRequested || !bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;

    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {}
  }, speed);
}

function initializeRandomJump() {
  console.log(`[${botId}] Random jump module active`);
  const interval = botConfig.movement.randomJump.interval || 15000;

  addInterval(() => {
    if (stopRequested || !bot || !botState.connected) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (stopRequested || !bot) return;
        bot.setControlState('jump', false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {}
  }, interval);
}

function initializeLookAround() {
  console.log(`[${botId}] Look around module active`);
  const interval = botConfig.movement.lookAround.interval || 20000;

  addInterval(() => {
    if (stopRequested || !bot || !botState.connected) return;
    try {
      const yaw = (Math.random() * Math.PI * 2) - Math.PI;
      const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {}
  }, interval);
}

function initializeCombat() {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  if (botConfig.combat.attackMobs) {
    bot.on('physicsTick', () => {
      if (!bot || !botState.connected) return;

      const now = Date.now();
      if (now - lastAttackTime < 620) return;

      try {
        if (lockedTarget && now < lockedTargetExpiry && bot.entities[lockedTarget.id]) {
          const dist = bot.entity.position.distanceTo(lockedTarget.position);
          if (dist < 4) {
            bot.attack(lockedTarget);
            lastAttackTime = now;
            return;
          } else {
            lockedTarget = null;
          }
        }

        const mobs = Object.values(bot.entities).filter(e =>
          e.type === 'mob' && e.position &&
          bot.entity.position.distanceTo(e.position) < 4
        );

        if (mobs.length > 0) {
          lockedTarget = mobs[0];
          lockedTargetExpiry = now + 3000;
          bot.attack(lockedTarget);
          lastAttackTime = now;
        }
      } catch (e) {}
    });
  }

  if (botConfig.combat.autoEat) {
    bot.on('health', () => {
      try {
        if (bot.food < 14) {
          const food = bot.inventory.items().find(i => i.foodPoints && i.foodPoints > 0);
          if (food) {
            bot.equip(food, 'hand')
              .then(() => bot.consume())
              .catch(() => {});
          }
        }
      } catch (e) {}
    });
  }
}

// ============================================================
// ERROR HANDLING
// ============================================================
process.on('uncaughtException', (err) => {
  console.log(`[${botId}] Uncaught exception: ${err.message}`);
  botState.errors.push({ type: 'uncaught', message: err.message, time: Date.now() });

  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  clearAllIntervals();
  botState.connected = false;

  if (isReconnecting) {
    isReconnecting = false;
    clearBotTimeouts();
  }

  if (stopRequested) {
    botState.status = 'stopped';
    return;
  }

  botState.status = 'error';
  // Uncaught exceptions are usually fatal — do not auto-reconnect
});

process.on('unhandledRejection', (reason) => {
  console.log(`[${botId}] Unhandled rejection: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});

// Status heartbeat
statusIntervalId = setInterval(sendStatus, 3000);

// Notify parent that worker is ready
process.send({ type: 'WORKER_READY', botId: botId });
