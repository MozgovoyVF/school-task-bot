# План: завершённая фаза 3 (архив)

Перенесено из `plan.md` после выпуска `v0.4.0` (PR #8, #9). Решения D-таблицы и общие контракты остаются в `plan.md`.

## Фаза 3 — Задачи и напоминания руководителю (ветка `phase-3-tasks`)

**Решение по ходу:** перед Task 3.1 обсудить с пользователем D6 (`dedupe_key` с версией) и D7 (правила планирования overdue).

**Приёмка (SPEC §22):**

- unit-тесты расписания: часовые пояса, all-day, переходы DST, тихие часы, изменение срока;
- сквозной сценарий: задача → напоминание накануне → snooze → due → «Выполнено» от руководителя → архив (без review, D40);
- сотрудникам бот ничего не присылает в личку (D40);
- сводка приходит в 09:00 в поясе Owner.

### Task 3.1: Планировщик уведомлений задачи (чистая функция)

**Файлы:** создать `src/domain/notifications/plan.ts`; тест `tests/unit/domain/notificationPlan.test.ts`.

**Интерфейсы:**

- Produces:
  - `interface PlanRecipient { userId: number; zone: string }` — получатель всегда только owner (D40);
  - `interface PlannedNotification { kind: 'pre_due' | 'due' | 'overdue'; recipientUserId: number; fireAt: Date; dedupeKey: string }`;
  - `planTaskNotifications(a: { task: { id: number; version: number; dueAt: Date | null; dueAllDay: boolean; dueTz: string | null; status: string }; recipients: PlanRecipient[]; reminders: Settings['reminders']; now: Date }): PlannedNotification[]`;
  - `nextOverdueAfter(a: { task; recipient: PlanRecipient; reminders; after: Date }): PlannedNotification | null` — используется для цепочки в 3.3.

- [x] **Шаг 1: падающие тесты** (SPEC §13.2, D6–D8, D40)

```ts
import { describe, it, expect } from 'vitest';
import { planTaskNotifications, type PlanRecipient } from '../../../src/domain/notifications/plan.js';

const reminders = {
  preDueTime: '10:00',
  allDayDueTime: '10:00',
  overdueTime: '10:00',
  groupOverdueThreshold: 3,
};
const owner: PlanRecipient = { userId: 10, zone: 'Europe/Moscow' };
const FRI_18_MSK = new Date('2026-09-25T15:00:00Z');
const FRI_ALLDAY_MSK = new Date('2026-09-25T20:59:00Z');
const task = (
  o: Partial<{
    id: number;
    version: number;
    dueAt: Date | null;
    dueAllDay: boolean;
    dueTz: string | null;
    status: string;
  }> = {},
) => ({
  id: 1,
  version: 1,
  dueAt: FRI_18_MSK,
  dueAllDay: false,
  dueTz: 'Europe/Moscow',
  status: 'open',
  ...o,
});
const plan = (
  t: ReturnType<typeof task>,
  now: string,
  recipients: PlanRecipient[] = [owner],
  r = reminders,
) =>
  planTaskNotifications({ task: t, recipients, reminders: r, now: new Date(now) }).map((n) => [
    n.kind,
    n.recipientUserId,
    n.fireAt.toISOString(),
    n.dedupeKey,
  ]);

describe('planTaskNotifications', () => {
  it('datetime due more than 24h ahead', () => {
    expect(plan(task(), '2026-09-23T09:00:00Z')).toEqual([
      ['pre_due', 10, '2026-09-24T07:00:00.000Z', 'task:1:v1:pre_due:10:2026-09-24'],
      ['due', 10, '2026-09-25T15:00:00.000Z', 'task:1:v1:due:10:2026-09-25'],
      ['overdue', 10, '2026-09-26T07:00:00.000Z', 'task:1:v1:overdue:10:2026-09-26'],
    ]);
  });
  it('skips pre_due when due is less than 24h away (D8)', () => {
    expect(plan(task(), '2026-09-25T00:00:00Z').map((x) => x[0])).toEqual(['due', 'overdue']);
  });
  it('all-day due', () => {
    expect(
      plan(task({ dueAt: FRI_ALLDAY_MSK, dueAllDay: true }), '2026-09-23T09:00:00Z').map((x) => x[2]),
    ).toEqual(['2026-09-24T07:00:00.000Z', '2026-09-25T07:00:00.000Z', '2026-09-26T07:00:00.000Z']);
  });
  it('never schedules in the past (D7)', () => {
    expect(
      plan(task({ dueAt: FRI_ALLDAY_MSK, dueAllDay: true }), '2026-09-24T12:00:00Z').map((x) => x[0]),
    ).toEqual(['due', 'overdue']);
  });
  it('uses the recipient zone for all-day dates', () => {
    const yekt: PlanRecipient = { userId: 10, zone: 'Asia/Yekaterinburg' };
    expect(
      plan(task({ dueAt: FRI_ALLDAY_MSK, dueAllDay: true }), '2026-09-23T03:00:00Z', [yekt]).map((x) => x[2]),
    ).toEqual(['2026-09-24T05:00:00.000Z', '2026-09-25T05:00:00.000Z', '2026-09-26T05:00:00.000Z']);
  });
  it('first overdue for an already overdue task is the next overdueTime after now', () => {
    expect(plan(task(), '2026-09-27T09:00:00Z')).toEqual([
      ['overdue', 10, '2026-09-28T07:00:00.000Z', 'task:1:v1:overdue:10:2026-09-28'],
    ]);
  });
  it('datetime overdue may fire the same day (D7, literal SPEC §13.2)', () => {
    const due0900 = new Date('2026-09-25T06:00:00Z');
    expect(plan(task({ dueAt: due0900 }), '2026-09-23T09:00:00Z').at(-1)?.[2]).toBe(
      '2026-09-25T07:00:00.000Z',
    );
  });
  it('handles DST in the recipient zone', () => {
    const berlin: PlanRecipient = { userId: 10, zone: 'Europe/Berlin' };
    const t = task({ dueAt: new Date('2026-10-25T22:59:00Z'), dueAllDay: true, dueTz: 'Europe/Berlin' });
    expect(plan(t, '2026-10-20T10:00:00Z', [berlin]).map((x) => x[2])).toEqual([
      '2026-10-24T08:00:00.000Z',
      '2026-10-25T09:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ]);
  });
  it('returns nothing without due or for closed tasks', () => {
    expect(plan(task({ dueAt: null }), '2026-09-23T09:00:00Z')).toEqual([]);
    expect(plan(task({ status: 'done' }), '2026-09-23T09:00:00Z')).toEqual([]);
    expect(plan(task({ status: 'cancelled' }), '2026-09-23T09:00:00Z')).toEqual([]);
  });
  it('reminds in_progress tasks the same way', () => {
    expect(plan(task({ status: 'in_progress' }), '2026-09-23T09:00:00Z')).toHaveLength(3);
  });
  it('embeds the task version in dedupe keys (D6) and honours custom times', () => {
    const r = plan(task({ version: 3 }), '2026-09-23T09:00:00Z', [owner], {
      ...reminders,
      preDueTime: '09:00',
    });
    expect(r[0]).toEqual(['pre_due', 10, '2026-09-24T06:00:00.000Z', 'task:1:v3:pre_due:10:2026-09-24']);
  });
});
```

- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация** (только luxon).
  - Календарная дата all-day берётся в `task.dueTz` (при отсутствии — в поясе получателя), время напоминания — в поясе получателя.
  - Первый `overdue`:
    - срок со временем — самое раннее `overdueTime` в поясе получателя строго после `max(dueAt, now)`;
    - all-day — самое раннее `overdueTime` не раньше следующего дня после даты срока и строго после `now`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(notifications): plan pre-due, due and overdue reminders`.

### Task 3.2: Пересчёт напоминаний при изменении задачи

**Файлы:** создать `src/domain/notifications/recipients.ts`, `src/domain/notifications/schedule.ts`; изменить `src/app.ts` (зарегистрировать хук в `deps.taskHooks`); тест `tests/integration/domain/reschedule.test.ts`.

**Интерфейсы:**

- Produces:
  - `resolveRecipients(tx, task: TaskRow, settings: Settings): Promise<PlanRecipient[]>` — только owner (D40), если `dm_started_at` не пусто и `dm_blocked=false`; иначе пустой список. Пояс: `users.timezone`, иначе пояс workspace;
  - `remindersHook: TaskHook` — отменяет все `scheduled` уведомления задачи (включая snooze: «любое изменение → отмена всех», SPEC §13.2), затем вставляет план `ON CONFLICT (dedupe_key) DO NOTHING`.

- [x] **Шаг 1: падающие тесты**
  1. Создание задачи со сроком и исполнителем-сотрудником → строки `notifications` только для owner (D40).
  2. Owner не начал DM или заблокировал бота → уведомлений нет.
  3. Изменение срока → старые строки `cancelled`, новые `scheduled` с `v2` в ключе.
  4. Перенос срока в пределах того же дня после уже отправленного `due` → новая строка создаётся без конфликта (D6).
  5. `done` или `cancelled` → все `scheduled` отменены.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(notifications): reschedule reminders on every task change`.

### Task 3.3: Job рассылки уведомлений

**Файлы:** создать `src/scheduler/jobs/notify.ts`, `src/bot/views/reminder.ts`; тесты `tests/unit/bot/views/reminder.test.ts`, `tests/integration/scheduler/notify.test.ts`.

**Интерфейсы:**

- Produces:
  - `notifyJob: Job`;
  - `renderReminder(v: { kind: 'pre_due' | 'due' | 'overdue' | 'snooze'; task: TaskListItem; viewerZone: string }): { text: string; buttons: Buttons }` — кнопки `[✅ Готово] [⏰ +1 час] [📅 Завтра] [🕐 Выбрать время]` (SPEC §13.3);
  - `renderOverdueDigest(items: TaskListItem[], viewerZone): { text; buttons }`;
  - `interface TaskListItem { id: number; title: string; assigneeName: string | null; dueAt: Date | null; dueAllDay: boolean; dueTz: string | null; status: string }` и `getTaskListItem(db, taskId): Promise<TaskListItem | null>` в `src/domain/tasks/queries.ts` (задачи 3.5 и 3.7 дополняют этот файл).

- [x] **Шаг 1: падающие тесты** (интеграционные, FakeMessenger, `fixedClock`)
  1. Scheduled `due` с `fire_at <= now` → отправлено, `status='sent'`, `sent_tg_message_id` заполнен.
  2. **Два параллельных `tickOnce`** (два соединения) → каждое уведомление отправлено ровно один раз (Фокус ревью 1).
  3. Три `overdue` одному owner в один тик → одно сообщение-список (`groupOverdueThreshold=3`). Два — отдельными сообщениями.
  4. После отправки `overdue` создан следующий на завтра в `overdueTime` (цепочка D7). Задача закрыта → цепочка не продолжается.
  5. Задача закрыта или удалена между планированием и отправкой → уведомление `cancelled`, ничего не отправлено.
  6. Тихие часы: `pre_due`, `overdue` и `summary` → `cancelled`, `last_error='quiet'`, цепочка `overdue` продолжается. `due` и `snooze` отправляются (SPEC §13.5).
  7. `send` бросает `rate_limited` или `network` → `attempts++`, `fire_at` сдвигается по `nextAttemptAt`. После 5 неудач → `failed`.
  8. `forbidden` (403) → `users.dm_blocked=true`, все `scheduled` этого пользователя `cancelled`.
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** Одна транзакция: `SELECT … WHERE status='scheduled' AND fire_at <= $now ORDER BY fire_at LIMIT 50 FOR UPDATE SKIP LOCKED` (SPEC §13.1) → проверка актуальности → группировка → отправка через throttled messenger → обновление статусов. Сводки (`kind='summary'`) рендерятся в момент отправки (3.5).
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(scheduler): send reminders with retries, grouping and quiet hours`.

### Task 3.4: Кнопки в напоминании и snooze

**Файлы:** создать `src/domain/notifications/snooze.ts`, `src/bot/handlers/reminderCallbacks.ts`, `src/bot/conversations/snoozeInput.ts`; тесты `tests/unit/domain/snooze.test.ts`, `tests/integration/bot/reminderButtons.test.ts`.

**Интерфейсы:**

- Produces:
  - `type SnoozeOption = '1h' | 'tomorrow' | '3h' | 'today18' | 'dayafter'`;
  - `snoozeFireAt(option: SnoozeOption, now: Date, zone: string, reminders: Settings['reminders']): Date | null` — `null`, если вариант уже неприменим (например, «Сегодня 18:00» после 18:00);
  - `createSnooze(tx, { taskId, recipientUserId, fireAt, workspaceId })` — `kind='snooze'`, ключ `snooze:{task}:{recipient}:{fireAtISO}`.

- [x] **Шаг 1: падающие тесты**
  - `snoozeFireAt` (сейчас 2026-09-23T09:00Z = 12:00 МСК):
    - `1h` → `10:00Z`;
    - `3h` → `12:00Z`;
    - `tomorrow` → `2026-09-24T07:00Z` (10:00 МСК);
    - `today18` → `2026-09-23T15:00Z`; при `now=18:30 МСК` → `null`;
    - `dayafter` → `2026-09-25T07:00Z`.
  - Кнопки:
    1. «⏰ +1 час» от owner → snooze-уведомление, срок задачи не изменился (SPEC §13.3).
    2. «🕐 Выбрать время» → `[Через 3 ч] [Сегодня 18:00] [Послезавтра] [Ввести…]`. «Ввести…» → текст → `parseDateText` → превью → snooze.
    3. «✅ Готово» от owner → задача `done`.
    4. Кнопку напоминания нажимает не owner (подделанный или пересланный callback) → `forbidden`.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(reminders): add done and snooze buttons`.

### Task 3.5: Утренняя сводка

**Файлы:** создать `src/bot/views/summary.ts`, `src/scheduler/jobs/summary.ts`, `src/domain/tasks/queries.ts` (секции сводки); тесты `tests/unit/bot/views/summary.test.ts`, `tests/integration/scheduler/summary.test.ts`.

**Интерфейсы:**

- Produces:
  - `summarySections(db, { workspaceId, now, zone }): Promise<{ overdue: TaskListItem[]; today: TaskListItem[]; inboxCount: number; noDue: TaskListItem[]; noDueTotal: number }>` — секции «Ждут вашей проверки» нет (D40);
  - `renderSummary(s, { date: Date; zone: string }): { text: string; buttons: Buttons }`;
  - `ensureSummariesJob: Job` — для owner держит одну scheduled-сводку на следующее `summary.time` в поясе получателя; ключ `summary:{ws}:{user}:{date}`.

- [x] **Шаг 1: падающие тесты**
  - View:
    - секции в порядке SPEC §13.4 без «Ждут вашей проверки» (D40), заголовок `☀️ Доброе утро! Сводка на пт, 25 сен`;
    - пустые секции не выводятся;
    - всё пусто → `Задач на сегодня нет 🎉`;
    - «Без срока»: топ-5 самых старых и `ещё 2 → /tasks`;
    - кнопки `[📋 Все задачи] [📥 Разобрать]`;
    - при 200 задачах текст не длиннее 4096 символов (секции обрезаются с «ещё N»).
  - Integration:
    1. Owner в поясе Asia/Yekaterinburg, `summary.time='09:00'`. Тик в `03:59Z` → ничего; тик в `04:00Z` → сводка отправлена, создана запись на завтра.
    2. `summary.enabled=false` → записи не создаются, уже созданные отменены.
    3. Смена `summary.time` через `/settings` → scheduled-сводка пересоздана.
    4. Тихий день (`dateRanges`) → сводка подавлена, на следующий день приходит.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(summary): add daily morning summary`.

### Task 3.6: Карточка задачи и действия с ней

**Файлы:** создать `src/bot/views/taskCard.ts`, `src/bot/views/history.ts`, `src/bot/handlers/taskCallbacks.ts`, `src/bot/conversations/editTask.ts`; изменить `src/domain/tasks/service.ts` (`cancel`, `restore`, `deleteForever`); тесты `tests/unit/bot/views/taskCard.test.ts`, `tests/integration/bot/taskActions.test.ts`.

**Интерфейсы:**

- Produces:
  - `renderTaskCard(t: TaskCardView, viewerZone: string): { text; buttons }` — формат SPEC §12.4;
  - `TaskService.cancel`, `restore` (→ `open`), `deleteForever` (удаляет задачу, события и уведомления);
  - общий редактор полей `editFieldsConversation`, который делят 2.14 и 3.6: после 2.14 вынести общие шаги в `src/bot/conversations/editFields.ts`.
  - Форвард-ссылка на Task 2.13 (fix round 1, M4): терминальная карточка «✅ Создано: T<id> …» (`src/bot/views/taskCreated.ts`, `src/bot/handlers/proposalCallbacks.ts`) сейчас редактируется без кнопок — SPEC §11.2 хочет там кнопки управления задачей. Когда `renderTaskCard` появится здесь, стоит навесить его кнопки (или ссылку на карточку задачи) на эту терминальную карточку тоже.

- [x] **Шаг 1: падающие тесты**
  - View:
    - snapshot карточки owner с кнопками `[✅ Выполнено] [▶️ В работу] / [✏️ Изменить] [⏰ Отложить] / [🗑 Отменить] [📜 История]`;
    - у архивной задачи кнопки `[♻️ Восстановить] [🗑 Удалить навсегда]`;
  - Действия:
    1. «Выполнено» → `done`, `completed_at`, `completed_by`, событие `status_changed`, напоминания отменены.
    2. «В работу» → `in_progress`.
    3. «Изменить» → диалог. Изменение срока → `version+1`, напоминания пересчитаны.
    4. «Отложить» → варианты snooze для owner.
    5. «Отменить» → `cancelled` (архив).
    6. «Восстановить» → `open`, напоминания запланированы заново.
    7. «Удалить навсегда» требует **двух** подтверждений. После них в БД нет ни задачи, ни событий, ни уведомлений.
    8. «История» → последние 20 событий с датами в поясе получателя.
    9. Кнопка удалённой задачи → «Задача не найдена», без исключения (Фокус ревью 2).
    10. Member жмёт кнопку управления → `forbidden`.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(tasks): add task card with status, edit, archive and delete actions`.

### Task 3.7: Списки и фильтры — `/tasks`, `/today`, `/overdue`, `/archive`

**Файлы:** изменить `src/domain/tasks/queries.ts`; создать `src/bot/views/taskList.ts`, `src/bot/handlers/lists.ts`; тесты `tests/unit/bot/views/taskList.test.ts`, `tests/integration/domain/taskQueries.test.ts`, `tests/integration/bot/lists.test.ts`.

**Интерфейсы:**

- Produces:
  - `type ListFilter = { kind: 'open' } | { kind: 'today' } | { kind: 'overdue' } | { kind: 'no_due' } | { kind: 'assignee'; userId: number | 'none' | 'all' } | { kind: 'chat'; chatId: number } | { kind: 'archive' } | { kind: 'today_and_overdue' }`;
  - Consumes: `TaskListItem` из 3.3;
  - `listTasks(db, { workspaceId, filter, page, pageSize = 5, now, zone }): Promise<{ items: TaskListItem[]; total: number; pages: number }>`;
  - `rowMarker(item, now, zone): '🔴' | '🔵' | '🟡' | '⚪'` (D24);
  - `renderTaskList(r, { filter, page, zone, now }): { text; buttons }`.
  - Callback: `v1:l:<f>:<page>[:<arg>]`, где `f` ∈ `all|tod|ovd|nod|asg|cht|arc|tov`.

- [x] **Шаг 1: падающие тесты**
  - `rowMarker`:
    - просрочено → 🔴;
    - `in_progress` и не просрочено → 🔵;
    - срок сегодня в поясе получателя → 🟡;
    - позже или без срока → ⚪;
    - all-day со сроком сегодня не считается просроченным до конца дня.
  - Строка: `🔴 T12 Подготовить расписание — Мария · пт, 25 сен`.
  - Пагинация: 12 задач → `стр 1/3`. На первой странице нет `◀️`, на последней нет `▶️`.
  - Запросы:
    - `today` в поясе Yekaterinburg отличается от Moscow на границе суток (тест на 20:30Z);
    - `archive` — `done` и `cancelled`, от новых к старым.
  - Бот:
    - `/today` = сегодня + просроченные;
    - member не может вызвать `/tasks` (`forbidden`);
    - нажатие на номер открывает карточку;
    - меню «По исполнителю ▾» и «По чату ▾» работает.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(tasks): add task lists with filters and pagination`.

### Task 3.8: Поиск и статистика

**Файлы:** создать `src/domain/tasks/search.ts`, `src/domain/tasks/stats.ts`, `src/bot/handlers/search.ts`, `src/bot/handlers/stats.ts`, `src/bot/views/stats.ts`; тесты `tests/integration/domain/search.test.ts`, `tests/integration/domain/stats.test.ts`.

**Интерфейсы:**

- Produces:
  - `searchTasks(db, { workspaceId, query, page }): Promise<{ items: TaskListItem[]; total: number }>` — по всем статусам (SPEC §12.2);
  - `taskStats(db, { workspaceId, periodDays: 7 | 30 | 90, now }): Promise<Array<{ key: { type: 'user'; userId: number; name: string } | { type: 'owner' } | { type: 'none' }; open: number; inProgress: number; overdueNow: number; done: number; onTimePct: number | null; avgLateHours: number | null }>>`.

- [x] **Шаг 1: падающие тесты**
  - Поиск:
    1. «расписан» находит «Подготовить расписание» (ILIKE) и «Расписание на ноябрь».
    2. Опечатка «расписане» находит через trigram.
    3. Запрос `50%` находит «Скидка 50% для группы» и не находит «Скидка 500».
    4. Запрос `_` не возвращает все задачи подряд (Фокус ревью 4).
    5. Ищутся и архивные задачи.
  - Статистика по Марии за 30 дней:
    - 2 задачи выполнены в срок, 1 — с опозданием на 48 ч, 1 открыта и просрочена, 1 в работе;
    - ожидается: `open=1`, `inProgress=1`, `overdueNow=1`, `done=3`, `onTimePct=67`, `avgLateHours=48`;
    - отдельные строки «Owner» и «без исполнителя».
- [x] **Шаг 2:** FAIL.
- [x] **Шаг 3: реализация.** `ILIKE` с экранированием `%`, `_` и `\` (`ESCAPE '\'`) плюс `similarity(title, q) > 0.2`; сортировка по `greatest(similarity(title), similarity(description))`. Период выбирается кнопками `[7] [30] [90]`.
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(tasks): add search and per-assignee statistics`.

### Task 3.9: (удалена — D40)

Поток исполнителя (уведомление о назначении, «Беру в работу», «Готово» → проверка → «Принять»/«Вернуть», `/my`) не реализуется: по решению пользователя бот присылает уведомления только руководителю. Оркестратор пропускает эту задачу.

### Task 3.10: Ручное создание — `/task` в группе, `/new`, свободный текст, пересылки

**Файлы:** создать `src/ai/pipeline/extractSingle.ts`, `src/bot/handlers/taskCommand.ts`, `src/bot/handlers/dmFreeText.ts`, `src/bot/handlers/forwards.ts`, `src/bot/conversations/newTask.ts`; изменить `src/bot/handlers/group.ts` (реальный `/task` вместо стаба), `src/bot/handlers/stubs.ts` (`/new` убран из стабов), `src/bot/handlers/normalize.ts`/`src/scheduler/jobs/cards.ts` (экспорт `forwardOriginName`/`markCardSent` для переиспользования), `src/domain/chats/messages.ts` (`getMessageByTgId`), `src/domain/proposals/repo.ts` (`createManualProposal`, `ProposalCategoryColumn`); тесты `tests/integration/bot/manualCreation.test.ts`, `tests/integration/bot/newTask.test.ts`, `tests/integration/ai/extractSingle.test.ts` (не `tests/unit/...` — см. шаг 1, пункт 11).

**Интерфейсы:**

- Produces:
  - `extractSingle(deps, { text: string; authorUserId: number; workspaceId: number; now: Date }): Promise<ResolvedAction & { kind: 'create' }>` — промпт `extractor.v1` + `extractor.single.v1`. Если действия нет или LLM недоступен, возвращает черновик с `title = первые 80 символов` (D19). Стоимость пишется как `analysis_batches` с `kind='manual'`;
  - `createManualProposal(deps, { workspaceId, chatId: number | null, action, origin: 'manual_group' | 'manual_dm' | 'forward', sourceMessageIds, quote, quoteAuthorName, createdByUserId })` — `category='manual'`, `policy_decision='shown'`, дальше обычный outbox (2.12).

- [x] **Шаг 1: падающие тесты** (не из списка D43 — реализовано напрямую; `extractSingle` всё же покрыто реальным тестом, см. ниже)
  1. `/task` ответом на сообщение в группе → карточка у owner с пометкой «вручную», на команду стоит реакция ✍, текстом в группу бот не отвечает.
  2. `/task купить бумагу` → карточка с этим текстом.
  3. `/task` от member → то же (предложение для owner).
  4. `/task` в `paused`-чате игнорируется. При `analysis_enabled=false` работает (D12).
  5. `/task` без текста и без ответа → игнорируется, пишется debug-лог.
  6. `/new` → шаги название → исполнитель → срок → приоритет → подтверждение → задача `origin='manual_dm'`.
  7. Свободный текст owner'а в DM (вне диалога) → черновик отправляется как обычная карточка предложения (`[✅ Создать] [✏️ Изменить] [❌ Не задача]`), рендерится сразу, а не ждёт тика outbox.
  8. Свободный текст от member → вежливый ответ, что бот работает только с руководителем, LLM не вызывается.
  9. Пересланные сообщения в DM в пределах `FORWARD_BURST_MS` (3 с) → один черновик `origin='forward'` с цитатой первого и автором из `forward_origin`; пауза ≥3 с → новый черновик (D18).
  10. Бюджет превышен → ручное создание всё равно работает (SPEC §9.2, D13): `extractSingle`/`createManualProposal` не проверяют `spentTodayUsd` вовсе.
  11. LLM недоступен → черновик с названием из первых 80 символов — покрыто `tests/integration/ai/extractSingle.test.ts` (не `tests/unit/...`: как и `processBatch.test.ts`, этот модуль пайплайна реально читает участников/владельца из БД — см. комментарий в начале файла).
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(tasks): add manual task creation from group, DM text and forwards`.

### Task 3.11: `/settings` и технические настройки в `/admin`

**Файлы:** создать `src/bot/handlers/settings.ts`, `src/bot/conversations/settings.ts`, `src/bot/views/settings.ts`, `src/time/parseRanges.ts`; тесты `tests/unit/time/parseRanges.test.ts`, `tests/integration/bot/settings.test.ts`.

**Интерфейсы:**

- Produces:
  - `parseDateRange(input: string, now: Date, zone: string): { from: string; to: string } | null`;
  - `parseTimeWindow(input: string): { from: string; to: string } | null`;
  - `parseAdminSetting(input: string): { path: string; value: unknown } | null` — формат `ключ значение`, например `ai.thresholds.low 0.3`.

- [x] **Шаг 1: падающие тесты**
  - `parseDateRange` (сейчас 2026-09-23):
    - `с 31.12 по 08.01` → `2026-12-31..2027-01-08`;
    - `31.12-08.01` → то же;
    - `с 01.11 по 03.11` → 2026;
    - `с 01.03 по 05.03` → 2027 (дата уже прошла);
    - `с 01.01.2027 по 10.01.2027` → явный год;
    - `32.12` → `null`.
    - Парсер извлекает даты регуляркой `\d{1,2}\.\d{1,2}(\.\d{4})?` и не зависит от слов «с/по», поэтому кириллица в коде не нужна.
  - `parseTimeWindow`: `22:00-08:00`, `22-8` → `22:00` и `08:00`; `25-8` → `null`.
  - Бот:
    1. Разделы: Сводка (вкл/выкл, время); Напоминания (время `preDue`, `allDayDue`, `overdue`, порог группировки); Тихие часы (вкл/выкл, дни недели кнопками, окно, диапазоны дат — добавить и удалить); Часовой пояс школы; Реакции (👀 вкл/выкл, ✍ при подтверждении); Текст уведомления в чате (изменить или сбросить).
    2. Некорректное время → понятная ошибка, настройки не изменились.
    3. `/admin → AI-настройки` (superadmin): `ai.thresholds.low 0.3` сохраняется, `ai.thresholds.low 2` отклоняется zod. `batch.*` — так же.
    4. Member → `forbidden`.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(settings): add /settings menus and admin AI/batch tuning`.
- [x] **Шаг 6: чистка по D40.**
  1. Убрать `summary.forMembers` и `reminders.notifyAssignees` из `SettingsSchema`, поправить тест defaults из Task 1.1. Сохранённые настройки с этими полями должны читаться без ошибок (лишние ключи отбрасываются).
  2. Миграция: удалить `memberships.notify_assignments`, `tasks.review_pending`, `tasks.review_requested_by`, `tasks.review_requested_at`.
  3. `pnpm lint && pnpm typecheck && pnpm test` — зелёные.
  4. Коммит и push: `refactor(settings): drop member-notification settings and review columns (D40)`.

### Task 3.12: Удаление персональных данных (SPEC §19.3.3)

**Файлы:** создать `src/domain/people/erase.ts`, `src/domain/workspaces/erase.ts`; изменить `src/bot/handlers/people.ts`, `src/bot/handlers/admin.ts`; тест `tests/integration/domain/erase.test.ts`.

**Интерфейсы:**

- Produces:
  - `eraseMember(deps, { workspaceId, userId, actor }): Promise<{ messages: number; tasksAnonymized: number; userDeleted: boolean }>`;
  - `eraseWorkspace(deps, { workspaceId, actor }): Promise<void>` — только superadmin, бот также покидает все чаты workspace.

- [x] **Шаг 1: падающие тесты**
  1. `eraseMember(Мария)`:
     - её сообщения удалены;
     - в задачах, где она исполнитель, `assignee_user_id=null`, `assignee_name_text` берётся из `texts.erase.anonymous` («[удалено]»);
     - `source_quote` задач из её сообщений очищен;
     - `actor_user_id` в `task_events` и `decided_by` в proposals очищены;
     - её ID убраны из `source_message_ids`;
     - membership удалён; user удалён, если у него нет других workspace и он не superadmin.
  2. Owner не может удалить себя (сначала `/transfer`).
  3. Нужно двойное подтверждение.
  4. `eraseWorkspace` → в БД нет строк этого workspace, `leaveChat` вызван для каждого активного чата.
- [x] **Шаг 2:** FAIL. **Шаг 3:** реализация. **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(privacy): add per-member and per-workspace data erasure`.

### Task 3.13: `pnpm feedback-report` (SPEC §20.4)

**Файлы:** создать `src/domain/proposals/feedback.ts`, `scripts/feedback-report.ts`; тест `tests/integration/domain/feedback.test.ts`.

**Интерфейсы:** Produces `feedbackStats(db, { since: Date; withText: boolean }): Promise<{ byCategory: Record<string, { shown: number; accepted: number; rejected: number }>; rejectReasons: Record<string, number>; editedFields: Record<string, number>; confidenceBuckets: Array<{ from: number; to: number; accepted: number; rejected: number }>; samples?: Array<{ title: string; quote: string | null; decision: string }> }>`.

- [x] **Шаг 1: падающий тест.**
  - Засеянные решения дают правильные частоты.
  - Без `withText` в результате нет строк с текстом: проверяется, что в `JSON.stringify` нет названий задач.
- [x] **Шаг 2:** FAIL. **Шаг 3: реализация.** Вывод — Markdown в stdout. Флаг `--with-text` печатает предупреждение «только для локального разбора».
- [x] **Шаг 4:** PASS.
- [x] **Шаг 5: коммит и push:** `feat(eval): add feedback report from owner decisions`.

### Task 3.14: Сквозной сценарий, меню команд, закрытие фазы

**Файлы:** создать `tests/integration/e2e/taskLifecycle.test.ts`; изменить `src/bot/commands.ts`, `src/bot/views/help.ts`.

- [x] **Шаг 1: сквозной тест** (bot harness, `fixedClock`, FixtureClient; каждый шаг — `clock.set(...)` и `ticker.tickOnce()`):
  1. Среда, 12:00 МСК. Сообщение в группе «Маша, подготовь расписание к пятнице 18:00» → через 3 мин тик → карточка у owner → «✅ Создать».
  2. Мария (DM начат) **ничего не получает** — ни о назначении, ни напоминаний (D40).
  3. Четверг, 10:00 МСК → `pre_due` у owner.
  4. Owner → «⏰ +1 час» → в 11:00 snooze-напоминание.
  5. Пятница, 18:00 → `due` у owner.
  6. Мария пишет в группе «сделала» ответом на поручение → owner получает предложение закрыть задачу.
  7. Owner → «✅ Закрыть задачу» → задача `done`, запланированный `overdue` отменён. В субботу в 10:00 по этой задаче ничего не отправлено. Задача видна в `/archive`.
  8. Owner в поясе Asia/Yekaterinburg: сводка в 09:00 местного времени (`04:00Z`), в `03:59Z` её ещё нет.
- [x] **Шаг 2:** прогнать, исправить найденное. PASS.
- [x] **Шаг 3:** финальные `setMyCommands` для всех scope (SPEC §12.2, без `/my`, D40) и `/help` по ролям.
- [x] **Шаг 4: коммит и push:** `test(e2e): cover task lifecycle acceptance scenario`.
- [x] **Шаг 5: закрытие фазы.**
  1. `pnpm coverage` показывает не меньше 80% по `domain` и `ai/pipeline` (2026-10-03 на `246ea03`: 888 тестов, statements 92.35%, branches 83.33%, functions 98.77%, lines 96.59% по `coverage.include` D43).
  2. `docs/` и `CHANGELOG.md` обновлены.
  3. RC `v0.4.0-rc.1` → dev (👤 ручная проверка сценария в тестовой группе) — выявила D47 → Task 3.15 → RC `v0.4.0-rc.2` → dev → 👤 повторная проверка.
  4. PR `Phase 3: tasks, reminders and assignees` → 👤 → merge → тег `v0.4.0`. Выполнено 2026-10-03: PR #8 смержен (`246ea03`), тег `v0.4.0`. 👤 Пункты 1–3 повторной проверки на `rc.2` пройдены; сквозной сценарий напоминаний (п. 4) пользователь проверит позже на dev.

### Task 3.15: Новое поручение vs перенос существующей задачи (D47, приёмка v0.4.0-rc.1)

**TDD (критичная задача: `ai/pipeline`, `domain/proposals`), ревью — Opus.** Файлы (ориентир): `prompts/extractor.v3.md` (копия v2 + правила D47; `prompt_version` → `extractor.v3`), `prompts/examples.school_ru.json` (синтетические примеры), `src/ai/schemas.ts`, `src/ai/pipeline/resolve.ts` и/или `processBatch.ts`, `src/ai/pipeline/dedup.ts`, `src/domain/proposals/decide.ts`, `src/bot/views/proposalCard.ts`, `src/bot/handlers/proposalCallbacks.ts`, `src/bot/keyboards/callbackCodec.ts`, `src/bot/texts/ru.ts`.

- [x] **Шаг 1: падающие тесты.**
  1. Пайплайн (fixtures): `update` на T# с исполнителем-человеком (user или text «Маша»), `changes.assignee` = другой человек, `explicit_transfer=false` → в БД предложение `kind='create'` (название = `new_task_title`, иначе название цели; исполнитель и срок — из `changes`, срок — из `changes.due`, иначе без срока), целевая задача не упоминается; dedup **не** отклоняет его как дубль той самой целевой задачи.
  2. То же с `explicit_transfer=true` → `kind='update'` со сменой исполнителя (как сейчас).
  3. Тот же исполнитель + новый срок, либо цель с исполнителем `all`/без исполнителя → остаётся `update`; `payload.newTaskTitle` сохранён.
  4. Карточка AI-`update` содержит кнопку «➕ Создать новой задачей» (`callback_data` через `callbackCodec`, ≤ 64 байт).
  5. Нажатие (`asNew`): атомарно (`UPDATE … WHERE status='pending' RETURNING`) предложение `accepted`, создана **новая** задача (название `newTaskTitle` ?? название цели; исполнитель `changes.assignee` ?? исполнитель цели; срок `changes.due` ?? нет; цитата/источник — из предложения), целевая задача и её напоминания не изменены; повторное нажатие — no-op; права проверяются по БД. Цель-предложение (`payload.targetProposalId`, D44) — тоже поддержано (название из `newTaskTitle` ?? payload цели).
- [x] **Шаг 2: реализация.** Схема: в `update` (local + wire) поля `explicit_transfer: boolean` и `new_task_title: string(3..120) | null` (wire — обязательные, nullable/boolean; local — с дефолтами, старые fixtures без полей остаются валидными). Промпт v3: правила D47 (1)–(3) + примеры. Реальные вызовы LLM/eval не запускать.
- [x] **Шаг 3:** `pnpm format && pnpm lint && pnpm typecheck && pnpm test` зелёные; CHANGELOG (Phase 3, Unreleased) дополнен.
- [x] **Шаг 4: коммит и push** в `phase-3-tasks` (PR #8 обновится сам).
