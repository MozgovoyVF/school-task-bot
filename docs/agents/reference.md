# Справочник для агентов (читать по необходимости)

`CLAUDE.md` содержит только обязательные правила. Здесь справочные данные: открывай нужный раздел, когда работаешь с соответствующей темой.

## 1. Context7 — ID библиотек и проверенные факты

Перед кодом с библиотекой сверь документацию через Context7: `mcp__context7__resolve-library-id` → `mcp__context7__query-docs`, один запрос на тему. Если Context7 недоступен, используй официальную документацию через WebFetch и упомяни это в отчёте. **Новые ID вписывай сюда.**

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
- **grammY `Api.setMyCommands(commands, { scope, language_code })`** (Task 1.11): scopes are _not_ merged — Telegram walks a fixed priority list per chat kind and returns the **first** scope that has any commands set for it. For a private chat: `chat` (that exact user) → `all_private_chats` → `default`. So a `BotCommandScopeChat` call for one user's DM fully replaces what `all_private_chats` would otherwise show there — it must list every command that chat should see, not just the extra ones. `@grammyjs/commands`' `CommandGroup`/`addToScope` wraps this same raw API; we call `setMyCommands` directly (no new dependency) since `@grammyjs/commands` isn't in SPEC §4's dependency list.
- **drizzle-orm 0.45.3 / drizzle-kit 0.31.11:** postgres.js-драйвер — `drizzle(client, { schema })` из `drizzle-orm/postgres-js`, миграции — `migrate(db, { migrationsFolder })` из `drizzle-orm/postgres-js/migrator`. При круговых ссылках между таблицами из разных файлов схемы (напр. `messages.batch_id → analysis_batches`, `analysis_batches.first_message_id → messages`) `drizzle-kit generate` работает без проблем (FK добавляются через `ALTER TABLE` после всех `CREATE TABLE`), но `tsc` падает с `TS7022` (циклический вывод типа таблицы). Лечится явной аннотацией возврата колбэка: `.references((): AnyPgColumn => other.id, {...})` вместо `.references(() => other.id, {...})`.

## 2. Карта модулей (SPEC §5, §25)

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

## 3. Грабли

- После отключения Privacy Mode в @BotFather бота нужно **заново добавить** в группы (SPEC §7.1).
- При миграции group → supergroup Telegram присылает `migrate_to_chat_id`: нужно обновить `chats.tg_chat_id` и `type`. Ссылки на сообщения есть только у supergroup: `https://t.me/c/<id без -100>/<msg_id>`.
- В форумах (topics) у каждого сообщения есть `reply_to_message` на служебное сообщение создания темы. Такой reply не считается ответом.
- `sequentialize` (runner) подключается до `conversations()`, ключ — `chat_id`.
- Strict structured outputs требуют, чтобы все поля были `required`. Поэтому схема для провайдера (wire) использует `nullable` вместо `optional`, а локальная zod-схема из SPEC §9.5 проверяет результат после нормализации.
- В регулярках не используй `\b`: в JS он работает только с ASCII. Для кириллицы нужны `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` с флагом `u`. `\p{Emoji_Component}` включает цифры, так что «15:00» нельзя считать эмодзи.
- Telegram ID до 2^52 хранятся как `bigint` с `mode: 'number'`.
- `pg_trgm` строит триграммы только из символов, которые локаль БД считает буквами. Кластер Postgres должен быть с UTF-8 ctype (в официальном образе `postgres:17` это `en_US.utf8`). Тест схемы проверяет, что `similarity()` работает на кириллице.
- luxon (проверено на 3.7.2): несуществующее локальное время при весеннем переходе DST сдвигается вперёд (`2026-03-29T02:30` Europe/Berlin → `01:30Z`). Неоднозначное осеннее время берёт более ранний offset (`2026-10-25T02:30` → `00:30Z`). `2026-02-30` даёт `isValid=false`. Пояс `UTC+5` валиден как фиксированный offset.
- **@grammyjs/conversations v2.1.1** (Phase 1, private-chat scoping): `createConversation(...)` бросает `"Cannot register a conversation without installing the conversations plugin first!"`, если на этом же update не отработал `conversations()`. Если нужно ограничить диалоги приватными чатами (группа не должна уметь начать диалог, который потом проглатывает её сообщения), scoping нужен **на обоих** — и на `conversations()`, и на каждом `createConversation(...)` — иначе любое сообщение в группе превращается в необработанное исключение. См. `src/bot/middleware/privateOnly.ts`.
- **zod v4 `toJSONSchema`** (Phase 2, Task 2.1): `oneOf` в выходной JSON-схеме появляется не только у `discriminatedUnion`, но и у `.nullable()` (внутри он тоже union). Для strict structured outputs (все поля required, без `oneOf`) renamer `oneOf → anyOf` должен рекурсивно обходить обе причины, а не только discriminated unions.
- **postgres.js агрегаты** (Phase 2, Task 2.9): `max()`/`min()` по колонке типа `timestamp`/`date` возвращают **строки**, даже если в запросе указан type hint `sql<Date>`\`...\`` — hint влияет только на TS-тип результата, не на рантайм-парсинг драйвера. Нужно явно парсить (`new Date(...)`через`clock`-совместимый путь или `DateTime.fromSQL`) перед использованием значения.
- **OpenAI Node SDK** (Phase 2, Task 2.17 / final review): клиент по умолчанию делает `maxRetries: 2`, включая повтор при таймауте. Если в приложении уже есть свой retry+fallback (primary→fallback модель, экспоненциальный backoff на уровне job), SDK-шные повторы утраивают эффективный таймаут одного вызова и могут надолго застопорить тикер при недоступности провайдера — передавать `maxRetries: 0` в конструктор `new OpenAI(...)`.
- **pg_trgm и функциональные GIN-индексы** (Phase 2, Task 2.8): `similarity(lower(title), lower($1))` не использует GIN-индекс, построенный на `title` (без `lower()`) — индекс должен быть построен на **том же самом** выражении, что в запросе (`CREATE INDEX ... USING gin (lower(title) gin_trgm_ops)`), иначе Postgres делает seq scan (результат корректный, просто без индекса).
