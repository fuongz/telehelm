'use strict';

const Docker = require('dockerode');

// This is the ONLY module that talks to Docker. It points at the socket-proxy
// over the internal network — never at /var/run/docker.sock directly. The proxy
// enforces which API endpoints are reachable; this layer just shapes the data.

const docker = new Docker({
  host: process.env.DOCKER_PROXY_HOST || 'socket-proxy',
  port: parseInt(process.env.DOCKER_PROXY_PORT || '2375', 10),
  protocol: 'http',
});

const SHORT = (id) => (id || '').slice(0, 12);

// ---- Read operations (need CONTAINERS=1 on the proxy) ---------------------

async function listContainers() {
  const raw = await docker.listContainers({ all: true });
  return raw.map((c) => ({
    id: SHORT(c.Id),
    name: (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, ''),
    image: c.Image,
    state: c.State, // running | exited | paused | ...
    status: c.Status, // human string e.g. "Up 3 hours"
  }));
}

async function inspect(id) {
  const data = await docker.getContainer(id).inspect();
  return {
    id: SHORT(data.Id),
    name: (data.Name || '').replace(/^\//, ''),
    state: data.State.Status,
    tty: !!data.Config.Tty,
    image: data.Config.Image,
  };
}

// Docker multiplexes stdout/stderr into frames of [type][000][size BE][payload]
// unless the container was started with a TTY. Strip the frame headers so the
// user sees clean text.
function demux(buffer, tty) {
  if (tty) return buffer.toString('utf8');
  let out = '';
  let off = 0;
  while (off + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(off + 4);
    const start = off + 8;
    const end = start + size;
    if (end > buffer.length) break;
    out += buffer.slice(start, end).toString('utf8');
    off = end;
  }
  return out || buffer.toString('utf8');
}

async function logs(id, tail = 100) {
  const meta = await inspect(id);
  const buf = await docker.getContainer(id).logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: false,
    follow: false,
  });
  // dockerode returns a Buffer when follow:false
  let text = demux(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), meta.tty);
  // Strip ANSI escape codes for clean display in Telegram.
  text = text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  return { name: meta.name, text };
}

// One-shot stats give a bad CPU% (precpu is empty), so sample twice ~1s apart.
async function stats(id) {
  const meta = await inspect(id);
  if (meta.state !== 'running') {
    return { name: meta.name, running: false };
  }
  const c = docker.getContainer(id);
  const s1 = await c.stats({ stream: false });
  await new Promise((r) => setTimeout(r, 1000));
  const s2 = await c.stats({ stream: false });

  const cpuDelta = s2.cpu_stats.cpu_usage.total_usage - s1.cpu_stats.cpu_usage.total_usage;
  const sysDelta = s2.cpu_stats.system_cpu_usage - s1.cpu_stats.system_cpu_usage;
  const cpus =
    s2.cpu_stats.online_cpus ||
    (s2.cpu_stats.cpu_usage.percpu_usage ? s2.cpu_stats.cpu_usage.percpu_usage.length : 1);
  const cpuPct = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  const inactive = (s2.memory_stats.stats && s2.memory_stats.stats.inactive_file) || 0;
  const memUsed = Math.max(0, (s2.memory_stats.usage || 0) - inactive);
  const memLimit = s2.memory_stats.limit || 0;
  const memPct = memLimit > 0 ? (memUsed / memLimit) * 100 : 0;

  return {
    name: meta.name,
    running: true,
    cpuPct,
    memUsed,
    memLimit,
    memPct,
  };
}

// ---- Lifecycle operations (gated by ALLOW_START/STOP/RESTARTS on the proxy) --

async function start(id) {
  await docker.getContainer(id).start();
}
async function stop(id) {
  await docker.getContainer(id).stop();
}
async function restart(id) {
  await docker.getContainer(id).restart();
}

async function ping() {
  await docker.ping();
}

module.exports = { listContainers, inspect, logs, stats, start, stop, restart, ping, SHORT };
