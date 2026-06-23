# telehelm

> Steer your Docker containers from Telegram — your phone is the helm.

Written in **TypeScript**, run on the **[Bun](https://bun.sh)** runtime (no build step — Bun executes the `.ts` entry directly).

Control your homelab's Docker containers from Telegram — list, view logs/stats, start/stop/restart, and **watch logs for patterns that ping you when they appear** — with a security model designed around the fact that **a Telegram bot is an internet-reachable remote-control surface**.

## Flow

```
Your phone / work machine (Telegram app)
        │
        ▼
   Telegram servers   ◄── relay
        │
        ▼
   bot  (long polling — dials OUT, no inbound ports)   ┐
        │  internal docker network only                │  both run ON the homelab
        ▼                                               │
   socket-proxy  (least-privilege)                      ┘
        │
        ▼
   Docker daemon  (/var/run/docker.sock)
```

The bot runs **on the homelab**, next to Docker. Your work machine is just a Telegram client — it needs no network path to the homelab, and the homelab opens no inbound ports (long polling is outbound-only, so it works behind home NAT with nothing forwarded).

## Security model

Two controls are your root credentials — get these right and the rest is defense in depth:

1. **Bot token** — functionally equivalent to control of your Docker host. Store in `.env`, never in git.
2. **User-ID allowlist** (`ALLOWED_USER_IDS`) — the bot silently drops any message from an ID not on the list, and refuses to start if the list is empty (fail-closed).

Layered on top:

- **Least-privilege socket proxy.** The bot never touches `/var/run/docker.sock`. It talks to `lscr.io/linuxserver/socket-proxy`, which exposes **only**: container list/inspect/logs/stats (`CONTAINERS=1`) and start/stop/restart (`ALLOW_START/STOP/RESTARTS=1`). `POST=0` stays off, so container **create, exec, image build/pull, volumes, and networks are all blocked** at the proxy. Even a fully compromised bot cannot create a privileged container or exec into one.
  - *Why this image and not `tecnativa/docker-socket-proxy`?* On the original, `ALLOW_RESTARTS` doesn't work unless you also set `POST=1` — which re-opens create/exec. The LinuxServer fork gates each lifecycle POST independently while keeping `POST=0`.
- **Network air-gap.** The proxy sits on an `internal: true` network with no route to the internet. Only the bot has an egress network (to reach Telegram). The proxy can never phone home.
- **Confirmation step.** Start/stop/restart require a second tap (`✅ Yes`).
- **Rate limiting.** Per-user sliding window, on top of the allowlist.
- **Audit log.** Every privileged action emits a JSON line (`audit: true`) with user ID, action, target, and result — captured by the Docker log driver.
- **Hardened bot container.** Runs as non-root, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem. The only writable path is a dedicated `monitors` named volume at `/data` (owned by the unprivileged `bun` uid), where log-monitor definitions persist — nothing else on disk is mutable.

## Setup

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **Find your user ID.** Message [@userinfobot](https://t.me/userinfobot); it replies with your numeric ID.
3. **Configure.**
   ```bash
   cp .env.example .env
   # edit .env: set BOT_TOKEN and ALLOWED_USER_IDS (comma-separated)
   ```
4. **Run** (on the homelab). Compose reads secrets from the `.env` file you just created:
   ```bash
   docker compose up -d --build
   ```
5. In Telegram, open your bot and send `/ps`.

### Local development (without Docker)

You need [Bun](https://bun.sh) ≥ 1.1 and a reachable socket proxy.

```bash
bun install
bun run dev        # watch mode; or `bun start`
bun run typecheck  # tsc --noEmit
```

Point the bot at your proxy with `DOCKER_PROXY_HOST` / `DOCKER_PROXY_PORT` (defaults: `socket-proxy:2375`). The default monitors path (`/data/monitors.json`) won't be writable outside Docker — set `MONITORS_FILE` to a local path (e.g. `./monitors.json`) if you want monitors to persist during local dev.

## Usage

- `/ps` — list all containers; tap one to open its menu.
- Container menu: **📄 Logs** (last 100 lines), **📊 Stats** (CPU/mem, sampled over 1s for accuracy), **🔔 Monitor** (regex log watches — see below), and **▶️ Start / ⏹️ Stop / 🔄 Restart** (with confirmation).
- `/watches` — list every active log monitor across all containers.
- `/help` — command summary.

### Log monitors

A log monitor watches one container's output for lines matching a regex and pings you on Telegram when new matches appear. Each monitor polls on its own interval and only ever inspects logs emitted **since its last check**, so a steady pre-existing line never re-fires — you're alerted only on genuinely fresh matches.

Set one up entirely from Telegram:

1. `/ps` → tap a container → **🔔 Monitor** → **➕ Add monitor**.
2. Reply with the interval (seconds) followed by the regex. Optional extra lines tune it:
   ```
   30 ERROR|panic|fatal
   ignore: healthcheck|debug
   cooldown: 600
   min: 5
   multiline: ^\d{4}-\d{2}-\d{2}
   restart: on
   ```
   - `ignore:` — a second regex; lines matching it are skipped (silence known-noisy output).
   - `cooldown:` — minimum seconds between alerts for this monitor (defaults to `MONITOR_DEFAULT_COOLDOWN`).
   - `min:` — only alert if at least N matches occur in a single check; the check interval is the effective window, so a lone transient line stays quiet while a burst fires.
   - `multiline:` — a "firstline" regex marking the start of a log block. Lines that don't match it are folded into the preceding block, so a stack trace becomes **one** alert instead of one per line. The match/ignore regexes then test the whole block.
   - `restart:` — `on` (or `true`/`yes`/`1`) makes the monitor **restart the container** whenever it alerts. Off by default. The restart fires from inside the same threshold + cooldown gate as the alert, so it runs at most once per cooldown window — never in a tight loop. The preview screen flags this before you confirm.
3. The bot shows a **dry-run preview** — what the pattern would have matched in the recent log tail — then a **✅ Create / ❌ Cancel** choice before anything is saved.
4. Manage existing monitors from the same view: **⏸️ Pause / ▶️ Resume** and **🗑️ Delete**.

Details:

- Matching is **case-sensitive** (the pattern is compiled as `new RegExp(pattern)` with no flags) and tested per log line.
- The interval is bounded by `MONITOR_MIN_INTERVAL` (default `5`s, protects the Docker socket from aggressive polling) and `MONITOR_MAX_INTERVAL` (default `86400`s).
- **Cooldown / anti-storm.** After an alert fires, further matches are counted but not sent until the cooldown elapses; the next alert notes how many were suppressed. This stops a fast-flapping line from flooding the chat.
- **Threshold debounce (`min:`).** Require N matches within a single check before alerting, so a one-off transient is ignored and only a real burst pages you.
- **Multi-line matching (`multiline:`).** Group stack traces and other multi-line records into a single alert via a firstline regex, instead of one alert per line.
- **Auto-restart (`restart: on`).** Optionally restart the watched container when a monitor alerts — automatic remediation for a crash-looped or wedged service. Gated by the same threshold + cooldown as the alert (so it can't restart-loop), audited as `monitor_autorestart`, and the outcome is reported back to the chat.
- **Restart catch-up.** The last-checked timestamp is persisted, so on startup each monitor immediately scans the gap since the bot was last up — you don't miss (or wait a full interval for) matches that occurred during downtime.
- Notifications cap at the first 10 matching lines per check to stay within Telegram's message limits.
- A monitor that fails its check 5 times in a row (e.g. the container was removed) auto-disables and tells you why.
- **Bounded by design.** A check won't start while the previous one is still running (no stacking on a slow Docker call); the total monitor count is capped (`MONITOR_MAX`); each log line/block is length-capped (`MONITOR_MAX_MATCH_LEN`) before matching and obviously catastrophic patterns (e.g. `(a+)+`) are rejected at add time, to bound regex backtracking.
- **Audited.** Creating, pausing/resuming, deleting, auto-disabling, and auto-restarting a monitor each emit an `audit` log line with the acting user (`system` for automatic actions).
- Definitions persist to `/data/monitors.json` on the `monitors` volume, so they survive bot restarts and updates. If that path can't be written the bot falls back to in-memory monitors and logs `monitor_persist_disabled`.

## What the bot can and cannot do

| Action | Allowed |
|---|---|
| List / inspect containers | ✅ |
| View logs, stats | ✅ |
| Watch logs for a regex, get alerts | ✅ |
| Start / stop / restart | ✅ |
| Create / run new containers | ❌ blocked at proxy |
| `exec` into a container | ❌ blocked at proxy |
| Pull / build images, manage volumes/networks | ❌ blocked at proxy |

## Troubleshooting

- **`docker_proxy_unreachable` in logs** — the proxy didn't start, or the socket isn't mounted. Check `docker logs telehelm-socket-proxy`.
- **Bot doesn't respond at all** — your user ID isn't in `ALLOWED_USER_IDS` (unauthorized messages are dropped silently; check `docker logs telehelm-bot` for `unauthorized` lines), or `BOT_TOKEN` is wrong.
- **`409 Conflict` on launch** — another instance is already polling the same token. Run only one.
- **Logs look garbled** — handled for non-TTY containers via frame de-multiplexing and ANSI stripping; open an issue if a specific container still misbehaves.

## Extending it

If you later want richer control (e.g. `exec`, image management), flip the corresponding proxy flag — but understand each one widens the blast radius. `EXEC=1` in particular is close to giving the bot host root. Add an extra confirmation tier before enabling anything beyond lifecycle.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow and the bar applied to anything that touches the security model, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please report it privately — see
[SECURITY.md](SECURITY.md). Don't open a public issue, and never paste your
`BOT_TOKEN` anywhere.

## License

[MIT](LICENSE)
