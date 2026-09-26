# CLAUDE.md — school-task-bot («Секретарь школы»)

Инструкции для агентов, работающих в этом репозитории. Читать целиком в начале каждой сессии.

- С пользователем общаемся **на русском**.
- Код, идентификаторы, комментарии, сообщения коммитов и названия веток пишем **на английском**.
- Тексты интерфейса бота пишем на русском, вежливо, коротко, на «вы». Все они лежат в `src/bot/texts/ru.ts`.

## 1. Что это за проект

Telegram-бот для руководителя школы французского языка. Бот молча читает до 5 рабочих групп (до ~500 сообщений в день). С помощью LLM (OpenRouter) он находит поручения, договорённости, события, а также сообщения о выполнении, переносе и отмене. Руководителю (Owner) в личный чат приходят карточки-предложения с кнопками. Бот ведёт задачи, напоминает о сроках и каждое утро присылает сводку. Позже появятся синхронизация с Apple «Напоминаниями» (фаза 5) и Mini App (фаза 6).

**Главный приоритет качества: пропуск задачи хуже ложного срабатывания.** Все пороги настраиваются в пользу полноты (recall).

## 2. Источники правды и приоритет

1. Явное указание пользователя в текущей сессии.
2. `SPEC.md` — спецификация, единственный источник бизнес-правил. Ссылайся на разделы как «SPEC §13.2».
3. `plan.md` — пошаговый план: фазы, задачи, интерфейсы, тест-кейсы, принятые решения (раздел «Решения и интерпретации»).
4. Этот файл: правила работы и соглашения по коду.

Если `plan.md` расходится с `SPEC.md`, прав `SPEC.md`: остановись и спроси пользователя. Если спецификация противоречива, неполна или требует решения, которого в ней нет, **остановись и задай вопрос** (SPEC §0.3). Бизнес-правила не выдумывай. Принятое решение запиши в `plan.md` → «Решения и интерпретации».

## 3. Рабочий процесс (обязательно)

1. **Фазы идут строго по порядку** (SPEC §22, `plan.md`). Следующая фаза не начинается, пока не выполнены критерии приёмки текущей, включая ручные проверки пользователя.
2. **Ветка на фазу:** `phase-<N>-<slug>` от свежего `main`, например `phase-0-skeleton`, `phase-1-groups`. Прямые коммиты в `main` запрещены; исключение одно — начальный коммит в задаче 0.1.
3. **Каждая задача плана** проходит один цикл:
   1. Сверить API используемых библиотек через **Context7** (раздел 5).
   2. TDD: написать падающий тест, убедиться, что он падает, написать минимальную реализацию, убедиться, что тест зелёный.
   3. Прогнать `pnpm lint && pnpm typecheck && pnpm test`. Всё должно быть зелёным.
   4. Отметить выполненные шаги в `plan.md` (`- [x]`) в том же коммите.
   5. **Коммит и `git push` в ветку фазы.** Задача не считается выполненной, пока коммит не отправлен на GitHub.
4. **Коммиты** — Conventional Commits на английском: `feat(ai): add extraction zod schemas`, `fix(scheduler): …`, `test(time): …`, `docs: …`, `chore(ci): …`. Одна задача — минимум один коммит. `git push --force` в общие ветки запрещён.
5. **Конец фазы:** обновить `docs/` и `CHANGELOG.md`, открыть PR `phase-N-… → main` через `gh pr create` и дождаться зелёного CI. Затем отчитаться пользователю по критериям приёмки. Мерж делается через `gh pr merge --merge` (merge-коммит сохраняет историю по задачам) **только после подтверждения пользователя**.
6. **Не делай без явного разрешения пользователя:** деплой на сервер, изменение настроек репозитория на GitHub, реальные вызовы LLM (eval стоит денег), действия в реальных Telegram-чатах, удаление данных.
7. **Исполнение и лимиты подписки.** План выполняется по одной фазе через субагента `stb-orchestrator`, который ведёт `superpowers:subagent-driven-development` (`plan.md` → «Как пользоваться планом», п. 8).
   - Субагенты вызываются только типами из `.claude/agents/` (`stb-implementer`, `stb-reviewer`), и модель всегда указывается явно.
   - Нельзя вызывать `general-purpose` или не указывать тип: такой субагент унаследует модель и effort основной сессии, а это быстро расходует лимит.
   - По умолчанию используется Sonnet. Opus подключается только для рискованных ревью, раундов исправлений 4–5 и финального ревью фазы.
   - Баги разбираются через `superpowers:systematic-debugging`. Перед заявлением «готово» используется `superpowers:verification-before-completion`.

