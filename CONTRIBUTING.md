# Contributing

Thanks for your interest in improving this project! It's a small, security-
focused homelab tool, so contributions are welcome but held to a careful bar
on anything that widens what the bot can do.

## Getting started

1. Fork and clone the repo.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure your environment:
   ```bash
   cp .env.example .env
   # set BOT_TOKEN and ALLOWED_USER_IDS
   ```
4. Run locally (you'll need Docker for the socket proxy):
   ```bash
   docker compose up -d --build
   # or, for the bot only, against a reachable proxy:
   npm start
   ```

## Ground rules

- **Never commit secrets.** `.env` is gitignored — keep it that way. Don't put
  real tokens or user IDs in code, tests, commits, or issues.
- **Respect the security model.** The least-privilege proxy, fail-closed
  allowlist, confirmation step, and audit log are the reason this project
  exists. PRs that loosen them (e.g. enabling `EXEC`/`POST`, removing
  confirmations, broadening permissions by default) will be declined unless
  they're opt-in and documented with the blast-radius trade-off.
- **Keep it least-privilege.** New capabilities should be gated behind explicit
  config, off by default.

## Making changes

1. Create a branch off `main` (`git checkout -b fix/short-description`).
2. Make focused commits with clear messages.
3. Match the existing code style — CommonJS, no build step, minimal
   dependencies. Don't add a dependency without a good reason.
4. Update the `README.md` if you change behavior, commands, or config.
5. Open a PR against `main` and fill out the template.

## Reporting bugs & requesting features

Use the issue templates. For anything security-sensitive, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).
