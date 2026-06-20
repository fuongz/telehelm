# Security Policy

This project is a remote-control surface for a Docker host, so security is the
whole point of it. Please read this before deploying — and before reporting.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, report privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(the **Security → Report a vulnerability** tab on this repo), or email the
maintainer at **hi@phuongphung.com**.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected version / commit.

You can expect an initial acknowledgement within **5 business days**. We'll keep
you updated on remediation and coordinate a disclosure timeline with you.

## Supported versions

This is a small homelab project; only the latest `main` is supported. Fixes
land on `main` and are tagged.

## Operator responsibilities

The two controls below are effectively your root credentials. The project's
defense-in-depth (socket proxy, internal network, confirmation, rate limiting)
does not save you if these are mishandled:

- **`BOT_TOKEN`** — functionally equivalent to control of your Docker host.
  Keep it in `.env` (gitignored) or a secrets manager. Never commit it, never
  paste it into issues, logs, or screenshots. Rotate it via @BotFather if it
  leaks.
- **`ALLOWED_USER_IDS`** — the allowlist is fail-closed (empty list = bot
  refuses to start). Only add IDs you control.

If you accidentally commit a token, rotate it immediately — scrubbing git
history is not enough, assume any pushed secret is compromised.

## Scope

In scope: authentication bypass, the bot performing actions beyond the
documented allowlist, secret leakage, and proxy escape (e.g. reaching blocked
Docker endpoints). Out of scope: misconfiguration by the operator (leaked
token, over-broad allowlist, enabling `EXEC=1`/`POST=1` against the README's
guidance).
