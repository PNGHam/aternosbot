'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');

// ================= CONFIG =================
const config1 = require('./settings.json');
let config2 = fs.existsSync('./settings2.json')
  ? require('./settings2.json')
  : null;

// ================= EXPRESS =================
const app = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.send(`Bots running: ${bots.length}`);
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// ================= STATE =================
let bots = [];

// ================= PERFORMANCE OPTIMIZED DISCORD =================
let lastDiscordSend = 0;
const DISCORD_COOLDOWN = 5000;

function sendDiscordWebhook(botConfig, content, color = 0x00ff00) {
  if (!botConfig.discord?.enabled || !botConfig.discord.webhookUrl) return;

  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_COOLDOWN) return;
  lastDiscordSend = now;

  const url = new URL(botConfig.discord.webhookUrl);
  const protocol = url.protocol === 'https:' ? https : http;

  const payload = JSON.stringify({
    username: config.name,
    embeds: [{
      description: content,
      color: color,
      timestamp: new Date().toISOString(),
      footer: { text: 'Slobos AFK Bot' }
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

  const req = protocol.request(options);
  req.on('error', err => console.log('[Discord Error]', err.message));
  req.write(payload);
  req.end();
}

// ================= BOT CREATION =================
function createBot(botConfig, label = 'Bot') {
  if (!botConfig.useBot) return;

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
  if (!bots.includes(bot)) bots.push(bot);

  bot.loadPlugin(pathfinder);

  let reconnectAttempts = 0;
  let intervals = [];

  // ================= CLEANUP HELPER =================
  const clearAllIntervals = () => {
    for (const id of intervals) clearInterval(id);
    intervals = [];
  };

  // ================= SPAWN =================
  bot.once('spawn', () => {
    console.log(`[${label}] Connected`);

    sendDiscordWebhook(botConfig, `[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);

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

    // ================= ANTI AFK (OPTIMIZED INTERVAL TRACKING) =================
    if (botConfig.utils['anti-afk']?.enabled) {
      intervals.push(setInterval(() => {
        try { bot.swingArm(); } catch {}
      }, 30000));

      intervals.push(setInterval(() => {
        try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch {}
      }, 60000));
    }

    // ================= CHAT MESSAGES =================
    if (botConfig.utils['chat-messages']?.enabled) {
      const msgs = botConfig.utils['chat-messages'].messages;
      let i = 0;

      intervals.push(setInterval(() => {
        bot.chat(msgs[i]);
        i = (i + 1) % msgs.length;
      }, botConfig.utils['chat-messages']['repeat-delay'] * 1000));
    }

    // ================= MOVEMENT =================
    if (botConfig.movement?.['look-around']?.enabled) {
      intervals.push(setInterval(() => {
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
        bot.look(yaw, pitch, false);
      }, botConfig.movement['look-around'].interval));
    }

    if (botConfig.movement?.['random-jump']?.enabled) {
      intervals.push(setInterval(() => {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
      }, botConfig.movement['random-jump'].interval));
    }
  });

  // ================= CHAT =================
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    console.log(`[${label}] ${username}: ${message}`);

    if (botConfig.discord?.events?.chat) {
      sendDiscordWebhook(botConfig, `💬 **${username}**: ${message}`, 0x7289da);
    }

    if (botConfig.chat?.respond && message.toLowerCase().includes('hi')) {
      bot.chat(`Hello ${username}`);
    }
  });

  // ================= KICK =================
  bot.on('kicked', (reason) => {
    console.log(`[${label}] Kicked:`, reason);
    sendDiscordWebhook(botConfig, `[!] **Kicked**: ${kickReason}`, 0xff0000);
    clearAllIntervals();
  });

  // ================= DISCONNECT =================
  bot.on('end', (reason) => {
    console.log(`[${label}] Disconnected`);

    sendDiscordWebhook(botConfig, "[-] **Disconnected**: ${reason || 'Unknown'}`, 0xf87171));

    clearAllIntervals();

    reconnectAttempts++;

    const delay = Math.min(
      (botConfig.utils['auto-reconnect-delay'] || 3000) * reconnectAttempts,
      botConfig.utils['max-reconnect-delay'] || 30000
    );

    console.log(`[${label}] Reconnecting in ${delay}ms`);

    setTimeout(() => createBot(botConfig, label), delay);
  });

  // ================= ERROR =================
  bot.on('error', (err) => {
    console.log(`[${label}] Error: ${err.message}`);
  });
}

// ================= START =================
let started = 0;

if (config1.useBot) {
  createBot(config1, 'Bot-1');
  started++;
}

if (config2?.useBot) {
  createBot(config2, 'Bot-2');
  started++;
}

if (started === 0) {
  console.log('[SYSTEM] No bots enabled');
} else {
  console.log(`[SYSTEM] ${started} bot(s) running`);
}
