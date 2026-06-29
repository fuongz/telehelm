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
	// Monitor kind. Absent (or "regex") = the original pattern watch. "silence"
	// = a heartbeat watch that alerts when the container stops producing logs.
	type?: "regex" | "silence";
	pattern: string; // regex source — a line (or block) must match this (unused for silence)
	ignore?: string; // optional regex — a matching line/block is excluded (noise filter)
	multiline?: string; // optional "firstline" regex — groups multi-line blocks (stack traces)
	restartOnMatch?: boolean; // when true, restart the container after an alert fires (off by default)
	silenceSec?: number; // silence watch: alert if no new logs for this many seconds
	lastLogAt?: number; // silence watch: unix seconds when output was last seen
	alarming?: boolean; // silence watch: true while a silence alert is active, so recovery fires once
	intervalSec: number;
	cooldownSec: number; // min seconds between notifications, to prevent storms
	minMatches: number; // min matching units in one check before alerting (debounce)
	chatId: number; // where matches are delivered
	createdBy: string; // telegram user id, for the audit trail
	enabled: boolean;
	lastCheck: number; // unix seconds; logs newer than this are considered
	lastNotify: number; // unix seconds of last sent alert (0 = never)
	suppressed: number; // matches dropped during cooldown since the last alert
	fails: number; // consecutive poll errors, for auto-disable
}

// An inline-keyboard button: visible label + the callback_data the bot's router
// understands. Kept as a plain shape so this module never imports Telegraf.
export interface Button {
	text: string;
	callback_data: string;
}

// (chatId, markdown text, optional inline-keyboard rows) -> delivered. Injected
// at init so this module never imports Telegraf directly.
type SendFn = (
	chatId: number,
	text: string,
	buttons?: Button[][],
) => Promise<void>;

const FILE = process.env.MONITORS_FILE || "/data/monitors.json";
const MIN_INTERVAL = parseInt(process.env.MONITOR_MIN_INTERVAL || "5", 10);
const MAX_INTERVAL = parseInt(process.env.MONITOR_MAX_INTERVAL || "86400", 10);
// Default min gap between alerts for the same monitor. After an alert, further
// matches are counted but not sent until this elapses — the primary defense
// against alert storms from a fast-flapping log line.
const DEFAULT_COOLDOWN = parseInt(
	process.env.MONITOR_DEFAULT_COOLDOWN || "300",
	10,
);
const PREVIEW_TAIL = parseInt(process.env.MONITOR_PREVIEW_TAIL || "200", 10);
// Hard ceiling on total monitors. Each is a recurring Docker poll + timer, so
// an unbounded count would hammer the socket-proxy and leak timers.
const MAX_MONITORS = parseInt(process.env.MONITOR_MAX || "50", 10);
// Cap the length of a single unit fed to a user regex. Catastrophic-backtracking
// blowup scales with input length, so bounding it bounds the worst case — a
// false-positive-free mitigation that complements the add-time pattern check.
const MAX_MATCH_LEN = parseInt(process.env.MONITOR_MAX_MATCH_LEN || "4000", 10);
const MAX_FAILS = 5; // disable a monitor after this many consecutive errors
const MATCH_LINE_CAP = 10; // lines shown per notification
const MSG_CHAR_CAP = 3500; // keep under Telegram's 4096 limit, with headroom

const monitors = new Map<string, Monitor>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const inFlight = new Set<string>(); // monitor ids with a check currently running
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
		for (const raw of arr) {
			// Backfill fields added after a monitor was first persisted, so older
			// state files keep working across upgrades.
			const m: Monitor = {
				...raw,
				cooldownSec: raw.cooldownSec ?? DEFAULT_COOLDOWN,
				minMatches: raw.minMatches ?? 1,
				restartOnMatch: raw.restartOnMatch ?? false,
				lastNotify: raw.lastNotify ?? 0,
				suppressed: raw.suppressed ?? 0,
			};
			monitors.set(m.id, m);
		}
		log.info("monitors_loaded", { count: monitors.size });
	} catch {
		// First run / no file yet — start empty, not an error.
	}
}

