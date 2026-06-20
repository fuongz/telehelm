// Minimal structured logger. Writes one JSON object per line to stdout so the
// Docker log driver captures a clean, greppable audit trail. No files written
// (keeps the container filesystem read-only).

type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function isLevel(s: string): s is Level {
	return s in LEVELS;
}

const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const THRESHOLD = isLevel(envLevel) ? LEVELS[envLevel] : LEVELS.info;

type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields: Fields = {}): void {
	if (LEVELS[level] > THRESHOLD) return;
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg,
		...fields,
	});
	if (level === "error") process.stderr.write(`${line}\n`);
	else process.stdout.write(`${line}\n`);
}

interface AuditEntry {
	userId: string;
	username?: string;
	action: string;
	target: string;
	result: "ok" | "error";
	detail?: string;
}

const log = {
	error: (msg: string, f?: Fields) => emit("error", msg, f),
	warn: (msg: string, f?: Fields) => emit("warn", msg, f),
	info: (msg: string, f?: Fields) => emit("info", msg, f),
	debug: (msg: string, f?: Fields) => emit("debug", msg, f),

	// Dedicated audit helper — every privileged action funnels through here.
	audit: ({ userId, username, action, target, result, detail }: AuditEntry) =>
		emit("info", "audit", {
			audit: true,
			userId,
			username,
			action,
			target,
			result,
			detail,
		}),
};

export default log;
