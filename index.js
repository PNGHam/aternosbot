const mineflayer = require('mineflayer');

// ===== CONFIG =====
const config = {
  host: 'quarrelsmp.mcsh.io', // Example: play.example.com
  port: 25565,            // Example: 25565
  username: 'admin',    // Change bot username
  version: false,         // Auto-detect version
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

// ===== WHEN BOT JOINS =====
bot.once('spawn', () => {
  console.log(`[+] ${config.username} joined the server.`);
});

// ===== AUTO REGISTER / LOGIN =====
bot.on('messagestr', (message) => {
  const msg = message.toLowerCase();

  console.log(`[CHAT] ${message}`);

  // Register if needed
  if (!authenticated && (
    msg.includes('/register') ||
    msg.includes('register with') ||
    msg.includes('please register')
  )) {
    console.log('[*] Registering account...');
    bot.chat(`/register ${config.password} ${config.password}`);

    setTimeout(() => {
      afterAuth();
    }, 3000);

    authenticated = true;
  }

  // Login if needed
  else if (!authenticated && (
    msg.includes('/login') ||
    msg.includes('please login') ||
    msg.includes('log in with')
  )) {
    console.log('[*] Logging in...');
    bot.chat(`/login ${config.password}`);

    setTimeout(() => {
      afterAuth();
    }, 3000);

    authenticated = true;
  }
});

// ===== AFTER LOGIN / REGISTER =====
function afterAuth() {
  console.log('[*] Running commands...');

  bot.chat('/supervanish');

  setTimeout(() => {
    bot.chat('/gamemode spectator');
  }, 1500);
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

// ===== ANTI-AFK (PREVENT SERVER TIMEOUT) =====
// This helps keep the bot active on servers with AFK kick systems.
// It does NOT bypass anti-cheat plugins.

setInterval(() => {
  if (!bot.entity) return;

  // Small head movement
  const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.4;
  const pitch = (Math.random() - 0.5) * 0.2;
  bot.look(yaw, pitch, true);

  // Small legitimate movement
  bot.setControlState('jump', true);

  setTimeout(() => {
    bot.setControlState('jump', false);
  }, 500);

}, 30000);

// ===== OPTIONAL AUTO RECONNECT =====

setInterval(() => {
  if (!bot.player) {
    console.log('[*] Attempting reconnect...');
    process.exit();
  }
}, 10000);
