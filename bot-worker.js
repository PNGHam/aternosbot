'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;

// ============================================================
// CONFIGURATION
// ============================================================
const botConfig = JSON.parse(process.env.BOT_CONFIG || '{}');
const botId     = botConfig.id || 'unknown';

// ============================================================
// STATE
// ============================================================

/**
 * isRunning — SINGLE SOURCE OF TRUTH
 *
 * false  → bot is stopped; no connection, no reconnect, no async logic executes
 * true   → bot is permitted to connect and run
 *
 * Set to true  ONLY inside startBot().
 * Set to false ONLY inside stopBot() — and it is set FIRST, before any teardown.
 */
let isRunning = false;

let bot                = null;
let isReconnecting     = false;
let spawnHandled       = false;
let playerGuardActive  = false;
let occupiedAlerted    = false;
let evictingForPlayers = false;

let reconnectTimerId   = null;
let connTimeoutId      = null;
let playerGuardTimerId = null;
let statusTimerId      = null;

const activeIntervals  = new Set();

const botState = {
  connected:         false,
  playerCount:       0,
  lastActivity:      Date.now(),
  reconnectAttempts: 0,
  startTime:         Date.now(),
  coordinates:       null,
  status:            'stopped',
  errors:            []
};

// ============================================================
// GUARD — call at the top of every async entry point
// ============================================================
/**
 * Returns true (and logs) when the bot is NOT running.
 * Use as: `if (halted('myContext')) return;`
 */
function halted(context) {
  if (!isRunning) {
    console.log(`[${botId}] [HALTED] Skipping "${context}" — bot is stopped`);
    return true;
  }
  return false;
}

// ============================================================
// IPC — INBOUND MESSAGES
// ============================================================
process.on('message', msg => {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'START':
      startBot();
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
          // Restart only if caller re-sends START; we do not auto-start
        });
      }
      break;

    default:
      console.log(`[${botId}] Unknown IPC type: ${msg.type}`);
  }
});

// ============================================================
// START / STOP — public entry points
// ============================================================
function startBot() {
  if (isRunning) {
    console.log(`[${botId}] startBot() called but already running — ignoring`);
    return;
  }

  console.log(`[${botId}] Starting bot`);

  // Reset flag FIRST — enables all gated logic downstream
  isRunning          = true;
  isReconnecting     = false;
  evictingForPlayers = false;
  occupiedAlerted    = false;
  botState.reconnectAttempts = 0;
  botState.status    = 'starting';

  beginConnectionFlow();
}

function stopBot(callback) {
  console.log(`[${botId}] Stopping bot`);

  // ── Step 1: Set flag — gates every async callback immediately ──
  isRunning      = false;
  isReconnecting = false;

  // ── Step 2: Cancel all pending timers / intervals ──
  _cancelAllTimers();

  // ── Step 3: Update state ──
  botState.connected = false;
  botState.status    = 'stopped';

  // ── Step 4: Destroy bot — remove listeners BEFORE end()
  //           so the 'end' event cannot trigger reconnect logic ──
  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log(`[${botId}] Error during bot teardown: ${e.message}`);
    }
    bot = null;
  }

  callback?.();

  process.send?.({ type: 'BOT_STOPPED', botId });

  console.log(`[${botId}] Bot stopped — worker exiting`);
  setTimeout(() => process.exit(0), 500);
}

// ============================================================
// CONNECTION FLOW
// ============================================================

/**
 * Entry point for the full connection cycle.
 * Delegates to player-guard polling (if enabled) or direct connect.
 */
function beginConnectionFlow() {
  if (halted('beginConnectionFlow')) return;

  if (botConfig.playerGuard?.enabled) {
    startPlayerGuardPolling();
  } else {
    createBot();
  }
}

// ─── Player Guard ────────────────────────────────────────────
const GUARD_POLL_MS = botConfig.playerGuard?.pollInterval || 30_000;

