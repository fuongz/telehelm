import { type Context, Markup, type Telegraf } from "telegraf";
import * as d from "./docker";
import log from "./logger";
import * as mon from "./monitor";

// Verbs that mutate state require a second tap to confirm.
type Verb = "start" | "stop" | "restart";
const ACTIONS: Record<Verb, (id: string) => Promise<void>> = {
	start: d.start,
	stop: d.stop,
	restart: d.restart,
};
const isVerb = (s: string): s is Verb => s in ACTIONS;

const STATE_EMOJI: Record<string, string> = {
	running: "🟢",
	exited: "🔴",
	paused: "🟡",
	created: "⚪",
	dead: "⚫",
};

type Keyboard = ReturnType<typeof Markup.inlineKeyboard>;

function fmtBytes(n: number | undefined): string {
	if (!n) return "0 B";
	const u = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(n) / Math.log(1024));
	return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
}

// Safely edit the message a callback came from; fall back to a fresh reply.
async function render(
	ctx: Context,
	text: string,
	keyboard?: Keyboard,
): Promise<void> {
	const extra = { parse_mode: "Markdown" as const, ...(keyboard || {}) };
	try {
		if (ctx.updateType === "callback_query") {
			await ctx.editMessageText(text, extra);
		} else {
			await ctx.reply(text, extra);
		}
	} catch (e) {
		// "message is not modified" and similar are non-fatal.
		const msg = e instanceof Error ? e.message : String(e);
		if (!/not modified/i.test(msg)) {
			await ctx.reply(text, extra).catch(() => {});
		}
	}
}

// ---- Views ----------------------------------------------------------------

async function listView(ctx: Context): Promise<void> {
	const containers = await d.listContainers();
	if (containers.length === 0) {
		return render(ctx, "No containers found.");
	}
	containers.sort((a, b) => a.name.localeCompare(b.name));
	const rows = containers.map((c) => [
		Markup.button.callback(
			`${STATE_EMOJI[c.state] || "⚪"} ${c.name}`,
			`c:${c.id}`,
		),
	]);
	rows.push([Markup.button.callback("🔄 Refresh", "ps")]);
	return render(
		ctx,
		"*Containers* — tap one to manage:",
		Markup.inlineKeyboard(rows),
	);
}

async function menuView(ctx: Context, id: string): Promise<void> {
	const c = await d.inspect(id);
	const running = c.state === "running";
	const kb = [
		[
			Markup.button.callback("📄 Logs", `a:logs:${id}`),
			Markup.button.callback("📊 Stats", `a:stats:${id}`),
		],
		[Markup.button.callback("🔔 Monitor", `a:mon:${id}`)],
		running
			? [
					Markup.button.callback("⏹️ Stop", `a:stop:${id}`),
					Markup.button.callback("🔄 Restart", `a:restart:${id}`),
				]
			: [Markup.button.callback("▶️ Start", `a:start:${id}`)],
		[Markup.button.callback("⬅️ Back", "ps")],
	];
	const text = `*${c.name}*\nState: ${STATE_EMOJI[c.state] || ""} ${c.state}\nImage: \`${c.image}\``;
	return render(ctx, text, Markup.inlineKeyboard(kb));
}

async function confirmView(
	ctx: Context,
	verb: Verb,
	id: string,
): Promise<void> {
	const c = await d.inspect(id);
	const kb = Markup.inlineKeyboard([
		[
			Markup.button.callback(`✅ Yes, ${verb}`, `do:${verb}:${id}`),
			Markup.button.callback("❌ Cancel", `c:${id}`),
		],
	]);
	return render(ctx, `Confirm *${verb}* on *${c.name}*?`, kb);
}

async function logsView(ctx: Context, id: string): Promise<void> {
	const { name, text } = await d.logs(id, 100);
	const trimmed = (text || "(no output)").slice(-3500);
	const body = `*Logs — ${name}* (last 100 lines)\n\`\`\`\n${trimmed}\n\`\`\``;
	const kb = Markup.inlineKeyboard([
		[Markup.button.callback("⬅️ Back", `c:${id}`)],
	]);
	return render(ctx, body, kb);
}

async function statsView(ctx: Context, id: string): Promise<void> {
	const s = await d.stats(id);
	const kb = Markup.inlineKeyboard([
		[Markup.button.callback("⬅️ Back", `c:${id}`)],
	]);
	if (!s.running) {
		return render(ctx, `*${s.name}* is not running — no stats.`, kb);
	}
	const text =
		`*Stats — ${s.name}*\n` +
		`CPU: ${(s.cpuPct ?? 0).toFixed(1)}%\n` +
		`Mem: ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memLimit)} (${(s.memPct ?? 0).toFixed(1)}%)`;
	return render(ctx, text, kb);
}

