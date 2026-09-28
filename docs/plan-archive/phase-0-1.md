# План: завершённые фазы 0–1 (архив)

Перенесено из `plan.md` после мержа фазы 1 (PR #4). Решения D-таблицы и общие контракты остаются в `plan.md`.

## Фаза 0 — Каркас (ветка `phase-0-skeleton`)

**Результат фазы:** репозиторий с инструментами, конфигом, схемой БД, логами, отчётами об ошибках, ticker'ом, `/healthz`, ботом с `/start`, `/help` и `/admin`, Docker, CI/CD и инструкцией по деплою. Dev-бот работает на VPS.

**Приёмка (SPEC §22):** `pnpm test` зелёный · dev-бот на VPS отвечает на `/start` · искусственная ошибка приходит superadmin · `docker compose restart` не теряет данных · `/healthz` = 200.

### Task 0.1: Репозиторий и инструменты

**Файлы:**

- Создать: `.gitignore`, `.editorconfig`, `.nvmrc`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `README.md`, `CHANGELOG.md`
- Создать: `tests/unit/architecture.test.ts`, `tests/helpers/architecture.ts`

**Интерфейсы:**

- Produces: `findForbiddenCyrillic(files: Array<{ path: string; content: string }>): string[]` — пути файлов с кириллицей вне разрешённых (`src/bot/texts/ru.ts`, `src/config/constants.ts`).

- [x] **Шаг 1 (👤):** проверить `node -v` (ожидается `v24.x`) и `pnpm -v` (ожидается `12.6.0`, установлен через `npm i -g pnpm@12.6.0`). Подтвердить создание публичного репозитория `MozgovoyVF/school-task-bot`.
- [x] **Шаг 2: git и начальный коммит в `main`** (выполняет основная сессия до запуска оркестратора: навыку субагентов нужен уже существующий репозиторий)

```bash
git init -b main
```

`.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
*.log
.DS_Store
backups/
*.dump
*.sql
*.sql.gz
*.age
exports/
result.json
eval/reports/*.local.md
.deploy/
.superpowers/
```

```bash
git add SPEC.md CLAUDE.md plan.md .gitignore .claude/agents
git commit -m "docs: add specification, agent guide and implementation plan"
gh repo create MozgovoyVF/school-task-bot --public --source . --remote origin --push
git switch -c phase-0-skeleton
```

- [x] **Шаг 3: `package.json`.** Версию pnpm сверить с `npm view pnpm version` (на 2026-09-26 — 12.6.0).

```json
{
  "name": "school-task-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "packageManager": "pnpm@12.6.0",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/src/index.js",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage",
    "db:up": "docker compose -f docker/compose.dev.yml up -d db",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx --env-file=.env src/db/migrate.ts",
    "eval": "tsx --env-file=.env eval/run.ts",
    "import-export": "tsx --env-file=.env scripts/import-export.ts",
    "feedback-report": "tsx --env-file=.env scripts/feedback-report.ts"
  }
}
```

- [x] **Шаг 4: зависимости.** Сверить версии через Context7 или npm.

```bash
pnpm add grammy @grammyjs/runner @grammyjs/conversations @grammyjs/auto-retry @grammyjs/transformer-throttler drizzle-orm postgres zod openai luxon fastify pino
pnpm add -D typescript@~5.9.3 tsx vitest @vitest/coverage-v8 drizzle-kit eslint @eslint/js typescript-eslint eslint-config-prettier prettier @types/node@^24 @types/luxon
```

Если pnpm предупреждает об отсутствующей peer-зависимости `vite` для vitest, добавить `pnpm add -D vite`.

- [x] **Шаг 5: `tsconfig.json` и `tsconfig.build.json`**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": ".",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src", "scripts", "eval", "tests", "vitest.config.ts", "drizzle.config.ts"]
}
```

```json
{ "extends": "./tsconfig.json", "include": ["src", "scripts", "eval"], "exclude": ["tests", "**/*.test.ts"] }
```

- [x] **Шаг 6: `eslint.config.js`** (flat config; синтаксис сверить через Context7 → typescript-eslint)

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const noClock = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use clock.now() (src/time/clock.ts)',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use clock.now()',
  },
  {
    selector: "CallExpression[callee.object.name='DateTime'][callee.property.name='now']",
    message: 'Use clock.now()',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'src/db/migrations'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/domain/**', 'src/ai/**', 'src/time/**', 'src/scheduler/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['grammy', '@grammyjs/*'], message: 'Domain must not depend on grammY; use Messenger' },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noClock],
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
```

`.prettierrc.json`: `{ "singleQuote": true, "printWidth": 110, "trailingComma": "all" }`. `.prettierignore`: `dist`, `coverage`, `pnpm-lock.yaml`, `src/db/migrations`, `SPEC.md`, `plan.md`.