function startPlayerGuardPolling() {
  if (halted('startPlayerGuardPolling')) return;
  if (playerGuardActive) return; // Already polling

  playerGuardActive = true;
  botState.status   = 'polling';
  console.log(`[${botId}] Player guard: polling every ${GUARD_POLL_MS / 1000}s`);

  const mc = require('minecraft-protocol');

  function poll() {
    if (halted('playerGuard poll')) {
      _stopPlayerGuardPolling();
      return;
    }

    mc.ping({ host: botConfig.serverIp, port: botConfig.serverPort }, (err, resp) => {
      // Guard checked again — time elapsed since poll was queued
      if (halted('playerGuard ping callback')) {
        _stopPlayerGuardPolling();
        return;
      }

      if (err) {
        console.log(`[${botId}] Ping failed — connecting anyway`);
        _stopPlayerGuardPolling();
        createBot();
        return;
      }

      const online = resp?.players?.online || 0;
      botState.playerCount = online;

      if (online === 0) {
        console.log(`[${botId}] Server empty — connecting`);
        _stopPlayerGuardPolling();
        occupiedAlerted = false;
        createBot();
      } else {
        if (!occupiedAlerted) {
          occupiedAlerted = true;
          console.log(`[${botId}] Server occupied (${online} players) — waiting`);
          sendWebhookEvent('PlayerOnServer', {
            playerCount: online,
            message:     `Server occupied with ${online} player(s). Bot waiting.`
          });
        }
      }
    });
  }

  poll(); // Immediate first check
  playerGuardTimerId = setInterval(poll, GUARD_POLL_MS);
}

function _stopPlayerGuardPolling() {
  if (!playerGuardActive) return;
  clearInterval(playerGuardTimerId);
  playerGuardTimerId = null;
  playerGuardActive  = false;
  console.log(`[${botId}] Player guard polling stopped`);
}

