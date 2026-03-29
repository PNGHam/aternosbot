'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');

// ================= LOAD CONFIGS =================
const config1 = require('./settings.json');
let config2 = null;

if (fs.existsSync('./settings2.json')) {
  config2 = require('./settings2.json');
}

// ================= EXPRESS SERVER =================
const app = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.send(`Bots running: ${bots.length}`);
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// ================= BOT STORAGE =================
let bots = [];

// ================= DISCORD =================
function sendDiscordWebhook(botConfig, content, color = 0x00ff00) {
  if (!botConfig.discord?.enabled) return;
  if (!botConfig.discord.webhookUrl) return;

  const url = new URL(botConfig.discord.webhookUrl);

  const payload = JSON.stringify({
    username: botConfig.name || "Bot",
    embeds: [{
      description: content,
      color: color,
      timestamp: new Date().toISOString()
    }]
  });

  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options);
  req.on('error', err => console.log('[Discord Error]', err.message));
  req.write(payload);
  req.end();
}

// ================= CREATE BOT =================
function createBot(botConfig, label = 'Bot') {

  if (!botConfig.useBot) {
    console.log(`[${label}] Disabled (useBot = false)`);
    return;
  }

  console.log(`[${label}] Connecting to ${botConfig.server.ip}`);

  let bot = mineflayer.createBot({
    username: botConfig['bot-account'].username,
    password: botConfig['bot-account'].password || undefined,
    auth: botConfig['bot-account'].type,
    host: botConfig.server.ip,
    port: botConfig.server.port,
    version: false
  });

  bots.push(bot);
  bot.loadPlugin(pathfinder);

  let reconnectAttempts = 0;

  bot.once('spawn', () => {
    console.log(`[${label}] ✅ Connected`);

    sendDiscordWebhook(botConfig, `🟢 **${label} Connected** to ${botConfig.server.ip}`, 0x4ade80);

    reconnectAttempts = 0;

    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);

    // ================= AUTO AUTH =================
    if (botConfig.utils['auto-auth']?.enabled) {
      const pass = botConfig.utils['auto-auth'].password;

      setTimeout(() => {
        bot.chat(`/login ${pass}`);
        bot.chat(`/register ${pass} ${pass}`);
      }, 3000);
    }

    // ================= ANTI AFK =================
    if (botConfig.utils['anti-afk']?.enabled) {

      setInterval(() => {
        try { bot.swingArm(); } catch {}
      }, 30000);

      setInterval(() => {
        try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch {}
      }, 60000);
    }

    // ================= CHAT SPAM =================
    if (botConfig.utils['chat-messages']?.enabled) {
      const msgs = botConfig.utils['chat-messages'].messages;
      let i = 0;

      setInterval(() => {
        bot.chat(msgs[i]);
        i = (i + 1) % msgs.length;
      }, botConfig.utils['chat-messages']['repeat-delay'] * 1000);
    }

    // ================= MOVEMENT =================
    if (botConfig.movement?.look-around?.enabled) {
      setInterval(() => {
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
        bot.look(yaw, pitch, false);
      }, botConfig.movement['look-around'].interval);
    }

    if (botConfig.movement?.random-jump?.enabled) {
      setInterval(() => {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
      }, botConfig.movement['random-jump'].interval);
    }
  });

  // ================= CHAT =================
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    console.log(`[${label}] ${username}: ${message}`);

    if (botConfig.discord?.events?.chat) {
      sendDiscordWebhook(botConfig, `💬 **${username}**: ${message}`, 0x7289da);
    }

    if (botConfig.chat?.respond) {
      if (message.toLowerCase().includes('hi')) {
        bot.chat(`Hello ${username}`);
      }
    }
  });

  // ================= KICK =================
  bot.on('kicked', (reason) => {
    console.log(`[${label}] ⚠️ Kicked: ${reason}`);

    sendDiscordWebhook(botConfig, `⚠️ **${label} Kicked**: ${reason}`, 0xff0000);
  });

  // ================= DISCONNECT =================
  bot.on('end', () => {
    console.log(`[${label}] ❌ Disconnected`);

    sendDiscordWebhook(botConfig, `🔴 **${label} Disconnected**`, 0xf87171);

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

  // ================= ERROR =================
  bot.on('error', (err) => {
    console.log(`[${label}] Error: ${err.message}`);
  });
}

// ================= START SYSTEM =================
let started = 0;

if (config1.useBot) {
  createBot(config1, 'Bot-1');
  started++;
}

if (config2 && config2.useBot) {
  createBot(config2, 'Bot-2');
  started++;
}

if (started === 0) {
  console.log('[SYSTEM] ❌ No bots enabled.');
} else {
  console.log(`[SYSTEM] ✅ ${started} bot(s) running.`);
}