- [x] **Шаг 7: `vitest.config.ts`** (синтаксис `projects` сверить через Context7 → vitest)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/globalSetup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/ai/pipeline/**'],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
```

`tests/integration/globalSetup.ts` пока пустой (`export default async function setup() {}`). Он заполняется в задаче 0.4.

- [x] **Шаг 8: падающий тест архитектурного правила**

```ts
// tests/unit/architecture.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findForbiddenCyrillic } from '../helpers/architecture.js';

describe('findForbiddenCyrillic', () => {
  it('flags Cyrillic outside allowed files', () => {
    expect(
      findForbiddenCyrillic([
        { path: 'src/bot/handlers/dm.ts', content: "reply('Привет')" },
        { path: 'src/bot/texts/ru.ts', content: "export const hi = 'Привет'" },
        { path: 'src/config/constants.ts', content: "export const STOP = ['ок']" },
        { path: 'src/ai/policy.ts', content: 'const x = 1;' },
      ]),
    ).toEqual(['src/bot/handlers/dm.ts']);
  });
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('repository', () => {
  it('keeps user-facing Russian text in src/bot/texts/ru.ts', () => {
    const files = walk('src').map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    expect(findForbiddenCyrillic(files)).toEqual([]);
  });
});
```

- [x] **Шаг 9:** `pnpm test:unit`. Ожидается FAIL: модуль `../helpers/architecture.js` не найден.
- [x] **Шаг 10: реализация**

```ts
// tests/helpers/architecture.ts
const ALLOWED = new Set(['src/bot/texts/ru.ts', 'src/config/constants.ts']);
const CYRILLIC = /[А-Яа-яЁё]/;

export function findForbiddenCyrillic(files: Array<{ path: string; content: string }>): string[] {
  return files
    .filter((f) => !ALLOWED.has(f.path.replaceAll('\\', '/')))
    .filter((f) => CYRILLIC.test(f.content))
    .map((f) => f.path);
}
```

- [x] **Шаг 11:** `pnpm lint && pnpm typecheck && pnpm test:unit` — PASS. `README.md` (кратко: что это, ссылки на SPEC, CLAUDE, plan, команды) и `CHANGELOG.md` (`## [Unreleased]`).
- [x] **Шаг 12: коммит и push**

```bash
git add -A && git commit -m "chore: scaffold TypeScript project tooling" && git push -u origin phase-0-skeleton
```

### Task 0.2: Конфигурация окружения (zod)

**Файлы:** создать `src/config/env.ts`, `src/config/constants.ts`, `.env.example`; тест `tests/unit/config/env.test.ts`.

**Интерфейсы:**

- Produces: `EnvSchema`, `type Env`, `loadEnv(source?: Record<string, string | undefined>): Env`, `class EnvError extends Error { issues: string[] }`. Константы (см. шаг 3).

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv, EnvError } from '../../../src/config/env.js';

const base = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  SUPERADMIN_TG_IDS: '111, 222',
  DATABASE_URL: 'postgres://stb:x@db:5432/stb',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.SUPERADMIN_TG_IDS).toEqual([111, 222]);
    expect(env.APP_ENV).toBe('dev');
    expect(env.TELEGRAM_MODE).toBe('polling');
    expect(env.DEFAULT_TIMEZONE).toBe('Europe/Moscow');
    expect(env.DEFAULT_WORKSPACE_NAME).toBe('Школа');
    expect(env.MIGRATE_ON_START).toBe(true);
    expect(env.LLM_DAILY_BUDGET_USD).toBe(1);
    expect(env.AI_PREFILTER).toBe('off');
    expect(env.AI_PREFILTER_THRESHOLD).toBe(0.15);
    expect(env.HTTP_PORT).toBe(3000);
    expect(env.GIT_SHA).toBe('dev');
  });

  it('lists every missing required variable in one error', () => {
    try {
      loadEnv({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as EnvError).message;
      expect(msg).toContain('TELEGRAM_BOT_TOKEN');
      expect(msg).toContain('SUPERADMIN_TG_IDS');
      expect(msg).toContain('DATABASE_URL');
    }
  });

  it('parses booleans strictly ("false" is false)', () => {
    expect(loadEnv({ ...base, MIGRATE_ON_START: 'false' }).MIGRATE_ON_START).toBe(false);
    expect(() => loadEnv({ ...base, MIGRATE_ON_START: 'yes' })).toThrow(EnvError);
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ ...base, SUPERADMIN_TG_IDS: 'abc' })).toThrow(/SUPERADMIN_TG_IDS/);
    expect(() => loadEnv({ ...base, DEFAULT_TIMEZONE: 'Mars/Base' })).toThrow(/DEFAULT_TIMEZONE/);
    expect(() => loadEnv({ ...base, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
    expect(() => loadEnv({ ...base, AI_PREFILTER_THRESHOLD: '1.5' })).toThrow(/AI_PREFILTER_THRESHOLD/);
  });

  it('requires webhook settings in webhook mode and TypeSafe key for jev', () => {
    expect(() => loadEnv({ ...base, TELEGRAM_MODE: 'webhook' })).toThrow(/TELEGRAM_WEBHOOK_URL/);
    expect(() => loadEnv({ ...base, AI_PREFILTER: 'jev' })).toThrow(/TYPESAFE_API_KEY/);
  });

  it('treats empty strings as unset (as in .env.example)', () => {
    expect(
      loadEnv({ ...base, BOOTSTRAP_OWNER_TG_ID: '', OPENROUTER_API_KEY: '' }).BOOTSTRAP_OWNER_TG_ID,
    ).toBeUndefined();
  });
});
```

- [x] **Шаг 2:** `pnpm test:unit tests/unit/config` — FAIL (модуль не найден).
- [x] **Шаг 3: реализация.** Переменные — ровно из SPEC §26 плюс `GIT_SHA` (D21).
  - Обязательны: `TELEGRAM_BOT_TOKEN`, `SUPERADMIN_TG_IDS`, `DATABASE_URL`.
  - `OPENROUTER_API_KEY` и `LLM_MODEL_PRIMARY` не обязательны. Если хотя бы одной нет, `deps.ai = null`, в лог пишется warn «AI analysis disabled».
  - Пустые строки заранее превращаются в `undefined`.
  - Булевы значения парсятся через `z.enum(['true','false']).transform(v => v === 'true')`.
  - Пояс проверяется через `IANAZone.isValidZone` из luxon.
  - `superRefine` проверяет условия для webhook (`TELEGRAM_WEBHOOK_URL` и `TELEGRAM_WEBHOOK_SECRET` обязательны) и для `AI_PREFILTER=jev` (`TYPESAFE_API_KEY` обязателен).
  - `EnvError.message`: `Invalid environment:\n- TELEGRAM_BOT_TOKEN: Required\n…`.

`src/config/constants.ts` (кириллица разрешена; `env.ts` берёт отсюда значение по умолчанию для `DEFAULT_WORKSPACE_NAME`, потому что в самом `env.ts` кириллица запрещена):

```ts
export const DEFAULT_WORKSPACE_NAME = 'Школа';
export const TICK_INTERVAL_MS = 20_000;
export const HEARTBEAT_MAX_AGE_MS = 60_000;
export const BATCH_BACKOFF_MINUTES = [1, 5, 15, 15] as const; // после 1-й…4-й неудачи; 5-я → failed
export const BATCH_MAX_ATTEMPTS = 5;
export const STALE_RUNNING_BATCH_MS = 5 * 60_000;
export const MAX_ANALYSIS_TEXT_CHARS = 2000;
export const QUOTE_MAX_CHARS = 200;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const CALLBACK_DATA_MAX_BYTES = 64;
export const CONTEXT_MESSAGES = 20;
export const PROMPT_MAX_OPEN_TASKS = 50;
export const PROMPT_MAX_OPEN_PROPOSALS = 20;
export const DEDUP_SIMILARITY = 0.6;
export const DEDUP_WINDOW_DAYS = 14;
export const MAX_CARDS_PER_BATCH = 10;
export const PENDING_CHAT_TIMEOUT_HOURS = 72;
export const CLAIM_CODE_TTL_HOURS = 24;
export const CONVERSATION_TIMEOUT_MS = 10 * 60_000;
export const PAGE_SIZE = 5;
export const FORWARD_BURST_MS = 3000;
export const DEFAULT_STOP_LIST = [
  'ок',
  'ok',
  'окей',
  'ок👍',
  'спасибо',
  'спс',
  'да',
  'нет',
  '+',
  '👍',
  'ага',
  'угу',
  'понял',
  'поняла',
  'хорошо',
  'ясно',
];
export const MSK_TOKENS = ['мск', 'msk'];
export const COMPLETION_SIGNALS = [
  'готово',
  'сделала',
  'сделал',
  'сделано',
  'отправила',
  'отправил',
  'выполнила',
  'выполнил',
  'готова',
  'готов',
];
```

Примечание: `хорошо`, `понял` и `поняла` в стоп-листе допустимы: сообщение остаётся контекстом. «Готова» и «готов» — сигналы завершения, стоп-лист их не отсеивает (SPEC §7.3).

- [x] **Шаг 4:** `.env.example` — дословно SPEC §26 плюс строка `GIT_SHA=dev  # подставляется при сборке образа`.
- [x] **Шаг 5:** тесты зелёные, lint и typecheck проходят.
- [x] **Шаг 6: коммит и push:** `feat(config): validate environment with zod`.

### Task 0.3: Логгер с redaction

**Файлы:** создать `src/ops/logger.ts`; тест `tests/unit/ops/logger.test.ts`.

**Интерфейсы:** Produces `createLogger(opts: { level: string; destination?: pino.DestinationStream }): Logger`, `type Logger = pino.Logger`.

- [x] **Шаг 1: падающий тест**

```ts
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../../src/ops/logger.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _e, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, destination };
}

describe('logger redaction', () => {
  it('never prints message texts, names, usernames or secrets', () => {
    const { lines, destination } = capture();
    const log = createLogger({ level: 'debug', destination });
    log.info(
      {
        text: 'СЕКРЕТ-1',
        msg1: {
          text: 'СЕКРЕТ-2',
          caption: 'СЕКРЕТ-3',
          from: { first_name: 'Анна', last_name: 'Петрова', username: 'anna_p' },
        },
        update: { message: { text: 'СЕКРЕТ-4' } },
        config: { TELEGRAM_BOT_TOKEN: '123:TOKEN', OPENROUTER_API_KEY: 'sk-or-KEY' },
        headers: { authorization: 'Bearer XYZ' },
        chatId: 42,
      },
      'incoming',
    );
    const out = lines.join('');
    for (const s of ['СЕКРЕТ', 'Анна', 'Петрова', 'anna_p', 'TOKEN', 'sk-or-KEY', 'XYZ'])
      expect(out).not.toContain(s);
    expect(out).toContain('"chatId":42');
    expect(out).toContain('[REDACTED]');
  });
});
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** pino с `redact.paths`: `text`, `*.text`, `*.*.text`, `*.*.*.text`, то же для `caption`, `first_name`, `last_name`, `username`; `*.TELEGRAM_BOT_TOKEN`, `*.OPENROUTER_API_KEY`, `*.TYPESAFE_API_KEY`, `*.authorization`, `*.token`, `*.apiKey`; `censor: '[REDACTED]'`. Синтаксис wildcard сверен через Context7 → pino (`/pinojs/pino/v10.1.0`): `*` matches exactly one level, no recursive wildcard, отсюда явные пути на глубину 0–3. Дополнительно: имена секретных ключей (например, `TELEGRAM_BOT_TOKEN`) сами содержат чувствительную подстроку, поэтому одного `censor` для значения недостаточно — само имя ключа осталось бы в выводе. `redact.remove` в pino общий на весь конфиг (не для отдельных путей), поэтому секретные ключи полностью вырезаются (ключ + значение) через `formatters.log` (выполняется до `redact`, подтверждено в документации pino), а PII-поля по-прежнему цензурируются через `redact.paths`, что и оставляет маркер `[REDACTED]` в выводе. `*.<SECRET_KEY>` пути в `redact.paths` сохранены как доп. защита.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ops): add pino logger with PII redaction`.

### Task 0.4: Схема БД, миграции, тестовая БД

**Файлы:**

- Создать: `drizzle.config.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/schema/{enums,workspaces,people,chats,messages,ai,tasks,notifications,system,index}.ts`, `src/db/migrations/*` (генерирует drizzle-kit), `docker/compose.dev.yml` (сервис `db`)
- Создать: `tests/helpers/db.ts`; изменить `tests/integration/globalSetup.ts`; тест `tests/integration/db/schema.test.ts`

**Интерфейсы:**

- Produces: `createDb`, `Db`, `Tx`, `DbOrTx` (общие контракты); `runMigrations(db: Db, migrationsFolder?: string): Promise<void>` (по умолчанию `src/db/migrations`); `schema` (все таблицы); в тестах `getTestDb(): Db` и `truncateAll(db: Db): Promise<void>`.

**Таблицы** — SPEC §6 с добавлениями D5. Enum'ы — `pgEnum` с именами из SPEC. Правила: `id` — `bigserial({ mode: 'number' })`; Telegram ID — `bigint({ mode: 'number' })`; даты — `timestamp({ withTimezone: true })`; FK с `onDelete`: сообщения, batch, proposals и события — `cascade` от чата или задачи; `tasks.proposal_id` — `set null`. Образец:

```ts
// src/db/schema/people.ts
export const memberships = pgTable(
  'memberships',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('member'),
    displayName: text('display_name').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notifyAssignments: boolean('notify_assignments').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('memberships_workspace_user').on(t.workspaceId, t.userId),
    uniqueIndex('memberships_one_owner')
      .on(t.workspaceId)
      .where(sql`${t.role} = 'owner'`),
  ],
);
```

Обязательные индексы и ограничения: `users.tg_user_id` unique; `chats.tg_chat_id` unique; `messages` unique `(chat_id, tg_message_id)` и индекс `(chat_id, analysis_status, sent_at)`; `tasks` — `(workspace_id, status, due_at)`, `(workspace_id, assignee_user_id, status)`, GIN `gin_trgm_ops` по `title` и `description`; индекс GIN trigram по `(payload->>'title')` у `proposals` (для dedup 2.8); `notifications.dedupe_key` unique и индекс `(status, fire_at)`; `analysis_batches` — индекс `(chat_id, status)`; `error_reports.fingerprint` pk; `app_state.key` pk.

- [x] **Шаг 1:** `docker/compose.dev.yml` с сервисом `db`: `postgres:17`, `POSTGRES_USER=stb`, `POSTGRES_PASSWORD=stb`, `POSTGRES_DB=stb`, порт `5433:5432`, volume `stb-dev-pgdata`, healthcheck `pg_isready`. Выполнить `pnpm db:up`.
- [x] **Шаг 2: падающий интеграционный тест**

```ts
// tests/integration/db/schema.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { workspaces, users, memberships } from '../../../src/db/schema/index.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

describe('schema', () => {
  it('has pg_trgm working on Cyrillic', async () => {
    const [row] = await db.execute<{ same: number; diff: number }>(
      sql`select similarity('подготовить расписание', 'подготовить расписание') as same, similarity('расписание', 'аренда') as diff`,
    );
    expect(Number(row!.same)).toBe(1);
    expect(Number(row!.diff)).toBeLessThan(0.3);
  });

  it('allows at most one owner per workspace', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Школа' }).returning();
    const [u1, u2] = await db
      .insert(users)
      .values([
        { tgUserId: 1, firstName: 'A' },
        { tgUserId: 2, firstName: 'B' },
      ])
      .returning();
    await db
      .insert(memberships)
      .values({ workspaceId: ws!.id, userId: u1!.id, role: 'owner', displayName: 'A' });
    await expect(
      db.insert(memberships).values({ workspaceId: ws!.id, userId: u2!.id, role: 'owner', displayName: 'B' }),
    ).rejects.toThrow(/memberships_one_owner|duplicate key/);
  });

  it('creates trigram indexes', async () => {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexdef like '%gin_trgm_ops%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [x] **Шаг 3:** `pnpm test:int` — FAIL (нет helpers и схемы).
- [x] **Шаг 4: миграции.** Порядок важен.
  1. `pnpm drizzle-kit generate --custom --name=extensions`, в файл вписать `CREATE EXTENSION IF NOT EXISTS pg_trgm;`.
  2. Описать схему.
  3. `pnpm db:generate` — сгенерировать основную миграцию. Проверить SQL глазами: частичный индекс, GIN, enum'ы.

  `drizzle.config.ts`: `dialect: 'postgresql'`, `schema: './src/db/schema/index.ts'`, `out: './src/db/migrations'`. Сверить через Context7 → drizzle.

- [x] **Шаг 5: `src/db/client.ts`, `src/db/migrate.ts`, helpers**
  - `createDb` использует `postgres(url, { max })` и `drizzle(client, { schema })`.
  - `runMigrations` вызывает `migrate(db, { migrationsFolder })` из `drizzle-orm/postgres-js/migrator`. Сверить через Context7.
  - `src/db/migrate.ts` — CLI: `loadEnv` → `createDb` → `runMigrations` → `close`.
  - `globalSetup`: подключиться к `postgres://stb:stb@localhost:5433/postgres` (или взять базу из `TEST_DATABASE_URL`), выполнить `DROP DATABASE IF EXISTS stb_test WITH (FORCE)` и `CREATE DATABASE stb_test`, применить миграции.
  - `truncateAll`: `TRUNCATE <все таблицы> RESTART IDENTITY CASCADE`. Список таблиц брать из `pg_tables where schemaname='public'`, кроме `__drizzle_migrations`.
- [x] **Шаг 6:** `pnpm test` — PASS.
- [x] **Шаг 7: коммит и push:** `feat(db): add drizzle schema, migrations and test database harness`.

### Task 0.5: Clock, Messenger, отчёты об ошибках

**Файлы:**

- Создать: `src/time/clock.ts`, `src/domain/messenger.ts`, `src/ops/errorReporter.ts`, `src/domain/system/appState.ts`
- Создать: `tests/helpers/clock.ts`, `tests/helpers/fakeMessenger.ts`
- Тесты: `tests/unit/ops/fingerprint.test.ts`, `tests/integration/ops/errorReporter.test.ts`

**Интерфейсы:**

- Produces:
  - `fingerprint(err: unknown): string`;
  - `createErrorReporter(deps: { db: Db; messenger: Messenger; clock: Clock; logger: Logger; superadminIds: number[] }): ErrorReporter`;
  - `interface ErrorReporter { report(err: unknown, context?: Record<string, string | number | boolean | null>): Promise<void>; alert(key: string, text: string, opts?: { throttleMs?: number; alsoTo?: number[] }): Promise<void> }` — `alert` использует ту же таблицу с отпечатком `alert:<key>`;
  - `getState<T>(db, key, schema: z.ZodType<T>): Promise<T | null>`, `setState(db, key, value: unknown, now: Date): Promise<void>`;
  - `FakeMessenger implements Messenger` с полем `sent: Array<{ chatId: number; text: string; opts?: SendOptions }>`, методами `failNextWith(err: MessengerError)` и `reactions`, `edits`, `left`.

- [x] **Шаг 1: падающие тесты**

```ts
// tests/unit/ops/fingerprint.test.ts
import { describe, it, expect } from 'vitest';
import { fingerprint } from '../../../src/ops/errorReporter.js';

function errAt(message: string) {
  return new Error(message);
}

describe('fingerprint', () => {
  it('ignores digits in the message', () => {
    const make = (id: number) => errAt(`Task ${id} not found`);
    expect(fingerprint(make(12))).toBe(fingerprint(make(13)));
  });
  it('differs by error type and message', () => {
    expect(fingerprint(new TypeError('x'))).not.toBe(fingerprint(new RangeError('x')));
    expect(fingerprint(new Error('a'))).not.toBe(fingerprint(new Error('b')));
  });
  it('handles non-Error values', () => {
    expect(fingerprint('boom')).toMatch(/^[a-f0-9]{16,}$/);
  });
});
```

```ts
// tests/integration/ops/errorReporter.test.ts — сценарии:
// 1. Первая ошибка → каждому superadmin одно сообщение. В тексте есть тип и контекст ({ taskId: 5 }) и нет текста пользователя.
// 2. Та же ошибка через 10 мин → сообщений нет; в error_reports count=1.
// 3. Ещё через 61 мин → сообщение «повторилось 2 раза»; count сбрасывается в 0 и увеличивается на эту ошибку.
// 4. Если messenger.send бросает ошибку, report() её не пробрасывает (пишет в лог).
// 5. alert('budget:2026-09-23', …) дважды за час → одно сообщение.
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Отпечаток: `sha256(name + ':' + message.replace(/\d+/g, '#') + ':' + первая строка stack после сообщения)`, первые 16 hex-символов.
  - `sample` — `{ name, message (≤300 символов, без цифр длиннее 6 подряд), topFrames (5), context }`.
  - Upsert по `fingerprint`: если `last_notified_at` пусто или старше часа, отправить и обновить `last_notified_at`.
  - Текст отчёта берётся из `texts.errors.report(...)` в `ru.ts`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ops): add error reporter with hourly throttling`.

### Task 0.6: Ticker, heartbeat, `/healthz`

**Файлы:**

- Создать: `src/scheduler/ticker.ts`, `src/scheduler/daily.ts`, `src/http/server.ts`, `src/http/routes/health.ts`
- Тесты: `tests/integration/scheduler/ticker.test.ts`, `tests/integration/http/health.test.ts`

**Интерфейсы:**

- Consumes: `AppDeps`, `Job`, `getState` и `setState` (0.5).
- Produces:
  - `createTicker(deps: AppDeps, jobs: Job[], opts?: { intervalMs?: number }): { start(): void; stop(): Promise<void>; tickOnce(): Promise<void>; lastHeartbeat(): Date | null }`;
  - `dailyJob(name: string, atUtc: string, run: (deps: AppDeps) => Promise<void>): Job` — выполняется один раз за UTC-сутки после `atUtc`, отметка хранится в `app_state` под ключом `daily:<name>`;
  - `buildHttpServer(deps: { db: Db; clock: Clock; heartbeat: () => Date | null }): FastifyInstance`.

- [x] **Шаг 1: падающие тесты**
  - Ticker:
    1. `tickOnce` запускает jobs по порядку.
    2. Ошибка одной job не останавливает следующие и уходит в `deps.errors.report`.
    3. После тика `app_state['ticker:heartbeat']` равен `clock.now()`.
    4. Тики не перекрываются: при `intervalMs=10` и job длиной 50 мс число одновременных запусков не больше 1.
    5. `dailyJob('retention','03:30')`: в 03:29 UTC не запускается, в 03:31 запускается, повторно в тот же день не запускается, на следующий день после 03:30 — запускается.
  - `/healthz` через `fastify.inject`:
    1. Heartbeat 10 с назад → 200 `{ status: 'ok' }`.
    2. Heartbeat 61 с назад → 503.
    3. БД недоступна (закрытое соединение) → 503.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Цикл на `setTimeout`: следующий тик планируется после завершения текущего. `stop()` дожидается текущего тика. Heartbeat хранится и в памяти (для `/healthz`), и в `app_state` (для watchdog в 4.5).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(scheduler): add ticker, daily jobs and health endpoint`.

См. D30 в «Решения и интерпретации» — почему `Job`/`createTicker`/`dailyJob` в этой задаче типизированы против локального `TickerDeps`, а не против `AppDeps`, и что нужно поменять в Task 0.8.

### Task 0.7: Скелет бота — `/start`, `/help`, superadmin, ошибки, `/admin`

**Файлы:**

- Создать: `src/bot/bot.ts`, `src/bot/context.ts`, `src/bot/messenger.ts`, `src/bot/middleware/errors.ts`, `src/bot/middleware/context.ts`, `src/bot/handlers/dm.ts`, `src/bot/handlers/admin.ts`, `src/bot/views/help.ts`, `src/bot/views/admin.ts`, `src/bot/texts/ru.ts`
- Создать: `tests/helpers/botHarness.ts`, `tests/helpers/updates.ts`
- Тесты: `tests/unit/bot/messenger.test.ts`, `tests/integration/bot/start.test.ts`, `tests/integration/bot/admin.test.ts`

**Интерфейсы:**

- Produces:
  - `type BotContext` (Context + ConversationFlavor + `state: { user: UserRow | null; membership: MembershipRow | null; workspace: WorkspaceRow | null; actor: Actor }`);
  - `createBot(deps: AppDeps, opts?: { botInfo?: UserFromGetMe }): Bot<BotContext>`;
  - `createGrammyMessenger(api: Api): Messenger`, `toMessengerError(e: unknown): MessengerError`;
  - `createBotHarness(opts?: { clock?: string; superadminIds?: number[] }): Promise<BotHarness>`, где `BotHarness = { bot; deps; clock; db; calls: Array<{ method: string; payload: Record<string, unknown> }>; send(update): Promise<void>; replies(chatId?): string[]; reset(): void }`;
  - фабрики апдейтов: `dmText(from: TgUserLike, text)`, `groupText(chat: TgChatLike, from, text, extra?)`, `callback(from, data, message?)`, `botAdded(chat, by)`, `botRemoved(chat, by)`, `editedGroupText(...)`, `forwardedDm(...)`.
- Harness: `bot.api.config.use(transformer)` записывает вызов и возвращает фейковый ответ (`sendMessage` → `{ message_id: n++ … }`, остальные → `true`). `botInfo` задаётся вручную, `getMe` не вызывается. Сверить через Context7 → grammY (transformers, `handleUpdate`, `botInfo`).

- [x] **Шаг 1: падающие тесты**
  - `/start` от superadmin: в ответе справка superadmin, в `users` у пользователя проставлен `dm_started_at`.
  - `/start` от незнакомца: нейтральный текст `texts.start.stranger` («Этот бот работает для сотрудников школы…»).
  - `/admin` от не-superadmin → `texts.common.forbidden`. От superadmin → версия (`GIT_SHA`) и аптайм.
  - Скрытая команда `/testerror` (только superadmin; кнопок нет, потому что кодек callback появляется в 1.3) → обработчик бросает `new Error('Test error from /testerror')` → `FakeMessenger` получает отчёт для superadmin, пользователь получает `texts.errors.userFacing`. От не-superadmin команда игнорируется.
  - `toMessengerError`: `GrammyError` 403 → `forbidden`; 429 с `retry_after: 5` → `rate_limited`, `retryAfterSec=5`; 400 `message is not modified` → `edit()` не бросает; 400 `chat not found` → `not_found`; `HttpError` → `network`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - `bot.ts`: `new Bot<BotContext>(token, { botInfo })`; `api.config.use(autoRetry())`, `api.config.use(apiThrottler())`; дальше middleware: errors → context → conversations() → handlers. `bot.catch` направляет ошибки в `deps.errors.report(err, { updateId })`.
  - `context.ts` (фаза 0): upsert пользователя из `ctx.from`, `actor.isSuperadmin` вычисляется по `config.SUPERADMIN_TG_IDS`.
  - Тексты — в `texts/ru.ts` в виде объекта функций, например `texts.start.owner(name)`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(bot): add bot skeleton with start, help, admin and error reporting`.

### Task 0.8: Composition root, graceful shutdown, Docker

**Файлы:**

- Создать: `src/index.ts`, `src/app.ts`, `src/deps.ts`, `docker/Dockerfile`, `docker/compose.yml`, `.dockerignore`
- Изменить: `docker/compose.dev.yml` (добавить сервис `app`)
- Тест: `tests/integration/app/startup.test.ts`

**Интерфейсы:**

- Produces: `startApp(env: Env, overrides?: { messenger?: Messenger; polling?: boolean; botInfo?: UserFromGetMe; clock?: Clock }): Promise<{ deps: AppDeps; http: FastifyInstance; stop(): Promise<void> }>`. `src/index.ts` вызывает `startApp(loadEnv())` и вешает `stop` на `SIGTERM` и `SIGINT`.

- [x] **Шаг 1: падающий тест.** `startApp` с `polling: false`, `FakeMessenger` и `DATABASE_URL` тестовой БД:
  1. Миграции применены.
  2. `http.inject GET /healthz` → 200.
  3. `stop()` завершается менее чем за 10 с, повторный `stop()` ничего не делает.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: `src/app.ts`.**
  - Последовательность: `logger` → `createDb` → `runMigrations` (если `MIGRATE_ON_START`) → `createBot` → messenger → error reporter → ticker (пока только heartbeat) → http `listen({ host: '0.0.0.0', port })` → runner.
  - Runner: `run(bot, { runner: { fetch: { allowed_updates: ['message','edited_message','callback_query','my_chat_member','chat_member'] } } })` с `sequentialize(ctx => ctx.chat?.id.toString())`. Сверить через Context7 → @grammyjs/runner.
  - `stop()` останавливает сначала runner, потом ticker, потом http и db.
  - См. D32 (заглушки `AiProviders`/`TaskHook`) и D34 (почему реальный `Messenger` использует отдельный `Api`-клиент, а не `bot.api`, и где оказался `sequentialize`) в «Решения и интерпретации».
- [x] **Шаг 4: `docker/Dockerfile`** (multi-stage, non-root)

```dockerfile
FROM node:24-bookworm-slim AS base
# corepack в Node 24 не запускает pnpm 12 (ищет bin/pnpm.cjs), поэтому ставим pnpm через npm
RUN npm i -g pnpm@12.6.0
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS runtime
ARG GIT_SHA=dev
ENV NODE_ENV=production GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prompts ./prompts
COPY src/db/migrations ./src/db/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
```

Каталог `prompts/` появится в фазе 2. До этого в репозитории лежит `prompts/.gitkeep`.

См. D33 в «Решения и интерпретации» — два исправления, найденные реальной сборкой/запуском (копирование `pnpm-workspace.yaml`; путь миграций `./dist/src/db/migrations`, а не `./src/db/migrations`).

- [x] **Шаг 5: `docker/compose.yml`**
  - `app`: `image: ghcr.io/mozgovoyvf/school-task-bot:${APP_TAG:-latest}`, `env_file: ../.env`, `ports: ["127.0.0.1:${HTTP_PORT:-3000}:3000"]`, `depends_on: db (service_healthy)`, `restart: unless-stopped`.
  - `db`: `postgres:17`, volume `pgdata`, без публикации порта, `POSTGRES_*` из `.env`, `restart: unless-stopped`.
  - У обоих логирование `json-file` с `max-size: 10m`, `max-file: "5"` (SPEC §18).

  `compose.dev.yml`: `app` собирается из `docker/Dockerfile` (target `deps`), bind-mount исходников, команда `pnpm dev` (SPEC §27.14).

- [x] **Шаг 6: проверка.**
  - `pnpm test` — PASS (54/54, включая новый `tests/integration/app/startup.test.ts`).
  - `docker build -f docker/Dockerfile -t stb:local .` — образ собирается (после исправлений D33).
  - `docker compose -f docker/compose.yml -p stb-local up -d` с синтетическим `.env` (реального dev-токена нет в этой среде — токен намеренно невалидный) → `db` становится `healthy`, `app` применяет миграции внутри контейнера; на `getMe()` с невалидным токеном бот закономерно падает (fail-fast на плохой конфиг, как и должно быть) — ручная проверка с настоящим токеном осталась пользователю. `docker compose -f docker/compose.yml config` и `docker compose -f docker/compose.dev.yml config` — валидны синтаксически.
  - `docker compose restart` / переживание данных в БД между перезапусками не проверялось (нет реального токена для полноценного up; риск низкий — том `pgdata` именованный, том тестировался только в рамках create/down-v в этой сессии).
- [x] **Шаг 7: коммит и push:** `feat(app): add composition root, graceful shutdown and Docker setup`.

### Task 0.9: CI/CD на GitHub

**Файлы:** создать `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/deploy.yml`, `.github/dependabot.yml`.

- [x] **Шаг 1: `ci.yml`** (версии actions сверить через Context7 или документацию GitHub)

```yaml
name: CI
on: { push: { branches: ['**'] }, pull_request: {} }
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_USER: stb, POSTGRES_PASSWORD: stb, POSTGRES_DB: stb }
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U stb" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://stb:stb@localhost:5433/stb_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm coverage
  docker-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with: { context: ., file: docker/Dockerfile, push: false, build-args: GIT_SHA=${{ github.sha }} }
```

- [x] **Шаг 2: `release.yml`.** Триггеры: `push: tags: ['v*']` и `workflow_dispatch` с input `tag`. Права: `packages: write`, `contents: read`. Логин в GHCR через `GITHUB_TOKEN`, сборка и push `ghcr.io/mozgovoyvf/school-task-bot:<tag>` и `:latest`; при ручном запуске с тегом `-rc` тег `latest` не ставится. Build-arg `GIT_SHA`.
- [x] **Шаг 3: `deploy.yml`.** Только `workflow_dispatch`, секреты `SSH_HOST`, `SSH_KEY`, `SSH_USER`: по SSH выполнить `cd /opt/stb-<env> && ./scripts/deploy.sh <tag>`. По умолчанию не используется (SPEC §24).
- [x] **Шаг 4: `dependabot.yml`:** `npm` и `github-actions`, раз в неделю.
- [x] **Шаг 5: коммит и push, проверка.** Коммит `chore(ci): add CI, release, manual deploy workflows and dependabot`, затем `git push` и `gh run watch`. Оба job'а должны быть зелёными.
- [ ] **Шаг 6 (👤 подтвердить): защита `main`.** Выполняется после первого зелёного прогона, когда имена проверок уже известны.

```bash
gh api -X PUT repos/MozgovoyVF/school-task-bot/branches/main/protection --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["check", "docker-build"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null }
JSON
```

### Task 0.10: Скрипты деплоя и бэкапа, `docs/DEPLOY.md`, приёмка фазы

**Файлы:** создать `scripts/deploy.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `docs/DEPLOY.md`; изменить `README.md`, `CHANGELOG.md`.

- [x] **Шаг 1: `scripts/deploy.sh <tag>`** (`set -euo pipefail`):
  1. Прочитать предыдущий тег из `.deploy/current_tag`.
  2. Запустить `scripts/backup.sh`.
  3. `APP_TAG=<tag> docker compose -f docker/compose.yml --env-file .env -p "$COMPOSE_PROJECT" pull app && … up -d`.
  4. До 90 с опрашивать `curl -fsS http://127.0.0.1:${HTTP_PORT:-3000}/healthz`.
  5. Если проверка не прошла — откатиться на предыдущий тег и выйти с кодом 1. Если прошла — записать новый тег.
- [x] **Шаг 2: `scripts/backup.sh`:**
  - `docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip | age -r "$BACKUP_AGE_RECIPIENT" > backups/stb-$APP_ENV-$(date -u +%Y%m%dT%H%M%SZ).sql.gz.age`;
  - хранить 14 последних копий;
  - если файл не больше 50 МБ, отправить его superadmin через `curl -F document=@… https://api.telegram.org/bot$TOKEN/sendDocument`;
  - при ошибке отправить superadmin текстовое оповещение через `sendMessage` и выйти с кодом 1.

  `scripts/restore.sh <file.age> <identity-file>`: остановить `app`, пересоздать БД, выполнить `age -d -i … | gunzip | psql`, запустить `app` и проверить `/healthz`.

- [x] **Шаг 3: локальная проверка круговорота бэкапа.** Нужен `age` (`brew install age`, 👤 подтвердить установку). Бэкап compose.dev-базы → восстановление в новую базу → количество строк в `users` совпадает. _Выполнено 2026-09-27 в изолированной копии: настоящие Docker, Postgres 17, age 1.3.2 и локально собранный образ, заглушка только для `curl`. 500 строк с кириллицей восстановлены, md5 совпал, ротация оставила 14 копий. Найдена и исправлена ошибка: `mapfile` отсутствует в bash 3.2 на macOS._
- [x] **Шаг 4: `docs/DEPLOY.md`** — все 14 пунктов SPEC §27. У каждого шага: точные команды, ожидаемый вывод и раздел «Если что-то пошло не так». Перед написанием п. 1 проверить актуальные тарифы VPS (Aéza, FirstByte, HostVDS, Fornex, Hetzner) через WebSearch и указать дату проверки. Каталоги на сервере: `/opt/stb-dev`, `/opt/stb-prod`. Команды compose: `docker compose -f docker/compose.yml --env-file .env -p stb-dev …`.
- [x] **Шаг 5: коммит и push:** `docs(deploy): add deploy/backup scripts and step-by-step DEPLOY guide`.
- [ ] **Шаг 6: релиз-кандидат.** `gh workflow run release.yml -f tag=v0.1.0-rc.1 --ref phase-0-skeleton`, затем `gh run watch`.
- [ ] **Шаг 7 (👤): развернуть dev-бота на VPS по `docs/DEPLOY.md`.** Агент сопровождает. Приёмка:
  1. `/start` в dev-боте работает.
  2. `/testerror` → отчёт приходит superadmin.
  3. `docker compose restart` не теряет данные: пользователь сохранился.
  4. `curl 127.0.0.1:3000/healthz` возвращает 200.
- [ ] **Шаг 8: закрытие фазы.**
  1. `CHANGELOG.md` → `## [0.1.0]`.
  2. `gh pr create --base main --title "Phase 0: skeleton" --body "<чек-лист приёмки>"`, дождаться зелёного CI.
  3. 👤 подтверждение, затем `gh pr merge --merge`.
  4. На `main`: `git tag v0.1.0 && git push origin v0.1.0`.

---

## Фаза 1 — Группы и сбор сообщений (ветка `phase-1-groups`)

**D12 принято пользователем (2026-09-27):** `paused` — бот игнорирует чат полностью, включая `/task`; `analysis_enabled=false` — сообщения не собираются, `/task` работает.

**Приёмка (SPEC §22):** бот, добавленный Owner, публикует уведомление и сохраняет сообщения · бот, добавленный посторонним, ждёт разрешения и ничего не сохраняет · claim-код одноразовый и истекает · сообщения старше 30 дней удаляются (тест со сдвигом времени).

### Task 1.1: Настройки workspace и сам workspace

**Файлы:** создать `src/domain/settings/schema.ts`, `src/domain/workspaces/repo.ts`; тесты `tests/unit/domain/settings.test.ts`, `tests/integration/domain/workspaces.test.ts`.

**Интерфейсы:**

- Produces:
  - `SettingsSchema`, `type Settings`, `type DeepPartial<T>`;
  - `parseSettings(raw: unknown, logger?: Logger): Settings` — невалидное значение даёт warn и defaults;
  - `mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings` — бросает `ZodError`, если результат невалиден;
  - `ensureDefaultWorkspace(db, { name, timezone }): Promise<WorkspaceRow>`, `getWorkspace(db, id)`, `getSettings(db, workspaceId): Promise<Settings>`, `updateSettings(db, workspaceId, patch): Promise<Settings>`, `listWorkspaces(db)`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { parseSettings, mergeSettings } from '../../../src/domain/settings/schema.js';

const DEFAULTS = {
  summary: { enabled: true, time: '09:00', forMembers: false },
  reminders: {
    preDueTime: '10:00',
    allDayDueTime: '10:00',
    overdueTime: '10:00',
    notifyAssignees: true,
    groupOverdueThreshold: 3,
  },
  quiet: { enabled: false, weekdays: [], windows: [], dateRanges: [] },
  fuzzyTimes: {
    morning: '10:00',
    afternoon: '15:00',
    evening: '19:00',
    endOfWeekDay: 5,
    endOfWeekTime: '18:00',
    soonWorkdays: 2,
    defaultTime: '18:00',
  },
  ai: {
    thresholds: { low: 0.35, high: 0.7, modify: 0.5 },
    autoCreate: { enabled: false, minConfidence: 0.9 },
    proposalExpiryDays: 7,
  },
  batch: { quietSeconds: 180, maxMessages: 25, maxWaitSeconds: 600 },
  reactions: { onDetect: '👀', onAccept: null },
  retention: { messageDays: 30, batchRawDays: 30 },
  privacyNoticeText: null,
};

describe('settings', () => {
  it('fills every default from SPEC §16', () => {
    expect(parseSettings({})).toEqual(DEFAULTS);
    expect(parseSettings(null)).toEqual(DEFAULTS);
  });
  it('deep-merges partial values', () => {
    const s = parseSettings({ summary: { time: '08:30' } });
    expect(s.summary).toEqual({ enabled: true, time: '08:30', forMembers: false });
    expect(s.reminders).toEqual(DEFAULTS.reminders);
  });
  it('rejects invalid values on merge', () => {
    expect(() => mergeSettings(parseSettings({}), { summary: { time: '25:00' } })).toThrow();
    expect(() => mergeSettings(parseSettings({}), { ai: { thresholds: { low: 1.2 } } })).toThrow();
    expect(() => mergeSettings(parseSettings({}), { quiet: { weekdays: [8] } })).toThrow();
    expect(() =>
      mergeSettings(parseSettings({}), { quiet: { dateRanges: [{ from: '2026-13-01', to: '2027-01-08' }] } }),
    ).toThrow();
  });
  it('accepts quiet windows crossing midnight and labelled date ranges', () => {
    const s = mergeSettings(parseSettings({}), {
      quiet: {
        enabled: true,
        windows: [{ from: '22:00', to: '08:00' }],
        dateRanges: [{ from: '2026-12-31', to: '2027-01-08', label: 'Каникулы' }],
      },
    });
    expect(s.quiet.windows).toHaveLength(1);
  });
  it('falls back to defaults on corrupted stored JSON', () => {
    expect(parseSettings({ summary: { time: 42 } }).summary.time).toBe('09:00');
  });
});
```

Интеграционные тесты: `ensureDefaultWorkspace`, вызванный дважды, создаёт одну строку · `updateSettings` сохраняет значение, `getSettings` возвращает объединённый результат.

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Формат `HH:mm` проверяется регуляркой `/^([01]\d|2[0-3]):[0-5]\d$/`, дата — `/^\d{4}-\d{2}-\d{2}$/` плюс `DateTime.fromISO().isValid`.
  - `weekdays` — ISO 1..7 (D10).
  - `reactions.onDetect` и `onAccept` — `string | null`.
  - `parseSettings` при ошибке разбирает каждую ветку отдельно и откатывает к defaults только невалидную.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(settings): add workspace settings schema with defaults`.

### Task 1.2: Люди, контекст запроса, матрица прав

**Файлы:** создать `src/domain/people/repo.ts`, `src/domain/people/permissions.ts`; изменить `src/bot/middleware/context.ts`; тесты `tests/unit/domain/permissions.test.ts`, `tests/integration/domain/people.test.ts`.

**Интерфейсы:**

- Produces:
  - `upsertTelegramUser(db, tg: { id: number; username?: string; first_name: string; last_name?: string }): Promise<UserRow>`;
  - `ensureMembership(db, { workspaceId, userId, displayName }): Promise<MembershipRow>` — роль `member`; существующие `role` и `display_name` не перезаписывает;
  - `getOwner(db, workspaceId): Promise<{ user: UserRow; membership: MembershipRow } | null>`;
  - `getMembership(db, workspaceId, userId)`, `listMembers(db, workspaceId)`;
  - `markDmStarted(db, userId, now)`, `markDmBlocked(db, userId, blocked: boolean)`, `setUserTimezone(db, userId, zone)`;
  - `bootstrapOwner(db, { workspaceId, tgUserId }): Promise<'created' | 'exists' | 'skipped'>`;
  - `type Action = 'proposal.receive' | 'proposal.decide' | 'task.createDm' | 'task.viewAll' | 'task.viewOwn' | 'task.startOwn' | 'task.doneOwn' | 'task.edit' | 'reminders.receive' | 'chat.approve' | 'admin.tech' | 'transfer.generate'`;
  - `can(actor: Actor, action: Action, target?: { assigneeUserId?: number | null }): boolean`.

- [x] **Шаг 1: падающие тесты** (матрица SPEC §3)

```ts
import { describe, it, expect } from 'vitest';
import { can, type Actor, type Action } from '../../../src/domain/people/permissions.js';

const superadmin: Actor = { userId: 1, isSuperadmin: true, role: null, dmStarted: true };
const owner: Actor = { userId: 2, isSuperadmin: false, role: 'owner', dmStarted: true };
const memberDm: Actor = { userId: 3, isSuperadmin: false, role: 'member', dmStarted: true };
const memberNoDm: Actor = { userId: 4, isSuperadmin: false, role: 'member', dmStarted: false };

const rows: Array<[Action, boolean, boolean, boolean, boolean]> = [
  // action,               superadmin, owner, memberDm, memberNoDm
  ['proposal.receive', false, true, false, false],
  ['proposal.decide', false, true, false, false],
  ['task.createDm', false, true, false, false],
  ['task.viewAll', false, true, false, false],
  ['task.edit', false, true, false, false],
  ['chat.approve', true, true, false, false],
  ['admin.tech', true, false, false, false],
  ['transfer.generate', true, true, false, false],
];

describe('permission matrix (SPEC §3)', () => {
  it.each(rows)('%s', (action, sa, ow, md, mn) => {
    expect([
      can(superadmin, action),
      can(owner, action),
      can(memberDm, action),
      can(memberNoDm, action),
    ]).toEqual([sa, ow, md, mn]);
  });
  it('members act only on their own tasks and only after starting DM', () => {
    expect(can(memberDm, 'task.viewOwn', { assigneeUserId: 3 })).toBe(true);
    expect(can(memberDm, 'task.startOwn', { assigneeUserId: 3 })).toBe(true);
    expect(can(memberDm, 'task.doneOwn', { assigneeUserId: 3 })).toBe(true);
    expect(can(memberDm, 'task.doneOwn', { assigneeUserId: 99 })).toBe(false);
    expect(can(memberNoDm, 'task.viewOwn', { assigneeUserId: 4 })).toBe(false);
    expect(can(memberDm, 'reminders.receive', { assigneeUserId: 3 })).toBe(true);
    expect(can(owner, 'task.doneOwn', { assigneeUserId: 99 })).toBe(true);
  });
  it('superadmin who is also owner gets both sets', () => {
    const both: Actor = { ...owner, isSuperadmin: true };
    expect(can(both, 'admin.tech')).toBe(true);
    expect(can(both, 'proposal.decide')).toBe(true);
  });
});
```

Интеграционные тесты:

- `upsertTelegramUser` обновляет `username` и имена;
- `ensureMembership` не понижает owner;
- `bootstrapOwner`: если owner нет → `'created'`; если есть → `'exists'`; если `BOOTSTRAP_OWNER_TG_ID` не задан → `'skipped'`;
- middleware `context` для апдейта из группы находит workspace по чату, для DM — по членству (в MVP это `default`).

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** `can` — чистая функция по таблице выше. В `context.ts` строится `ctx.state.actor`: пользователь, его membership в workspace чата или DM, `isSuperadmin`. `bootstrapOwner` вызывается из `startApp` после `ensureDefaultWorkspace`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(people): add users, memberships, bootstrap owner and permission matrix`.

### Task 1.3: Кодек callback-данных и клавиатуры

**Файлы:** создать `src/bot/keyboards/callbackCodec.ts`, `src/bot/keyboards/build.ts`; тест `tests/unit/bot/callbackCodec.test.ts`.

**Интерфейсы:**

- Produces:
  - `type Entity = 'p' | 't' | 'c' | 'n' | 'l' | 's' | 'u' | 'a' | 'z' | 'o'` (proposal, task, chat, notification, list, settings, user/person, admin, timezone, ownership);
  - `interface CallbackPayload { entity: Entity; action: string; id: number; arg?: string }`;
  - `encodeCallback(p): string` (бросает `CallbackTooLongError`), `decodeCallback(data: string): CallbackPayload | null`;
  - `toInlineKeyboard(buttons: Buttons): InlineKeyboard`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import {
  encodeCallback,
  decodeCallback,
  CallbackTooLongError,
} from '../../../src/bot/keyboards/callbackCodec.js';

describe('callback codec', () => {
  it('encodes per SPEC §25', () => {
    expect(encodeCallback({ entity: 'p', action: 'acc', id: 123 })).toBe('v1:p:acc:123');
    expect(encodeCallback({ entity: 't', action: 'snz', id: 45, arg: '1h' })).toBe('v1:t:snz:45:1h');
  });
  it('round-trips', () => {
    const p = { entity: 'l', action: 'ovd', id: 2, arg: 'a17' } as const;
    expect(decodeCallback(encodeCallback(p))).toEqual(p);
  });
  it.each([
    'v2:p:acc:1',
    'v1:p:acc:abc',
    'v1:zz:acc:1',
    'garbage',
    '',
    'v1:p:acc:-5',
    'v1:p::1',
    'v1:p:ACC:1',
    'v1:p:acc:1:a:b',
  ])('rejects %j', (s) => expect(decodeCallback(s)).toBeNull());
  it('refuses payloads over 64 bytes or with unsafe args', () => {
    expect(() => encodeCallback({ entity: 'p', action: 'acc', id: 1, arg: 'x'.repeat(60) })).toThrow(
      CallbackTooLongError,
    );
    expect(() => encodeCallback({ entity: 'p', action: 'acc', id: 1, arg: 'a:b' })).toThrow();
  });
});
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Регулярка `^v1:([a-z]):([a-z]{1,4}):(\d{1,15})(?::([A-Za-z0-9_.-]{1,40}))?$`, плюс zod-проверка `entity`. Размер считать через `Buffer.byteLength(s, 'utf8') <= 64`. `encodeCallback` отдельно проверяет символы `arg` без ограничения длины (иначе тест на превышение 64 байт словил бы `CallbackEncodeError` вместо `CallbackTooLongError` раньше проверки размера), а сам предел длины (40 символов для внешних данных) применяется только при `decodeCallback`. `toInlineKeyboard` (`build.ts`) собран на `InlineKeyboard.from` + `InlineKeyboard.text`/`InlineKeyboard.url` (grammY, проверено через Context7 `/grammyjs/website`); дополнительно покрыт тестом `tests/unit/bot/keyboardBuild.test.ts` (в брифе задачи не был явно затребован, добавлен по общему правилу TDD из CLAUDE.md §3).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(bot): add versioned callback data codec`.

### Task 1.4: Часовые пояса, `/start` с выбором пояса, `/timezone`

**Файлы:** создать `src/time/zones.ts`, `src/bot/conversations/timezone.ts`; изменить `src/bot/handlers/dm.ts`, `src/bot/views/help.ts`, `src/bot/texts/ru.ts`; тесты `tests/unit/time/zones.test.ts`, `tests/integration/bot/timezone.test.ts`.

**Интерфейсы:**

- Produces:
  - `RU_ZONES: readonly string[]` — `Europe/Kaliningrad`, `Europe/Moscow`, `Europe/Samara`, `Asia/Yekaterinburg`, `Asia/Omsk`, `Asia/Novosibirsk`, `Asia/Krasnoyarsk`, `Asia/Irkutsk`, `Asia/Yakutsk`, `Asia/Vladivostok`, `Asia/Magadan`, `Asia/Kamchatka`; подписи для кнопок лежат в `ru.ts`;
  - `parseZoneInput(input: string): string | null` — кириллические токены (`мск`) лежат в `MSK_TOKENS` в `src/config/constants.ts`;
  - `zoneLabel(zone: string, at: Date): { kind: 'msk' | 'utc'; offsetMinutes: number }` — для поясов из `RU_ZONES` смещение считается относительно Москвы, для остальных — относительно UTC (D17);
  - `formatZoneLabel(l): string` в `src/bot/texts/ru.ts` — `МСК`, `МСК+2`, `МСК−1`, `UTC+2`;
  - `userZone(user: { timezone: string | null }, workspace: { timezone: string }): string`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { parseZoneInput, zoneLabel as rawZoneLabel } from '../../../src/time/zones.js';
import { formatZoneLabel } from '../../../src/bot/texts/ru.js';

const zoneLabel = (zone: string, at: Date) => formatZoneLabel(rawZoneLabel(zone, at));
const at = new Date('2026-09-23T09:00:00Z');

describe('zones', () => {
  it.each([
    ['Europe/Samara', 'Europe/Samara'],
    ['  asia/yekaterinburg ', 'Asia/Yekaterinburg'],
    ['+5', 'UTC+5'],
    ['UTC+5', 'UTC+5'],
    ['GMT+05:00', 'UTC+5'],
    ['UTC-3:30', 'UTC-3:30'],
    ['МСК+2', 'UTC+5'],
    ['мск', 'Europe/Moscow'],
    ['Mars/Base', null],
    ['+15', null],
  ])('parseZoneInput(%j) → %j', (input, out) => expect(parseZoneInput(input)).toBe(out));

  it.each([
    ['Europe/Moscow', 'МСК'],
    ['Asia/Yekaterinburg', 'МСК+2'],
    ['Europe/Kaliningrad', 'МСК−1'],
    ['Europe/Paris', 'UTC+2'],
    ['UTC+5', 'UTC+5'],
  ])('zoneLabel(%s) → %s', (zone, label) => expect(zoneLabel(zone, at)).toBe(label));
});
```

Для 2026-09-23 у Europe/Paris летнее время, UTC+2. Структура из `src/time` превращается в строку только в `ru.ts`, потому что кириллица в `src/time` запрещена.

Интеграционные тесты:

- первый `/start` показывает кнопки поясов с кнопкой по умолчанию «Оставить: Москва»; нажатие сохраняет `users.timezone`, потом приходит справка по роли;
- `/timezone` → «Ввести вручную» → `+5` сохраняет `UTC+5`, а `Mars/Base` возвращает понятную ошибку и повторный запрос.

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Диалог на conversations v2: побочные эффекты только через `conversation.external`, `maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS`. Сверить API через Context7.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(bot): add timezone selection on start and /timezone`.

### Task 1.5: Коды владения — `/transfer`, `/claim`, код для пустого workspace

**Файлы:** создать `src/domain/people/claim.ts`, `src/bot/handlers/transfer.ts`, `src/bot/views/transfer.ts`; изменить `src/bot/handlers/admin.ts`; тесты `tests/unit/domain/claimCode.test.ts`, `tests/integration/domain/claim.test.ts`, `tests/integration/bot/transfer.test.ts`.

**Интерфейсы:**

- Produces:
  - `CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`;
  - `generateClaimCode(randomBytes?: (n: number) => Uint8Array): string` — 8 символов;
  - `normalizeClaimCode(input: string): string` — верхний регистр, без пробелов и дефисов;
  - `hashClaimCode(code: string): string` — sha256 hex от нормализованного кода;
  - `createClaimCode(db, { workspaceId, createdByUserId, previousOwnerAction: 'demote' | 'remove', now }): Promise<{ code: string; expiresAt: Date }>`;
  - `redeemClaimCode(db, { code, userId, now }): Promise<{ ok: true; workspaceId: number; previousOwnerUserId: number | null } | { ok: false; reason: 'invalid' | 'expired' | 'used' }>`;
  - `afterOwnerChanged(deps, workspaceId): Promise<void>` в `src/domain/people/ownerChanged.ts` — вызывается после успешного `/claim`. В этой задаче функция только пишет в лог. Задача 1.6 добавляет в неё `requestPendingApprovals`, задача 1.11 — `syncCommands`, каждая со своим тестом.

- [x] **Шаг 1: падающие тесты**
  - Unit:
    - код состоит из 8 символов алфавита;
    - `normalizeClaimCode(' abcd-2345 ')` даёт `'ABCD2345'`;
    - хеш детерминирован и не равен коду.
  - Integration:
    1. redeem верным кодом → `ok`, новый пользователь становится owner, прежний — member (`demote`);
    2. повторный redeem → `used`;
    3. через 24 ч + 1 с → `expired`;
    4. неверный код → `invalid`;
    5. при `remove` membership прежнего owner удаляется;
    6. код для пустого workspace (выпущен superadmin, owner нет) → `ok`, `previousOwnerUserId=null`;
    7. два одновременных redeem одного кода → ровно один `ok`;
    8. в БД хранится только хеш: поиск по открытому коду в `claim_codes` ничего не находит.
  - Бот:
    - `/transfer` от owner → выбор «Прежний владелец станет участником / будет удалён» → сообщение с кодом;
    - `/transfer` от member → `forbidden`;
    - `/claim КОД` в группе игнорируется;
    - `/admin` → «Код владельца» (superadmin) → код.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Redeem выполняется в одной транзакции: `SELECT … FOR UPDATE` строки кода → проверки → понизить или удалить прежнего owner → назначить нового → `used_at`. Порядок «сначала понизить, потом назначить» сохраняет частичный уникальный индекс. `redeemClaimCode` никогда не логирует сам код.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(people): add one-time ownership transfer codes`.

### Task 1.6: Жизненный цикл групповых чатов

**Файлы:** создать `src/domain/chats/repo.ts`, `src/domain/chats/lifecycle.ts`, `src/bot/handlers/chatMember.ts`, `src/bot/views/chatApproval.ts`, `src/scheduler/jobs/pendingChats.ts`; тесты `tests/integration/bot/chatLifecycle.test.ts`, `tests/integration/scheduler/pendingChats.test.ts`.

**Интерфейсы:**

- Produces:
  - `onBotAdded(deps, { tgChat: { id: number; title: string; type: 'group' | 'supergroup' }, addedByTgUserId: number }): Promise<{ chat: ChatRow; outcome: 'activated' | 'pending_notified' | 'pending_no_owner' }>`;
  - `approveChat(deps, chatId, actor)`, `rejectChat(deps, chatId, actor)`;
  - `onBotRemoved(deps, tgChatId)` — `status='left'`, pending-сообщения удаляются, `notice_sent_at=null` (D25);
  - `migrateChat(db, oldTgChatId, newTgChatId)`;
  - `publishNoticeOnce(deps, chat)`;
  - `requestPendingApprovals(deps, workspaceId)` — вызывается из `afterOwnerChanged` (1.5): отправляет Owner запросы по pending-чатам и проставляет `pending_since`;
  - job `pendingChatsJob: Job`.

- [x] **Шаг 1: падающие тесты** (апдейты `my_chat_member` из `tests/helpers/updates.ts`)
  1. Бота добавил owner → чат `active`, уведомление (SPEC §15.2) опубликовано один раз. Повторный апдейт уведомление не дублирует.
  2. Добавил superadmin → `active` (D14).
  3. Добавил посторонний → `pending`, `pending_since` проставлен. Owner и superadmin получили карточку «Бота добавили в „…“ (добавил: …)» с кнопками `[✅ Разрешить] [🚪 Покинуть чат]`.
  4. Owner ещё нет → `pending`, `pending_since=null`, superadmin получил карточку. После `/claim` owner получает запрос, `pending_since` проставляется.
  5. «Разрешить» от owner → `active` плюс уведомление. «Разрешить» от member (подделанный callback) → `forbidden`, статус не меняется.
  6. «Покинуть» → `leaveChat`, `status='left'`.
  7. Job: `pending_since` + 72 ч + 1 мин → `leaveChat` и `left`. Через 71 ч ничего не происходит. При `pending_since=null` ничего не происходит.
  8. Бота удалили (`kicked`) → `left`, pending-сообщения удалены, задачи не тронуты.
  9. `migrate_to_chat_id` → у той же строки `chats.tg_chat_id` новый, `type='supergroup'`.
  10. Повышение бота до администратора не меняет статус.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** `publishNoticeOnce` сначала «застолбляет» отправку (`UPDATE chats SET notice_sent_at=$now WHERE id=$1 AND notice_sent_at IS NULL RETURNING id`), потом отправляет. Если отправка упала, метка сбрасывается в `NULL`. Текст уведомления: `settings.privacyNoticeText ?? texts.privacy.chatNotice`. Заодно закрыт D39: `context.ts` резолвит workspace группового чата через `getChatByTgId` вместо прямого `select`; `afterOwnerChanged` (Task 1.5) теперь вызывает `requestPendingApprovals`, для чего в `OwnerChangedDeps` добавлены `messenger`/`clock` (и в `TransferHandlersDeps` — `messenger`), со своим тестом (`tests/integration/domain/ownerChanged.test.ts`).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(chats): add group lifecycle with approval, notice and auto-leave`.

### Task 1.7: Нормализация входящих сообщений и эвристика stage 0

**Файлы:** создать `src/ai/pipeline/heuristics.ts`, `src/bot/handlers/normalize.ts`; тесты `tests/unit/ai/heuristics.test.ts`, `tests/unit/bot/normalize.test.ts`.

**Интерфейсы:**

- Produces:
  - `classifyForAnalysis(text: string, opts?: { stopList?: readonly string[]; completionSignals?: readonly string[] }): 'pending' | 'skipped'`;
  - `interface IncomingMessage { tgChatId: number; tgMessageId: number; from: { id: number; first_name: string; last_name?: string; username?: string; is_bot: boolean }; sentAt: Date; text: string; replyToTgMessageId: number | null; replyQuote: string | null; isForward: boolean; forwardOriginName: string | null; isTaskCommand: boolean; commandArgs: string | null }`;
  - `normalizeIncoming(msg: Message, botUsername: string): IncomingMessage | null`.

- [x] **Шаг 1: падающие тесты**

```ts
// heuristics
import { describe, it, expect } from 'vitest';
import { classifyForAnalysis } from '../../../src/ai/pipeline/heuristics.js';

describe('stage 0 heuristics (SPEC §7.3)', () => {
  it.each([
    'ок',
    'Ок.',
    'ОК!!',
    'ок👍',
    '👍',
    '👍👍🔥',
    '!!!',
    '+',
    '  ',
    'да',
    'нет',
    'спасибо!',
    'ok',
    '10',
  ])('skips %j', (t) => expect(classifyForAnalysis(t)).toBe('skipped'));
  it.each([
    'готово',
    'Сделала',
    'сделал ✅',
    'отправила',
    'Готова!',
    '15:00',
    'в 15',
    'Маша, подготовь расписание',
    'спасибо большое, сделаю завтра',
  ])('keeps %j', (t) => expect(classifyForAnalysis(t)).toBe('pending'));
});
```

```ts
// normalize — строить Message-объекты вручную (минимальные поля)
// Случаи:
// 1. текст от человека → IncomingMessage с text и sentAt = date*1000.
// 2. from.is_bot → null. 3. нет text и caption (стикер, new_chat_members) → null.
// 4. photo + caption 'счёт' → text '[фото] счёт'; document → '[документ] …'; video → '[видео] …'; audio → '[аудио] …'; animation → '[gif] …'.
// 5. '/help' → null; '/task купить бумагу' → isTaskCommand=true, commandArgs='купить бумагу'; '/task@school_bot' → isTaskCommand=true, commandArgs=null.
// 6. forward_origin: user → 'Ольга'; hidden_user → sender_user_name; chat/channel → title; isForward=true.
// 7. reply_to_message → replyToTgMessageId и replyQuote = текст исходного, обрезанный до 200 символов.
// 8. форум: reply_to_message.forum_topic_created → replyToTgMessageId=null (D26).
// 9. quote (частичная цитата при ответе) → replyQuote = quote.text.
// 10. текст 5000 символов → text сохраняется целиком (обрезка до 2000 — только в buildInput).
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Нормализация текста: NFC → lowercase → trim → схлопнуть пробелы → убрать пунктуацию по краям.
  - Длина считается как `Array.from(s).length`.
  - Порядок правил: сигналы завершения (любое слово текста совпадает с `COMPLETION_SIGNALS`) → `pending`; стоп-лист (весь нормализованный текст целиком) → `skipped`; длина меньше 3 → `skipped`; только эмодзи и пунктуация (`/^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️\p{P}\p{S}\s]+$/u`) → `skipped`; иначе `pending`.
  - `\p{Emoji_Component}` не использовать: он включает цифры (`CLAUDE.md` §12).
  - Метки медиа (`[фото]`) берутся из `texts.media` в `ru.ts`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(intake): add message normalization and stage-0 heuristics`.

### Task 1.8: Приём сообщений в группах и правки

**Файлы:** создать `src/domain/chats/messages.ts`, `src/bot/handlers/group.ts`; тест `tests/integration/bot/groupIntake.test.ts`.

**Интерфейсы:**

- Consumes: `normalizeIncoming`, `classifyForAnalysis`, `upsertTelegramUser`, `ensureMembership`.
- Produces:
  - `saveIncomingMessage(db, { chat: ChatRow; incoming: IncomingMessage; authorUserId: number; status: 'pending' | 'skipped' }): Promise<MessageRow | null>` — `ON CONFLICT (chat_id, tg_message_id) DO NOTHING`;
  - `applyEdit(db, { chatId, tgMessageId, text, editedAt }): Promise<'updated_pending' | 'updated_analyzed' | 'not_found'>`.

- [x] **Шаг 1: падающие тесты**
  1. Активный чат, текст «Маша, подготовь расписание» → строка `pending`, автор есть в `users` и в `memberships`. При `first_name='Мария Иванова'` получается `display_name='Мария'` (D28).
  2. «ок» → `skipped`.
  3. Сообщения ботов не сохраняются.
  4. Чат `pending`, `paused` или `analysis_enabled=false` → ничего не сохраняется.
  5. Фото с подписью → `[фото] …`.
  6. Пересылка → `is_forward=true`, `forward_origin_name` заполнен.
  7. Ответ на сообщение, которого нет в БД → `reply_to_quote` заполнен.
  8. Один и тот же апдейт дважды → одна строка.
  9. `edited_message` для `pending` → текст обновлён, `edited_at` пусто.
  10. `edited_message` для `analyzed` → текст обновлён, `edited_at` проставлен, в лог пишется debug.
  11. Текст 5000 символов сохранён целиком.
  12. `/task` в группе этим обработчиком не сохраняется: он уходит обработчику задачи 3.10, до фазы 3 — в заглушку, которая только пишет в лог. Прочие команды игнорируются.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация** по SPEC §7.2.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(intake): store group messages and handle edits`.

### Task 1.9: `/chats` — управление чатами

**Файлы:** создать `src/bot/handlers/chats.ts`, `src/bot/views/chats.ts`; тесты `tests/unit/bot/views/chats.test.ts`, `tests/integration/bot/chats.test.ts`.

**Интерфейсы:** Produces `renderChatList(chats: ChatRow[]): { text: string; buttons: Buttons }`, `renderChatCard(chat: ChatRow): { text: string; buttons: Buttons }`; domain-функции `setAnalysis`, `setReactions`, `pauseChat`, `resumeChat`, `leaveChat` в `src/domain/chats/lifecycle.ts`.

- [x] **Шаг 1: падающие тесты**
  - Views (inline snapshot): список со статусами (`🟢 активен`, `⏸ пауза`, `⏳ ждёт разрешения`, `🚪 покинут`). Карточка с кнопками `[Анализ: вкл] [Реакции: вкл] [⏸ Пауза] [🚪 Покинуть] [◀️ Назад]`, каждый `callback_data` не длиннее 64 байт.
  - Integration:
    - owner переключает анализ → БД обновлена, карточка отредактирована;
    - member → `forbidden`;
    - «Покинуть» требует подтверждения («Точно покинуть „…“?»), после него `leaveChat`, `left`, pending-сообщения удалены;
    - «Пауза» → `paused`, «Возобновить» → `active`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(chats): add /chats management`.

### Task 1.10: `/people` — участники, имена, алиасы

**Файлы:** создать `src/bot/handlers/people.ts`, `src/bot/views/people.ts`, `src/bot/conversations/editPerson.ts`; тесты `tests/unit/domain/aliases.test.ts`, `tests/integration/bot/people.test.ts`.

**Интерфейсы:** Produces `parseAliases(input: string): string[]` в `src/domain/people/repo.ts`, а также `updatePerson(db, { membershipId, displayName?, aliases? })` (без `notifyAssignments`, D40).

- [x] **Шаг 1: падающие тесты**
  - `parseAliases('Маша, Машенька ,маша,, ')` → `['Маша', 'Машенька']` (регистронезависимая дедупликация, пустые убираются).
  - Больше 10 алиасов или алиас длиннее 30 символов → ошибка.
  - `/people` (owner) → список: имя, алиасы, пояс (без переключателя уведомлений, D40).
  - Редактирование имени и алиасов через диалог сохраняется.
  - member → `forbidden`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Кнопка «Удалить данные» появляется в задаче 3.12.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(people): add /people with names and aliases`.

### Task 1.11: Privacy mode, `/privacy`, меню команд

**Файлы:** создать `src/bot/startupChecks.ts`, `src/bot/commands.ts`, `src/bot/handlers/privacy.ts`, `docs/legal/privacy_notice_chat.md`, `docs/legal/privacy_full.md`; изменить `src/bot/texts/ru.ts`; тест `tests/integration/bot/privacy.test.ts`.

**Интерфейсы:**

- Produces:
  - `checkPrivacyMode(deps, me: UserFromGetMe): Promise<void>` — при `can_read_all_group_messages === false` пишет warn в лог и вызывает `errors.alert('privacy_mode', texts.admin.privacyModeOn)`;
  - `syncCommands(deps, api)` — `setMyCommands` для scope: все личные чаты (`/start /help /timezone /privacy`; `/my` нет, D40), все группы (`/task /privacy`), чат owner (полный список SPEC §12.2), чаты superadmin (плюс `/admin /debug /reanalyze`).

- [x] **Шаг 1: падающие тесты**
  - `getMe` с `can_read_all_group_messages: false` → superadmin получает инструкцию «Отключите privacy mode и **заново добавьте бота** в группы».
  - При `true` сообщения нет.
  - `/privacy` в группе → бот отвечает полным текстом (единственный случай, когда бот пишет в группу).
  - `/privacy` в DM → тот же текст.
  - `syncCommands` делает 4 вызова `setMyCommands` с правильными `scope`.
  - После `/claim` меню owner обновляется.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Тексты `privacy_full` и уведомления в чате лежат в `ru.ts`. Их содержательные копии — в `docs/legal/*.md` с пометкой «проверить юристу». Обязательно указать, что имена третьих лиц в MVP не заменяются (SPEC §19.3.2).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(privacy): add privacy mode check, /privacy and scoped command menus`.

### Task 1.12: Очистка по сроку хранения и закрытие фазы

**Файлы:** создать `src/domain/chats/retention.ts`, `src/scheduler/jobs/retention.ts`; тест `tests/integration/scheduler/retention.test.ts`.

**Интерфейсы:** Produces `runRetention(db, { now: Date }): Promise<{ deletedMessages: number; clearedTexts: number; clearedRaw: number }>` и `retentionJob = dailyJob('retention', '03:30', …)`.

- [x] **Шаг 1: падающие тесты** (сдвиг времени через `fixedClock`)
  1. Сообщение старше 31 дня → строка удалена.
  2. Сообщение возрастом 29 дней → осталось.
  3. Сообщение старше 31 дня, на которое ссылается pending-proposal (`source_message_ids`) → строка осталась, `text=NULL`.
  4. У batch старше `batchRawDays` → `raw_response=NULL`.
  5. `messageDays` берётся из настроек workspace чата (например, 10).
  6. Job в тот же день второй раз не запускается.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** SQL с параметром `$now`; удаление строк по условию `NOT EXISTS (SELECT 1 FROM proposals p WHERE p.status='pending' AND m.id = ANY(p.source_message_ids))`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(retention): delete message texts after retention period`.
- [ ] **Шаг 6: закрытие фазы.**
  1. `docs/` и `CHANGELOG.md` обновлены.
  2. RC-релиз `v0.2.0-rc.1` → деплой на dev (👤).
  3. Ручная проверка приёмки: тестовая группа, добавленная owner, и группа, добавленная посторонним.
  4. PR `Phase 1: groups and message intake` → 👤 подтверждение → merge → тег `v0.2.0`.

---
