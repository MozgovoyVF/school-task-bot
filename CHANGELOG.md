# Changelog

## [Unreleased]

Phase 1 (groups): workspace settings, claim-code owner transfer, group-chat lifecycle
(approve/pause/leave, 72h auto-leave for unapproved chats), message intake with stage-0
heuristics, `/chats` and `/people` management, privacy-mode enforcement with `/privacy` and
per-role scoped Telegram command menus, and a daily message-retention job.

### Added

- `src/domain/settings/schema.ts`, `src/domain/workspaces/repo.ts` — validated workspace settings
  (SPEC §16 defaults) and the single default workspace.
- `src/domain/people/*` — claim codes (`/transfer`, one-time, expiring, DM-only), owner transfer,
  `/people` with name/alias editing (`people.manage` permission, aliases capped at 10×30 chars).
- `src/domain/chats/*` — chat lifecycle (Owner approval/pause, member leave, 72h auto-leave for
  chats an owner never approved), message intake and edits, stage-0 heuristics for task detection,
  daily retention job that deletes message text and analysis-batch raw responses past the
  configured retention window while preserving rows still referenced by a pending proposal.
- `/chats` (Owner-only `chat.manage` permission, gates all `v1:c:*` callback actions).
- `/privacy` (identical reply in groups and DMs, SPEC §12.2) and privacy-mode enforcement
  (`checkPrivacyMode` alerts superadmins if `can_read_all_group_messages` is off).
- Per-role Telegram command menus (`syncCommands`, scoped DM/group/Owner/superadmin command
  lists), refreshed after ownership transfer via dependency injection (no domain→bot import).
- Correct `/start`/`/help` text for the Owner and Members, built from the same command-list
  source of truth as the Telegram menu.
- Group-chat safety: `/start`, `/help`, `/timezone`, `/admin` and the conversations plugin are now
  private-chat only, so a command typed in a group can no longer start a dialog that silently
  swallows the group's subsequent messages; the generic error reply is likewise private-chat only
  (superadmin error reports are unaffected).

### Known open point

- Whether `/task` in a chat still pending Owner approval should reach the Owner as a proposal, or
  stay fully dormant like a paused chat (current behaviour): SPEC doesn't cover the `pending` case
  explicitly. `/task`'s own handling is a stub until Phase 3 either way; to be confirmed during
  manual testing in a test group chat before Phase 3 relies on it.

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
