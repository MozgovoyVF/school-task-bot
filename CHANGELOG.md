# Changelog

## [Unreleased]

## [0.1.0] — 2026-09-27

Phase 0 (skeleton): project tooling, zod env config, pino logger with PII redaction, Drizzle
schema and migrations, error reporter, ticker and `/healthz`, bot skeleton (`/start`, `/help`,
`/admin`, `/testerror`), Docker image and compose files, CI/release workflows, deploy and backup
scripts. Accepted on the dev VPS on 2026-09-27.

### Added

- `scripts/deploy.sh` — pulls a new image tag, waits for `/healthz` up to 90s, rolls back to the
  previously deployed tag on failure.
- `scripts/backup.sh` — `pg_dump | gzip | age`-encrypted backups, keeps the 14 most recent copies,
  forwards the file to the superadmin via Telegram when ≤ 50MB, alerts on failure.
- `scripts/restore.sh` — restores an encrypted backup into a freshly recreated database and
  verifies `/healthz` afterwards.
- `docs/DEPLOY.md` — step-by-step VPS deployment guide covering all 14 points of SPEC §27 (VPS
  selection, server hardening, Docker install, @BotFather/OpenRouter setup, first deploy, test
  group, backups, version updates/rollback, monitoring, domain/HTTPS for phase 5, VPS-based dev
  fallback).
