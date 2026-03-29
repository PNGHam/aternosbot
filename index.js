'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

// ================= CONFIG =================
const config = require('./settings.json');
let config2 = null;

if (fs.existsSync('./settings2.json')) {
  config2 = require('./settings2.json');
}

// ================= EXPRESS SERVER =================
const app = express();
const PORT = process.env.PORT || 5000;

// MULTI BOT STORAGE
let bots = [];

// ================= DASHBOARD =================
app.get('/', (req, res) => {
  res.send(`<h1>Bot System Running (${bots.length} bots)</h1>`);
});

app.get('/health', (req, res) => {
  res.json({
    bots: bots.length,
    active: bots.map((b, i) => ({
      id: i + 1,
      username: b.username,
      position: b.entity ? b.entity.position : null
    }))
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// ================= CREATE BOT =================
function createBot(botConfig, label = 'Bot') {

  if (!botConfig.useBot) {
    console.log(`[${label}] Skipped (useBot = false)`);
    return;
  }

  console.log(`[${label}] Connecting to ${botConfig.server.ip}`);

  const bot = mineflayer.createBot({
    username: botConfig['bot-account'].username,
    password: botConfig['bot-account'].password || undefined,
    auth: botConfig['bot-account'].type,
    host: botConfig.server.ip,
    port: botConfig.server.port,
    version: false
  });

  bots.push(bot);

  let reconnectAttempts = 0;

  bot.loadPlugin(pathfinder);

  // ================= SPAWN =================
  bot.once('spawn', () => {
    console.log(`[${label}] ✅ Spawned`);

    reconnectAttempts = 0;

    // AUTO AUTH
    if (botConfig.utils['auto-auth']?.enabled) {
      const pass = botConfig.utils['auto-auth'].password;

      setTimeout(() => {
        bot.chat(`/login ${pass}`);
        bot.chat(`/register ${pass} ${pass}`);
      }, 3000);
    }

    // TRY CREATIVE
    if (botConfig.server['try-creative']) {
      setTimeout(() => {
        bot.chat('/gamemode creative');
      }, 5000);
    }

    // CHAT MESSAGES
    if (botConfig.utils['chat-messages']?.enabled) {
      const msgs = botConfig.utils['chat-messages'].messages;
      let i = 0;

      setInterval(() => {
        if (!bot.entity) return;
        bot.chat(msgs[i]);
        i = (i + 1) % msgs.length;
      }, botConfig.utils['chat-messages']['repeat-delay'] * 1000);
    }

    // ANTI AFK
    if (botConfig.utils['anti-afk']?.enabled) {
      setInterval(() => {
        try { bot.swingArm(); } catch {}
      }, 30000);

      setInterval(() => {
        try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch {}
      }, 60000);
    }

    // LOOK AROUND
    if (botConfig.movement?.['look-around']?.enabled) {
      setInterval(() => {
        try {
          const yaw = Math.random() * Math.PI * 2;
          const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
          bot.look(yaw, pitch, false);
        } catch {}
      }, botConfig.movement['look-around'].interval);
    }

    // RANDOM JUMP
    if (botConfig.movement?.['random-jump']?.enabled) {
      setInterval(() => {
        try {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 300);
        } catch {}
      }, botConfig.movement['random-jump'].interval);
    }

    // POSITION WALK
    if (botConfig.position?.enabled) {
      const mcData = require('minecraft-data')(bot.version);
      const move = new Movements(bot, mcData);

      bot.pathfinder.setMovements(move);
      bot.pathfinder.setGoal(
        new GoalBlock(
          botConfig.position.x,
          botConfig.position.y,
          botConfig.position.z
        )
      );
    }
  });

  // ================= CHAT =================
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    if (botConfig.chat?.respond) {
      if (message.toLowerCase().includes('hi')) {
        bot.chat(`Hello ${username}`);
      }
    }
  });

  // ================= DISCONNECT =================
  bot.on('end', () => {
    console.log(`[${label}] ❌ Disconnected`);

    if (!botConfig.utils['auto-reconnect']) return;

    reconnectAttempts++;

    const delay = Math.min(
      botConfig.utils['auto-reconnect-delay'] * reconnectAttempts,
      botConfig.utils['max-reconnect-delay']
    );

    console.log(`[${label}] Reconnecting in ${delay}ms`);

    setTimeout(() => {
      createBot(botConfig, label);
    }, delay);
  });

  bot.on('kicked', (reason) => {
    console.log(`[${label}] ⚠️ Kicked: ${reason}`);
  });

  bot.on('error', (err) => {
    console.log(`[${label}] Error: ${err.message}`);
  });
}

// ================= START =================
let started = 0;

if (config.useBot) {
  createBot(config, 'Bot-1');
  started++;
}

if (config2 && config2.useBot) {
  createBot(config2, 'Bot-2');
  started++;
}

if (started === 0) {
  console.log('[SYSTEM] ❌ No bots enabled.');
} else {
  console.log(`[SYSTEM] ✅ ${started} bot(s) started.`);
}
