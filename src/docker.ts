import Docker from 'dockerode';

// This is the ONLY module that talks to Docker. It points at the socket-proxy
// over the internal network — never at /var/run/docker.sock directly. The proxy
// enforces which API endpoints are reachable; this layer just shapes the data.

const docker = new Docker({
  host: process.env.DOCKER_PROXY_HOST || 'socket-proxy',
  port: parseInt(process.env.DOCKER_PROXY_PORT || '2375', 10),
  protocol: 'http',
});

export const SHORT = (id: string | undefined): string => (id || '').slice(0, 12);

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string; // running | exited | paused | ...
  status: string; // human string e.g. "Up 3 hours"
}

export interface ContainerDetail {
  id: string;
  name: string;
  state: string;
  tty: boolean;
  image: string;
}

export interface LogsResult {
  name: string;
  text: string;
}

export interface StatsResult {
  name: string;
  running: boolean;
  cpuPct?: number;
  memUsed?: number;
  memLimit?: number;
  memPct?: number;
}

// ---- Read operations (need CONTAINERS=1 on the proxy) ---------------------

export async function listContainers(): Promise<ContainerSummary[]> {
  const raw = await docker.listContainers({ all: true });
  return raw.map((c) => ({
    id: SHORT(c.Id),
    name: (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
  }));
}

export async function inspect(id: string): Promise<ContainerDetail> {
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
function demux(buffer: Buffer, tty: boolean): string {
  if (tty) return buffer.toString('utf8');
  let out = '';
  let off = 0;
  while (off + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(off + 4);
    const start = off + 8;
    const end = start + size;
    if (end > buffer.length) break;
    out += buffer.subarray(start, end).toString('utf8');
    off = end;
  }
  return out || buffer.toString('utf8');
}

export async function logs(id: string, tail = 100): Promise<LogsResult> {
  const meta = await inspect(id);
  const buf = await docker.getContainer(id).logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: false,
    follow: false,
  });
  // dockerode returns a Buffer when follow:false
  let text = demux(Buffer.isBuffer(buf) ? buf : Buffer.from(buf as unknown as ArrayBuffer), meta.tty);
  // Strip ANSI escape codes for clean display in Telegram.
  text = text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  return { name: meta.name, text };
}

// One-shot stats give a bad CPU% (precpu is empty), so sample twice ~1s apart.
export async function stats(id: string): Promise<StatsResult> {
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

  return { name: meta.name, running: true, cpuPct, memUsed, memLimit, memPct };
}

// ---- Lifecycle operations (gated by ALLOW_START/STOP/RESTARTS on the proxy) --

export async function start(id: string): Promise<void> {
  await docker.getContainer(id).start();
}
export async function stop(id: string): Promise<void> {
  await docker.getContainer(id).stop();
}
export async function restart(id: string): Promise<void> {
  await docker.getContainer(id).restart();
}

export async function ping(): Promise<void> {
  await docker.ping();
}
