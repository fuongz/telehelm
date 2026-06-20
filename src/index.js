'use strict';

const { Telegraf } = require('telegraf');
const { authMiddleware } = require('./auth');
const { register } = require('./handlers');
const d = require('./docker');
const log = require('./logger');

const token = process.env.BOT_TOKEN;
if (!token) {
  log.error('startup_refused', { reason: 'BOT_TOKEN missing' });
  process.exit(1);
}

const bot = new Telegraf(token);

// Auth + rate limit run before any handler sees the update.
bot.use(authMiddleware());

register(bot);

bot.catch((err, ctx) => {
  log.error('bot_error', { error: err.message, updateType: ctx && ctx.updateType });
});

async function main() {
  // Verify the proxy path works before we start accepting commands.
  try {
    await d.ping();
    log.info('docker_proxy_ok');
  } catch (e) {
    log.error('docker_proxy_unreachable', { error: e.message });
    // Don't exit — Telegram may still be useful and the proxy might come up.
  }

  // Long polling: the bot dials OUT to Telegram. No inbound ports, NAT-friendly.
  await bot.launch({ dropPendingUpdates: true });
  log.info('bot_started');
}

// Graceful shutdown so Telegram releases the polling session cleanly.
function shutdown(sig) {
  log.info('shutdown', { signal: sig });
  bot.stop(sig);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  log.error('fatal', { error: e.message });
  process.exit(1);
});
