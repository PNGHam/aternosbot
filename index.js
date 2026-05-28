const mineflayer = require('mineflayer');

// ===== CONFIG =====
const config = {
  host: 'quarrelsmp.mcsh.io', // Example: play.example.com
  port: 25565,
  username: 'admin',
  version: false,
  password: 'passwordis123'
};

// ===== CREATE BOT =====
const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version
});

let authenticated = false;
let joinTime = 0;

// ===== WHEN BOT JOINS =====
bot.once('spawn', () => {
  joinTime = Date.now();
  console.log(`[+] ${config.username} joined the server.`);
  console.log('[*] Waiting 5 seconds before login/register...');
});

// ===== AUTO REGISTER / LOGIN =====
bot.on('messagestr', (message) => {
  const msg = message.toLowerCase();

  console.log(`[CHAT] ${message}`);

  if (authenticated) return;

  // Wait at least 5 seconds after joining
  const timeSinceJoin = Date.now() - joinTime;

  if (timeSinceJoin < 5000) {
    return;
  }

  // Register if needed
  if (
    msg.includes('/register') ||
    msg.includes('register with') ||
    msg.includes('please register')
  ) {
    authenticated = true;

    console.log('[*] Registering account...');

    bot.chat(`/register ${config.password} ${config.password}`);

    setTimeout(() => {
      afterAuth();
    }, 5000);
  }

  // Login if needed
  else if (
    msg.includes('/login') ||
    msg.includes('please login') ||
    msg.includes('log in with')
  ) {
    authenticated = true;

    console.log('[*] Logging in...');

    bot.chat(`/login ${config.password}`);

    setTimeout(() => {
      afterAuth();
    }, 5000);
  }
});

// ===== AFTER LOGIN / REGISTER =====
function afterAuth() {
  console.log('[*] Running commands...');

  bot.chat('/supervanish');

  setTimeout(() => {
    bot.chat('/gamemode spectator');
  }, 2000);
}

// ===== ERROR HANDLING =====
bot.on('kicked', (reason) => {
  console.log('[!] Kicked:', reason);
});

bot.on('error', (err) => {
  console.log('[!] Error:', err);
});

bot.on('end', () => {
  console.log('[!] Disconnected from server.');
});

// ===== ANTI-AFK =====
// Keeps the bot active so many servers won't kick it for inactivity.

setInterval(() => {
  if (!bot.entity) return;

  // Random head movement
  const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.4;
  const pitch = (Math.random() - 0.5) * 0.2;

  bot.look(yaw, pitch, true);

  // Small jump
  bot.setControlState('jump', true);

  setTimeout(() => {
    bot.setControlState('jump', false);
  }, 400);

}, 30000);

/*
========================
INSTALLATION
========================

1. Install Node.js
https://nodejs.org/

2. Save this file as bot.js

3. Install Mineflayer:

npm init -y
npm install mineflayer

4. Edit the config section.

5. Run the bot:

node bot.js
*/