## 4. Команды

```bash
npm i -g pnpm@12.6.0                  # один раз; corepack из Node 24 не запускает pnpm 12 (ищет bin/pnpm.cjs, а в пакете bin/pnpm.mjs)
pnpm install
pnpm db:up                            # Postgres 17 для разработки и тестов (docker/compose.dev.yml, порт 5433)
pnpm dev                              # tsx watch src/index.ts (нужен .env)
pnpm lint | pnpm format | pnpm format:check | pnpm typecheck
pnpm test                             # unit + integration (нужен pnpm db:up)
pnpm test:unit                        # только unit, без БД
pnpm test:int                         # только integration
pnpm coverage                         # покрытие domain/ и ai/pipeline/ ≥ 80%
pnpm db:generate                      # drizzle-kit: SQL-миграция из изменений схемы
pnpm db:migrate                       # применить миграции к DATABASE_URL
pnpm build && pnpm start              # сборка в dist/ и запуск
pnpm eval --model <id> --limit 20     # РЕАЛЬНЫЙ API, стоит денег — только с разрешения пользователя
docker compose -f docker/compose.yml -p stb-dev up -d   # как на сервере
```

Для тестов нужна переменная `TEST_DATABASE_URL`, по умолчанию `postgres://stb:stb@localhost:5433/stb_test`.

## 5. Документация библиотек: Context7 обязателен

Перед тем как писать код с использованием библиотеки, фреймворка или внешнего API, **сверь актуальную документацию через Context7**. Порядок: `mcp__context7__resolve-library-id`, затем `mcp__context7__query-docs`, один запрос на одну тему. Спецификация описывает намерение, а не точные сигнатуры (SPEC §0.6). Обучающие данные модели могут отставать от текущих версий.

- Если Context7 недоступен (квота, сеть), используй официальную документацию через WebFetch (ссылки ниже) и упомяни это в отчёте о задаче.
- При первом обращении к библиотеке впиши её Context7 ID в таблицу, чтобы следующие агенты не искали его заново.

| Технология                                                                     | Официальная документация              | Context7 ID                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------- |
| grammY и плагины (runner, conversations v2, auto-retry, transformer-throttler) | https://grammy.dev                    | `/grammyjs/website` (общее), `/grammyjs/conversations` (диалоги) |
| Telegram Bot API                                                               | https://core.telegram.org/bots/api    | —                                                                |
| Drizzle ORM / drizzle-kit                                                      | https://orm.drizzle.team              | `/drizzle-team/drizzle-orm-docs`                                 |
| postgres.js                                                                    | https://github.com/porsager/postgres  | —                                                                |
| PostgreSQL 17, pg_trgm                                                         | https://www.postgresql.org/docs/17/   | —                                                                |
| zod v4                                                                         | https://zod.dev                       | —                                                                |
| OpenAI Node SDK (для OpenRouter)                                               | https://github.com/openai/openai-node | —                                                                |
| OpenRouter API                                                                 | https://openrouter.ai/docs            | —                                                                |
| luxon                                                                          | https://moment.github.io/luxon        | —                                                                |
| Fastify 5                                                                      | https://fastify.dev                   | `/fastify/fastify`                                               |
| pino                                                                           | https://getpino.io                    | —                                                                |
| vitest                                                                         | https://vitest.dev                    | —                                                                |
| typescript-eslint / ESLint flat config                                         | https://typescript-eslint.io          | —                                                                |
| Docker / Compose                                                               | https://docs.docker.com               | —                                                                |
| GitHub Actions / GHCR                                                          | https://docs.github.com/actions       | —                                                                |

