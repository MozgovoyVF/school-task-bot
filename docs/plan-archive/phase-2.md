# План: завершённая фаза 2 (архив)

Перенесено из `plan.md` после выпуска `v0.3.0` (PR #5, #6, #7). Задача 2.19 (префильтр Jev) отложена по решению пользователя. Решения D-таблицы и общие контракты остаются в `plan.md`.

## Фаза 2 — AI-пайплайн и предложения (ветка `phase-2-ai`)

**Решение по ходу:** перед Task 2.15 обсудить с пользователем D11 (истечение proposals). 👤 Аккаунт OpenRouter, ключ с лимитом расходов, тестовые группы.

**Приёмка (SPEC §22):**

- eval достигает целей SPEC §20.2 на выбранной модели: recall ≥ 0.90, precision ≥ 0.60, точность дат ≥ 0.85;
- «Маша, подготовь расписание к пятнице» даёт карточку у Owner не позже 4 мин после последнего сообщения, с правильными исполнителем и сроком;
- «сделала» на открытую задачу даёт предложение закрыть её;
- отключение OpenRouter не теряет сообщения;
- превышение бюджета ставит анализ на паузу и оповещает.

### Task 2.1: Схемы выхода extractor

**Файлы:** создать `src/ai/schemas.ts`; тест `tests/unit/ai/schemas.test.ts`.

**Интерфейсы:**

- Produces:
  - `TimeHint`, `Due`, `Action`, `ExtractionResult` — дословно SPEC §9.5;
  - `type ExtractionResultT = z.infer<typeof ExtractionResult>`, `type DueT`, `type ActionT`;
  - `ExtractionWire` — wire-схема по D4;
  - `extractionJsonSchema(): Record<string, unknown>` — `z.toJSONSchema(ExtractionWire)`;
  - `parseExtraction(raw: unknown): { ok: true; value: ExtractionResultT } | { ok: false; error: string }` — сначала нормализует wire-данные (`null` → поле отсутствует у `changes.*`), потом проверяет строгой схемой. `error` — короткий человекочитаемый список проблем для повторного запроса.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { parseExtraction, extractionJsonSchema } from '../../../src/ai/schemas.js';

const create = {
  type: 'create',
  category: 'assignment',
  title: 'Подготовить расписание на октябрь',
  description: null,
  assignee_ref: 'P1',
  assignee_name_text: null,
  due: { due_local: '2026-09-25', time_hint: 'none', due_text: 'к пятнице' },
  priority: 'normal',
  source_message_ids: ['M1'],
  confidence: 0.87,
  reasoning: 'Прямое поручение',
};

describe('extraction schema', () => {
  it('accepts a valid result', () => {
    expect(parseExtraction({ actions: [create] })).toMatchObject({ ok: true });
    expect(parseExtraction({ actions: [] })).toMatchObject({ ok: true });
  });
  it.each([
    [{ ...create, source_message_ids: ['X1'] }],
    [{ ...create, source_message_ids: [] }],
    [{ ...create, confidence: 1.2 }],
    [{ ...create, title: 'ok' }],
    [{ ...create, assignee_ref: 'Маша' }],
    [{ ...create, due: { due_local: '25.09.2026', time_hint: 'none', due_text: null } }],
    [{ type: 'complete', target_ref: 'X5', source_message_ids: ['M1'], confidence: 0.9, reasoning: '' }],
  ])('rejects invalid action %#', (a) => {
    const r = parseExtraction({ actions: [a] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
  it('rejects more than 20 actions', () => {
    expect(parseExtraction({ actions: Array(21).fill(create) }).ok).toBe(false);
  });
  it('normalizes wire nulls in update.changes', () => {
    const r = parseExtraction({
      actions: [
        {
          type: 'update',
          target_ref: 'T12',
          changes: { due: null, assignee_ref: null, title: 'Новое' },
          source_message_ids: ['M2'],
          confidence: 0.8,
          reasoning: 'Уточнение',
        },
      ],
    });
    expect(r.ok && r.value.actions[0]).toMatchObject({ changes: { title: 'Новое' } });
    expect(r.ok && 'due' in (r.value.actions[0] as { changes: object }).changes).toBe(false);
  });
  it('produces a strict-compatible JSON schema', () => {
    const walk = (n: unknown): void => {
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (o.type === 'object' && o.properties) {
          expect(o.additionalProperties).toBe(false);
          expect(new Set(o.required as string[])).toEqual(new Set(Object.keys(o.properties as object)));
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(extractionJsonSchema());
    expect(JSON.stringify(extractionJsonSchema())).not.toContain('"oneOf"'); // strict mode понимает только anyOf
  });
});
```

Примечание: в `update.changes` wire-поле `assignee_ref: null` неоднозначно: это «не менять» или «снять исполнителя»? Правило: `null` в wire означает «не менять». Снятие исполнителя моделью не поддерживается, Owner делает это через «Изменить».

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** API `z.toJSONSchema` сверить через Context7 → zod v4. Если для `discriminatedUnion` генерируется `oneOf`, при построении wire-схемы заменить его на `anyOf`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): add extraction zod schemas and strict wire schema`.

### Task 2.2: Псевдонимизация

**Файлы:** создать `src/ai/pseudonymize.ts`; тест `tests/unit/ai/pseudonymize.test.ts`. Маркеры (`[телефон]`, `[email]`, `[реквизиты]`, `[ссылка]`, `@user`) лежат в `src/config/constants.ts` как `PII_MARKERS`.

**Интерфейсы:**

- Produces:
  - `interface ParticipantForLlm { code: string; userId: number; displayName: string; aliases: string[]; username: string | null; lastName: string | null; isOwner: boolean }`;
  - `pseudonymizeText(text: string, participants: readonly ParticipantForLlm[]): string`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { pseudonymizeText, type ParticipantForLlm } from '../../../src/ai/pseudonymize.js';

const P: ParticipantForLlm[] = [
  {
    code: 'P0',
    userId: 1,
    displayName: 'Анна',
    aliases: [],
    username: 'anna_p',
    lastName: 'Петрова',
    isOwner: true,
  },
  {
    code: 'P1',
    userId: 2,
    displayName: 'Мария',
    aliases: ['Маша'],
    username: 'maria_t',
    lastName: 'Иванова',
    isOwner: false,
  },
];
const ps = (t: string) => pseudonymizeText(t, P);

describe('pseudonymize (SPEC §19.3.2)', () => {
  it.each([
    ['@maria_t подготовь', 'P1 подготовь'],
    ['@unknown_user привет', '@user привет'],
    ['позвони +7 (912) 345-67-89', 'позвони [телефон]'],
    ['89123456789', '[телефон]'],
    ['8 912 345 67 89 мама Пети', '[телефон] мама Пети'],
    ['+79123456789', '[телефон]'],
    ['912-345-67-89', '[телефон]'],
    ['+33 6 12 34 56 78', '[телефон]'],
    ['пиши на anna@school.ru', 'пиши на [email]'],
    ['карта 2202 2024 1234 5678', 'карта [реквизиты]'],
    ['счёт 40702810900000012345', 'счёт [реквизиты]'],
    ['смотри https://docs.google.com/x?id=1', 'смотри [ссылка]'],
    ['https://t.me/maria_t', '[ссылка]'],
    ['www.school.ru/price', '[ссылка]'],
    ['Мария Иванова сделает', 'Мария сделает'],
    ['Иванова, отчёт готов?', 'P1, отчёт готов?'],
    ['ИВАНОВА!', 'P1!'],
  ])('%j → %j', (input, out) => expect(ps(input)).toBe(out));

  it.each([
    'созвон 15.10 в 14:00',
    'оплата 15 000 ₽ до 01.11',
    'урок в каб. 3',
    'дата 2026-10-03',
    'ученик Петя Сидоров',
    'Ивановка — это деревня',
  ])('keeps %j unchanged', (t) => expect(ps(t)).toBe(t));

  it('is idempotent', () => {
    const t = 'Мария Иванова, @maria_t, +7 912 345-67-89, https://x.ru';
    expect(ps(ps(t))).toBe(ps(t));
  });
});
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Порядок замен: URL → e-mail → `@username` → номера карт и счетов (16–20 цифр с разделителями) → телефоны → фамилии.
  - Границы слов: `(?<![\p{L}\p{N}_])` и `(?![\p{L}\p{N}_])` с флагом `u`, без `\b`.
  - «Имя Фамилия», где имя совпадает с `displayName` или алиасом, превращается в «Имя». Отдельная фамилия превращается в `P#`. Совпадение по фамилии регистронезависимое и точное: падежные формы в MVP не обрабатываются, это отмечено в `/privacy`.
  - Имена третьих лиц не заменяются (SPEC §19.3.2).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): add pseudonymization before LLM calls`.

### Task 2.3: Промпты, few-shot и сборка входа extractor

**Файлы:**

- Создать: `prompts/extractor.v1.md`, `prompts/extractor.single.v1.md`, `prompts/parseDate.v1.md`, `prompts/profiles/school_ru.md`, `prompts/examples.school_ru.json`, `src/ai/prompts.ts`, `src/ai/pipeline/buildInput.ts`
- Тесты: `tests/unit/ai/prompts.test.ts`, `tests/unit/ai/buildInput.test.ts`

**Интерфейсы:**

- Produces:
  - `interface PromptBundle { version: string; system: string; userTemplate: string; examples: Array<{ user: string; assistant: string }> }`;
  - `loadPrompt(opts: { name: 'extractor' | 'extractor.single' | 'parseDate'; version: string; profile: string; dir?: string }): PromptBundle` — `version` имеет вид `'extractor.v1'`;
  - `renderTemplate(tpl: string, vars: Record<string, string>): string` — бросает ошибку на отсутствующую переменную и на оставшийся `{name}`;
  - `interface OpenTaskForLlm { id: number; title: string; assignee: AssigneeResolution; dueAt: Date | null; dueAllDay: boolean }`, `interface OpenProposalForLlm { id: number; title: string; kind: string; targetTaskId: number | null }`;
  - `interface MessageForLlm { id: number; sentAt: Date; authorUserId: number; authorTz: string | null; text: string; replyToMessageId: number | null; replyQuote: string | null; isForward: boolean; forwardOriginName: string | null; forwardOriginUserId: number | null }`;
  - `interface RefMaps { messages: Map<string, number>; participants: Map<string, number>; tasks: Map<string, number>; proposals: Map<string, number> }`;
  - `interface ExtractionInput { promptVersion: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; refs: RefMaps }`;
  - `buildExtractionInput(args: { now: Date; workspaceTz: string; participants: ParticipantForLlm[]; openTasks: OpenTaskForLlm[]; openProposals: OpenProposalForLlm[]; context: MessageForLlm[]; messages: MessageForLlm[] }, prompt: PromptBundle): ExtractionInput`.

- [x] **Шаг 1: файлы промптов.**
  - `extractor.v1.md` — текст SPEC §9.9. Выше маркера `<!-- DATA -->` — инструкции и `{profile}`, ниже — строки с `{now_local}`, `{weekday}`, `{workspace_tz}`, `{participants}`, `{open_tasks}`, `{open_proposals}`, `{context_messages}`, `{new_messages}` (D27).
  - `extractor.single.v1.md` — дополнение для ручного режима: «Во входе ровно одно сообщение, которое пользователь явно пометил как задачу. Верни ровно одно действие `create`…» (D19).
  - `parseDate.v1.md` — «разбери дату и время из фразы относительно „Сейчас“», вывод по схеме `Due`.
  - `profiles/school_ru.md` — текст профиля из SPEC §9.9.
  - `examples.school_ru.json` — 8–10 синтетических примеров: по одному на каждую категорию `create`, плюс `complete`, `update`, `cancel` и два негатива. Каждый пример проходит `ExtractionResult`.
- [x] **Шаг 2: тесты** (не из D43 — написаны сразу вместе с реализацией, не failing-first)
  - `prompts.test.ts`:
    - `loadPrompt('extractor','extractor.v1','school_ru')` отдаёт `system` с текстом профиля и без `{profile}`;
    - `userTemplate` содержит все 8 переменных;
    - каждый пример из `examples.school_ru.json` проходит `parseExtraction`;
    - `renderTemplate('a {x}', {})` бросает ошибку.
  - `buildInput.test.ts` (сейчас `2026-09-23T12:00+03:00`, пояс Europe/Moscow; участники из 2.2; задача T12 «Подготовить расписание», P1, 2026-10-02 18:00):
    1. Строки участников: `P0/OWNER: Анна (руководитель)` и `P1: Мария (алиасы: Маша)`.
    2. Во всех `content` нет `Петрова`, `Иванова`, `anna_p`, `maria_t` и Telegram ID.
    3. Новое сообщение: `M1 [2026-09-23 11:58, P0]: Маша, подготовь расписание к пятнице`.
    4. Ответ: `M2 [2026-09-23 12:01, P1, ответ на M1]: хорошо`. Ответ на контекстное сообщение ссылается на `M-ctx-N`. Если исходного нет в БД — `ответ на «<reply_quote>»`.
    5. Пересылка от участника: `переслано от P1`. От чужого: `переслано от «Ольга»`.
    6. Автор с поясом, отличным от пояса workspace: `…, P2, пояс Asia/Yekaterinburg]`.
    7. Задачи: `T12: «Подготовить расписание» · P1 · срок 2026-10-02 18:00`. All-day — `срок 2026-10-02`, без срока — `без срока`, исполнитель «всем» — `ALL`.
    8. Лимиты: не больше 50 задач, 20 proposals и 20 контекстных сообщений. Текст обрезан до 2000 символов с `…`.
    9. `refs.messages.get('M1')` равен ID сообщения в БД, `refs.participants.get('P1') === 2`.
    10. Телефон в тексте превращается в `[телефон]`.
    11. Порядок `messages`: system, пары few-shot, user.
- [x] **Шаг 3:** ~~FAIL~~ (не из D43, тесты не писались до реализации).
- [x] **Шаг 4: реализация.** Тексты промптов лежат в `prompts/*.md`. Подписи в строках входа (`ответ на`, `переслано от`, `срок`, `без срока`, `пояс`, `руководитель`, `алиасы`) — в `constants.ts` как `PROMPT_LABELS` (правило кириллицы).
- [x] **Шаг 5:** PASS.
- [x] **Шаг 6: коммит и push:** `feat(ai): add versioned prompts, few-shot examples and input builder`.

### Task 2.4: Провайдеры LLM и оркестрация extract

**Файлы:**

- Создать: `src/ai/providers/types.ts`, `src/ai/providers/openrouter.ts`, `src/ai/providers/fixture.ts`, `src/ai/pipeline/extract.ts`, `tests/fixtures/llm/*.json`
- Тесты: `tests/unit/ai/openrouter.test.ts`, `tests/unit/ai/extract.test.ts`

**Интерфейсы** (SPEC §9.2 плюс уровень клиента):

```ts
// src/ai/providers/types.ts
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export interface CompletionRequest {
  model: string;
  messages: ExtractionInput['messages'];
  jsonSchema: Record<string, unknown> | null;
  timeoutMs: number;
}
export interface CompletionResponse {
  content: string;
  usage: Usage;
  model: string;
  raw: unknown;
}
export interface ChatCompletionClient {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
export interface ExtractionProvider {
  extract(
    input: ExtractionInput,
  ): Promise<{ result: ExtractionResultT; usage: Usage; model: string; raw: unknown }>;
}
export interface PrefilterInput {
  messages: ExtractionInput['messages'];
}
export interface DecisionProvider {
  hasActionableContent(input: PrefilterInput): Promise<{ probability: number; usage: Usage; model: string }>;
}
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    readonly attempts: string[],
  ) {
    super(message);
  }
}
export interface AiProviders {
  extraction: ExtractionProvider;
  decision: DecisionProvider | null;
  client: ChatCompletionClient;
  models: { primary: string; fallback: string | null };
}
```

- Produces:
  - `createOpenRouterClient(opts: { apiKey: string; fetch?: typeof fetch; referer: string; title: string }): ChatCompletionClient`;
  - `class LlmExtractionProvider implements ExtractionProvider` с конструктором `(client, { primary, fallback, timeoutMs = 30_000, jsonSchema })`;
  - `class FixtureClient implements ChatCompletionClient` с конструктором `(script: Array<CompletionResponse | Error>)`, отдаёт ответы по порядку и сохраняет запросы в `requests`.

- [x] **Шаг 1: fixtures** в `tests/fixtures/llm/`: `valid_assignment.json`, `valid_complete_t12.json`, `invalid_json.json` (`content: "{actions: ["`), `schema_violation.json` (confidence 1.4), `hallucinated_refs.json` (M9, P7, T99), `empty_actions.json`, `too_many_actions.json`. Формат — `CompletionResponse`.
- [x] **Шаг 2: падающие тесты**
  - `openrouter.test.ts` (подменный `fetch` через опцию клиента openai SDK; сверить через Context7):
    - в запросе: `baseURL` OpenRouter, `model`, `temperature: 0`, `response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema } }`, заголовки `HTTP-Referer` и `X-Title`;
    - из `usage.cost`, `prompt_tokens` и `completion_tokens` получается `Usage`;
    - без `usage.cost` → `costUsd=0` и warn;
    - ответ 400 со словом `response_format` → повторный запрос с `{ type: 'json_object' }` (схема передаётся текстом в system), модель запоминается как non-strict.
  - `extract.test.ts`:
    1. Валидный ответ с первой попытки → `result`, `model=primary`.
    2. `invalid_json`, затем валидный → вторая попытка на primary. В её `messages` есть assistant с сырым ответом и user с текстом ошибки. `usage` просуммирован.
    3. Две невалидные попытки подряд → fallback-модель → успех, `model=fallback`.
    4. Таймаут на primary (Error `timeout`) → сразу fallback.
    5. Все попытки неудачны → `ExtractionError` с суммарным `usage` и списком попыток.
    6. `fallback=null` и две неудачи → `ExtractionError`.
    7. `empty_actions` → `{ actions: [] }`, это не ошибка.
- [x] **Шаг 3:** FAIL.
- [x] **Шаг 4: реализация.**
  - OpenAI SDK: `new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders, fetch })`.
  - Дополнительно передать `provider: { require_parameters: true }` (сверить с документацией OpenRouter), чтобы запросы уходили только к провайдерам со structured outputs.
  - `usage` разбирать zod-схемой с `.passthrough()`: поле `cost` отсутствует в типах SDK.
- [x] **Шаг 5:** PASS.
- [x] **Шаг 6: коммит и push:** `feat(ai): add OpenRouter client and extraction provider with retry and fallback`.

### Task 2.5: Разрешение сроков (resolveDue)

**Файлы:** создать `src/time/resolveDue.ts`; тест `tests/unit/time/resolveDue.test.ts`.

**Интерфейсы:**

- Produces:
  - `type FuzzyTimes = Settings['fuzzyTimes']`;
  - `interface ResolvedDue { dueAt: Date | null; allDay: boolean; tz: string | null; inPast: boolean; invalid: boolean; dueText: string | null }`;
  - `resolveDue(due: DueT, opts: { zone: string; now: Date; fuzzy: FuzzyTimes }): ResolvedDue`.

- [x] **Шаг 1: падающие тесты** (SPEC §10; значения проверены на luxon 3.7.2)

```ts
import { describe, it, expect } from 'vitest';
import { resolveDue } from '../../../src/time/resolveDue.js';
import type { DueT } from '../../../src/ai/schemas.js';

const fuzzy = {
  morning: '10:00',
  afternoon: '15:00',
  evening: '19:00',
  endOfWeekDay: 5,
  endOfWeekTime: '18:00',
  soonWorkdays: 2,
  defaultTime: '18:00',
};
const WED = '2026-09-23T12:00:00+03:00'; // среда
const r = (due: Partial<DueT>, now = WED, zone = 'Europe/Moscow') =>
  resolveDue(
    { due_local: null, time_hint: 'none', due_text: null, ...due },
    { zone, now: new Date(now), fuzzy },
  );
const iso = (x: { dueAt: Date | null }) => x.dueAt?.toISOString() ?? null;

describe('resolveDue (SPEC §10)', () => {
  it.each([
    [{ due_local: '2026-09-25T18:00' }, '2026-09-25T15:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'morning' }, '2026-09-25T07:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'afternoon' }, '2026-09-25T12:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'evening' }, '2026-09-25T16:00:00.000Z', false],
    [{ due_local: '2026-09-25' }, '2026-09-25T20:59:00.000Z', true],
    [{ time_hint: 'end_of_week' }, '2026-09-25T15:00:00.000Z', false],
    [{ time_hint: 'soon' }, '2026-09-25T15:00:00.000Z', false],
    [{ due_local: '2026-09-25', time_hint: 'end_of_week' }, '2026-09-25T15:00:00.000Z', false], // дата есть → дата + defaultTime
  ] as const)('%j', (due, expected, allDay) => {
    const res = r(due);
    expect(iso(res)).toBe(expected);
    expect(res.allDay).toBe(allDay);
    expect(res.tz).toBe('Europe/Moscow');
  });

  it('returns null due when nothing is given', () => {
    expect(r({})).toMatchObject({ dueAt: null, allDay: false, tz: null, inPast: false });
  });

  it.each([
    ['2026-09-25T17:00:00+03:00', '2026-09-25T15:00:00.000Z'], // пт до 18:00 → сегодня
    ['2026-09-25T18:00:00+03:00', '2026-10-02T15:00:00.000Z'], // ровно 18:00 → следующая
    ['2026-09-25T18:30:00+03:00', '2026-10-02T15:00:00.000Z'],
    ['2026-09-26T10:00:00+03:00', '2026-10-02T15:00:00.000Z'], // сб
    ['2026-09-27T10:00:00+03:00', '2026-10-02T15:00:00.000Z'], // вс
  ])('end_of_week at %s', (now, expected) =>
    expect(iso(r({ time_hint: 'end_of_week' }, now))).toBe(expected),
  );

  it.each([
    ['2026-09-24T12:00:00+03:00', '2026-09-28T15:00:00.000Z'], // чт → пн
    ['2026-09-25T12:00:00+03:00', '2026-09-29T15:00:00.000Z'], // пт → вт
    ['2026-09-26T12:00:00+03:00', '2026-09-29T15:00:00.000Z'], // сб → вт
  ])('soon at %s', (now, expected) => expect(iso(r({ time_hint: 'soon' }, now))).toBe(expected));

  it('crosses the year boundary', () => {
    expect(iso(r({ time_hint: 'soon' }, '2026-12-30T12:00:00+03:00'))).toBe('2027-01-01T15:00:00.000Z');
    expect(iso(r({ time_hint: 'end_of_week' }, '2026-12-31T12:00:00+03:00'))).toBe(
      '2027-01-01T15:00:00.000Z',
    );
  });

  it('flags dates in the past', () => {
    expect(r({ due_local: '2026-09-22' }).inPast).toBe(true);
    expect(r({ due_local: '2026-09-23' }).inPast).toBe(false); // 23:59 сегодня
    expect(r({ due_local: '2026-09-23', time_hint: 'morning' }).inPast).toBe(true);
  });

  it('uses the author zone', () => {
    const res = r({ due_local: '2026-09-25T18:00' }, WED, 'Asia/Yekaterinburg');
    expect(iso(res)).toBe('2026-09-25T13:00:00.000Z');
    expect(res.tz).toBe('Asia/Yekaterinburg');
  });

  it('handles DST gaps and overlaps deterministically', () => {
    expect(iso(r({ due_local: '2026-03-29T02:30' }, '2026-03-20T12:00:00+01:00', 'Europe/Berlin'))).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(iso(r({ due_local: '2026-10-25T02:30' }, '2026-10-20T12:00:00+02:00', 'Europe/Berlin'))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('marks impossible dates as invalid instead of throwing', () => {
    expect(r({ due_local: '2026-02-30' })).toMatchObject({ dueAt: null, invalid: true });
  });

  it('respects fuzzyTimes overrides', () => {
    const res = resolveDue(
      { due_local: '2026-09-25', time_hint: 'morning', due_text: null },
      { zone: 'Europe/Moscow', now: new Date(WED), fuzzy: { ...fuzzy, morning: '09:30' } },
    );
    expect(iso(res)).toBe('2026-09-25T06:30:00.000Z');
  });
});
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Только luxon. Выходные — сб и вс, праздники не учитываются (SPEC §30.2).
  - `end_of_week`: кандидат — пятница текущей ISO-недели в `endOfWeekTime`. Если кандидат ≤ `now`, берётся +7 дней.
  - `soon`: прибавлять дни, пропуская выходные, пока не наберётся `soonWorkdays` рабочих дней, потом поставить `defaultTime`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(time): resolve fuzzy due dates across zones and DST`.

### Task 2.6: Разрешение ссылок и исполнителя

**Файлы:** создать `src/ai/pipeline/resolve.ts`; тест `tests/unit/ai/resolve.test.ts`.

**Интерфейсы:**

- Produces:

```ts
export type AssigneeResolution =
  { type: 'user'; userId: number } | { type: 'all' } | { type: 'text'; name: string } | { type: 'none' };
export type Category = 'assignment' | 'event' | 'owner_intent' | 'commitment' | 'request_to_owner';
interface Common {
  sourceMessageIds: number[];
  confidence: number;
  reasoning: string;
}
export type ResolvedAction =
  | ({
      kind: 'create';
      category: Category;
      title: string;
      description: string | null;
      assignee: AssigneeResolution;
      due: ResolvedDue;
      priority: 'low' | 'normal' | 'high';
    } & Common)
  | ({
      kind: 'update';
      target: { taskId: number } | { proposalId: number };
      changes: { due?: ResolvedDue; assignee?: AssigneeResolution; title?: string };
    } & Common)
  | ({ kind: 'complete' | 'cancel'; target: { taskId: number } | { proposalId: number } } & Common);
export interface ResolveContext {
  refs: RefMaps;
  messages: Map<
    number,
    { authorUserId: number; authorTz: string | null; replyToAuthorUserId: number | null }
  >;
  ownerUserId: number;
  workspaceTz: string;
  now: Date;
  fuzzy: FuzzyTimes;
}
export function resolveActions(
  result: ExtractionResultT,
  ctx: ResolveContext,
): { actions: ResolvedAction[]; dropped: Array<{ index: number; reason: string }> };
export function defaultAssignee(
  category: Category,
  ctx: { authorUserId: number; replyToAuthorUserId: number | null; ownerUserId: number },
): AssigneeResolution;
```

- [x] **Шаг 1: падающие тесты**
  1. `source_message_ids: ['M1','M9']`, где M9 неизвестна → M9 отброшена, действие осталось. `['M9']` → действие отброшено, в `dropped` причина `unknown_message_refs`.
  2. `target_ref: 'T99'`, которого нет → отброшено (`unknown_target`). `R5` из входа → `{ proposalId }`.
  3. `assignee_ref: 'P7'`, которого нет → применяется правило исполнителя по умолчанию, пишется warn.
  4. `OWNER` → owner. `ALL` → `{ type: 'all' }`. `null` плюс `assignee_name_text: 'Ольга'` → `{ type: 'text', name: 'Ольга' }`.
  5. Исполнитель по умолчанию (SPEC §9.6):
     - `commitment` → автор первого исходного сообщения;
     - `request_to_owner` и `owner_intent` → owner;
     - `assignment` в ответ на сообщение P1 → P1;
     - `assignment` без ответа → `none`;
     - `event` → `none`.
  6. Срок считается в поясе автора первого исходного сообщения (`users.timezone`, иначе пояс workspace).
  7. `update.changes.due` тоже проходит `resolveDue`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): resolve model references, assignees and dates`.

### Task 2.7: Policy — правила показа

**Файлы:** создать `src/ai/pipeline/policy.ts`; тест `tests/unit/ai/policy.test.ts`.

**Интерфейсы:** Produces `applyPolicy(a: ResolvedAction, thresholds: Settings['ai']['thresholds'], mode: 'auto' | 'manual'): { decision: 'shown' | 'suppressed'; reason: string }`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { applyPolicy } from '../../../src/ai/pipeline/policy.js';

const T = { low: 0.35, high: 0.7, modify: 0.5 };
const due = {
  dueAt: new Date('2026-09-25T15:00:00Z'),
  allDay: false,
  tz: 'Europe/Moscow',
  inPast: false,
  invalid: false,
  dueText: 'к пятнице',
};
const noDue = { dueAt: null, allDay: false, tz: null, inPast: false, invalid: false, dueText: null };
const create = (category: string, confidence: number, d = noDue) =>
  ({
    kind: 'create',
    category,
    confidence,
    due: d,
    title: 'X',
    description: null,
    assignee: { type: 'none' },
    priority: 'normal',
    sourceMessageIds: [1],
    reasoning: '',
  }) as never;
const modify = (kind: string, confidence: number) =>
  ({ kind, confidence, target: { taskId: 1 }, sourceMessageIds: [1], reasoning: '', changes: {} }) as never;

describe('policy (SPEC §9.6)', () => {
  it.each([
    [create('assignment', 0.35), 'shown'],
    [create('assignment', 0.34), 'suppressed'],
    [create('event', 0.5), 'shown'],
    [create('owner_intent', 0.35), 'shown'],
    [create('commitment', 0.35, due), 'shown'],
    [create('commitment', 0.34, due), 'suppressed'],
    [create('commitment', 0.69), 'suppressed'],
    [create('commitment', 0.7), 'shown'],
    [create('request_to_owner', 0.69), 'suppressed'],
    [create('request_to_owner', 0.4, due), 'shown'],
    [modify('update', 0.5), 'shown'],
    [modify('update', 0.49), 'suppressed'],
    [modify('complete', 0.5), 'shown'],
    [modify('cancel', 0.49), 'suppressed'],
  ])('%# → %s', (a, expected) => expect(applyPolicy(a, T, 'auto').decision).toBe(expected));

  it('explains suppression', () => {
    expect(applyPolicy(create('commitment', 0.5), T, 'auto').reason).toBe(
      'commitment_without_due_below_high',
    );
    expect(applyPolicy(create('assignment', 0.1), T, 'auto').reason).toBe('below_low');
    expect(applyPolicy(modify('update', 0.1), T, 'auto').reason).toBe('modify_below_threshold');
  });

  it('never suppresses manual requests', () => {
    expect(applyPolicy(create('assignment', 0.01), T, 'manual').decision).toBe('shown');
  });
});
```

- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): add display policy with configurable thresholds`.

### Task 2.8: Дедупликация

**Файлы:** создать `src/ai/pipeline/dedup.ts`; тест `tests/integration/ai/dedup.test.ts`.

**Интерфейсы:**

- Produces:
  - `findPossibleDuplicate(db, { workspaceId: number; title: string; assignee: AssigneeResolution; now: Date }): Promise<{ type: 'task' | 'proposal'; id: number; title: string; similarity: number } | null>`;
  - `isRepeatInBatch(existing: ResolvedAction[], candidate: ResolvedAction): boolean` — тот же набор `sourceMessageIds` и то же нормализованное название (SPEC §9.7 п. 3).

- [x] **Шаг 1: падающие тесты**
  1. Открытая задача «Подготовить расписание на октябрь» (P1) и кандидат «подготовить расписание на октябрь!» (P1) → дубль, `type='task'`.
  2. Тот же текст с другим исполнителем → не дубль.
  3. Задача создана 15 дней назад → не дубль.
  4. Задача `done` → не дубль.
  5. Совсем другое название → не дубль.
  6. Pending-proposal с похожим `payload.title` → дубль, `type='proposal'`.
  7. Совпадают исполнители `all` и `all`, а также `none` и `none`.
  8. `isRepeatInBatch`: одинаковые ID и название, различающееся регистром → `true`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** SQL: `similarity(lower(title), lower($title)) >= 0.6`, `status IN ('open','in_progress')`, `created_at >= $now - 14 days`. Для proposals — `status='pending'` и `payload->>'title'`. Берётся строка с максимальной похожестью.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): detect possible duplicates with trigram similarity`.

### Task 2.9: Батчинг, analyze job, бюджет, backoff

**Файлы:** создать `src/ai/pipeline/batcher.ts`, `src/ai/budget.ts`, `src/scheduler/jobs/analyze.ts`; тесты `tests/unit/ai/batcher.test.ts`, `tests/integration/scheduler/analyze.test.ts`.

**Интерфейсы:**

- Produces:
  - `interface PendingStats { pendingCount: number; lastMessageAt: Date; oldestPendingAt: Date }`;
  - `shouldEnqueue(s: PendingStats, cfg: Settings['batch'], now: Date): boolean`;
  - `nextAttemptAt(failedAttempts: number, now: Date): Date | null` — `null` означает `failed`;
  - `enqueueBatches(db, { now: Date }): Promise<number[]>` — не больше одного открытого (`queued` или `running`) batch на чат; batch берёт до `maxMessages` самых старых pending-сообщений без `batch_id`;
  - `claimNextBatch(db, { now }): Promise<BatchRow | null>` — `FOR UPDATE SKIP LOCKED`, переводит в `running`;
  - `recoverStaleBatches(db, { now })` — `running` старше 5 мин переводит обратно в `queued`;
  - `spentTodayUsd(db, { now, tz }): Promise<number>`;
  - `analyzeJob: Job`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { shouldEnqueue, nextAttemptAt } from '../../../src/ai/pipeline/batcher.js';

const cfg = { quietSeconds: 180, maxMessages: 25, maxWaitSeconds: 600 };
const now = new Date('2026-09-23T09:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe('shouldEnqueue (SPEC §8)', () => {
  it.each([
    [{ pendingCount: 3, lastMessageAt: ago(180), oldestPendingAt: ago(200) }, true],
    [{ pendingCount: 3, lastMessageAt: ago(179), oldestPendingAt: ago(179) }, false],
    [{ pendingCount: 25, lastMessageAt: ago(5), oldestPendingAt: ago(60) }, true],
    [{ pendingCount: 4, lastMessageAt: ago(10), oldestPendingAt: ago(600) }, true],
    [{ pendingCount: 0, lastMessageAt: ago(999), oldestPendingAt: ago(999) }, false],
  ])('%j → %s', (s, expected) => expect(shouldEnqueue(s, cfg, now)).toBe(expected));
});

describe('nextAttemptAt', () => {
  it.each([
    [1, 1],
    [2, 5],
    [3, 15],
    [4, 15],
  ])('after failure %i waits %i min', (n, min) =>
    expect(nextAttemptAt(n, now)!.getTime() - now.getTime()).toBe(min * 60_000),
  );
  it('gives up after the 5th failure', () => expect(nextAttemptAt(5, now)).toBeNull());
});
```

Интеграционные тесты (`FixtureClient` через `deps.ai`):

1. Чат с 3 pending-сообщениями, последнее 3 мин назад → создан batch, сообщения получили `batch_id`. Новое сообщение в процессе → не попадает в этот batch.
2. Два параллельных `claimNextBatch` на разных соединениях → разные batch или `null`, двойного захвата нет.
3. LLM падает → `attempts=1`, `next_attempt_at=+1 мин`, статус `queued`, сообщения остаются `pending`. После 5 неудач → `failed`, superadmin получил оповещение. Сообщения по-прежнему `pending` и доступны для `/reanalyze`.
4. Пять неудачных вызовов LLM подряд (в разных batch) → оповещение «5 ошибок LLM подряд». Успешный вызов сбрасывает счётчик.
5. Бюджет: `spentToday >= LLM_DAILY_BUDGET_USD` → вызовов LLM нет, сообщения копятся, superadmin и owner получают по одному оповещению в день. На следующие сутки (в `DEFAULT_TIMEZONE`) анализ продолжается.
6. `deps.ai = null` → job ничего не делает.
7. Префильтр: `DecisionProvider` с `probability=0.1` при пороге 0.15 → extractor не вызывается, сообщения `analyzed`, proposals нет, стоимость префильтра учтена.
8. `recoverStaleBatches`: `running` 6 мин назад → `queued`.

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Порядок в job: `recoverStaleBatches` → `enqueueBatches` → проверка бюджета → до 5 раз `claimNextBatch` и `processBatch` (2.10).
  - Подряд идущие ошибки считаются в `app_state['llm:consecutive_failures']`.
  - Бюджетная пауза фиксируется в `app_state['budget:paused:<YYYY-MM-DD>']`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): add batching, retry backoff and daily LLM budget`.

### Task 2.10: processBatch — от пачки к proposals в одной транзакции

**Файлы:** создать `src/ai/pipeline/processBatch.ts`, `src/domain/proposals/repo.ts`; тест `tests/integration/ai/processBatch.test.ts`.

**Интерфейсы:**

- Consumes: `buildExtractionInput`, `ExtractionProvider`, `resolveActions`, `applyPolicy`, `findPossibleDuplicate`, `isRepeatInBatch`.
- Produces:
  - `processBatch(deps: AppDeps, batch: BatchRow, opts?: { mode?: 'auto' | 'manual'; noReaction?: boolean }): Promise<{ shown: number; suppressed: number }>`;
  - `insertProposal(tx, p: NewProposal): Promise<ProposalRow>`;
  - payload proposal: `{ title, description, category, assignee, due, priority, dueText, reasoning, duplicateOf?: { type, id, title }, changes?, origin: 'ai' | 'manual_group' | 'manual_dm' | 'forward', noReaction?: boolean, quote, quoteAuthorName }`.

- [x] **Шаг 1: падающие тесты** (FixtureClient, фиксированные часы)
  1. Сообщение «Маша, подготовь расписание к пятнице» от owner и fixture `valid_assignment`:
     - один proposal `shown`, `kind='create'`, `category='assignment'`, исполнитель Мария, срок — пятница, 23:59 МСК, all-day;
     - сообщения `analyzed`;
     - у batch статус `done`, заполнены `model`, `prompt_version='extractor.v1'`, токены, `cost_usd`, `latency_ms`, `raw_response`.
  2. Действие с confidence 0.2 → proposal `suppressed` с `policy_reason`, `notified_at` пусто, в outbox не попадает.
  3. `hallucinated_refs` → отброшенные действия не записаны, в лог пишется warn с индексами (без текстов).
  4. Похожая открытая задача → `payload.duplicateOf` заполнен.
  5. `valid_complete_t12` → proposal `kind='complete'`, `target_task_id=12`.
  6. **Падение посреди записи:** `insertProposal` бросает ошибку на втором proposal → транзакция откатилась (proposals нет, сообщения `pending`, batch не `done`), job переводит batch на повтор (Фокус ревью 1).
  7. `skipped`-сообщения из того же временного окна попадают во вход как контекст, а не как новые.
  8. В `/reanalyze`-режиме (`noReaction`) флаг сохраняется в payload.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Вызов LLM выполняется **вне** транзакции.
  - В одной транзакции: запись proposals (`shown` и `suppressed`) → сообщения `analyzed` → batch `done`.
  - Карточки здесь не отправляются: их отправляет outbox (2.12).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(ai): process batches into proposals transactionally`.

### Task 2.11: Отображение — даты, ссылки, карточки proposals

**Файлы:** создать `src/time/format.ts`, `src/bot/views/escape.ts`, `src/bot/views/links.ts`, `src/bot/views/proposalCard.ts`; тесты `tests/unit/time/format.test.ts`, `tests/unit/bot/views/proposalCard.test.ts`.

**Интерфейсы:**

- Produces:
  - `formatDue(due: { at: Date; allDay: boolean; tz: string | null } | null, viewerZone: string): { date: string; time: string | null; zone: ZoneLabel | null } | null` — структура. Строку собирает `texts.formatDue` в `ru.ts`, массивы дней и месяцев лежат там же (D17, D29);
  - `escapeHtml(s: string): string`;
  - `messageLink(chat: { type: 'group' | 'supergroup'; tgChatId: number }, tgMessageId: number): string | null`;
  - `interface ProposalCardView { id: number; kind: 'create' | 'update' | 'complete' | 'cancel'; category: Category | 'manual' | null; confidence: number; manual: boolean; title: string; assigneeName: string | null; assigneeKind: AssigneeResolution['type']; due: { at: Date; allDay: boolean; tz: string | null } | null; priority: 'low' | 'normal' | 'high'; quote: string | null; quoteAuthor: string | null; chatTitle: string | null; link: string | null; dueInPast: boolean; duplicateOf: { taskId: number; title: string } | null; target: { taskId: number; title: string; before: string | null; after: string | null; field: 'due' | 'assignee' | 'title' | null } | null }`;
  - `renderProposalCard(v: ProposalCardView, viewerZone: string): { text: string; buttons: Buttons }`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { renderProposalCard } from '../../../../src/bot/views/proposalCard.js';
import { messageLink } from '../../../../src/bot/views/links.js';

const base = {
  id: 7,
  kind: 'create',
  category: 'assignment',
  confidence: 0.87,
  manual: false,
  title: 'Подготовить расписание на октябрь',
  assigneeName: 'Мария',
  assigneeKind: 'user',
  due: { at: new Date('2026-09-25T15:00:00Z'), allDay: false, tz: 'Europe/Moscow' },
  priority: 'normal',
  quote: 'Маша, подготовь расписание к пятнице',
  quoteAuthor: 'Анна',
  chatTitle: 'Преподаватели',
  link: 'https://t.me/c/1234567890/42',
  dueInPast: false,
  duplicateOf: null,
  target: null,
} as const;

describe('proposal card (SPEC §11.1)', () => {
  it('renders a create card', () => {
    const { text, buttons } = renderProposalCard(base, 'Europe/Moscow');
    expect(text).toBe(
      '🆕 Задача · уверенность 87%\n' +
        '📌 Подготовить расписание на октябрь\n' +
        '👤 Мария · 📅 пт, 25 сен, 18:00 · ⚡ обычный\n' +
        '💬 «Маша, подготовь расписание к пятнице» — Анна, «Преподаватели»\n' +
        '🔗 <a href="https://t.me/c/1234567890/42">Открыть сообщение</a>',
    );
    expect(buttons).toEqual([
      [
        { text: '✅ Создать', data: 'v1:p:acc:7' },
        { text: '✏️ Изменить', data: 'v1:p:edt:7' },
        { text: '❌ Не задача', data: 'v1:p:rej:7' },
      ],
    ]);
  });
  it('shows the viewer zone when it differs (D29)', () => {
    expect(renderProposalCard(base, 'Asia/Yekaterinburg').text).toContain('📅 пт, 25 сен, 20:00 (МСК+2)');
  });
  it('escapes HTML and truncates the quote', () => {
    const t = renderProposalCard(
      { ...base, title: 'A <b> & B', quote: '<x>'.repeat(100) },
      'Europe/Moscow',
    ).text;
    expect(t).toContain('A &lt;b&gt; &amp; B');
    expect(t).not.toContain('<x>');
  });
  it('marks manual cards, past dates and duplicates', () => {
    const t = renderProposalCard(
      {
        ...base,
        manual: true,
        dueInPast: true,
        duplicateOf: { taskId: 12, title: 'Подготовить расписание' },
      },
      'Europe/Moscow',
    );
    expect(t.text.split('\n')[0]).toBe('🆕 Задача · вручную');
    expect(t.text).toContain('⚠️ срок в прошлом — проверьте');
    expect(t.buttons.flat()).toContainEqual({ text: '🔗 Дубль T12', data: 'v1:p:dup:7:12' });
  });
  it('renders update / complete / cancel cards', () => {
    const upd = renderProposalCard(
      {
        ...base,
        kind: 'update',
        target: {
          taskId: 12,
          title: 'Подготовить расписание',
          before: 'пт, 25 сен',
          after: 'пн, 28 сен',
          field: 'due',
        },
      },
      'Europe/Moscow',
    );
    expect(upd.text).toContain(
      '🔄 Перенос срока: T12 «Подготовить расписание» · было пт, 25 сен → стало пн, 28 сен',
    );
    expect(upd.buttons.flat().map((b) => b.text)).toEqual(['✅ Применить', '✏️ Изменить', '❌ Игнорировать']);
    const done = renderProposalCard(
      {
        ...base,
        kind: 'complete',
        quote: 'сделала',
        quoteAuthor: 'Мария',
        target: { taskId: 12, title: 'Подготовить расписание', before: null, after: null, field: null },
      },
      'Europe/Moscow',
    );
    expect(done.text).toContain('✅ Похоже, выполнено: T12 «Подготовить расписание» — «сделала» (Мария)');
    expect(done.buttons.flat().map((b) => b.text)).toEqual(['✅ Закрыть задачу', '❌ Нет']);
    const cancel = renderProposalCard(
      {
        ...base,
        kind: 'cancel',
        quote: 'уже не нужно',
        quoteAuthor: 'Мария',
        target: { taskId: 12, title: 'Подготовить расписание', before: null, after: null, field: null },
      },
      'Europe/Moscow',
    );
    expect(cancel.buttons.flat().map((b) => b.text)).toEqual(['🗑 Отменить задачу', '❌ Нет']);
  });
  it('keeps every card within Telegram limits', () => {
    const t = renderProposalCard(
      { ...base, title: 'я'.repeat(120), quote: 'ж'.repeat(5000) },
      'Europe/Moscow',
    );
    expect(t.text.length).toBeLessThanOrEqual(4096);
    for (const b of t.buttons.flat()) expect(Buffer.byteLength(b.data!, 'utf8')).toBeLessThanOrEqual(64);
  });
});

describe('messageLink', () => {
  it('builds supergroup links only', () => {
    expect(messageLink({ type: 'supergroup', tgChatId: -1001234567890 }, 42)).toBe(
      'https://t.me/c/1234567890/42',
    );
    expect(messageLink({ type: 'group', tgChatId: -4567 }, 42)).toBeNull();
  });
});
```

Плюс `format.test.ts`:

- all-day → `пт, 25 сен` без времени и без пояса;
- `null` → `без срока`;
- 1 января → `пт, 1 янв`;
- пояс получателя тот же, что у срока → без метки.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Все строки берутся из `ru.ts`. Цитата обрезается до 200 символов **до** экранирования. Причины отказа: `v1:p:rjr:7:nt|dup|done|oth`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(bot): render proposal cards and localized due dates`.

### Task 2.12: Outbox карточек, реакции 👀, тихие часы

**Файлы:** создать `src/time/quiet.ts`, `src/scheduler/jobs/cards.ts`; тесты `tests/unit/time/quiet.test.ts`, `tests/integration/scheduler/cards.test.ts`.

**Интерфейсы:** Produces `isQuietAt(instant: Date, zone: string, quiet: Settings['quiet']): boolean` и `cardsJob: Job`.

- [x] **Шаг 1: падающие тесты**

```ts
import { describe, it, expect } from 'vitest';
import { isQuietAt } from '../../../src/time/quiet.js';

const MSK = 'Europe/Moscow';
const off = { enabled: false, weekdays: [], windows: [{ from: '22:00', to: '08:00' }], dateRanges: [] };
const night = { ...off, enabled: true };
const q = (iso: string, cfg: typeof off, zone = MSK) => isQuietAt(new Date(iso), zone, cfg);

describe('quiet hours (SPEC §13.5, D10)', () => {
  it('is off when disabled', () => expect(q('2026-09-23T20:00:00Z', off)).toBe(false));
  it.each([
    ['2026-09-23T20:00:00Z', true], // 23:00 МСК
    ['2026-09-24T04:59:00Z', true], // 07:59
    ['2026-09-24T05:00:00Z', false], // 08:00
    ['2026-09-23T18:59:00Z', false], // 21:59
  ])('overnight window at %s', (iso, expected) => expect(q(iso, night)).toBe(expected));
  it('supports same-day windows', () => {
    const lunch = { ...night, windows: [{ from: '13:00', to: '14:00' }] };
    expect(q('2026-09-23T10:30:00Z', lunch)).toBe(true);
    expect(q('2026-09-23T11:00:00Z', lunch)).toBe(false);
  });
  it('supports ISO weekdays', () => {
    const weekend = { ...night, windows: [], weekdays: [6, 7] };
    expect(q('2026-09-26T09:00:00Z', weekend)).toBe(true); // сб
    expect(q('2026-09-25T09:00:00Z', weekend)).toBe(false); // пт
  });
  it('supports inclusive date ranges', () => {
    const hol = { ...night, windows: [], dateRanges: [{ from: '2026-12-31', to: '2027-01-08' }] };
    expect(q('2027-01-08T20:00:00Z', hol)).toBe(true); // 23:00 8 янв
    expect(q('2027-01-08T21:00:00Z', hol)).toBe(false); // 00:00 9 янв
    expect(q('2026-12-30T20:59:00Z', hol)).toBe(false); // 23:59 30 дек
  });
  it('evaluates in the recipient zone', () => {
    expect(q('2026-09-23T18:00:00Z', night, MSK)).toBe(false); // 21:00 МСК
    expect(q('2026-09-23T18:00:00Z', night, 'Asia/Yekaterinburg')).toBe(true); // 23:00
  });
});
```

Интеграционные тесты `cardsJob` (FakeMessenger):

1. 12 shown-proposals одного batch → 10 карточек и одно сообщение «ещё 2 предложения: /inbox». У всех 12 заполнен `notified_at`, у первых 10 — `owner_dm_message_id`.
2. Реакция 👀 на первое исходное сообщение каждого shown-proposal из группы (`react(chatTgId, msgId, '👀')`). При `reactions_enabled=false`, `onDetect=null` или `noReaction` реакции нет. Если `react` бросает `bad_request`, карточка всё равно отправлена, ошибка пишется в лог.
3. Тихие часы owner сейчас → ничего не отправлено. После их окончания → одно сообщение «За время тишины найдено N предложений» с кнопкой `[📥 Разобрать]`, `notified_at` заполнен у всех (D10).
4. Owner не начал DM → ничего не отправлено, superadmin получает оповещение не чаще раза в час. После `/start` owner'а карточки уходят.
5. `send` бросает `forbidden` → `users.dm_blocked=true`, `notified_at` пусто.
6. Suppressed-proposals никогда не отправляются.

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** `notified_at` проставляется **после** успешной отправки (at-least-once). Группировка идёт по `batch_id`, карточки упорядочены по `created_at`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(scheduler): deliver proposal cards via outbox with quiet hours and reactions`.

### Task 2.13: Ядро задач и решения по proposals

**Файлы:**

- Создать: `src/domain/tasks/repo.ts`, `src/domain/tasks/service.ts`, `src/domain/tasks/events.ts`, `src/domain/proposals/decide.ts`, `src/bot/handlers/proposalCallbacks.ts`, `src/bot/views/taskCreated.ts`
- Тесты: `tests/integration/domain/tasks.test.ts`, `tests/integration/bot/proposalActions.test.ts`

**Интерфейсы:**

- Produces:

```ts
export interface CreateTaskInput {
  workspaceId: number;
  title: string;
  description: string | null;
  assignee: AssigneeResolution;
  due: { at: Date | null; allDay: boolean; tz: string | null };
  priority: 'low' | 'normal' | 'high';
  origin: 'ai' | 'manual_group' | 'manual_dm' | 'forward';
  proposalId: number | null;
  source: { chatId: number | null; tgMessageId: number | null; link: string | null; quote: string | null };
}
export type ActorRef =
  { type: 'user'; userId: number } | { type: 'system' } | { type: 'ai' } | { type: 'apple'; userId: number };
export interface TaskService {
  create(tx: Tx, input: CreateTaskInput, actor: ActorRef): Promise<TaskRow>;
  update(
    tx: Tx,
    taskId: number,
    patch: Partial<Pick<CreateTaskInput, 'title' | 'description' | 'assignee' | 'due' | 'priority'>>,
    actor: ActorRef,
  ): Promise<TaskRow>;
  setStatus(
    tx: Tx,
    taskId: number,
    status: 'open' | 'in_progress' | 'done' | 'cancelled',
    actor: ActorRef,
  ): Promise<TaskRow>;
}
export function createTaskService(deps: Pick<AppDeps, 'clock' | 'config' | 'taskHooks'>): TaskService;

// src/domain/proposals/decide.ts
export type DecisionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'already_decided' | 'forbidden' | 'not_found' | 'target_gone' };
export function acceptProposal(
  deps: AppDeps,
  a: { proposalId: number; actor: Actor; edits?: ProposalEdits },
): Promise<DecisionResult<TaskRow>>;
export function rejectProposal(
  deps: AppDeps,
  a: { proposalId: number; actor: Actor; reason: 'not_task' | 'duplicate' | 'already_done' | 'other' | null },
): Promise<DecisionResult<ProposalRow>>;
export function markDuplicate(
  deps: AppDeps,
  a: { proposalId: number; taskId: number; actor: Actor; appendToDescription: boolean },
): Promise<DecisionResult<TaskRow>>;
export function applyModification(
  deps: AppDeps,
  a: { proposalId: number; actor: Actor },
): Promise<DecisionResult<TaskRow>>; // для kind update/complete/cancel
export interface ProposalEdits {
  title?: string;
  assignee?: AssigneeResolution;
  due?: { at: Date | null; allDay: boolean; tz: string | null };
  priority?: 'low' | 'normal' | 'high';
  description?: string | null;
}
```

- [x] **Шаг 1: падающие тесты**
  - Сервис задач:
    - `create` пишет событие `created`, `version=1`, `title` обрезается до 120 символов, `source_quote` — до 200;
    - `update` увеличивает `version`, пишет событие `updated` с `diff`;
    - каждое изменение вызывает `taskHooks` внутри той же транзакции (проверяется шпионским хуком).
  - Решения (через bot harness):
    1. «✅ Создать» от owner → задача `origin='ai'`, proposal `accepted` (`decided_by`, `decided_at`), карточка отредактирована в «✅ Создано: T<id> „…“».
    2. **Два одновременных accept** (`Promise.all`) → одна задача, второй получает `already_decided` и ответ «Уже обработано» (Фокус ревью 2).
    3. «Создать» от member (пересланная карточка) → `forbidden`, задачи нет.
    4. После передачи владения прежний owner (теперь member) нажимает кнопку → `forbidden`.
    5. «❌ Не задача» → меню причин → «Уже сделано» → `rejected`, `reject_reason='already_done'`, карточка отредактирована.
    6. «🔗 Дубль T12» → proposal `rejected` (`duplicate`). По кнопке «Дописать в описание» текст добавлен в описание T12.
    7. `update` → «✅ Применить» → у T12 новый срок, событие `updated`. `complete` → T12 `done`. `cancel` → T12 `cancelled`. Если задачу удалили → `target_gone` и понятный текст.
    8. Реакция `onAccept` (если задана `✍`) ставится на исходное сообщение после accept.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.**
  - Решение: `UPDATE proposals SET status=…, decided_by_user_id=…, decided_at=$now WHERE id=$1 AND status='pending' RETURNING *` — в той же транзакции, что и создание или изменение задачи.
  - Права проверяются `can(actor, 'proposal.decide')` по данным БД.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(proposals): accept, reject, duplicate and apply proposals idempotently`.

### Task 2.14: Диалог «Изменить» и разбор даты из текста

**Файлы:** создать `src/bot/conversations/editProposal.ts`, `src/bot/views/editMenu.ts`, `src/ai/pipeline/parseDate.ts`, `src/time/quickDue.ts`; тесты `tests/unit/time/quickDue.test.ts`, `tests/unit/ai/parseDate.test.ts`, `tests/integration/bot/editProposal.test.ts`.

**Интерфейсы:**

- Produces:
  - `quickDue(option: 'today' | 'tomorrow' | 'fri' | 'next_mon' | 'none', now: Date, zone: string): { at: Date | null; allDay: boolean; tz: string | null }` (D23);
  - `parseDateText(deps: AppDeps, text: string, ctx: { zone: string; now: Date }): Promise<ResolvedDue | null>` — промпт `parseDate.v1`, схема `Due`, дальше `resolveDue`; стоимость записывается как `analysis_batches` с `kind='manual'`;
  - `editProposalConversation` — conversations v2, `maxMillisecondsToWait = CONVERSATION_TIMEOUT_MS`.

- [x] **Шаг 1: падающие тесты**
  - `quickDue` (сейчас среда 2026-09-23 12:00 МСК):
    - `today` → 2026-09-23 all-day (23:59 МСК = `20:59Z`);
    - `tomorrow` → 24.09;
    - `fri` → 25.09; `fri` в пятницу → в тот же день; `fri` в субботу 26.09 → 02.10;
    - `next_mon` → 28.09;
    - `none` → `at=null`.
  - `parseDate` на FixtureClient:
    - «в четверг в 11» → fixture `{"due_local":"2026-09-24T11:00","time_hint":"none","due_text":"в четверг в 11"}` → `2026-09-24T08:00Z`;
    - мусорный ответ → `null` (пользователь увидит «Не удалось разобрать дату»).
  - Диалог:
    1. «✏️ Изменить» → меню `[Название] [Исполнитель] [Срок] [Приоритет] [Описание] [✅ Сохранить и создать] [↩️ Назад]`.
    2. «Исполнитель» → кнопки участников, «Я», «Не назначен», «Всем».
    3. «Срок» → `[Сегодня] [Завтра] [Пт] [След. пн] [Без срока] [Ввести…]`. «Ввести…» → текст «15.10 14:00» → превью «чт, 15 окт, 14:00 — верно?» → `[Да] [Нет]`.
    4. «Сохранить и создать» → задача с правками. В `proposals.payload.ownerEdits` записаны пары было/стало по полям (для SPEC §20.4).
    5. Member не может войти в диалог.
  - Не TDD-задача (D43): тесты написаны вместе с реализацией, не строго тест-первым — `tests/unit/time/quickDue.test.ts`, `tests/integration/ai/parseDate.test.ts` (нужен реальный `Db` для `settings.fuzzyTimes`/`analysis_batches` — не `tests/unit/ai/...`, вопреки брифу), `tests/integration/bot/editProposal.test.ts`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Все обращения к БД и LLM внутри диалога — через `conversation.external`. Сверено через Context7 → grammY conversations (`wait`/`waitForCallbackQuery`/`external`/`skip`/`halt`'s `next` option — подтверждает, что во время активного диалога прочие `bot.callbackQuery` не видят обновление, пока диалог явно не отдаст его дальше).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(bot): add proposal editing dialog with quick and free-text dates`.

### Task 2.15: `/inbox`, `/debug`, `/reanalyze`, расширенный `/admin`, истечение proposals

**Файлы:**

- Создать: `src/bot/handlers/inbox.ts`, `src/bot/views/debug.ts`, `src/domain/proposals/queries.ts`, `src/domain/ai/stats.ts`, `src/scheduler/jobs/expireProposals.ts`
- Изменить: `src/bot/handlers/admin.ts`, `src/bot/views/admin.ts`
- Тесты: `tests/integration/bot/inbox.test.ts`, `tests/integration/bot/debug.test.ts`, `tests/integration/domain/aiStats.test.ts`

**Интерфейсы:**

- Produces:
  - `listPendingProposals(db, workspaceId, { page, pageSize })`;
  - `aiStats(db, { now, tz }): Promise<{ costToday: number; costMonth: number; last7: { shown: number; suppressed: number; accepted: number; rejected: number }; precision: number | null; pendingByChat: Array<{ chatId: number; title: string; count: number }> }>`;
  - `reanalyze(deps, { chatId, lastN?: number })` — если `lastN` не задан, failed-batch'и чата возвращаются в очередь (`batch_id=null` у их сообщений). Если задан, последние N сообщений с текстом переводятся в `pending` и собираются в новый batch с `kind='reanalyze'` и `noReaction`;
  - `expireProposalsJob = dailyJob('expire-proposals', '03:40', …)` (D11).

- [x] **Шаг 1: падающие тесты**
  1. `/inbox` → список неразобранных (по 5 на страницу). Нажатие → карточка присылается заново.
  2. `/debug` (superadmin) → последние 10 batch: время, число сообщений, shown и suppressed с причинами, стоимость, модель, статус и ошибка. Не-superadmin → `forbidden`.
  3. `/reanalyze <chatId> 10` → новый batch `reanalyze`; повторные proposals помечаются дублями (дедуп работает); реакции не ставятся.
  4. `/reanalyze <chatId>` без N → failed-сообщения снова в очереди.
  5. `/admin` показывает стоимость за сегодня и месяц, статистику за 7 дней и precision = accepted/(accepted+rejected); при нуле знаменателя — «н/д».
  6. Proposal возрастом 8 дней → `expired`. Возрастом 6 дней — остаётся.
  - Не TDD-задача (D43): тесты написаны вместе с реализацией, не строго тест-первым. Также: SPEC §12.2's команда `/reanalyze` — Superadmin, не Owner (бриф задачи ошибочно называл её owner-only «по D40»; реализовано по SPEC/`src/bot/commands.ts`, см. коммит).
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(bot): add /inbox, /debug, /reanalyze and AI stats in /admin`.

### Task 2.16: Eval-датасет (≥150 синтетических кейсов)

**Файлы:** создать `eval/schema.ts`, `eval/datasets/school_ru.v1.jsonl`; тест `tests/unit/eval/dataset.test.ts`.

**Интерфейсы:**

- Produces: `EvalCaseSchema` (zod), `type EvalCase`:

```ts
{
  id: string; tags: string[]; now: string /* ISO с offset */; workspaceTz: string;
  participants: Array<{ code: string; name: string; aliases?: string[]; role: 'owner' | 'member'; tz?: string }>;
  openTasks: Array<{ ref: string; title: string; assignee: string | null; due: string | null }>;
  openProposals: Array<{ ref: string; title: string }>;
  context: Array<{ ref: string; author: string; at: string; text: string }>;
  messages: Array<{ ref: string; author: string; at: string; text: string; replyTo?: string; forwardFrom?: string }>;
  expected: Array<{ type: 'create' | 'update' | 'complete' | 'cancel'; category?: Category; assignee?: string | null; targetRef?: string;
                    due?: { date: string | null; time: string | null; hint: 'morning'|'afternoon'|'evening'|'end_of_week'|'soon'|'none' } }>;
}
```

- [x] **Шаг 1: падающий тест**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EvalCaseSchema } from '../../../eval/schema.js';

const cases = readFileSync('eval/datasets/school_ru.v1.jsonl', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => EvalCaseSchema.parse(JSON.parse(l)));
const examples = JSON.parse(readFileSync('prompts/examples.school_ru.json', 'utf8')) as Array<{
  messages: Array<{ text: string }>;
}>;
const share = (pred: (c: (typeof cases)[number]) => boolean) => cases.filter(pred).length / cases.length;

describe('eval dataset (SPEC §20.1)', () => {
  it('has at least 150 unique cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
  it('follows the target distribution', () => {
    expect(share((c) => c.expected.some((a) => a.type === 'create'))).toBeGreaterThanOrEqual(0.4);
    expect(share((c) => c.expected.some((a) => a.type === 'create'))).toBeLessThanOrEqual(0.5);
    const mod = share((c) => c.expected.length > 0 && c.expected.every((a) => a.type !== 'create'));
    expect(mod).toBeGreaterThanOrEqual(0.12);
    expect(mod).toBeLessThanOrEqual(0.18);
    expect(share((c) => c.expected.length === 0)).toBeGreaterThanOrEqual(0.35);
    expect(share((c) => c.expected.length === 0)).toBeLessThanOrEqual(0.45);
  });
  it('covers every category', () => {
    for (const cat of ['assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner']) {
      expect(cases.filter((c) => c.expected.some((a) => a.category === cat)).length).toBeGreaterThanOrEqual(
        8,
      );
    }
  });
  it('covers date phrases, month and year crossing', () => {
    const dateCases = cases.filter((c) => c.tags.includes('dates'));
    expect(dateCases.length).toBeGreaterThanOrEqual(20);
    const all = dateCases.flatMap((c) => c.messages.map((m) => m.text.toLowerCase())).join('\n');
    for (const p of [
      'к пятнице',
      'в среду в 15',
      'до конца недели',
      'на днях',
      'завтра утром',
      'после обеда',
      'через неделю',
      '15.10',
      'к 1 ноября',
    ]) {
      expect(all).toContain(p);
    }
    expect(cases.some((c) => c.tags.includes('month_cross'))).toBe(true);
    expect(cases.some((c) => c.tags.includes('year_cross'))).toBe(true);
  });
  it('has consistent references', () => {
    for (const c of cases) {
      const people = new Set([...c.participants.map((p) => p.code), 'OWNER', 'ALL']);
      const targets = new Set([...c.openTasks.map((t) => t.ref), ...c.openProposals.map((p) => p.ref)]);
      for (const a of c.expected) {
        if (a.assignee) expect(people.has(a.assignee), `${c.id}`).toBe(true);
        if (a.targetRef) expect(targets.has(a.targetRef), `${c.id}`).toBe(true);
      }
    }
  });
  it('does not leak few-shot examples', () => {
    const shots = new Set(examples.flatMap((e) => e.messages.map((m) => m.text)));
    for (const c of cases) for (const m of c.messages) expect(shots.has(m.text), c.id).toBe(false);
  });
});
```

- [x] **Шаг 2:** FAIL (нет файла).
- [x] **Шаг 3: датасет в три коммита**, чтобы ревью было проще: (а) ~70 кейсов с `create` по всем категориям, включая 20+ кейсов на даты; (б) ~23 кейса `complete`, `update`, `cancel`; (в) ~60 трудных негативов (обсуждение без действия, прошедшие события, «надо бы когда-нибудь…» без адресата, вопросы, шутки, благодарности). Стиль — живой рабочий русский: сокращения, опечатки, эмодзи, нет знаков препинания, есть реплаи и пересылки. Имена вымышленные, телефоны вида `+7 900 000-00-00`.
  - Тест из шага 1 буквально ожидает `prompts/examples.school_ru.json` в форме `Array<{ messages: Array<{ text: string }> }>`, но реальный файл (Task 2.3) хранит примеры как `{ user: string; assistant: string }` — `user` это уже отрендеренный промпт целиком, поля `messages` там нет. Тест адаптирован под реальную форму: проверяет, что ни один текст сообщения датасета не встречается подстрокой в `user` какого-либо примера (тот же смысл — нет утечки few-shot).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммиты и push:** `test(eval): add synthetic dataset part N/3`.

### Task 2.17: Скрипт `pnpm eval`

**Файлы:** создать `eval/run.ts`, `eval/metrics.ts`, `eval/report.ts`, `eval/pricing.ts`; тест `tests/unit/eval/metrics.test.ts`.

**Интерфейсы:**

- Produces:
  - `computeMetrics(rows: Array<{ caseId: string; expected: EvalCase['expected']; predicted: Array<ResolvedAction & { decision: 'shown' | 'suppressed' }>; resolvedExpectedDue: Array<Date | null>; costUsd: number; latencyMs: number }>): Metrics`;
  - `interface Metrics { n: number; recall: number; precision: number; typeAccuracy: number; categoryAccuracy: number; assigneeAccuracy: number; dueAccuracy: number; costPer100: number; avgLatencyMs: number }`;
  - `renderReport(meta, metrics, failures): string`;
  - `estimateCostUsd(cases, pricing): number`.
- CLI: `pnpm eval --model <id> [--fallback <id>] [--prefilter off|llm|jev] [--prompt-version v1] [--limit N] [--concurrency 4] [--yes] [--provider openrouter|fixture]`.

- [x] **Шаг 1: тесты** (не из D43 — написаны сразу вместе с реализацией, не failing-first; `computeMetrics` на ручных данных)
  1. 4 кейса: TP (ожидалось и показано), FN (ожидалось, ничего не показано), FP (не ожидалось, показано), TN → recall 0.5, precision 0.5.
  2. Сопоставление действий: по типу и `targetRef`, для `create` — по категории. Верный тип при неверной категории: `typeAccuracy` 1, `categoryAccuracy` 0.
  3. Исполнитель сравнивается только у сопоставленных `create`, где исполнитель ожидался.
  4. Срок: ожидаемый срок прогоняется через `resolveDue` и сравнивается с предсказанным `dueAt`. Всё, что не all-day, должно совпадать с точностью до минуты; у all-day — дата.
  5. Suppressed-действия не считаются показанными (метрики отражают то, что увидит Owner).
- [x] **Шаг 2:** PASS.
- [x] **Шаг 3: реализация.**
  - `run.ts` берёт цену модели из `GET https://openrouter.ai/api/v1/models`, оценивает стоимость (символы / 3 × цена токена), печатает оценку. Если оценка больше $1 и нет `--yes`, спрашивает подтверждение через `readline`. После прогона печатает фактическую стоимость.
  - Отчёт: `eval/reports/<YYYY-MM-DD>-<model>-<prompt>.md` плюс строка в `eval/reports/COMPARISON.md`.
  - `--provider fixture` отвечает эталоном: даёт метрики 1.0 и служит smoke-проверкой без затрат.
- [x] **Шаг 4:** PASS, плюс `pnpm eval --provider fixture --limit 5` отрабатывает.
- [x] **Шаг 5: коммит и push:** `feat(eval): add evaluation runner with metrics and reports`.

### Task 2.18 (👤): Выбор моделей, настройка промпта, приёмка фазы

- [x] **Шаг 1:** проверить актуальный список и цены моделей OpenRouter (WebFetch `openrouter.ai/models`). Предложить пользователю 3–4 кандидата из классов SPEC §9.2 (Gemini Flash, GPT mini, Claude Haiku 4.5) с оценкой стоимости полного прогона.
- [x] **Шаг 2 (👤 одобрить расходы):** `pnpm eval --model <m> --limit 30` для каждого кандидата, затем полный прогон для двух лучших.
- [x] **Шаг 3:** если целевые метрики не достигнуты, итерировать промпт через новые версии файлов (`extractor.v2.md`, D27). Каждая итерация — отдельный коммит с отчётом.
- [x] **Шаг 4:** записать выбор (primary и fallback) в `eval/reports/COMPARISON.md`, в `.env.example` (комментарий) и в `CHANGELOG.md`. Коммит: `docs(eval): select primary and fallback models`.
- [x] **Шаг 5 (👤): ручная приёмка на dev-боте** (RC `v0.3.0-rc.1`):
  1. «Маша, подготовь расписание к пятнице» → карточка не позже 4 мин с правильными исполнителем и сроком.
  2. «сделала» ответом → предложение закрыть задачу.
  3. Неверный `OPENROUTER_API_KEY` → сообщения `pending`, после исправления они проанализированы.
  4. `LLM_DAILY_BUDGET_USD=0.0001` → пауза и оповещения.
  5. `docker stats` после суток работы — RAM приложения меньше 300 МБ (SPEC §29).
- [x] **Шаг 6: закрытие фазы:** docs, `CHANGELOG.md`, PR `Phase 2: AI pipeline and proposals` → 👤 → merge → тег `v0.3.0`.

### Task 2.19 (опционально, фаза 2b, по решению пользователя): префильтр Jev

- [ ] **Шаг 1:** исследовать актуальную документацию (Context7, WebFetch: typesafe.ai, jevai.org, Pydantic AI по TypeSafe): доступ к API, есть ли модель в OpenRouter, формат запроса, цена, русский язык. Результат — `docs/JEV_SPIKE.md`.
- [ ] **Шаг 2:** если API доступен: `src/ai/providers/jev.ts` (`DecisionProvider`) плюс вариант `llm` (дешёвая модель), unit-тесты на fixtures, `pnpm eval --prefilter jev|llm`.
- [ ] **Шаг 3:** критерий включения (SPEC §9.4): теряется не больше 2% позитивных кейсов и стоимость заметно снижается. Иначе `AI_PREFILTER=off`. Решение — в `COMPARISON.md`.

---
