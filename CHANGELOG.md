# Changelog

## [Unreleased]

Phase 3 (tasks, reminders and assignees — Owner-only per D40): pre-due/due/overdue reminder
scheduling and delivery with quiet-hours grouping, retry and `done`/snooze buttons, a daily
morning summary, full task cards (status, edit, archive, delete), task lists with filters and
pagination (`/tasks`, `/today`, `/overdue`, `/archive`), search and per-assignee statistics,
manual task creation (`/task` in a group, `/new`, free DM text, forwards), `/settings` and
`/admin` AI/batch tuning, GDPR-style per-member and per-workspace data erasure, a
`pnpm feedback-report` from Owner decisions, and an end-to-end task-lifecycle acceptance test.

### Added

- `src/domain/notifications/plan.ts` — pure reminder-schedule function (SPEC §13.2): pre-due,
  due and a chained `overdue` series that stops once the task closes; a dedupe key versioned by
  the task's own version (D6: `task:{id}:v{version}:{kind}:{recipient}:{fire_date}`) so a
  same-day due-date change can't collide with an already-sent reminder; past-moment reminders are
  never created, only the nearest future `overdue` is, and the next one is added after delivery
  (D7).
- `src/domain/notifications/schedule.ts` — recomputes a task's pending reminders on every
  create/edit/complete/cancel/snooze, replacing stale rows atomically.
- `src/scheduler/jobs/notify.ts` — reminder delivery job: retries, per-recipient grouping,
  quiet-hours deferral, `FOR UPDATE SKIP LOCKED` claiming.
- `src/domain/notifications/snooze.ts`, `src/bot/views/reminder.ts` — `done`/`snooze` buttons
  on a delivered reminder (quick-pick snooze durations), own dedupe key (D6:
  `snooze:{task}:{recipient}:{fireAtISO}`).
- `src/scheduler/jobs/summary.ts`, `src/bot/views/summary.ts` — daily morning summary for the
  Owner (SPEC §13.4), its own dedupe key (D6: `summary:{workspace}:{recipient}:{date}`).
- `src/bot/views/taskCard.ts`, `src/bot/handlers/taskCallbacks.ts` — the task card (status, due,
  assignee, quote) with edit/archive/(soft-)delete actions and a task-events audit trail.
- `src/domain/tasks/queries.ts`, `src/bot/handlers/lists.ts` — `/tasks`, `/today`,
  `/overdue`, `/archive` with filters and pagination.
- `src/domain/tasks/search.ts`, `src/domain/tasks/stats.ts`, `/search`, `/stats` — free-text task
  search and per-assignee statistics.
- `src/bot/handlers/taskCommand.ts`, `/new`, `src/bot/handlers/dmFreeText.ts`,
  `src/ai/pipeline/extractSingle.ts`, `src/bot/handlers/forwards.ts` — manual task creation from a
  group `/task` reply/text, a DM dialog, free DM text (single-message LLM extraction), and
  forwarded messages, each capturing the quote and its author for later erasure (see
  `domain/people/erase.ts` below).
- `src/bot/handlers/settings.ts`, `/settings` (Owner) and extended `/admin` — AI model/batch
  tuning and workspace settings editing in-chat.
- `src/domain/people/erase.ts` (`eraseMember`) and `src/domain/workspaces/erase.ts`
  (`eraseWorkspace`) — GDPR-style per-member and per-workspace data erasure (SPEC §19.3.3): own
  messages deleted, assigned tasks anonymized (`texts.erase.anonymous`), quotes authored by the
  erased member redacted (`texts.erase.redactedQuote`) via `tasks.quote_author_user_id`/
  `proposals.payload.quoteAuthorUserId` tracked independently of the source message (D46 — a plain
  join through `messages` stopped matching once 30-day retention deleted the row), the quote
  author's display name redacted too (`texts.erase.redactedQuoteAuthor`, D46 extension,
  2026-10-02), claim codes and now-orphaned `users` rows cleaned up, an owner must `/transfer`
  first. Migrations `0002_narrow_azazel.sql` (D40 column drops) and `0003_red_mauler.sql`
  (`tasks.quote_author_user_id`, D46).
- `scripts/feedback-report.ts`, `pnpm feedback-report` (SPEC §20.4) — accept/reject/edit rates and
  common edit fields from the proposal decision history.