Уже проверенные факты (2026-09-26):

- **conversations v2:** сессии не нужны. Внутри диалога есть replay-семантика, поэтому все побочные эффекты (БД, время, случайные числа) выполняются только через `conversation.external(...)`, время берётся через `conversation.now()`. Таймаут задаётся опцией `createConversation(fn, { maxMillisecondsToWait })`. Вход в диалог — `ctx.conversation.enter(name, ...jsonArgs)`.
- **OpenRouter:** `usage.cost`, `usage.prompt_tokens` и `usage.completion_tokens` приходят в каждом ответе автоматически. Параметр `usage: { include: true }` устарел, его не передаём.
- **TypeScript:** в npm latest уже 7.x, но по SPEC §4 держим **5.x** (`~5.9.3`). typescript-eslint поддерживает TS `<6.1`.
- **@grammyjs/transformer-throttler** 1.2.1 совместим с grammy ^1.
- **drizzle-orm 0.45.3 / drizzle-kit 0.31.11:** postgres.js-драйвер — `drizzle(client, { schema })` из `drizzle-orm/postgres-js`, миграции — `migrate(db, { migrationsFolder })` из `drizzle-orm/postgres-js/migrator`. При круговых ссылках между таблицами из разных файлов схемы (напр. `messages.batch_id → analysis_batches`, `analysis_batches.first_message_id → messages`) `drizzle-kit generate` работает без проблем (FK добавляются через `ALTER TABLE` после всех `CREATE TABLE`), но `tsc` падает с `TS7022` (циклический вывод типа таблицы). Лечится явной аннотацией возврата колбэка: `.references((): AnyPgColumn => other.id, {...})` вместо `.references(() => other.id, {...})`.

## 6. Стек (SPEC §4) и зависимости

Node.js 24 LTS · TypeScript 5.9 strict · ESM · pnpm · grammY + `@grammyjs/runner` + `@grammyjs/conversations` + `@grammyjs/auto-retry` + `@grammyjs/transformer-throttler` · PostgreSQL 17 + `pg_trgm` · Drizzle ORM + drizzle-kit + `postgres` · zod v4 · `openai` SDK с baseURL OpenRouter · luxon · Fastify · pino · vitest · eslint (typescript-eslint) + prettier · Docker Compose v2 · GitHub Actions + GHCR · Caddy (с фазы 5).

**Новые зависимости добавляются только из этого списка.** Для любых других нужен обоснованный запрос пользователю. Заранее одобрены только dev-инструменты, вытекающие из стека: `tsx`, `@vitest/coverage-v8` (и `vite`, если его требует vitest как peer-зависимость), `@types/node`, `@types/luxon`, `eslint-config-prettier`. Redis, очереди и Supabase не используются.

## 7. Архитектура и границы модулей (SPEC §5, §25)

Приложение — один Node-процесс: `bot/` + `ai/` + `scheduler/` + `domain/` + `http/`, БД — PostgreSQL. Апдейты приходят через long polling.

```
src/index.ts      composition root: config → db/migrate → bot → scheduler → http
src/config/       env.ts (zod), constants.ts (стоп-лист, лимиты)
src/db/           client.ts, schema/*.ts, migrations/ (SQL, генерирует drizzle-kit)
src/domain/       бизнес-логика: tasks, proposals, people, chats, workspaces, notifications, settings
src/ai/           pipeline/ (batcher, heuristics, buildInput, extract, resolve, policy, dedup), providers/, pseudonymize.ts
src/scheduler/    ticker.ts + jobs/ (analyze, cards, notify, summary, retention, …)
src/time/         clock.ts, resolveDue.ts, zones.ts, quiet.ts, format.ts
src/bot/          bot.ts, middleware/, handlers/, conversations/, keyboards/ (callback-кодек), views/ (чистые рендеры), texts/ru.ts
src/http/         server.ts, routes/health.ts
src/ops/          logger.ts, errorReporter.ts
```

Правила зависимостей (часть из них проверяет eslint):

