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
let stopRequested = false; // Flag to prevent reconnection after stop

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
      // Reset stop flag when starting
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
          // Reset stop flag before restart
          stopRequested = false;
          setTimeout(() => startPlayerGuardPolling(), 2000);
        });
      }
      break;
    default:
      console.log(`[${botId}] Unknown message type: ${msg.type}`);
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

  // Exponential backoff with jitter
  const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

// ============================================================
// PLAYER GUARD - Pre-join polling
// ============================================================
const PLAYER_GUARD_POLL_INTERVAL = botConfig.playerGuard?.pollInterval || 30000;

function startPlayerGuardPolling() {
  if (playerGuardIntervalId) {
    console.log(`[${botId}] PlayerGuard polling already active`);
    return;
  }

  // Check if stop was requested - don't restart
  if (stopRequested) {
    console.log(`[${botId}] Stop was requested - not starting player guard`);
    return;
  }

  isReconnecting = false;
  botState.status = 'polling';
  console.log(`[${botId}] Starting player guard polling...`);

  const mc = require('minecraft-protocol');

  function checkAndJoin() {
    // Check stop flag before each iteration
    if (stopRequested) {
      console.log(`[${botId}] Stop requested - aborting player guard polling`);
      stopPlayerGuardPolling();
      return;
    }

    // If player guard is disabled, join immediately
    if (!botConfig.playerGuard?.enabled) {
      console.log(`[${botId}] Player guard disabled - joining immediately`);
      stopPlayerGuardPolling();
      occupiedNotificationSent = false;
      createBot();
      return;
    }

    mc.ping(
      { host: botConfig.serverIp, port: botConfig.serverPort },
      (err, response) => {
        // Check stop flag after async ping
        if (stopRequested) {
          stopPlayerGuardPolling();
          return;
        }

        if (err) {
          console.log(`[${botId}] Ping error: ${err.message} - proceeding to join`);
          stopPlayerGuardPolling();
          occupiedNotificationSent = false;
          createBot();
          return;
        }

        const onlinePlayers = (response?.players?.online) || 0;
        botState.playerCount = onlinePlayers;

        console.log(`[${botId}] Ping: ${onlinePlayers} player(s) online`);

        if (onlinePlayers === 0) {
          console.log(`[${botId}] Server empty - joining`);
          stopPlayerGuardPolling();
          occupiedNotificationSent = false;
          createBot();
        } else {
          if (!occupiedNotificationSent) {
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
    console.log(`[${botId}] PlayerGuard polling stopped`);
  }
}

// ============================================================
// BOT CREATION AND LIFECYCLE
// ============================================================
function createBot() {
  // Check if stop was requested
  if (stopRequested) {
    console.log(`[${botId}] Stop requested - not creating bot`);
    return;
  }

  if (isReconnecting) {
    console.log(`[${botId}] Already reconnecting, skipping`);
    return;
  }

  // Cleanup previous instance
  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log(`[${botId}] Cleanup error: ${e.message}`);
    }
    bot = null;
  }

  console.log(`[${botId}] Creating bot instance...`);
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
      // CRITICAL: Check stop flag before taking action
      if (stopRequested) {
        console.log(`[${botId}] Stop requested during connection - abandoning`);
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (e) {}
        bot = null;
        botState.status = 'stopped';
        return;
      }

      if (!botState.connected) {
        console.log(`[${botId}] Connection timeout`);
        dispatchWebhookEvent('ErrorOccurred', {
          error: 'Connection timeout - no spawn received',
          playerCount: null
        });
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (e) {}
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

      console.log(`[${botId}] Spawned successfully (Version: ${bot.version})`);

      dispatchWebhookEvent('BotSpawned', {
        playerCount: 0,
        version: bot.version
      });

      // Request creative mode if enabled
      if (botConfig.tryCreative) {
        setTimeout(() => {
          if (bot && botState.connected) {
            bot.chat('/gamemode spectator');
          }
        }, 10000);
      }

      // Initialize modules
      initializeModules();

      // Player guard - check for existing players
      checkExistingPlayers();

      // Watch for player joins
      bot.on('playerJoined', (player) => {
        handlePlayerJoined(player);
      });
    });

    // Kicked handler
    bot.on('kicked', (reason) => {
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
        dispatchWebhookEvent('BotKicked', {
          reason: kickReason,
          playerCount: null
        });
      }

      if (isThrottle) {
        botState.reconnectAttempts += 2; // Extra delay for throttle
      }
    });

    // End handler - single reconnect trigger
    bot.on('end', (reason) => {
      console.log(`[${botId}] Disconnected: ${reason || 'Unknown'}`);
      botState.connected = false;
      botState.status = 'disconnected';
      clearAllIntervals();
      spawnHandled = false;

      dispatchWebhookEvent('Disconnected', {
        reason: reason || 'Unknown',
        playerCount: botState.playerCount
      });

      // Check if stop was requested - don't reconnect
      if (stopRequested) {
        console.log(`[${botId}] Stop was requested - not reconnecting`);
        botState.status = 'stopped';
        return;
      }

      if (disconnectedByPlayerDetection) {
        disconnectedByPlayerDetection = false;
        occupiedNotificationSent = false;
        isReconnecting = false;
        console.log(`[${botId}] Returning to player guard polling`);
        startPlayerGuardPolling();
      } else {
        scheduleReconnect('end');
      }
    });

    // Error handler
    bot.on('error', (err) => {
      console.log(`[${botId}] Error: ${err.message}`);
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
    dispatchWebhookEvent('ErrorOccurred', {
      error: err.message,
      playerCount: null
    });
    // CRITICAL: Check stop flag before reconnecting
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
    console.log(`[${botId}] Players already online: ${names}`);

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
  if (!botState.connected || player.username === bot.username) return;

  botState.playerCount = Object.values(bot.players).filter(p => p.username !== bot.username).length;

  console.log(`[${botId}] Player joined: ${player.username}`);

  dispatchWebhookEvent('PlayerOnServer', {
    playerCount: botState.playerCount,
    playerName: player.username,
    message: `Player ${player.username} joined the server`
  });

  if (botConfig.playerGuard?.evictOnPlayer) {
    console.log(`[${botId}] Evicting due to player join`);
    disconnectedByPlayerDetection = true;
    botState.connected = false;
    clearAllIntervals();
    try { bot.end(); } catch (e) {}
  }
}

function scheduleReconnect(reason) {
  // CRITICAL: Check stop flag FIRST before any reconnection logic
  if (stopRequested) {
    console.log(`[${botId}] Stop requested - aborting reconnect (${reason})`);
    botState.status = 'stopped';
    return;
  }

  clearBotTimeouts();

  if (isReconnecting) {
    console.log(`[${botId}] Reconnect already scheduled`);
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;
  botState.status = 'reconnecting';

  const delay = getReconnectDelay();
  console.log(`[${botId}] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  dispatchWebhookEvent('BotReconnecting', {
    attempt: botState.reconnectAttempts,
    delay: delay,
    playerCount: null
  });

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    // Double-check stop flag before actually starting
    if (stopRequested) {
      console.log(`[${botId}] Stop requested during reconnect delay - aborting`);
      botState.status = 'stopped';
      return;
    }
    startPlayerGuardPolling();
  }, delay);
}

function stopBot(callback) {
  console.log(`[${botId}] Stopping bot... (hard stop)`);

  // Set stop flag FIRST to prevent any async callbacks from restarting
  stopRequested = true;
  isReconnecting = false;

  // Clear all timers/intervals immediately to stop any pending operations
  stopPlayerGuardPolling();
  clearBotTimeouts();
  clearAllIntervals();

  // Update state
  botState.status = 'stopped';
  botState.connected = false;
  botState.reconnectAttempts = 0;

  // Destroy bot instance
  if (bot) {
    try {
      // Remove ALL listeners first to prevent 'end' event from triggering reconnect
      bot.removeAllListeners();
      // Force disconnect
      bot.end();
    } catch (e) {
      console.log(`[${botId}] Stop error: ${e.message}`);
    }
    bot = null;
  }

  if (callback) callback();

  process.send({ type: 'BOT_STOPPED', botId: botId });
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules() {
  if (!bot || !botState.connected) return;

  console.log(`[${botId}] Initializing modules...`);

  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.allowFreeMotion = false;
  defaultMove.canDig = false;

  bot.pathfinder.setMovements(defaultMove);

  // Auto-auth module
  if (botConfig.autoAuth?.enabled && botConfig.autoAuth?.password) {
    initializeAutoAuth(botConfig.autoAuth.password);
  }

  // Anti-AFK module
  if (botConfig.antiAfk?.enabled) {
    initializeAntiAfk();
  }

  // Movement modules
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

  // Position module
  if (botConfig.position?.enabled && !botConfig.movement?.circleWalk?.enabled) {
    bot.pathfinder.setGoal(new GoalBlock(
      botConfig.position.x,
      botConfig.position.y,
      botConfig.position.z
    ));
  }

  // Combat module
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

    if (type === 'register') {
      bot.chat(`/register ${password} ${password}`);
    } else {
      bot.chat(`/login ${password}`);
    }
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
  // Swing arm
  if (botConfig.antiAfk.swingArm) {
    addInterval(() => {
      if (bot && botState.connected) {
        try { bot.swingArm(); } catch (e) {}
      }
    }, 10000 + Math.floor(Math.random() * 50000));
  }

  // Hotbar cycle
  if (botConfig.antiAfk.hotbarCycle) {
    addInterval(() => {
      if (bot && botState.connected) {
        try {
          const slot = Math.floor(Math.random() * 9);
          bot.setQuickBarSlot(slot);
        } catch (e) {}
      }
    }, 30000 + Math.floor(Math.random() * 90000));
  }

  // Sneak
  if (botConfig.antiAfk.sneak) {
    try { bot.setControlState('sneak', true); } catch (e) {}
  }

  // Micro-walk (only if circle-walk not running)
  if (!botConfig.movement?.circleWalk?.enabled) {
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try {
        const yaw = Math.random() * Math.PI * 2;
        bot.look(yaw, 0, true);
        bot.setControlState('forward', true);
        setTimeout(() => {
          if (bot) bot.setControlState('forward', false);
        }, 500 + Math.floor(Math.random() * 1500));
        botState.lastActivity = Date.now();
      } catch (e) {}
    }, 120000 + Math.floor(Math.random() * 360000));
  }
}

function initializeCircleWalk(defaultMove) {
  const radius = botConfig.movement.circleWalk.radius || 5;
  const speed = botConfig.movement.circleWalk.speed || 3000;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (!bot || !botState.connected) return;
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
  const interval = botConfig.movement.randomJump.interval || 15000;

  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (bot) bot.setControlState('jump', false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {}
  }, interval);
}

function initializeLookAround() {
  const interval = botConfig.movement.lookAround.interval || 20000;

  addInterval(() => {
    if (!bot || !botState.connected) return;
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
              .catch(e => {});
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
  console.log(`[${botId}] FATAL: ${err.message}`);
  botState.errors.push({ type: 'uncaught', message: err.message, time: Date.now() });

  // Keep error log bounded
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  clearAllIntervals();
  botState.connected = false;

  if (isReconnecting) {
    isReconnecting = false;
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  // CRITICAL: Check stopRequested before scheduling reconnect
  if (stopRequested) {
    console.log(`[${botId}] Stop requested - not scheduling reconnect after exception`);
    botState.status = 'stopped';
    return;
  }

  setTimeout(() => scheduleReconnect('crash'), 5000);
});

process.on('unhandledRejection', (reason) => {
  console.log(`[${botId}] REJECTION: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});

// Initial status report
setInterval(sendStatus, 3000);

// Notify parent that worker is ready
process.send({ type: 'WORKER_READY', botId: botId });