- `tests/integration/e2e/taskLifecycle.test.ts` — end-to-end acceptance scenario covering reminder
  buttons and the snooze dialog across a full task lifecycle.

### Removed

- **D40** (user decision, 2026-09-27): all notifications now go to the Owner only. Removed:
  assignment DMs, the assignee's «беру в работу»/«готово» buttons, the review flow
  (готово → owner принять/вернуть), assignee reminders and summary, `/my`,
  `memberships.notify_assignments`, `tasks.review_*` columns, `reminders.notifyAssignees` and
  `summary.forMembers` from the settings schema. Task 3.9 (the assignee-facing review flow) was
  dropped outright. The assignee remains a plain task field (card, filter, `/stats`); `/task` from
  a Member in a group still reaches the Owner as a proposal.

### Changed

- `/tasks`, `/today`, `/overdue`, `/new`, `/archive`, `/search`, `/stats` and `/settings` — the
  stub "coming soon" replies added at the end of Phase 2 are now real handlers.

### Fixed

- Review-round findings across Tasks 3.1–3.12 (quiet-hours edge cases in the reminder chain,
  oversized-digest splitting, dead overdue chains after a quiet-summary cancel, claim-code and
  orphaned-user cleanup on erasure) — see individual task commits for detail.
- **D47** (user decision, 2026-10-03, found during the `v0.4.0-rc.1` manual acceptance test): the
  extractor could merge a brand-new instruction into an unrelated open task of similar topic as an
  `update`, as long as the new instruction named a different person than the task's own assignee
  (e.g. "Вероника, подготовь отчёт" wrongly merged into Masha's open "Подготовить отчёт" task).
  `src/ai/schemas.ts`'s `update` action now carries `explicit_transfer`/`new_task_title`;
  `src/ai/pipeline/resolve.ts` turns such an `update` into a brand-new `create` action instead,
  unless the model flags an explicit hand-over (`explicit_transfer: true`, e.g. "передай
  Веронике"); `src/ai/pipeline/processBatch.ts` plumbs the target task's current assignee into
  `ResolveContext.targetTasks` for that comparison. Every `update`-kind card now also offers a
  manual "➕ Создать новой задачей" escape hatch regardless of this rule
  (`src/bot/views/proposalCard.ts`, `src/bot/texts/ru.ts`, `src/bot/keyboards/callbackCodec.ts`'s
  new `asn` action, `src/bot/handlers/proposalCallbacks.ts`,
  `src/domain/proposals/decide.ts`'s `createTaskFromUpdate`), including when the target is itself
  a still-pending proposal (D44). New prompt `prompts/extractor.v3.md`
  (`EXTRACTOR_PROMPT_VERSION`), 3 new synthetic examples in `prompts/examples.school_ru.json`.

### Known open points (flagged for the user, not blocking)

- `proposals.payload.quoteAuthorName` captured from a DM forward (`forwards.ts`) is always stored
  with `quoteAuthorUserId: null` (no reliable internal id on a `forward_origin`, same gap as
  `forward_origin_name`, Phase 2's M6) — such a quote's author name is not covered by `eraseMember`
  (D46's known, accepted limitation).
- `eraseMember`'s quote-author redaction (`tasks.quote_author_user_id`/
  `payload.quoteAuthorUserId`) is scoped to the current workspace; a cross-workspace pending
  proposal by the same erased user could in theory retain a dangling id (rare, multi-workspace
  scenario, parked as backlog per existing precedent elsewhere in `erase.ts`).
- Changing `settings.reminders.*` times or the Owner's `/timezone` does not replan reminders
  already scheduled for existing tasks (SPEC §13.2 only requires replanning on task changes) —
  they keep firing at the old time/zone until the task itself is next edited.

## [0.3.0] — 2026-10-01

Phase 2 (AI pipeline and proposals): message batching with daily cost budgeting, the
pseudonymized OpenRouter extraction pipeline with structured outputs, reference/due-date
resolution, visibility policy, duplicate detection, proposal cards with accept/apply/reject/
duplicate/edit flows and reactions, task creation from accepted proposals, an owner-facing
`/inbox`, a superadmin `/debug` and `/reanalyze`, proposal expiry, and a synthetic eval
dataset + runner.

### Added

- `src/ai/schemas.ts` — `ExtractionResult`/`Action`/`Due` zod schemas (verbatim SPEC §9.5),
  a wire schema for OpenRouter's structured-output constraints (nullable instead of optional),
  and `parseExtraction` (normalize-then-validate).
- `src/ai/pseudonymize.ts` — regex-based redaction (names, phones, amounts) applied to every
  message before it reaches the LLM.
- `prompts/extractor.v1.md` + `prompts/examples.school_ru.json`, `src/ai/prompts.ts`,
  `src/ai/pipeline/buildInput.ts` — the extractor prompt (system/few-shot/user template split
  by `<!-- DATA -->`, D27) and pseudonymized input assembly.
- `src/ai/pipeline/{resolveDue,resolve}.ts` — SPEC §10 due-date resolution (luxon, DST-safe) and
  SPEC §9.5/§9.6 reference/assignee resolution.
- `src/ai/pipeline/policy.ts` — confidence-threshold visibility policy (SPEC §9.6, config-driven
  per-category thresholds).
- `src/ai/pipeline/dedup.ts` — trigram-similarity duplicate candidate search against open tasks.
- `src/ai/pipeline/{batcher,budget,analyze}.ts`, `src/scheduler/jobs/analyze.ts` — message
  batching, daily LLM cost budget with pause+alert on overrun (manual/`reanalyze` batches keep
  working while paused, per SPEC.md:260), `FOR UPDATE SKIP LOCKED` batch claiming with backoff
  and stale-batch recovery.
- `src/ai/pipeline/processBatch.ts`, `src/domain/proposals/repo.ts` — extraction → resolution →
  policy → dedup → transactional proposal insert, with outbox-style `notified_at`.
- `src/scheduler/jobs/cards.ts`, `src/bot/views/proposalCard.ts` — proposal cards for the Owner
  (create/update/complete/cancel), quiet-hours-aware delivery (summary/overflow grouping),
  reactions fired once per proposal at actual delivery time.
- `src/domain/proposals/decide.ts`, `src/bot/handlers/proposalCallbacks.ts`,
  `src/domain/tasks/{repo,service,events}.ts` — accept/apply/reject/duplicate(mark-only or
  mark-and-append)/edit decisions via atomic `UPDATE ... WHERE status='pending' RETURNING`
  (race-safe under concurrent accepts), task creation from accepted proposals.
- `src/bot/conversations/editProposal.ts`, `src/bot/views/editMenu.ts`,
  `src/time/quickDue.ts`, `src/ai/pipeline/parseDate.ts` — Owner edit dialog (quick-pick due
  dates, free-text date parsing via the LLM, assignee submenu) before accepting a proposal.
- `src/bot/handlers/inbox.ts` (`/inbox`, Owner), `src/bot/views/debug.ts` (`/debug`,
  `/reanalyze`, superadmin per SPEC §12.2), `src/domain/proposals/queries.ts`,
  `src/domain/ai/stats.ts` — pipeline visibility and manual re-analysis tooling.
- `src/scheduler/jobs/expireProposals.ts` — daily expiry of proposals pending 7+ days (D11).
- `eval/` — synthetic Russian-language eval dataset (`eval/datasets/school_ru.v1.jsonl`, 153
  cases) and `pnpm eval` CLI (`eval/run.ts`) computing recall/precision/date-accuracy metrics
  against SPEC §20.2 targets, with a `$1` cost pre-flight gate and a `--provider fixture` offline
  smoke-test mode.
- `src/app.ts` now wires `analyzeJob`/`cardsJob`/`expireProposalsJob` into the production ticker
  and constructs a real `AiProviders` (OpenRouter client + extraction provider) from env, so the
  AI pipeline actually runs outside tests.

- `prompts/extractor.v2.md` (D45, Task 2.18) — vague-intention rule: an intention with no concrete
  action, assignee, or due date no longer creates a proposal; `extractor.v1.md` is kept unedited
  (D27).
- Model selection (Task 2.18, `eval/reports/COMPARISON.md`): primary `openai/gpt-5-mini`, fallback
  `openai/gpt-4.1-mini`, both on `extractor.v2` — `src/config/constants.ts`'s
  `EXTRACTOR_PROMPT_VERSION` now points at `extractor.v2`, `.env.example` documents the chosen
  models.

### Fixed

- Real-eval findings from running candidate models through `pnpm eval` (Task 2.18) surfaced four
  OpenRouter/provider-compat bugs, fixed before any candidate could be scored:
  - `openrouter.ts` sent `temperature: 0` unconditionally, 404ing on models whose endpoints don't
    support it (`openai/gpt-5-mini`); now retried once without `temperature` and remembered
    per model, like the existing non-strict-schema fallback.
  - the wire JSON schema now defaults to the full strict schema (needed by
    `deepseek/deepseek-v4-flash`, whose recall collapsed under a stripped schema) and only falls
    back to a Gemini-compatible schema (no `pattern`/`minLength`/`maxLength`) per model once that
    model is seen rejecting the strict one.
  - `parseExtraction` now always normalizes a `create` action's `target_ref` to `null` instead of
    validating it (not meaningful for a new task), so a stray value there can no longer fail the
    whole batch; `update`/`complete`/`cancel` still validate `target_ref` as before.
  - `eval/run.ts` samples `--limit` cases evenly across the dataset instead of taking a prefix,
    scores each case independently instead of aborting the run on the first failure (surfacing
    per-case errors and a per-model error summary in the report), and now always asks for
    confirmation (or requires `--yes`) before any real `--provider openrouter` API call.
- **D44** resolved (found during manual acceptance of `v0.3.0-rc.1` on dev): an
  `update`/`complete`/`cancel` proposal whose `payload.targetProposalId` pointed at another
  proposal that was later decided used to stay `pending` forever — never getting a card, logging
  a warning every single tick. `cardsJob` now calls `resolveDependentProposals`
  (`src/domain/proposals/resolveDependents.ts`) at the top of every tick: once the target is
  `accepted`, the dependent is re-targeted onto the resulting task (`tasks.proposal_id`) and
  delivered as an ordinary card the same tick; when the target was instead `rejected` as a
  duplicate of an existing task (`reject_reason='duplicate'`, user decision 2026-10-01, review
  round 1 M1) and its own `payload.duplicateOf` resolves to that task, the dependent is
  re-targeted onto it too, the same as `accepted`; once the target is `rejected` for any other
  reason (or `duplicate` with no resolvable task) / `expired` / `superseded` (no task ever
  resulted), the dependent is closed too (`status='expired'`) so it stops looping; while the
  target is still `pending`, it keeps waiting, now logged once at `debug` instead of `warn` on
  every tick.
- `/tasks`, `/today`, `/overdue`, `/new`, `/archive`, `/search`, `/stats` and `/settings` are
  listed in the Owner's command menu (`src/bot/commands.ts`) but had no handler yet, so the bot
  stayed silent (found during manual acceptance of `v0.3.0-rc.1` on dev). `src/bot/handlers/stubs.ts`
  now replies with a short "coming in a future update" DM text (`texts.common.comingSoon`) for each,
  gated to the Owner only (`can(actor, 'task.viewAll')`, review round 1, I1 — the first version
  replied to anyone), until Phase 3 implements them for real; group-chat behaviour is unchanged.
- The daily LLM budget alert (and `/admin`'s cost lines) rounded any USD amount under one cent to
  `"0.00"` via a flat `toFixed(2)` — visible with a tiny `LLM_DAILY_BUDGET_USD` (e.g. `0.0001`),
  which showed as "из 0.00 $" (found during manual acceptance of `v0.3.0-rc.1` on dev).
  `formatUsd` (`src/bot/texts/ru.ts`) now shows up to 4 decimal places (trimmed of trailing
  zeros) for amounts under one cent, two decimal places otherwise, and «менее 0.0001» (review
  round 1, M7; re-reviewed to drop a raw `<0.0001` — every call site sends `parse_mode: 'HTML'`,
  and an unescaped `<` there made Telegram reject the whole message) for anything smaller still,
  instead of rounding it to a misleading `"0.0000"`.

### Known open points (flagged for the user, not blocking)

- Quiet-hours interaction between `weekdays`/`windows`/`dateRanges` was implemented as an
  independent OR across all three (Task 2.12); SPEC leaves room for an AND/nested reading too.
- Proposal reactions (👀) fire when a card is actually delivered to the Owner, not strictly "at
  creation time" as SPEC §9 literally says — deliberate tradeoff to avoid firing reactions on
  proposals still waiting out quiet hours.
- Real-model eval ran and the model/prompt choice is recorded (Task 2.18 steps 1–4,
  `eval/reports/COMPARISON.md`); manual acceptance on the dev bot (Task 2.18 step 5, RC
  `v0.3.0-rc.1`) and phase closing (step 6) are still open.

## [0.2.0] — 2026-09-28

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