// ─── Bot creation ────────────────────────────────────────────
function createBot() {
  if (halted('createBot')) return;

  // Prevent parallel createBot calls (e.g. from two racing timeouts)
  if (isReconnecting) {
    console.log(`[${botId}] Already reconnecting — skipping duplicate createBot`);
    return;
  }

  // Clean up any leftover instance
  if (bot) {
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  _clearTimers();
  spawnHandled       = false;
  botState.status    = 'connecting';
  botState.connected = false;

  console.log(`[${botId}] Connecting to ${botConfig.serverIp}:${botConfig.serverPort}`);

  try {
    bot = mineflayer.createBot({
      username:              botConfig.name,
      password:              botConfig.password || undefined,
      auth:                  botConfig.authType || 'offline',
      host:                  botConfig.serverIp,
      port:                  botConfig.serverPort,
      version:               botConfig.serverVersion?.trim() || false,
      hideErrors:            false,
      checkTimeoutInterval:  600_000
    });

    bot.loadPlugin(pathfinder);

    // ── Connection timeout ──────────────────────────────────
    connTimeoutId = setTimeout(() => {
      if (halted('connection timeout')) {
        _destroyBot();
        return;
      }
      if (!botState.connected) {
        console.log(`[${botId}] Connection timeout — no spawn received`);
        sendWebhookEvent('ErrorOccurred', { error: 'Connection timeout', playerCount: null });
        _destroyBot();
        scheduleReconnect('timeout');
      }
    }, 150_000);

    // ── Spawn ───────────────────────────────────────────────
    bot.once('spawn', () => {
      if (halted('spawn')) {
        _destroyBot();
        return;
      }
      if (spawnHandled) return;
      spawnHandled = true;

      _clearTimers();

      botState.connected         = true;
      botState.status            = 'connected';
      botState.lastActivity      = Date.now();
      botState.reconnectAttempts = 0;
      botState.startTime         = Date.now();
      isReconnecting             = false;

      console.log(`[${botId}] Spawned (version: ${bot.version})`);
      sendWebhookEvent('BotSpawned', { playerCount: 0, version: bot.version });

      if (botConfig.tryCreative) {
        setTimeout(() => {
          if (halted('gamemode cmd') || !botState.connected) return;
          try { bot.chat('/gamemode spectator'); } catch (_) {}
        }, 10_000);
      }

      initializeModules();
      checkExistingPlayers();

      bot.on('playerJoined', player => handlePlayerJoined(player));
    });

    // ── Kicked ──────────────────────────────────────────────
    bot.on('kicked', reason => {
      if (halted('kicked')) return;

      const kickStr = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
      console.log(`[${botId}] Kicked: ${kickStr}`);

      botState.connected = false;
      botState.status    = 'kicked';
      _pushError('kicked', kickStr);
      _clearAllIntervals();

      const lower   = kickStr.toLowerCase();
      const isFull  = lower.includes('full') || lower.includes('capacity');
      const isAuth  = lower.includes('auth') || lower.includes('login') || lower.includes('password');
      const isThrot = lower.includes('throttl') || lower.includes('wait before') || lower.includes('too fast');

      if (isFull)        sendWebhookEvent('ServerFull',  { playerCount: null });
      else if (isAuth)   sendWebhookEvent('AuthFailed',  { playerCount: null });
      else               sendWebhookEvent('BotKicked',   { reason: kickStr, playerCount: null });

      if (isThrot) botState.reconnectAttempts += 2; // back off extra
    });

    // ── End ─────────────────────────────────────────────────
    bot.on('end', reason => {
      if (halted('end')) {
        botState.connected = false;
        botState.status    = 'stopped';
        return;
      }

      console.log(`[${botId}] Disconnected: ${reason || 'unknown'}`);

      botState.connected = false;
      botState.status    = 'disconnected';
      spawnHandled       = false;
      _clearAllIntervals();

      sendWebhookEvent('Disconnected', { reason: reason || 'unknown', playerCount: botState.playerCount });

      if (evictingForPlayers) {
        evictingForPlayers = false;
        occupiedAlerted    = false;
        isReconnecting     = false;
        startPlayerGuardPolling();
      } else {
        scheduleReconnect('disconnect');
      }
    });

    // ── Error ───────────────────────────────────────────────
    bot.on('error', err => {
      if (halted('bot error')) return;
      console.log(`[${botId}] Bot error: ${err.message}`);
      _pushError('error', err.message);
    });

    // ── Position tracking ───────────────────────────────────
    bot.on('move', () => {
      if (!isRunning || !bot?.entity) return;
      const p = bot.entity.position;
      botState.coordinates = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    });

  } catch (err) {
    console.log(`[${botId}] Failed to create bot: ${err.message}`);
    sendWebhookEvent('ErrorOccurred', { error: err.message, playerCount: null });
    if (!isRunning) {
      botState.status = 'stopped';
    } else {
      scheduleReconnect('create_error');
    }
  }
}

// ─── Player detection ────────────────────────────────────────
function checkExistingPlayers() {
  if (halted('checkExistingPlayers') || !botState.connected) return;

  const others = Object.values(bot.players).filter(p => p.username !== bot.username);
  if (others.length === 0) return;

  const names = others.map(p => p.username).join(', ');
  console.log(`[${botId}] Players at spawn: ${names}`);

  sendWebhookEvent('PlayerOnServer', {
    playerCount:  others.length,
    playerNames:  others.map(p => p.username),
    message:      `Players detected at spawn: ${names}`
  });

  if (botConfig.playerGuard?.evictOnPlayer) {
    console.log(`[${botId}] Evicting — players present at spawn`);
    _evict();
  }
}

function handlePlayerJoined(player) {
  if (halted('handlePlayerJoined') || !botState.connected) return;
  if (player.username === bot.username) return;

  botState.playerCount = Object.values(bot.players).filter(p => p.username !== bot.username).length;
  console.log(`[${botId}] Player joined: ${player.username} (${botState.playerCount} on server)`);

  sendWebhookEvent('PlayerOnServer', {
    playerCount: botState.playerCount,
    playerName:  player.username,
    message:     `Player ${player.username} joined`
  });

  if (botConfig.playerGuard?.evictOnPlayer) {
    _evict();
  }
}

/** Disconnect due to player detection; will resume player-guard polling on 'end'. */
function _evict() {
  evictingForPlayers = true;
  botState.connected = false;
  _clearAllIntervals();
  try { bot.end(); } catch (_) {}
}

// ─── Reconnect ───────────────────────────────────────────────
function scheduleReconnect(reason) {
  if (halted('scheduleReconnect')) {
    botState.status = 'stopped';
    return;
  }

  if (isReconnecting) return;
  isReconnecting = true;

  _clearTimers();

  botState.reconnectAttempts++;
  botState.status = 'reconnecting';

  const delay = _reconnectDelay();
  console.log(`[${botId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${botState.reconnectAttempts}, reason: ${reason})`);

  sendWebhookEvent('BotReconnecting', {
    attempt:     botState.reconnectAttempts,
    delay,
    playerCount: null
  });

  reconnectTimerId = setTimeout(() => {
    reconnectTimerId = null;
    isReconnecting   = false;

    // Guard checked again after the delay has elapsed
    if (halted('reconnect timer fired')) {
      botState.status = 'stopped';
      return;
    }

    beginConnectionFlow();
  }, delay);
}

function _reconnectDelay() {
  const base    = botConfig.autoReconnectDelay || botConfig.autoReconnect?.delay || 3_000;
  const max     = botConfig.maxReconnectDelay  || 30_000;
  const backoff = Math.min(base * Math.pow(2, botState.reconnectAttempts), max);
  const jitter  = Math.floor(Math.random() * 2_000);
  return backoff + jitter;
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules() {
  if (halted('initializeModules') || !botState.connected) return;

  console.log(`[${botId}] Initializing modules`);

  const mcData     = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.allowFreeMotion = false;
  defaultMove.canDig          = false;
  bot.pathfinder.setMovements(defaultMove);

  if (botConfig.autoAuth?.enabled && botConfig.autoAuth?.password) {
    initAutoAuth(botConfig.autoAuth.password);
  }

  if (botConfig.antiAfk?.enabled) {
    initAntiAfk();
  }

  if (botConfig.movement?.enabled !== false) {
    if (botConfig.movement?.circleWalk?.enabled)  initCircleWalk(defaultMove);
    if (botConfig.movement?.randomJump?.enabled && !botConfig.movement?.circleWalk?.enabled) initRandomJump();
    if (botConfig.movement?.lookAround?.enabled)  initLookAround();
  }

  if (botConfig.position?.enabled && !botConfig.movement?.circleWalk?.enabled) {
    bot.pathfinder.setGoal(new GoalBlock(
      botConfig.position.x,
      botConfig.position.y,
      botConfig.position.z
    ));
  }

  if (botConfig.combat?.attackMobs || botConfig.combat?.autoEat) {
    initCombat();
  }

  console.log(`[${botId}] Modules initialized`);
}

// ─── Auto-auth ───────────────────────────────────────────────
function initAutoAuth(password) {
  let done = false;

  const tryAuth = type => {
    if (!isRunning || done || !botState.connected) return;
    done = true;
    try { bot.chat(type === 'register' ? `/register ${password} ${password}` : `/login ${password}`); } catch (_) {}
    console.log(`[${botId}] Auto-auth: ${type}`);
  };

  bot.on('messagestr', msg => {
    if (!isRunning || done) return;
    const lower = msg.toLowerCase();
    if (lower.includes('/register') || lower.includes('register')) tryAuth('register');
    else if (lower.includes('/login') || lower.includes('login'))  tryAuth('login');
  });

  setTimeout(() => {
    if (!isRunning || done || !botState.connected) return;
    tryAuth('login');
  }, 3_000);
}

// ─── Anti-AFK ────────────────────────────────────────────────
function initAntiAfk() {
  console.log(`[${botId}] Anti-AFK active`);

  if (botConfig.antiAfk.sneak) {
    try { bot.setControlState('sneak', true); } catch (_) {}
  }

  if (botConfig.antiAfk.swingArm) {
    _addInterval(() => {
      if (!isRunning || !botState.connected) return;
      try { bot.swingArm(); } catch (_) {}
    }, 10_000 + Math.floor(Math.random() * 50_000));
  }

  if (botConfig.antiAfk.hotbarCycle) {
    _addInterval(() => {
      if (!isRunning || !botState.connected) return;
      try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {}
    }, 30_000 + Math.floor(Math.random() * 90_000));
  }

  if (!botConfig.movement?.circleWalk?.enabled) {
    _addInterval(() => {
      if (!isRunning || !botState.connected) return;
      try {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        bot.setControlState('forward', true);
        setTimeout(() => {
          if (!isRunning || !bot) return;
          bot.setControlState('forward', false);
        }, 500 + Math.floor(Math.random() * 1_500));
        botState.lastActivity = Date.now();
      } catch (_) {}
    }, 120_000 + Math.floor(Math.random() * 360_000));
  }
}

// ─── Circle walk ─────────────────────────────────────────────
function initCircleWalk(defaultMove) {
  console.log(`[${botId}] Circle walk active`);
  const radius = botConfig.movement.circleWalk.radius || 5;
  const speed  = botConfig.movement.circleWalk.speed  || 3_000;
  let angle    = 0;
  let lastPath = 0;

  _addInterval(() => {
    if (!isRunning || !botState.connected) return;
    const now = Date.now();
    if (now - lastPath < 2_000) return;
    lastPath = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (_) {}
  }, speed);
}

// ─── Random jump ─────────────────────────────────────────────
function initRandomJump() {
  console.log(`[${botId}] Random jump active`);
  const interval = botConfig.movement.randomJump.interval || 15_000;

  _addInterval(() => {
    if (!isRunning || !botState.connected) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (!isRunning || !bot) return;
        bot.setControlState('jump', false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (_) {}
  }, interval);
}

// ─── Look around ─────────────────────────────────────────────
function initLookAround() {
  console.log(`[${botId}] Look around active`);
  const interval = botConfig.movement.lookAround.interval || 20_000;

  _addInterval(() => {
    if (!isRunning || !botState.connected) return;
    try {
      bot.look((Math.random() * Math.PI * 2) - Math.PI, (Math.random() * Math.PI / 2) - Math.PI / 4, false);
      botState.lastActivity = Date.now();
    } catch (_) {}
  }, interval);
}

// ─── Combat ──────────────────────────────────────────────────
function initCombat() {
  let lastAttack = 0;
  let locked     = null;
  let lockedExp  = 0;

  if (botConfig.combat.attackMobs) {
    bot.on('physicsTick', () => {
      if (!isRunning || !botState.connected) return;
      const now = Date.now();
      if (now - lastAttack < 620) return;

      try {
        if (locked && now < lockedExp && bot.entities[locked.id]) {
          if (bot.entity.position.distanceTo(locked.position) < 4) {
            bot.attack(locked);
            lastAttack = now;
            return;
          }
          locked = null;
        }

        const nearby = Object.values(bot.entities).filter(e =>
          e.type === 'mob' && e.position &&
          bot.entity.position.distanceTo(e.position) < 4
        );

        if (nearby.length > 0) {
          locked    = nearby[0];
          lockedExp = now + 3_000;
          bot.attack(locked);
          lastAttack = now;
        }
      } catch (_) {}
    });
  }

  if (botConfig.combat.autoEat) {
    bot.on('health', () => {
      if (!isRunning || !botState.connected) return;
      try {
        if (bot.food < 14) {
          const food = bot.inventory.items().find(i => i.foodPoints > 0);
          if (food) bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
        }
      } catch (_) {}
    });
  }
}

// ============================================================
// IPC — OUTBOUND
// ============================================================
function sendStatus() {
  process.send?.({
    type:   'STATUS_UPDATE',
    botId,
    status: {
      connected:         botState.connected,
      playerCount:       botState.playerCount,
      status:            botState.status,
      lastActivity:      botState.lastActivity,
      reconnectAttempts: botState.reconnectAttempts,
      uptime:            Math.floor((Date.now() - botState.startTime) / 1000),
      coordinates:       botState.coordinates,
      errors:            botState.errors.slice(-10)
    }
  });
}

function sendWebhookEvent(eventType, extra = {}) {
  process.send?.({
    type:    'WEBHOOK_EVENT',
    botId,
    payload: {
      eventType,
      timestamp: new Date().toISOString(),
      serverIP:  `${botConfig.serverIp}:${botConfig.serverPort}`,
      botName:   botConfig.name,
      ...extra
    }
  });
}

// ============================================================
// INTERNAL HELPERS
// ============================================================
function _addInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.add(id);
  return id;
}

function _clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals.clear();
}

function _clearTimers() {
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (connTimeoutId)    { clearTimeout(connTimeoutId);    connTimeoutId    = null; }
}

function _cancelAllTimers() {
  _stopPlayerGuardPolling();
  _clearTimers();
  _clearAllIntervals();
  if (statusTimerId) { clearInterval(statusTimerId); statusTimerId = null; }
}

function _destroyBot() {
  if (!bot) return;
  try { bot.removeAllListeners(); bot.end(); } catch (_) {}
  bot = null;
}

function _pushError(type, msg) {
  botState.errors.push({ type, message: msg, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
}

// ============================================================
// PROCESS-LEVEL ERROR HANDLING
// ============================================================
process.on('uncaughtException', err => {
  console.error(`[${botId}] Uncaught exception: ${err.message}`);
  _pushError('uncaught', err.message);
  _clearAllIntervals();
  botState.connected = false;

  if (!isRunning) {
    botState.status = 'stopped';
    return;
  }

  botState.status = 'error';
  // Uncaught exceptions are typically fatal — do not auto-reconnect
});

process.on('unhandledRejection', reason => {
  console.error(`[${botId}] Unhandled rejection: ${reason}`);
  _pushError('rejection', String(reason));
});

// ============================================================
// STARTUP
// ============================================================
// Status heartbeat (always active so manager gets updates)
statusTimerId = setInterval(sendStatus, 3_000);

// isRunning starts false — no connections until START is received
// Notify parent that this worker process is ready
process.send({ type: 'WORKER_READY', botId });
