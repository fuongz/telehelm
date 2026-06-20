'use strict';

// Minimal structured logger. Writes one JSON object per line to stdout so the
// Docker log driver captures a clean, greppable audit trail. No files written
// (keeps the container filesystem read-only).

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] > THRESHOLD) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  error: (msg, f) => emit('error', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  info: (msg, f) => emit('info', msg, f),
  debug: (msg, f) => emit('debug', msg, f),

  // Dedicated audit helper — every privileged action funnels through here.
  audit: ({ userId, username, action, target, result, detail }) =>
    emit('info', 'audit', { audit: true, userId, username, action, target, result, detail }),
};
