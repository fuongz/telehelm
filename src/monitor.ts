// Log monitors: watch a container's output for lines matching a regex and ping
// the user on Telegram when new matches appear. Each monitor is an independent
// poller (its own interval); we only ever inspect logs emitted SINCE the last
// check, so a steady pre-existing line never re-fires — only fresh matches do.
//
// State persists to a JSON file on a writable volume (see compose `monitors`
// volume + the /data dir created in the Dockerfile). If that path can't be
// written we fall back to in-memory and warn — the feature still works for the
// life of the process, monitors just won't survive a restart.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as d from "./docker";
import log from "./logger";

export interface Monitor {
	id: string; // short, opaque — also used in callback_data
	containerId: string; // SHORT (12-char) id, as everything else uses
	containerName: string; // cached for display; refreshed on match
	pattern: string; // regex source
	intervalSec: number;
	chatId: number; // where matches are delivered
	createdBy: string; // telegram user id, for the audit trail
	enabled: boolean;
	lastCheck: number; // unix seconds; logs newer than this are considered
	fails: number; // consecutive poll errors, for auto-disable
}

// (chatId, markdown text) -> delivered. Injected at init so this module never
// imports Telegraf directly.
type SendFn = (chatId: number, text: string) => Promise<void>;

const FILE = process.env.MONITORS_FILE || "/data/monitors.json";
const MIN_INTERVAL = parseInt(process.env.MONITOR_MIN_INTERVAL || "5", 10);
const MAX_INTERVAL = parseInt(process.env.MONITOR_MAX_INTERVAL || "86400", 10);
const MAX_FAILS = 5; // disable a monitor after this many consecutive errors
const MATCH_LINE_CAP = 10; // lines shown per notification
const MSG_CHAR_CAP = 3500; // keep under Telegram's 4096 limit, with headroom

const monitors = new Map<string, Monitor>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
let send: SendFn = async () => {}; // no-op until init wires in the real sender
let persistOk = true;

// ---- Persistence ----------------------------------------------------------