// ---- Log monitors ----------------------------------------------------------

// Pending "send me the pattern" prompts, keyed by user id. The next plain-text
// message from that user is consumed as the monitor spec. Entries self-expire
// so a forgotten prompt can't capture an unrelated message hours later.
const PROMPT_TTL_MS = 5 * 60 * 1000;
const awaiting = new Map<string, { containerId: string; expires: number }>();

function fmtMonitor(m: mon.Monitor): string {
	const dot = m.enabled ? "🟢" : "⚪";
	return `${dot} \`/${m.pattern}/\` every ${m.intervalSec}s`;
}

async function monitorView(ctx: Context, id: string): Promise<void> {
	const c = await d.inspect(id);
	const list = mon.listMonitors(id);
	const rows = list.map((m) => [
		Markup.button.callback(
			`${m.enabled ? "⏸️ Pause" : "▶️ Resume"}`,
			`mon:tog:${m.id}`,
		),
		Markup.button.callback("🗑️ Delete", `mon:del:${m.id}`),
	]);
	rows.push([Markup.button.callback("➕ Add monitor", `mon:add:${id}`)]);
	rows.push([Markup.button.callback("⬅️ Back", `c:${id}`)]);

	const lines = list.length
		? list.map(fmtMonitor).join("\n")
		: "_No monitors yet._";
	const text =
		`*Monitors — ${c.name}*\n${lines}\n\n` +
		"A monitor checks new logs every N seconds and pings you when a line " +
		"matches its regex.";
	return render(ctx, text, Markup.inlineKeyboard(rows));
}

// Begin the add flow: stash who's adding to what, then ask for the spec.
async function monitorAddPrompt(ctx: Context, id: string): Promise<void> {
	const from = ctx.from;
	if (!from) return;
	awaiting.set(String(from.id), {
		containerId: id,
		expires: Date.now() + PROMPT_TTL_MS,
	});
	const c = await d.inspect(id);
	const text =
		`*Add monitor — ${c.name}*\n` +
		"Reply with the interval (seconds) then the regex, e.g.\n" +
		"`30 ERROR|panic|fatal`\n\n" +
		"Send /cancel to abort.";
	const kb = Markup.inlineKeyboard([
		[Markup.button.callback("❌ Cancel", `a:mon:${id}`)],
	]);
	return render(ctx, text, kb);
}

// Consume the user's reply to an add prompt. Returns true if it was handled.
async function handleMonitorReply(
	ctx: Context,
	text: string,
): Promise<boolean> {
	const from = ctx.from;
	if (!from) return false;
	const userId = String(from.id);
	const pending = awaiting.get(userId);
	if (!pending) return false;

	if (pending.expires < Date.now()) {
		awaiting.delete(userId);
		await ctx.reply("That add prompt expired — tap 🔔 Monitor again.");
		return true;
	}
	if (/^\/cancel\b/.test(text.trim())) {
		awaiting.delete(userId);
		await ctx.reply("Cancelled.");
		return true;
	}

	// First token = interval, the rest (verbatim) = regex.
	const trimmed = text.trim();
	const sp = trimmed.indexOf(" ");
	const intervalSec = parseInt(sp === -1 ? trimmed : trimmed.slice(0, sp), 10);
	const pattern = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

	const chat = ctx.chat;
	try {
		mon.validate(pattern, intervalSec);
		const info = await d.inspect(pending.containerId);
		const m = mon.addMonitor({
			containerId: pending.containerId,
			containerName: info.name,
			pattern,
			intervalSec,
			chatId: chat ? chat.id : from.id,
			createdBy: userId,
		});
		awaiting.delete(userId);
		await ctx.reply(
			`✅ Monitoring *${info.name}* for \`/${m.pattern}/\` every ${m.intervalSec}s.`,
			{ parse_mode: "Markdown" },
		);
	} catch (e) {
		// Keep the prompt open so the user can correct and resend.
		const msg = e instanceof Error ? e.message : String(e);
		await ctx.reply(`⚠️ ${msg}\nTry again, or /cancel.`);
	}
	return true;
}

// Flat list of every monitor across all containers, for /watches.
async function watchesView(ctx: Context): Promise<void> {
	const list = mon.listMonitors();
	if (list.length === 0) {
		return render(
			ctx,
			"No monitors configured. Open a container → 🔔 Monitor.",
		);
	}
	list.sort((a, b) => a.containerName.localeCompare(b.containerName));
	const lines = list.map((m) => `*${m.containerName}* — ${fmtMonitor(m)}`);
	return render(ctx, `*All monitors*\n${lines.join("\n")}`);
}