// ---- Validation ------------------------------------------------------------

// The tunable shape of a monitor — shared by validate(), preview(), and the
// add flow so new fields only have to be threaded through one type.
export interface SpecInput {
	type?: "regex" | "silence";
	pattern: string;
	intervalSec: number;
	ignore?: string;
	cooldownSec?: number;
	multiline?: string;
	minMatches?: number;
	restartOnMatch?: boolean;
	silenceSec?: number; // required when type === "silence"
}

interface Compiled {
	re: RegExp;
	ignoreRe?: RegExp;
	firstlineRe?: RegExp;
}

// Compile the match, optional ignore, and optional multiline firstline regexes.
// Throws on a bad regex.
function compile(
	pattern: string,
	ignore?: string,
	multiline?: string,
): Compiled {
	const re = new RegExp(pattern);
	const ignoreRe = ignore?.trim() ? new RegExp(ignore) : undefined;
	const firstlineRe = multiline?.trim() ? new RegExp(multiline) : undefined;
	return { re, ignoreRe, firstlineRe };
}

// Split log text into the units a pattern is tested against. Without a
// firstline regex each non-empty line is its own unit. With one, a line that
// matches firstline begins a block and following lines append to it, so a whole
// stack trace becomes a single unit (one alert instead of one-per-line).
function segment(text: string, firstlineRe?: RegExp): string[] {
	const lines = text.split("\n").filter((l) => l.length > 0);
	if (!firstlineRe) return lines;
	const blocks: string[] = [];
	for (const line of lines) {
		if (blocks.length === 0 || firstlineRe.test(line)) blocks.push(line);
		else blocks[blocks.length - 1] += `\n${line}`;
	}
	return blocks;
}

// A stop/start or `compose up` recreates the container under a new id, so the
// old id 404s. Detect that specific failure so we can re-resolve by name
// instead of treating it as a real error and auto-disabling the monitor.
function isContainerGone(detail: string): boolean {
	return /no such container|404/i.test(detail);
}

// Test a regex against a unit, bounding the input length so worst-case
// backtracking time stays bounded (see MAX_MATCH_LEN).
function safeTest(re: RegExp, s: string): boolean {
	return re.test(s.length > MAX_MATCH_LEN ? s.slice(0, MAX_MATCH_LEN) : s);
}

// Best-effort flag for the textbook exponential-backtracking shape: an
// unbounded quantifier applied to a group that itself contains one — (a+)+,
// (.*)*, (\d+)+, etc. Not exhaustive and not the security boundary (the
// allowlist + MAX_MATCH_LEN are); just a guardrail against an obvious footgun.
const CATASTROPHIC = /\([^()]*[*+][^()]*\)[*+]/;
function assertSafeRegex(src: string | undefined, label: string): void {
	if (src?.trim() && CATASTROPHIC.test(src)) {
		throw new Error(
			`${label} looks prone to catastrophic backtracking (a nested ` +
				`quantifier like (a+)+). Rewrite it more specifically.`,
		);
	}
}