- `domain/`, `ai/`, `time/` и `scheduler/` **не импортируют `grammy`**. Отправка в Telegram идёт через интерфейс `Messenger`: он объявлен в `src/domain/messenger.ts`, реализован на grammY в `src/bot/messenger.ts`, а в тестах подменяется на `tests/helpers/fakeMessenger.ts`.
- `bot/views/` — чистые функции без БД и I/O. Они возвращают `{ text, buttons }` и покрываются snapshot-тестами.
- `bot/handlers/` тонкие: разобрать ввод, проверить права, вызвать domain-сервис, отрендерить view.
- Бизнес-логика живёт в `domain/`. Функции принимают `DbOrTx` первым аргументом.

## 8. Правила кода (SPEC §0.4 и решения плана)

- TypeScript `strict` + `noUncheckedIndexedAccess`. ESM: импорты с расширением `.js`, `verbatimModuleSyntax`. **Без `any`**; исключение допустимо только с комментарием `// eslint-disable-next-line … -- причина`.
- **Все внешние данные проходят через zod:** env, ответы LLM, HTTP, `callback_data`, данные из `jsonb`. Для булевых env не используй `z.coerce.boolean()`: он превращает строку `"false"` в `true`. Используй свой парсер `"true"|"false"`.
- **Время.** В БД только UTC (`timestamptz`). Часовые пояса обрабатываются только через luxon. В `domain/`, `ai/`, `scheduler/` и `time/` нельзя вызывать `new Date()` без аргументов, `Date.now()` и `DateTime.now()`: текущее время берётся из `clock.now()` (`src/time/clock.ts`). Это нужно для тестов со сдвигом времени. По той же причине в SQL не используется `now()` для бизнес-решений, время передаётся параметром.
- **Тексты.** Все пользовательские строки лежат в `src/bot/texts/ru.ts`. Кириллица в `src/**/*.ts` вне `texts/ru.ts` и `config/constants.ts` запрещена, это проверяет `tests/unit/architecture.test.ts`. Промпты лежат в `prompts/*.md`.
- **Telegram.** `parse_mode: 'HTML'`, любой пользовательский текст проходит через `escapeHtml`. Лимиты: сообщение до 4096 символов, `callback_data` до 64 байт, текст `answerCallbackQuery` до 200 символов.
- **callback_data** имеет формат `v1:<entity>:<action>:<id>[:<arg>]` и собирается только через кодек `src/bot/keyboards/callbackCodec.ts`. В `id` всегда внутренний ID из БД, а не Telegram ID.
- **Права проверяются по БД на каждом callback и команде** (SPEC §3). Содержимому `callback_data` не доверяем. Матрица прав лежит в `src/domain/people/permissions.ts`.
- **Идемпотентность.** Решения по proposals принимаются через `UPDATE … WHERE status='pending' RETURNING`: двойной клик не создаёт две задачи. Уведомления защищены уникальным `dedupe_key`. Выборки планировщика делаются через `FOR UPDATE SKIP LOCKED`. Карточки proposals отправляются через outbox: поле `proposals.notified_at` и job `cards`. Так ничего не теряется при перезапуске.
- **Логи** — pino JSON. Тексты сообщений, имена и username не логируются на уровне `info` и выше, redaction настроен в `src/ops/logger.ts`. В отчётах об ошибках только ID сущностей.
- **LLM.** Температура 0. Перед отправкой всё проходит псевдонимизацию (`src/ai/pseudonymize.ts`): никаких Telegram ID, username и фамилий, телефоны и e-mail заменяются на маркеры. Ссылки `M#/P#/T#/R#`, которых не было во входе, отбрасываются.
- Прочие проектные решения (добавления к схеме, `dedupe_key` с версией задачи, тихие часы и т. п.) записаны в `plan.md` → «Решения и интерпретации». Соблюдай их.

## 9. Тестирование (SPEC §28)