async function execute(ctx: Context, verb: Verb, id: string): Promise<void> {
	const from = ctx.from;
	const who = {
		userId: from ? String(from.id) : "unknown",
		username: from?.username,
	};
	let name = id;
	try {
		const info = await d.inspect(id);
		name = info.name;
		await ACTIONS[verb](id);
		log.audit({ ...who, action: verb, target: name, result: "ok" });
		await ctx.answerCbQuery(`${verb} ✓`).catch(() => {});
		// Brief pause so Docker settles, then show refreshed menu.
		await new Promise((r) => setTimeout(r, 600));
		return menuView(ctx, id);
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		log.audit({ ...who, action: verb, target: name, result: "error", detail });
		await ctx.answerCbQuery("Failed").catch(() => {});
		const kb = Markup.inlineKeyboard([
			[Markup.button.callback("⬅️ Back", `c:${id}`)],
		]);
		return render(ctx, `⚠️ *${verb}* on *${name}* failed:\n\`${detail}\``, kb);
	}
}

// ---- Registration ---------------------------------------------------------

export function register(bot: Telegraf<Context>): void {
	bot.start((ctx) =>
		ctx.reply(
			"Docker control bot ready. Use /ps to list and manage containers, /help for commands.",
		),
	);

	bot.help((ctx) =>
		ctx.reply(
			[
				"*Commands*",
				"/ps — list containers, then tap to manage",
				"/watches — list all active log monitors",
				"",
				"From a container you can view Logs, Stats, Start/Stop/Restart,",
				"and set up 🔔 Monitor — a regex watch on new log lines that pings",
				"you when it matches. Lifecycle actions ask for confirmation first.",
			].join("\n"),
			{ parse_mode: "Markdown" },
		),
	);

	bot.command("ps", listView);
	bot.command("watches", watchesView);

	// Plain-text replies feed the "add monitor" flow when one is pending for
	// this user; otherwise they're ignored (commands are handled above).
	bot.on("text", async (ctx, next) => {
		const text = "text" in ctx.message ? ctx.message.text : "";
		if (text.startsWith("/")) return next?.();
		const handled = await handleMonitorReply(ctx, text);
		if (!handled) return next?.();
	});

	// Single callback router for all inline-button taps.
	bot.on("callback_query", async (ctx) => {
		const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
		try {
			if (data === "ps") {
				await ctx.answerCbQuery().catch(() => {});
				return listView(ctx);
			}
			const [kind, a, b] = data.split(":");

			if (kind === "c" && a) {
				await ctx.answerCbQuery().catch(() => {});
				return menuView(ctx, a);
			}
			if (kind === "a" && a && b) {
				const verb = a;
				const id = b;
				if (verb === "logs") {
					await ctx.answerCbQuery("Fetching…").catch(() => {});
					return logsView(ctx, id);
				}
				if (verb === "stats") {
					await ctx.answerCbQuery("Sampling…").catch(() => {});
					return statsView(ctx, id);
				}
				if (verb === "mon") {
					// Opening the monitor list also cancels any pending add prompt
					// (e.g. the Cancel button routes here).
					if (ctx.from) awaiting.delete(String(ctx.from.id));
					await ctx.answerCbQuery().catch(() => {});
					return monitorView(ctx, id);
				}
				if (isVerb(verb)) {
					await ctx.answerCbQuery().catch(() => {});
					return confirmView(ctx, verb, id);
				}
			}
			if (kind === "do" && a && b && isVerb(a)) {
				return execute(ctx, a, b);
			}
			if (kind === "mon" && a && b) {
				if (a === "add") {
					await ctx.answerCbQuery().catch(() => {});
					return monitorAddPrompt(ctx, b);
				}
				if (a === "tog") {
					const m = mon.toggleMonitor(b);
					await ctx
						.answerCbQuery(m?.enabled ? "Resumed" : "Paused")
						.catch(() => {});
					if (m) return monitorView(ctx, m.containerId);
				}
				if (a === "del") {
					const m = mon.removeMonitor(b);
					await ctx.answerCbQuery(m ? "Deleted" : "Gone").catch(() => {});
					if (m) return monitorView(ctx, m.containerId);
				}
			}
			await ctx.answerCbQuery().catch(() => {});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log.error("callback_error", { data, error: msg });
			await ctx.answerCbQuery("Error").catch(() => {});
			await ctx.reply(`⚠️ Error: ${msg}`).catch(() => {});
		}
	});
}
