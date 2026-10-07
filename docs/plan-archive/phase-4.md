# План: завершённая фаза 4 (архив)

Перенесено из `plan.md` после выпуска `v1.0.0` (PR #14, #15). Решения D-таблицы и общие контракты остаются в `plan.md`.

## Фаза 4 — Прод и переезд к руководителю (ветка `phase-4-prod`)

**Гейт:** юридическое согласование (SPEC §19.5). Prod не запускается в реальных чатах, пока руководитель не подтвердит, что профиль (А или Б) и документы согласованы с юристом.

**Приёмка (SPEC §22):** восстановление из бэкапа на чистом сервере по инструкции · руководитель успешно выполнил claim · бот работает в реальных группах.

### Task 4.1: Бэкапы — регламент, оповещения, проверка восстановления

**Файлы:** изменить `scripts/backup.sh`, `scripts/restore.sh`; создать `scripts/test-backup-restore.sh`, `docs/OPERATIONS.md` (раздел «Бэкапы»).

- [x] **Шаг 1:** `scripts/test-backup-restore.sh` полностью в Docker:
  1. Поднять временный Postgres 17 и заполнить его фикстурой.
  2. Выполнить `backup.sh` с тестовым age-ключом.
  3. Поднять второй временный Postgres и восстановить в него через `restore.sh`.
  4. Сравнить `count(*)` по всем таблицам.

  Скрипт должен падать, если в восстановленной БД чего-то не хватает: проверить это, удалив одну таблицу из дампа. После проверки вернуть исходное состояние.

- [x] **Шаг 2:** cron на сервере `0 3 * * * /opt/stb-prod/scripts/backup.sh >> /var/log/stb-backup.log 2>&1` (03:00 UTC, SPEC §27.10). При неудаче `backup.sh` отправляет оповещение superadmin через Bot API. Строка задокументирована в `docs/OPERATIONS.md`; в crontab прод-сервера установлено 2026-10-07 как `15 3 * * * cd /opt/stb-prod && ./scripts/backup.sh >> /opt/stb-prod/backups/backup.log 2>&1` (03:15 UTC, чтобы не совпадать с dev в 03:00).
- [x] **Шаг 3:** описать в `docs/OPERATIONS.md` ротацию, где хранится приватный ключ (вне сервера) и пошаговое восстановление на чистом сервере.
- [x] **Шаг 4: коммит и push:** `chore(ops): verify backup and restore round-trip`.

### Task 4.2: Watchdog и финальный `/admin`

**Файлы:** создать `src/ops/watchdog.ts`; изменить `src/app.ts`; тест `tests/integration/ops/watchdog.test.ts`.

**Интерфейсы:** Produces `checkTickerGapOnStart(deps): Promise<void>` — если `app_state['ticker:heartbeat']` старше 2 мин, вызывается `errors.alert('ticker_gap', …)` с длительностью простоя (SPEC §18).

- [x] **Шаг 1: падающий тест.**
  - Heartbeat 5 мин назад → при старте superadmin получает оповещение «ticker не работал 5 мин».
  - Heartbeat 30 с назад → оповещения нет.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5:** сверить `/admin` с SPEC §18: версия, аптайм, pending по чатам, стоимость LLM за сегодня и месяц, proposals за 7 дней, precision, «Код владельца», «Удалить workspace», последние ошибки. Недостающее дописать с тестами.
- [x] **Шаг 6: коммит и push:** `feat(ops): alert on ticker downtime at startup`.

### Task 4.3: Документы — OPERATIONS, MIGRATION_TO_OWNER, юридические шаблоны

**Файлы:** создать `docs/OPERATIONS.md`, `docs/MIGRATION_TO_OWNER.md`, `docs/legal/consent_template.md`, `docs/legal/processing_policy_template.md`, `docs/legal/rkn_checklist.md`; изменить `docs/legal/privacy_notice_chat.md`, `docs/legal/privacy_full.md`.

- [x] **Шаг 1:** `docs/OPERATIONS.md`: логи (`docker compose logs -f app`), `/admin`, `/debug`, диск (`df -h`), обновление и откат (`scripts/deploy.sh`), бэкапы, типовые инциденты (бюджет LLM, заблокированный бот, privacy mode, падение OpenRouter, миграция group → supergroup), ротация токена.
- [x] **Шаг 2:** `docs/MIGRATION_TO_OWNER.md` — 8 шагов SPEC §17.3 с командами. **Первый пункт чек-листа — юридический гейт** (профиль А или Б и документы согласованы).
- [x] **Шаг 3:** шаблоны `docs/legal/*` (SPEC §19.5), каждый с пометкой «⚠️ Шаблон, проверить юристу». Содержание:
  - какие данные обрабатываются, цели и сроки хранения (30 дней для текстов);
  - передача за рубеж (OpenRouter) и псевдонимизация, включая то, что имена третьих лиц в MVP не заменяются;
  - как запросить удаление;
  - чек-лист уведомлений РКН (ст. 22, ст. 12).
- [x] **Шаг 4: коммит и push:** `docs: add operations runbook, owner migration guide and legal templates`.

### Task 4.4: Профиль Б — БД в РФ через WireGuard

**Файлы:** создать `docker/compose.db-remote.yml`, `docs/DEPLOY_PROFILE_B.md`.

- [x] **Шаг 1:** `compose.db-remote.yml` — только сервис `app` без `db`. `DATABASE_URL` указывает на туннельный адрес с `sslmode=require` (SPEC §19.4).
- [x] **Шаг 2:** `docs/DEPLOY_PROFILE_B.md`:
  1. VPS в РФ с Postgres 17 (UTF-8 локаль для `pg_trgm`).
  2. TLS-сертификат Postgres.
  3. WireGuard между серверами: ключи, `wg0.conf`, `ufw`.
  4. Проверка `psql "sslmode=require host=10.x.x.x"`.
  5. Бэкапы на стороне РФ.
  6. Проверка, что на ЕС-сервере нет данных (`docker volume ls`).
- [x] **Шаг 3:** проверка — CI собирает образ. Локально `docker compose -f docker/compose.db-remote.yml config` без ошибок.
- [x] **Шаг 4: коммит и push:** `docs(deploy): add strict profile B with remote database`.

### Task 4.5 (👤): Юридический гейт, prod, переезд, закрытие фазы

- [x] **Шаг 1 (👤):** руководитель подтверждает, что профиль и документы согласованы с юристом. Подтверждение фиксируется в `docs/MIGRATION_TO_OWNER.md` (дата и выбранный профиль, без ПД).
- [x] **Шаг 2 (👤 и агент):** prod по `docs/DEPLOY.md`: `/opt/stb-prod`, чистая БД, **без** `BOOTSTRAP_OWNER_TG_ID`, релиз `v1.0.0-rc.1`. 2026-10-07: `rc.1` падал при старте (`setMyCommands` для чата суперадмина → 400 «chat not found», пока суперадмин не написал новому боту `/start`); исправлено, в prod работает `v1.0.0-rc.2`.
- [ ] **Шаг 3 (👤):** восстановление из бэкапа на чистом сервере по `docs/OPERATIONS.md` (приёмка). Отложено пользователем 2026-10-07; первый prod-бэкап снят и доставлен superadmin.
- [x] **Шаг 4 (👤):** выполнено 2026-10-07 (передача через Transfer Ownership, токен перевыпущен руководителем).
  1. `/admin → Код владельца`.
  2. Руководитель выполняет `/start`, `/claim КОД` и выбирает пояс.
  3. Руководитель добавляет бота в рабочие группы.
  4. Проверочное поручение даёт карточку.
  5. Бот передаётся в @BotFather, токен перевыпускается (SPEC §17.3).
- [x] **Шаг 5: закрытие фазы:** `CHANGELOG.md`, PR `Phase 4: production` → 👤 → merge → тег `v1.0.0`. PR #15 смержен 2026-10-07, тег `v1.0.0`, prod переведён на `v1.0.0`.