- `tests/unit/` — чистые функции без БД и сети: resolveDue, policy, pseudonymize, heuristics, кодек, views, quiet, расписание уведомлений, права.
- `tests/integration/` — реальный Postgres: репозитории, ticker (`SKIP LOCKED`, отсутствие дублей), retention, claim, обработчики бота. Файлы выполняются последовательно, перед каждым тестом `truncateAll()`.
- Обработчики бота тестируются через `tests/helpers/botHarness.ts`: transformer перехватывает исходящие вызовы Bot API и возвращает фейковые ответы. Апдейты подаются через `bot.handleUpdate()`.
- **Реальные вызовы LLM в тестах и CI запрещены.** Используются записанные ответы из `tests/fixtures/llm/*.json` через `FixtureExtractionProvider`.
- Время в тестах задаётся через `fixedClock('2026-09-23T12:00:00+03:00')` из `tests/helpers/clock.ts`.
- Покрытие `src/domain/**` и `src/ai/pipeline/**` должно быть не ниже 80%.

## 10. Персональные данные и публичный репозиторий

Репозиторий **публичный**: `github.com/MozgovoyVF/school-task-bot`.

- Никогда не коммить `.env`, токены, ключи, экспорты Telegram (`result.json`), дампы БД, бэкапы и любые реальные ПД. Всё это покрыто `.gitignore`. Перед коммитом проверь `git diff --cached`.
- Eval-датасеты и few-shot-примеры только синтетические. Имена в них вымышленные, телефоны не должны выглядеть реальными.
- Сроки хранения, удаление по запросу и шифрование бэкапов описаны в SPEC §19.3. Юридические шаблоны лежат в `docs/legal/` с пометкой «проверить юристу».

## 11. Окружение

- Локальная машина: macOS. Docker 29 и Compose v5 установлены, Telegram и OpenRouter доступны напрямую. Разработка идёт локально, Postgres поднимается в Docker (`pnpm db:up`).
- Node **24.21.0** через nvm (`nvm alias default 24`). pnpm **12.6.0** установлен глобально через npm; corepack для pnpm отключён (`corepack disable pnpm`).
- Окружения dev и prod — два compose-проекта `stb-dev` и `stb-prod` на одном VPS (SPEC §17.1). Деплой только ручной: `scripts/deploy.sh <tag>`.
- Образ: `ghcr.io/mozgovoyvf/school-task-bot:<tag>` (имя в GHCR в нижнем регистре).

## 12. Грабли, о которых стоит помнить

- После отключения Privacy Mode в @BotFather бота нужно **заново добавить** в группы (SPEC §7.1).
- При миграции group → supergroup Telegram присылает `migrate_to_chat_id`: нужно обновить `chats.tg_chat_id` и `type`. Ссылки на сообщения есть только у supergroup: `https://t.me/c/<id без -100>/<msg_id>`.
- В форумах (topics) у каждого сообщения есть `reply_to_message` на служебное сообщение создания темы. Такой reply не считается ответом.
- `sequentialize` (runner) подключается до `conversations()`, ключ — `chat_id`.
- Strict structured outputs требуют, чтобы все поля были `required`. Поэтому схема для провайдера (wire) использует `nullable` вместо `optional`, а локальная zod-схема из SPEC §9.5 проверяет результат после нормализации.
- В регулярках не используй `\b`: в JS он работает только с ASCII. Для кириллицы нужны `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` с флагом `u`. `\p{Emoji_Component}` включает цифры, так что «15:00» нельзя считать эмодзи.
- Telegram ID до 2^52 хранятся как `bigint` с `mode: 'number'`.
- `pg_trgm` строит триграммы только из символов, которые локаль БД считает буквами. Кластер Postgres должен быть с UTF-8 ctype (в официальном образе `postgres:17` это `en_US.utf8`). Тест схемы проверяет, что `similarity()` работает на кириллице.
- luxon (проверено на 3.7.2): несуществующее локальное время при весеннем переходе DST сдвигается вперёд (`2026-03-29T02:30` Europe/Berlin → `01:30Z`). Неоднозначное осеннее время берёт более ранний offset (`2026-10-25T02:30` → `00:30Z`). `2026-02-30` даёт `isValid=false`. Пояс `UTC+5` валиден как фиксированный offset.
