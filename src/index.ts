import { Telegraf, type Context } from 'telegraf';
import { authMiddleware } from './auth';
import { register } from './handlers';
import * as d from './docker';
import log from './logger';

const token = process.env.BOT_TOKEN;
if (!token) {
  log.error('startup_refused', { reason: 'BOT_TOKEN missing' });
  process.exit(1);
}

const bot = new Telegraf<Context>(token);

// Auth + rate limit run before any handler sees the update.
bot.use(authMiddleware());

register(bot);

bot.catch((err, ctx) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error('bot_error', { error: msg, updateType: ctx?.updateType });
});

async function main(): Promise<void> {
  // Verify the proxy path works before we start accepting commands.
  try {
    await d.ping();
    log.info('docker_proxy_ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('docker_proxy_unreachable', { error: msg });
    // Don't exit — Telegram may still be useful and the proxy might come up.
  }

  // Long polling: the bot dials OUT to Telegram. No inbound ports, NAT-friendly.
  await bot.launch({ dropPendingUpdates: true });
  log.info('bot_started');
}

// Graceful shutdown so Telegram releases the polling session cleanly.
function shutdown(sig: NodeJS.Signals): void {
  log.info('shutdown', { signal: sig });
  bot.stop(sig);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  log.error('fatal', { error: msg });
  process.exit(1);
});
