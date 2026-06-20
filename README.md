# telehelm

> Steer your Docker containers from Telegram — your phone is the helm.

Control your homelab's Docker containers from Telegram — list, view logs/stats, and start/stop/restart — with a security model designed around the fact that **a Telegram bot is an internet-reachable remote-control surface**.

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
- **Hardened bot container.** Runs as non-root, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem.

## Setup

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **Find your user ID.** Message [@userinfobot](https://t.me/userinfobot); it replies with your numeric ID.
3. **Configure.**
   ```bash
   cp .env.example .env
   # edit .env: set BOT_TOKEN and ALLOWED_USER_IDS (comma-separated)
   ```
4. **Run** (on the homelab):
   ```bash
   docker compose up -d --build
   ```
5. In Telegram, open your bot and send `/ps`.

## Usage

- `/ps` — list all containers; tap one to open its menu.
- Container menu: **📄 Logs** (last 100 lines), **📊 Stats** (CPU/mem, sampled over 1s for accuracy), and **▶️ Start / ⏹️ Stop / 🔄 Restart** (with confirmation).
- `/help` — command summary.

## What the bot can and cannot do

| Action | Allowed |
|---|---|
| List / inspect containers | ✅ |
| View logs, stats | ✅ |
| Start / stop / restart | ✅ |
| Create / run new containers | ❌ blocked at proxy |
| `exec` into a container | ❌ blocked at proxy |
| Pull / build images, manage volumes/networks | ❌ blocked at proxy |

## Troubleshooting

- **`docker_proxy_unreachable` in logs** — the proxy didn't start, or the socket isn't mounted. Check `docker logs dtb-socket-proxy`.
- **Bot doesn't respond at all** — your user ID isn't in `ALLOWED_USER_IDS` (unauthorized messages are dropped silently; check `docker logs dtb-bot` for `unauthorized` lines), or `BOT_TOKEN` is wrong.
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
