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
let statusIntervalId = null; // DEBUG: Track status interval for cleanup

// Discord rate limiting
let lastWebhookSend = 0;
const WEBHOOK_RATE_LIMIT_MS = 5000;

// ============================================================
// IPC MESSAGE HANDLING
// ============================================================
process.on('message', (msg) => {
  if (!msg || !msg.type) return;

  console.log(`[${botId}] DEBUG: IPC message received: ${msg.type}`);

  switch (msg.type) {
    case 'START':
      // Reset stop flag when starting
      console.log(`[${botId}] DEBUG: START received - resetting stopRequested from ${stopRequested} to false`);
      stopRequested = false;
      startPlayerGuardPolling();
      break;
    case 'STOP':
      console.log(`[${botId}] DEBUG: STOP received - calling stopBot`);
      stopBot();
      break;
    case 'GET_STATUS':
      sendStatus();
      break;
    case 'UPDATE_CONFIG':
      console.log(`[${botId}] DEBUG: UPDATE_CONFIG received - restart: ${msg.restart}`);
      Object.assign(botConfig, msg.config);
      if (msg.restart && botState.connected) {
        stopBot(() => {
          // Reset stop flag before restart
          console.log(`[${botId}] DEBUG: UPDATE_CONFIG callback - resetting stopRequested for restart`);
          stopRequested = false;
          setTimeout(() => startPlayerGuardPolling(), 2000);
        });
      }
      break;
    default:
      console.log(`[${botId}] DEBUG: Unknown message type: ${msg.type}`);
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
  console.log(`[${botId}] DEBUG: Clearing bot timeouts`);
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
    console.log(`[${botId}] DEBUG: Cleared reconnect timeout`);
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
    console.log(`[${botId}] DEBUG: Cleared connection timeout`);
  }
}

function clearAllIntervals() {
  console.log(`[${botId}] DEBUG: Clearing ${activeIntervals.length} active intervals`);
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
  // FIX: Clear status interval which runs forever otherwise
  if (statusIntervalId) {
    clearInterval(statusIntervalId);
    statusIntervalId = null;
    console.log(`[${botId}] DEBUG: Cleared status interval`);
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
  console.log(`[${botId}] DEBUG: startPlayerGuardPolling called - playerGuardIntervalId: ${playerGuardIntervalId}, stopRequested: ${stopRequested}`);

  if (playerGuardIntervalId) {
    console.log(`[${botId}] DEBUG: PlayerGuard polling already active`);
    return;
  }

  // FIX: Check if stop was requested - don't restart
  if (stopRequested) {
    console.log(`[${botId}] DEBUG: startPlayerGuardPolling ABORTED - stopRequested is true`);
    return;
  }

  isReconnecting = false;
  botState.status = 'polling';
  console.log(`[${botId}] DEBUG: Starting player guard polling...`);

  const mc = require('minecraft-protocol');

  function checkAndJoin() {
    // FIX: Check stop flag before each iteration
    console.log(`[${botId}] DEBUG: checkAndJoin called - stopRequested: ${stopRequested}`);
    if (stopRequested) {
      console.log(`[${botId}] DEBUG: checkAndJoin ABORTED - stopRequested is true`);
      stopPlayerGuardPolling();
      return;
    }

    // If player guard is disabled, join immediately
    if (!botConfig.playerGuard?.enabled) {
      console.log(`[${botId}] DEBUG: Player guard disabled - joining immediately`);
      stopPlayerGuardPolling();
      occupiedNotificationSent = false;
      createBot();
      return;
    }

    console.log(`[${botId}] DEBUG: Pinging server ${botConfig.serverIp}:${botConfig.serverPort}`);
    mc.ping(
      { host: botConfig.serverIp, port: botConfig.serverPort },
      (err, response) => {
        // FIX: Check stop flag after async ping
        console.log(`[${botId}] DEBUG: Ping callback - stopRequested: ${stopRequested}, err: ${err ? err.message : 'none'}`);
        if (stopRequested) {
          console.log(`[${botId}] DEBUG: Ping callback ABORTED - stopRequested is true`);
          stopPlayerGuardPolling();
          return;
        }

        if (err) {
          console.log(`[${botId}] DEBUG: Ping error - proceeding to join`);
          stopPlayerGuardPolling();
          occupiedNotificationSent = false;
          createBot();
          return;
        }

        const onlinePlayers = (response?.players?.online) || 0;
        botState.playerCount = onlinePlayers;

        console.log(`[${botId}] DEBUG: Ping result - ${onlinePlayers} player(s) online`);

        if (onlinePlayers === 0) {
          console.log(`[${botId}] DEBUG: Server empty - joining`);
          stopPlayerGuardPolling();
          occupiedNotificationSent = false;
          createBot();
        } else {
          if (!occupiedNotificationSent) {
            console.log(`[${botId}] DEBUG: Server occupied - waiting`);
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
  console.log(`[${botId}] DEBUG: Player guard interval started (id: ${playerGuardIntervalId})`);
}

function stopPlayerGuardPolling() {
  console.log(`[${botId}] DEBUG: stopPlayerGuardPolling called - playerGuardIntervalId: ${playerGuardIntervalId}`);
  if (playerGuardIntervalId) {
    clearInterval(playerGuardIntervalId);
    playerGuardIntervalId = null;
    console.log(`[${botId}] DEBUG: PlayerGuard polling stopped and cleared`);
  }
}

// ============================================================
// BOT CREATION AND LIFECYCLE
// ============================================================
function createBot() {
  // FIX: Check if stop was requested BEFORE any connection attempt
  console.log(`[${botId}] DEBUG: createBot called - stopRequested: ${stopRequested}`);
  if (stopRequested) {
    console.log(`[${botId}] DEBUG: Stop requested - aborting createBot`);
    return;
  }

  if (isReconnecting) {
    console.log(`[${botId}] DEBUG: Already reconnecting, skipping createBot`);
    return;
  }

  // Cleanup previous instance
  if (bot) {
    console.log(`[${botId}] DEBUG: Cleaning up previous bot instance`);
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log(`[${botId}] DEBUG: Cleanup error: ${e.message}`);
    }
    bot = null;
  }

  console.log(`[${botId}] DEBUG: Creating bot instance...`);
  console.log(`[${botId}] DEBUG: Connecting to ${botConfig.serverIp}:${botConfig.serverPort}`);

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
      // FIX: Check stopRequested first
      if (stopRequested) {
        console.log(`[${botId}] DEBUG: Kicked event ignored - stopRequested is true`);
        return;
      }

      const kickReason = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
      console.log(`[${botId}] DEBUG: Kicked event received: ${kickReason}`);

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
      // FIX: Check stopRequested first before processing end event
      console.log(`[${botId}] DEBUG: End event received - stopRequested: ${stopRequested}, reason: ${reason || 'Unknown'}`);

      if (stopRequested) {
        console.log(`[${botId}] DEBUG: End event - stopRequested is true, not triggering reconnect`);
        botState.connected = false;
        botState.status = 'stopped';
        return;
      }

      console.log(`[${botId}] DEBUG: End event - processing normal disconnect flow`);
      botState.connected = false;
      botState.status = 'disconnected';
      clearAllIntervals();
      spawnHandled = false;

      dispatchWebhookEvent('Disconnected', {
        reason: reason || 'Unknown',
        playerCount: botState.playerCount
      });

      if (disconnectedByPlayerDetection) {
        console.log(`[${botId}] DEBUG: End event - disconnected by player detection, returning to polling`);
        disconnectedByPlayerDetection = false;
        occupiedNotificationSent = false;
        isReconnecting = false;
        startPlayerGuardPolling();
      } else {
        console.log(`[${botId}] DEBUG: End event - scheduling reconnect`);
        scheduleReconnect('end');
      }
    });

    // Error handler
    bot.on('error', (err) => {
      // FIX: Process errors if stopped
      if (stopRequested) {
        console.log(`[${botId}] DEBUG: Error event ignored - stopRequested is true`);
        return;
      }
      console.log(`[${botId}] DEBUG: Error event - ${err.message}`);
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
  // FIX: Check stopRequested first
  if (stopRequested) {
    console.log(`[${botId}] DEBUG: handlePlayerJoined ignored - stopRequested is true`);
    return;
  }
  if (!botState.connected || player.username === bot.username) return;

  botState.playerCount = Object.values(bot.players).filter(p => p.username !== bot.username).length;

  console.log(`[${botId}] DEBUG: Player joined: ${player.username}`);

  dispatchWebhookEvent('PlayerOnServer', {
    playerCount: botState.playerCount,
    playerName: player.username,
    message: `Player ${player.username} joined the server`
  });

  if (botConfig.playerGuard?.evictOnPlayer) {
    console.log(`[${botId}] DEBUG: Evicting due to player join - stopRequested: ${stopRequested}`);
    disconnectedByPlayerDetection = true;
    botState.connected = false;
    clearAllIntervals();
    try { bot.end(); } catch (e) {}
  }
}

function scheduleReconnect(reason) {
  console.log(`[${botId}] DEBUG: scheduleReconnect called - reason: ${reason}, stopRequested: ${stopRequested}`);

  // FIX: CRITICAL - Check stop flag FIRST before any reconnection logic
  if (stopRequested) {
    console.log(`[${botId}] DEBUG: scheduleReconnect ABORTED - stopRequested is true`);
    botState.status = 'stopped';
    return;
  }

  clearBotTimeouts();

  if (isReconnecting) {
    console.log(`[${botId}] DEBUG: scheduleReconnect - already reconnecting, skipping`);
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;
  botState.status = 'reconnecting';

  const delay = getReconnectDelay();
  console.log(`[${botId}] DEBUG: Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  dispatchWebhookEvent('BotReconnecting', {
    attempt: botState.reconnectAttempts,
    delay: delay,
    playerCount: null
  });

  reconnectTimeoutId = setTimeout(() => {
    console.log(`[${botId}] DEBUG: Reconnect timeout fired - stopRequested: ${stopRequested}`);
    reconnectTimeoutId = null;
    isReconnecting = false;
    // FIX: Double-check stop flag before actually starting
    if (stopRequested) {
      console.log(`[${botId}] DEBUG: Reconnect timeout - ABORTING due to stopRequested`);
      botState.status = 'stopped';
      return;
    }
    console.log(`[${botId}] DEBUG: Reconnect timeout - proceeding to startPlayerGuardPolling`);
    startPlayerGuardPolling();
  }, delay);
}

function stopBot(callback) {
  console.log(`[${botId}] DEBUG: stopBot called - initiating hard stop`);
  console.log(`[${botId}] DEBUG: Current state - stopRequested: ${stopRequested}, isReconnecting: ${isReconnecting}, connected: ${botState.connected}`);

  // Set stop flag FIRST to prevent any async callbacks from restarting
  stopRequested = true;
  isReconnecting = false;
  console.log(`[${botId}] DEBUG: stopRequested set to TRUE`);

  // Clear all timers/intervals immediately to stop any pending operations
  stopPlayerGuardPolling();
  clearBotTimeouts();
  clearAllIntervals();

  // Update state
  botState.status = 'stopped';
  botState.connected = false;
  botState.reconnectAttempts = 0;
  console.log(`[${botId}] DEBUG: Bot state updated to stopped`);

  // Destroy bot instance
  if (bot) {
    try {
      console.log(`[${botId}] DEBUG: Removing all bot listeners and ending connection`);
      // Remove ALL listeners first to prevent 'end' event from triggering reconnect
      bot.removeAllListeners();
      // Force disconnect
      bot.end();
    } catch (e) {
      console.log(`[${botId}] DEBUG: Stop error: ${e.message}`);
    }
    bot = null;
    console.log(`[${botId}] DEBUG: Bot instance set to null`);
  } else {
    console.log(`[${botId}] DEBUG: No bot instance to destroy`);
  }

  if (callback) callback();

  process.send({ type: 'BOT_STOPPED', botId: botId });

  // Exit the worker process completely - no need to keep it running
  // The parent will spawn a new worker if/when the bot is restarted
  console.log(`[${botId}] DEBUG: Worker process exiting in 500ms...`);
  setTimeout(() => {
    console.log(`[${botId}] DEBUG: Process exiting now`);
    process.exit(0);
  }, 500); // Brief delay for BOT_STOPPED message to send
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
  console.log(`[${botId}] DEBUG: Initializing Anti-AFK module`);

  // Swing arm
  if (botConfig.antiAfk.swingArm) {
    addInterval(() => {
      // FIX: Check stopRequested before performing any action
      if (stopRequested) {
        console.log(`[${botId}] DEBUG: AntiAfk swing arm - stopRequested, skipping`);
        return;
      }
      if (bot && botState.connected) {
        try { bot.swingArm(); } catch (e) {}
      }
    }, 10000 + Math.floor(Math.random() * 50000));
  }

  // Hotbar cycle
  if (botConfig.antiAfk.hotbarCycle) {
    addInterval(() => {
      // FIX: Check stopRequested before performing any action
      if (stopRequested) {
        console.log(`[${botId}] DEBUG: AntiAfk hotbar - stopRequested, skipping`);
        return;
      }
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
      // FIX: Check stopRequested before performing any action
      if (stopRequested) {
        console.log(`[${botId}] DEBUG: AntiAfk micro-walk - stopRequested, skipping`);
        return;
      }
      if (!bot || !botState.connected) return;
      try {
        const yaw = Math.random() * Math.PI * 2;
        bot.look(yaw, 0, true);
        bot.setControlState('forward', true);
        setTimeout(() => {
          // FIX: Also check stopRequested in nested timeout
          if (stopRequested || !bot) {
            console.log(`[${botId}] DEBUG: AntiAfk micro-walk nested timeout - stopRequested or no bot, skipping`);
            return;
          }
          bot.setControlState('forward', false);
        }, 500 + Math.floor(Math.random() * 1500));
        botState.lastActivity = Date.now();
      } catch (e) {}
    }, 120000 + Math.floor(Math.random() * 360000));
  }
}

function initializeCircleWalk(defaultMove) {
  console.log(`[${botId}] DEBUG: Initializing Circle Walk module`);
  const radius = botConfig.movement.circleWalk.radius || 5;
  const speed = botConfig.movement.circleWalk.speed || 3000;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    // FIX: Check stopRequested before performing any action
    if (stopRequested) {
      console.log(`[${botId}] DEBUG: CircleWalk - stopRequested, skipping`);
      return;
    }
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
  console.log(`[${botId}] DEBUG: Initializing Random Jump module`);
  const interval = botConfig.movement.randomJump.interval || 15000;

  addInterval(() => {
    // FIX: Check stopRequested before performing any action
    if (stopRequested) {
      console.log(`[${botId}] DEBUG: RandomJump - stopRequested, skipping`);
      return;
    }
    if (!bot || !botState.connected) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        // FIX: Also check stopRequested in nested timeout
        if (stopRequested || !bot) {
          console.log(`[${botId}] DEBUG: RandomJump nested timeout - stopRequested or no bot, skipping`);
          return;
        }
        bot.setControlState('jump', false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {}
  }, interval);
}

function initializeLookAround() {
  console.log(`[${botId}] DEBUG: Initializing Look Around module`);
  const interval = botConfig.movement.lookAround.interval || 20000;

  addInterval(() => {
    // FIX: Check stopRequested before performing any action
    if (stopRequested) {
      console.log(`[${botId}] DEBUG: LookAround - stopRequested, skipping`);
      return;
    }
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
  console.log(`[${botId}] DEBUG: FATAL uncaughtException - ${err.message}`);
  console.log(`[${botId}] DEBUG: Exception handler - stopRequested: ${stopRequested}`);
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

  // FIX: CRITICAL - Check stopRequested before scheduling reconnect
  if (stopRequested) {
    console.log(`[${botId}] DEBUG: Exception handler - stopRequested is true, NOT scheduling reconnect`);
    botState.status = 'stopped';
    return;
  }

  console.log(`[${botId}] DEBUG: Exception handler - scheduling reconnect after fatal error`);
  botState.status = 'error';
  // Note: We don't automatically reconnect on uncaught exceptions as they're usually fatal
});

process.on('unhandledRejection', (reason) => {
  console.log(`[${botId}] REJECTION: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});

// Initial status report - FIX: Track interval ID for cleanup on stop
statusIntervalId = setInterval(sendStatus, 3000);
console.log(`[${botId}] DEBUG: Status interval started (id: ${statusIntervalId})`);

// Notify parent that worker is ready
process.send({ type: 'WORKER_READY', botId: botId });