// Throws a user-facing Error on bad input; returns the compiled regexes for a
// regex monitor, or void for a silence monitor (which has no pattern).
export function validate(s: SpecInput): Compiled | undefined {
	if (!Number.isFinite(s.intervalSec) || s.intervalSec < MIN_INTERVAL) {
		throw new Error(`Interval must be a number ≥ ${MIN_INTERVAL} (seconds).`);
	}
	if (s.intervalSec > MAX_INTERVAL) {
		throw new Error(`Interval must be ≤ ${MAX_INTERVAL} seconds.`);
	}
	if (
		s.cooldownSec !== undefined &&
		(!Number.isFinite(s.cooldownSec) || s.cooldownSec < 0)
	) {
		throw new Error("Cooldown must be a number ≥ 0 (seconds).");
	}

	// Silence watch: no regex to compile, just a threshold. Validate it and
	// return early so the pattern checks below don't apply.
	if (s.type === "silence") {
		if (!Number.isFinite(s.silenceSec) || (s.silenceSec ?? 0) < MIN_INTERVAL) {
			throw new Error(
				`Silence threshold must be a number ≥ ${MIN_INTERVAL} (seconds).`,
			);
		}
		if ((s.silenceSec ?? 0) < s.intervalSec) {
			throw new Error(
				"Silence threshold should be ≥ the check interval, or it can't be detected.",
			);
		}
		return;
	}

	if (
		s.minMatches !== undefined &&
		(!Number.isInteger(s.minMatches) || s.minMatches < 1)
	) {
		throw new Error("min (matches before alerting) must be an integer ≥ 1.");
	}
	if (!s.pattern.trim()) throw new Error("Pattern is empty.");
	try {
		new RegExp(s.pattern);
	} catch (e) {
		throw new Error(
			`Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	assertSafeRegex(s.pattern, "Pattern");
	assertSafeRegex(s.ignore, "Ignore regex");
	assertSafeRegex(s.multiline, "Multiline regex");
	try {
		new RegExp(s.multiline?.trim() || "");
	} catch (e) {
		throw new Error(
			`Invalid multiline regex: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	try {
		return compile(s.pattern, s.ignore, s.multiline);
	} catch (e) {
		throw new Error(
			`Invalid ignore regex: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// Dry-run a spec against a container's recent logs so the user can see what it
// would catch before committing. Returns the matching units (newest logs).
export async function preview(
	containerId: string,
	s: SpecInput,
	tail = PREVIEW_TAIL,
): Promise<{ sampled: number; matched: string[] }> {
	const { re, ignoreRe, firstlineRe } = compile(
		s.pattern,
		s.ignore,
		s.multiline,
	);
	const { text } = await d.logs(containerId, tail);
	const units = segment(text, firstlineRe);
	const matched = units.filter(
		(u) => safeTest(re, u) && !(ignoreRe && safeTest(ignoreRe, u)),
	);
	return { sampled: units.length, matched };
}

// ---- Polling ---------------------------------------------------------------

async function check(m: Monitor): Promise<void> {
	// Skip if a previous tick is still running (slow Docker call + short
	// interval), so checks never stack up and race on m.lastCheck.
	if (!m.enabled || inFlight.has(m.id)) return;
	const now = Math.floor(Date.now() / 1000);
	let re: RegExp;
	let ignoreRe: RegExp | undefined;
	let firstlineRe: RegExp | undefined;
	try {
		({ re, ignoreRe, firstlineRe } = compile(m.pattern, m.ignore, m.multiline));
	} catch {
		return; // shouldn't happen — validated at creation
	}

	inFlight.add(m.id);
	try {
		const text = await d.logsSince(m.containerId, m.lastCheck);
		m.lastCheck = now;
		m.fails = 0;

		const matched = segment(text, firstlineRe).filter(
			(u) => safeTest(re, u) && !(ignoreRe && safeTest(ignoreRe, u)),
		);

		// Threshold debounce: a single check must produce at least minMatches
		// matching units before it counts as an alert — a lone transient line
		// stays quiet, a burst fires. The check interval is the effective window.
		if (matched.length >= m.minMatches) {
			// Cooldown gate: after an alert, count further matches but stay quiet
			// until the window elapses, so a flapping line can't spam the chat.
			if (now - m.lastNotify < m.cooldownSec) {
				m.suppressed += matched.length;
			} else {
				// Refresh the name in case it changed; best-effort.
				try {
					m.containerName = (await d.inspect(m.containerId)).name;
				} catch {}
				await notify(m, matched, m.suppressed);
				m.lastNotify = now;
				m.suppressed = 0;
				// Optional remediation, armed per-monitor. It lives inside the
				// cooldown+threshold gate, so a flapping line restarts at most
				// once per cooldown window rather than looping.
				if (m.restartOnMatch) await autoRestart(m);
			}
		}
		persist();
	} catch (e) {
		await handleCheckError(m, e, now);
	} finally {
		inFlight.delete(m.id);
	}
}

// Shared error handling for both pollers. A container that just got recreated
// (stop/start, `compose up`) surfaces as "no such container"; rebind to the
// current container of the same name instead of counting it as a failure.
// Otherwise count the error and auto-disable after MAX_FAILS in a row.
async function handleCheckError(
	m: Monitor,
	e: unknown,
	now: number,
): Promise<void> {
	const detail = e instanceof Error ? e.message : String(e);
	const label =
		m.type === "silence" ? `silence ≥${m.silenceSec}s` : `/${m.pattern}/`;

	// Watch the rebound container from now forward so its startup logs don't
	// flood in as a backlog.
	if (isContainerGone(detail)) {
		try {
			const newId = await d.findIdByName(m.containerName);
			if (newId && newId !== m.containerId) {
				log.info("monitor_rebind", {
					id: m.id,
					container: m.containerName,
					oldId: m.containerId,
					newId,
				});
				m.containerId = newId;
				m.lastCheck = now;
				if (m.type === "silence") {
					m.lastLogAt = now; // fresh container, reset the silence clock
					m.alarming = false;
				}
				m.fails = 0;
				persist();
				return; // next tick polls the new container
			}
		} catch {
			// fall through to normal failure handling below
		}
	}

	m.fails += 1;
	log.warn("monitor_check_failed", {
		id: m.id,
		container: m.containerName,
		fails: m.fails,
		error: detail,
	});
	if (m.fails >= MAX_FAILS) {
		m.enabled = false;
		stopTimer(m.id);
		log.audit({
			userId: "system",
			action: "monitor_autodisable",
			target: `${m.containerName} ${label}`,
			result: "error",
			detail,
		});
		await send(
			m.chatId,
			`⚠️ Monitor on *${m.containerName}* disabled after ${MAX_FAILS} ` +
				`failed checks.\nLast error: \`${detail}\``,
		).catch(() => {});
	}
	persist();
}

// Silence/heartbeat poller: alert when a running container stops producing new
// logs for longer than silenceSec. A stopped container is legitimately quiet,
// so we only alarm while it's running. Mirrors check()'s lifecycle (in-flight
// guard, fail handling, persistence).
async function checkSilence(m: Monitor): Promise<void> {
	if (!m.enabled || inFlight.has(m.id)) return;
	const now = Math.floor(Date.now() / 1000);

	inFlight.add(m.id);
	try {
		const info = await d.inspect(m.containerId);
		m.containerName = info.name; // refresh in case it changed
		const text = await d.logsSince(m.containerId, m.lastCheck);
		m.lastCheck = now;
		m.fails = 0;

		const hasOutput = text.split("\n").some((l) => l.length > 0);
		if (hasOutput) {
			m.lastLogAt = now;
			// Recovered: only announce if we'd previously alerted on this silence.
			if (m.alarming) {
				m.alarming = false;
				await send(
					m.chatId,
					`✅ Logs resumed — *${m.containerName}* is producing output again.`,
				).catch(() => {});
			}
		} else if (info.state === "running") {
			const silent = now - (m.lastLogAt ?? now);
			if (silent >= (m.silenceSec ?? 0)) {
				// Cooldown gate, same as the regex path: after an alert, stay quiet
				// until the window elapses so a persistently-silent container can't
				// re-ping every interval.
				if (now - m.lastNotify >= m.cooldownSec) {
					await notifySilence(m, silent);
					m.lastNotify = now;
					m.alarming = true;
					// Optional remediation; gated by the same cooldown, so a stuck
					// container restarts at most once per cooldown window.
					if (m.restartOnMatch) await autoRestart(m);
				}
			}
		}
		persist();
	} catch (e) {
		await handleCheckError(m, e, now);
	} finally {
		inFlight.delete(m.id);
	}
}

async function notify(
	m: Monitor,
	lines: string[],
	suppressed = 0,
): Promise<void> {
	const shown = lines.slice(0, MATCH_LINE_CAP);
	const more =
		lines.length > shown.length
			? `\n…+${lines.length - shown.length} more`
			: "";
	let body = shown.join("\n");
	if (body.length > MSG_CHAR_CAP) body = `${body.slice(0, MSG_CHAR_CAP)}\n…`;

	// Tell the user if matches were swallowed by the previous cooldown window.
	const backlog =
		suppressed > 0
			? `\n_(+${suppressed} earlier match(es) suppressed during cooldown)_`
			: "";

	const text =
		`🔔 *Match — ${m.containerName}*\n` +
		`Pattern: \`${m.pattern}\`\n` +
		`${lines.length} new matching line(s):${backlog}\n` +
		`\`\`\`\n${body}${more}\n\`\`\``;
	// Quick actions on the alert itself: restart (routes through the usual
	// confirm step) and a 50-line log tail. callback_data mirrors the buttons
	// the handlers' router already understands.
	const buttons: Button[][] = [
		[
			{ text: "🔄 Restart", callback_data: `a:restart:${m.containerId}` },
			{ text: "📄 Logs", callback_data: `a:logs50:${m.containerId}` },
		],
	];
	await send(m.chatId, text, buttons).catch((e) => {
		log.warn("monitor_notify_failed", {
			id: m.id,
			error: e instanceof Error ? e.message : String(e),
		});
	});
}

// Compact "2m 5s" / "45s" / "1h 3m" rendering for a duration in seconds.
function fmtDuration(sec: number): string {
	const s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	const parts: string[] = [];
	if (h) parts.push(`${h}h`);
	if (m) parts.push(`${m}m`);
	if (r || parts.length === 0) parts.push(`${r}s`);
	return parts.join(" ");
}

// Silence alert: the container went quiet past its threshold. Same quick-action
// buttons as a match alert (restart routes through the usual confirm step).
async function notifySilence(m: Monitor, silentSec: number): Promise<void> {
	const text =
		`🔕 *Silence — ${m.containerName}*\n` +
		`No new logs for ${fmtDuration(silentSec)} ` +
		`(threshold ${fmtDuration(m.silenceSec ?? 0)}).`;
	const buttons: Button[][] = [
		[
			{ text: "🔄 Restart", callback_data: `a:restart:${m.containerId}` },
			{ text: "📄 Logs", callback_data: `a:logs50:${m.containerId}` },
		],
	];
	await send(m.chatId, text, buttons).catch((e) => {
		log.warn("monitor_notify_failed", {
			id: m.id,
			error: e instanceof Error ? e.message : String(e),
		});
	});
}

// Restart the watched container as an automatic remediation after an alert.
// Called only from inside the cooldown+threshold gate in check(), so it can't
// loop on a flapping line. Audited like any other lifecycle action, and the
// outcome (success or failure) is reported to the same chat as the alert.
async function autoRestart(m: Monitor): Promise<void> {
	const label =
		m.type === "silence" ? `silence ≥${m.silenceSec}s` : `/${m.pattern}/`;
	try {
		await d.restart(m.containerId);
		log.audit({
			userId: "system",
			action: "monitor_autorestart",
			target: `${m.containerName} ${label}`,
			result: "ok",
		});
		await send(
			m.chatId,
			`🔄 Auto-restart triggered for *${m.containerName}* (monitor matched).`,
		).catch(() => {});
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		log.audit({
			userId: "system",
			action: "monitor_autorestart",
			target: `${m.containerName} ${label}`,
			result: "error",
			detail,
		});
		await send(
			m.chatId,
			`⚠️ Auto-restart of *${m.containerName}* failed:\n\`${detail}\``,
		).catch(() => {});
	}
}

function startTimer(m: Monitor): void {
	stopTimer(m.id);
	if (!m.enabled) return;
	const poll = m.type === "silence" ? checkSilence : check;
	// unref so a pending tick never blocks process shutdown.
	const t = setInterval(() => void poll(m), m.intervalSec * 1000);
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

export interface AddInput extends SpecInput {
	containerId: string;
	containerName: string;
	chatId: number;
	createdBy: string;
}

// Validates, persists, and immediately starts polling. Throws on bad input.
export function addMonitor(input: AddInput): Monitor {
	if (monitors.size >= MAX_MONITORS) {
		throw new Error(
			`Monitor limit reached (${MAX_MONITORS}). Delete one before adding another.`,
		);
	}
	validate(input);
	const id = crypto.randomUUID().slice(0, 8);
	const now = Math.floor(Date.now() / 1000);
	const silence = input.type === "silence";
	const m: Monitor = {
		id,
		containerId: input.containerId,
		containerName: input.containerName,
		type: silence ? "silence" : "regex",
		pattern: silence ? "" : input.pattern, // unused for silence watches
		ignore: silence ? undefined : input.ignore?.trim() || undefined,
		multiline: silence ? undefined : input.multiline?.trim() || undefined,
		restartOnMatch: input.restartOnMatch ?? false,
		silenceSec: silence ? input.silenceSec : undefined,
		lastLogAt: silence ? now : undefined, // assume output is current at creation
		intervalSec: input.intervalSec,
		cooldownSec: input.cooldownSec ?? DEFAULT_COOLDOWN,
		minMatches: input.minMatches ?? 1,
		chatId: input.chatId,
		createdBy: input.createdBy,
		enabled: true,
		lastCheck: now, // watch from now forward only
		lastNotify: 0,
		suppressed: 0,
		fails: 0,
	};
	monitors.set(id, m);
	startTimer(m);
	persist();
	log.audit({
		userId: input.createdBy,
		action: "monitor_add",
		target:
			(silence
				? `${input.containerName} silence ≥${input.silenceSec}s @${input.intervalSec}s`
				: `${input.containerName} /${input.pattern}/ @${input.intervalSec}s`) +
			(m.restartOnMatch ? " +auto-restart" : ""),
		result: "ok",
	});
	return m;
}

export function removeMonitor(
	id: string,
	actorId = "unknown",
): Monitor | undefined {
	const m = monitors.get(id);
	if (!m) return undefined;
	stopTimer(id);
	inFlight.delete(id);
	monitors.delete(id);
	persist();
	log.audit({
		userId: actorId,
		action: "monitor_remove",
		target: `${m.containerName} /${m.pattern}/`,
		result: "ok",
	});
	return m;
}

// Flip enabled on/off. Re-enabling resets the failure counter and the watch
// window so it starts fresh from now (no backlog flood).
export function toggleMonitor(
	id: string,
	actorId = "unknown",
): Monitor | undefined {
	const m = monitors.get(id);
	if (!m) return undefined;
	m.enabled = !m.enabled;
	if (m.enabled) {
		const now = Math.floor(Date.now() / 1000);
		m.fails = 0;
		m.lastCheck = now;
		m.lastNotify = 0;
		m.suppressed = 0;
		if (m.type === "silence") {
			m.lastLogAt = now; // start the silence clock fresh from now
			m.alarming = false;
		}
		startTimer(m);
	} else {
		stopTimer(id);
	}
	persist();
	log.audit({
		userId: actorId,
		action: m.enabled ? "monitor_resume" : "monitor_pause",
		target: `${m.containerName} /${m.pattern}/`,
		result: "ok",
	});
	return m;
}

// Load saved monitors, wire the notifier, and start every enabled poller. Each
// monitor's persisted `lastCheck` means the first poll covers the gap since the
// bot was last up — so we also fire one immediate check rather than waiting a
// full interval, catching anything that matched while we were down.
export function initMonitors(sender: SendFn): void {
	send = sender;
	load();
	for (const m of monitors.values()) {
		startTimer(m);
		if (m.enabled) {
			// immediate catch-up; respects cooldown
			if (m.type === "silence") void checkSilence(m);
			else void check(m);
		}
	}
	if (monitors.size > 0) {
		log.info("monitors_started", {
			active: [...monitors.values()].filter((m) => m.enabled).length,
		});
	}
}
