import { Telegraf, type Context } from "telegraf";
import { authMiddleware } from "./auth";
import * as d from "./docker";
import { register } from "./handlers";
import log from "./logger";
import { initMonitors } from "./monitor";

const token = process.env.BOT_TOKEN;
if (!token) {
	log.error("startup_refused", { reason: "BOT_TOKEN missing" });
	process.exit(1);
}

const bot = new Telegraf<Context>(token);

// Auth + rate limit run before any handler sees the update.
bot.use(authMiddleware());

register(bot);

bot.catch((err, ctx) => {
	const msg = err instanceof Error ? err.message : String(err);
	log.error("bot_error", { error: msg, updateType: ctx?.updateType });
});

async function main(): Promise<void> {
	// Verify the proxy path works before we start accepting commands.
	try {
		await d.ping();
		log.info("docker_proxy_ok");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.error("docker_proxy_unreachable", { error: msg });
		// Don't exit — Telegram may still be useful and the proxy might come up.
	}

	// Restore saved log monitors and start their pollers. Notifications are sent
	// via the bot's outbound Telegram channel, the same path commands reply on.
	initMonitors((chatId, text) =>
		bot.telegram
			.sendMessage(chatId, text, { parse_mode: "Markdown" })
			.then(() => {}),
	);

	// Long polling: the bot dials OUT to Telegram. No inbound ports, NAT-friendly.
	await bot.launch({ dropPendingUpdates: true });
	log.info("bot_started");
}

// Graceful shutdown so Telegram releases the polling session cleanly.
function shutdown(sig: NodeJS.Signals): void {
	log.info("shutdown", { signal: sig });
	bot.stop(sig);
	process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

main().catch((e) => {
	const msg = e instanceof Error ? e.message : String(e);
	log.error("fatal", { error: msg });
	process.exit(1);
});
