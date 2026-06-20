# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Rewrote the source in **TypeScript**, now run on the **Bun** runtime (no
  build step — Bun executes the `.ts` entry directly).
- Dockerfile rebuilt on `oven/bun:1-alpine` (multi-stage, non-root `bun` user).
- `docker-compose.yml`: named stack (`telehelm`), containers renamed to
  `telehelm-bot` / `telehelm-socket-proxy`, secrets loaded from an optional
  `.env` file via `env_file`.

## [1.0.0]

### Added
- Initial release: control Docker containers from Telegram (`/ps`, logs, stats,
  start/stop/restart) via long polling.
- Least-privilege `socket-proxy` (LinuxServer fork) on an internal-only network;
  create/exec/image/volume/network operations blocked at the proxy.
- Fail-closed user-ID allowlist, per-user rate limiting, confirmation step on
  lifecycle actions, and JSON audit logging.
- Hardened bot container: non-root, `cap_drop: ALL`, `no-new-privileges`,
  read-only root filesystem.

[Unreleased]: https://github.com/fuongz/telehelm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/fuongz/telehelm/releases/tag/v1.0.0
