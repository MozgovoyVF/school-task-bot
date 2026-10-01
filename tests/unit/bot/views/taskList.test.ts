import { describe, it, expect } from 'vitest';
import { renderTaskList, rowMarker } from '../../../../src/bot/views/taskList.js';
import type { ListTasksResult, TaskListItem } from '../../../../src/domain/tasks/queries.js';
import { texts } from '../../../../src/bot/texts/ru.js';

const ZONE = 'Europe/Moscow';
const NOW = new Date('2026-09-26T10:00:00Z'); // Saturday, 13:00 MSK

function baseItem(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: 12,
    title: 'Подготовить расписание',
    assigneeName: 'Мария',
    dueAt: null,
    dueAllDay: false,
    dueTz: null,
    status: 'open',
    ...overrides,
  };
}

describe('rowMarker', () => {
  it('is 🔴 once a datetime due date is in the past, regardless of status', () => {
    const item = baseItem({ dueAt: new Date('2026-09-25T15:00:00Z'), dueTz: ZONE, status: 'in_progress' });
    expect(rowMarker(item, NOW, ZONE)).toBe('🔴');
  });

  it('is 🔵 for in_progress once it is not overdue', () => {
    const item = baseItem({ dueAt: new Date('2026-09-30T10:00:00Z'), dueTz: ZONE, status: 'in_progress' });
    expect(rowMarker(item, NOW, ZONE)).toBe('🔵');
  });

  it("is 🟡 once the due date falls today in the recipient's own zone", () => {
    const item = baseItem({ dueAt: new Date('2026-09-26T15:00:00Z'), dueTz: ZONE, status: 'open' });
    expect(rowMarker(item, NOW, ZONE)).toBe('🟡');
  });

  it('is ⚪ once the due date is later than today, or there is none at all', () => {
    expect(rowMarker(baseItem({ dueAt: new Date('2026-10-01T10:00:00Z'), dueTz: ZONE }), NOW, ZONE)).toBe(
      '⚪',
    );
    expect(rowMarker(baseItem({ dueAt: null }), NOW, ZONE)).toBe('⚪');
  });

  it('an all-day due date of today is not overdue, even once its own midnight instant has already passed', () => {
    // 2026-09-26T00:00:00Z is 03:00 MSK — already well in the past relative to NOW (13:00 MSK) — but an
    // all-day due only ever reads its own calendar date, never a time of day (D24).
    const item = baseItem({
      dueAt: new Date('2026-09-26T00:00:00Z'),
      dueAllDay: true,
      dueTz: null,
      status: 'open',
    });
    expect(rowMarker(item, NOW, ZONE)).toBe('🟡');
  });
});

function render(items: TaskListItem[], opts: { page: number; pages: number; total?: number }) {
  const r: ListTasksResult = { items, total: opts.total ?? items.length, pages: opts.pages };
  return renderTaskList(r, { filter: { kind: 'open' }, page: opts.page, zone: ZONE, now: NOW });
}

describe('renderTaskList', () => {
  it("renders the brief's own row sample verbatim", () => {
    const item = baseItem({
      id: 12,
      title: 'Подготовить расписание',
      assigneeName: 'Мария',
      dueAt: new Date('2026-09-25T15:00:00Z'),
      dueAllDay: false,
      dueTz: ZONE,
      status: 'open',
    });
    const rendered = render([item], { page: 1, pages: 1 });
    expect(rendered.text).toContain('🔴 T12 Подготовить расписание — Мария · пт, 25 сен');
  });

  it('shows a "стр 1/3" footer for a 12-task, 5-per-page list', () => {
    const items = [baseItem({ id: 1 }), baseItem({ id: 2 })];
    const rendered = render(items, { page: 1, pages: 3, total: 12 });
    expect(rendered.text).toContain('стр 1/3');
  });

  it('hides "◀️" on the first page and "▶️" on the last page', () => {
    const items = [baseItem({ id: 1 })];

    const first = render(items, { page: 1, pages: 3, total: 12 });
    const firstButtons = first.buttons.flat().map((b) => b.text);
    expect(firstButtons).not.toContain(texts.taskList.prevButton);
    expect(firstButtons).toContain(texts.taskList.nextButton);

    const last = render(items, { page: 3, pages: 3, total: 12 });
    const lastButtons = last.buttons.flat().map((b) => b.text);
    expect(lastButtons).toContain(texts.taskList.prevButton);
    expect(lastButtons).not.toContain(texts.taskList.nextButton);

    const middle = render(items, { page: 2, pages: 3, total: 12 });
    const middleButtons = middle.buttons.flat().map((b) => b.text);
    expect(middleButtons).toContain(texts.taskList.prevButton);
    expect(middleButtons).toContain(texts.taskList.nextButton);
  });

  it('shows the empty-filter text and no row/pagination buttons when nothing matches', () => {
    const rendered = render([], { page: 1, pages: 1, total: 0 });
    expect(rendered.text).toContain(texts.taskList.empty);
    expect(rendered.buttons.flat().map((b) => b.text)).not.toContain(texts.taskList.prevButton);
  });
});