function persist(): void {
	if (!persistOk) return;
	try {
		mkdirSync(dirname(FILE), { recursive: true });
		writeFileSync(FILE, JSON.stringify([...monitors.values()], null, 2));
	} catch (e) {
		// Flip to in-memory mode once; don't spam the log every interval.
		if (persistOk) {
			persistOk = false;
			log.warn("monitor_persist_disabled", {
				file: FILE,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
}

function load(): void {
	try {
		const arr = JSON.parse(readFileSync(FILE, "utf8")) as Monitor[];
		for (const m of arr) monitors.set(m.id, m);
		log.info("monitors_loaded", { count: monitors.size });
	} catch {
		// First run / no file yet — start empty, not an error.
	}
}

// ---- Validation ------------------------------------------------------------

// Throws a user-facing Error on bad input; returns the compiled regex on ok.
export function validate(pattern: string, intervalSec: number): RegExp {
	if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL) {
		throw new Error(`Interval must be a number ≥ ${MIN_INTERVAL} (seconds).`);
	}
	if (intervalSec > MAX_INTERVAL) {
		throw new Error(`Interval must be ≤ ${MAX_INTERVAL} seconds.`);
	}
	if (!pattern.trim()) throw new Error("Pattern is empty.");
	try {
		return new RegExp(pattern);
	} catch (e) {
		throw new Error(
			`Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// ---- Polling ---------------------------------------------------------------

async function check(m: Monitor): Promise<void> {
	if (!m.enabled) return;
	const now = Math.floor(Date.now() / 1000);
	let re: RegExp;
	try {
		re = new RegExp(m.pattern);
	} catch {
		return; // shouldn't happen — validated at creation
	}

	try {
		const text = await d.logsSince(m.containerId, m.lastCheck);
		m.lastCheck = now;
		m.fails = 0;

		const matched = text
			.split("\n")
			.filter((line) => line.length > 0 && re.test(line));

		if (matched.length > 0) {
			// Refresh the name in case it changed; best-effort.
			try {
				m.containerName = (await d.inspect(m.containerId)).name;
			} catch {}
			await notify(m, matched);
		}
		persist();
	} catch (e) {
		m.fails += 1;
		const detail = e instanceof Error ? e.message : String(e);
		log.warn("monitor_check_failed", {
			id: m.id,
			container: m.containerName,
			fails: m.fails,
			error: detail,
		});
		if (m.fails >= MAX_FAILS) {
			m.enabled = false;
			stopTimer(m.id);
			await send(
				m.chatId,
				`⚠️ Monitor on *${m.containerName}* disabled after ${MAX_FAILS} ` +
					`failed checks.\nLast error: \`${detail}\``,
			).catch(() => {});
		}
		persist();
	}
}

async function notify(m: Monitor, lines: string[]): Promise<void> {
	const shown = lines.slice(0, MATCH_LINE_CAP);
	const more =
		lines.length > shown.length
			? `\n…+${lines.length - shown.length} more`
			: "";
	let body = shown.join("\n");
	if (body.length > MSG_CHAR_CAP) body = `${body.slice(0, MSG_CHAR_CAP)}\n…`;

	const text =
		`🔔 *Match — ${m.containerName}*\n` +
		`Pattern: \`${m.pattern}\`\n` +
		`${lines.length} new matching line(s):\n` +
		`\`\`\`\n${body}${more}\n\`\`\``;
	await send(m.chatId, text).catch((e) => {
		log.warn("monitor_notify_failed", {
			id: m.id,
			error: e instanceof Error ? e.message : String(e),
		});
	});
}

function startTimer(m: Monitor): void {
	stopTimer(m.id);
	if (!m.enabled) return;
	// unref so a pending tick never blocks process shutdown.
	const t = setInterval(() => void check(m), m.intervalSec * 1000);
	t.unref?.();
	timers.set(m.id, t);
}

function stopTimer(id: string): void {
	const t = timers.get(id);
	if (t) {
		clearInterval(t);
		timers.delete(id);
	}
}

// ---- Public API (used by handlers) ----------------------------------------

export function listMonitors(containerId?: string): Monitor[] {
	const all = [...monitors.values()];
	return containerId ? all.filter((m) => m.containerId === containerId) : all;
}

export function getMonitor(id: string): Monitor | undefined {
	return monitors.get(id);
}

export interface AddInput {
	containerId: string;
	containerName: string;
	pattern: string;
	intervalSec: number;
	chatId: number;
	createdBy: string;
}

// Validates, persists, and immediately starts polling. Throws on bad input.
export function addMonitor(input: AddInput): Monitor {
	validate(input.pattern, input.intervalSec);
	const id = crypto.randomUUID().slice(0, 8);
	const m: Monitor = {
		id,
		containerId: input.containerId,
		containerName: input.containerName,
		pattern: input.pattern,
		intervalSec: input.intervalSec,
		chatId: input.chatId,
		createdBy: input.createdBy,
		enabled: true,
		lastCheck: Math.floor(Date.now() / 1000), // watch from now forward only
		fails: 0,
	};
	monitors.set(id, m);
	startTimer(m);
	persist();
	log.audit({
		userId: input.createdBy,
		action: "monitor_add",
		target: `${input.containerName} /${input.pattern}/ @${input.intervalSec}s`,
		result: "ok",
	});
	return m;
}

export function removeMonitor(id: string): Monitor | undefined {
	const m = monitors.get(id);
	if (!m) return undefined;
	stopTimer(id);
	monitors.delete(id);
	persist();
	return m;
}

// Flip enabled on/off. Re-enabling resets the failure counter and the watch
// window so it starts fresh from now (no backlog flood).
export function toggleMonitor(id: string): Monitor | undefined {
	const m = monitors.get(id);
	if (!m) return undefined;
	m.enabled = !m.enabled;
	if (m.enabled) {
		m.fails = 0;
		m.lastCheck = Math.floor(Date.now() / 1000);
		startTimer(m);
	} else {
		stopTimer(id);
	}
	persist();
	return m;
}

// Load saved monitors, wire the notifier, and start every enabled poller.
export function initMonitors(sender: SendFn): void {
	send = sender;
	load();
	for (const m of monitors.values()) startTimer(m);
	if (monitors.size > 0) {
		log.info("monitors_started", {
			active: [...monitors.values()].filter((m) => m.enabled).length,
		});
	}
}
