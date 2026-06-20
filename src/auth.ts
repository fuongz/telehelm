import type { Context, MiddlewareFn } from "telegraf";
import log from "./logger";

// ---- User allowlist -------------------------------------------------------
// The bot token is internet-reachable via Telegram's relay, so the numeric
// user-ID allowlist is the primary access gate. Anything not on it is dropped
// silently (no reply) to avoid confirming the bot exists to strangers.

export const ALLOWED = new Set<string>(
	(process.env.ALLOWED_USER_IDS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);

if (ALLOWED.size === 0) {
	log.error("startup_refused", { reason: "ALLOWED_USER_IDS is empty" });
	// Fail closed: a bot with no allowlist would accept commands from anyone.
	process.exit(1);
}

// ---- Rate limiting --------------------------------------------------------
// Belt-and-suspenders: even an allowlisted account is capped, so a leaked
// token / compromised account can't hammer the daemon. Simple in-memory
// sliding window keyed by user ID.

const MAX = parseInt(process.env.RATE_LIMIT_MAX || "20", 10);
const WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const hits = new Map<string, number[]>(); // userId -> timestamps

function rateLimited(userId: string): boolean {
	const now = Date.now();
	const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW);
	arr.push(now);
	hits.set(userId, arr);
	return arr.length > MAX;
}

// Periodically clear stale entries so the map doesn't grow unbounded.
setInterval(() => {
	const now = Date.now();
	for (const [id, arr] of hits) {
		const fresh = arr.filter((t) => now - t < WINDOW);
		if (fresh.length === 0) hits.delete(id);
		else hits.set(id, fresh);
	}
}, WINDOW).unref();

export function authMiddleware(): MiddlewareFn<Context> {
	return async (ctx, next) => {
		const from = ctx.from;
		if (!from) return; // service updates with no user

		const userId = String(from.id);

		if (!ALLOWED.has(userId)) {
			log.warn("unauthorized", { userId, username: from.username });
			return; // silent drop
		}

		if (rateLimited(userId)) {
			log.warn("rate_limited", { userId, username: from.username });
			if (ctx.callbackQuery)
				await ctx.answerCbQuery("Slow down ⏳").catch(() => {});
			else
				await ctx
					.reply("Slow down — too many requests. Try again shortly.")
					.catch(() => {});
			return;
		}

		return next();
	};
}
