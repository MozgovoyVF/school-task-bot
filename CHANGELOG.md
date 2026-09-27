# Changelog

## [Unreleased]

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
