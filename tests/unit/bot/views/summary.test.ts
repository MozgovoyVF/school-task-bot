import { describe, it, expect } from 'vitest';
import { renderSummary } from '../../../../src/bot/views/summary.js';
import type { SummarySections, TaskListItem } from '../../../../src/domain/tasks/queries.js';
import { TELEGRAM_TEXT_LIMIT } from '../../../../src/config/constants.js';

function task(overrides: Partial<TaskListItem> & { id: number }): TaskListItem {
  return {
    title: 'Купить краски',
    assigneeName: 'Мария',
    dueAt: new Date('2026-09-25T15:00:00Z'),
    dueAllDay: false,
    dueTz: 'Europe/Moscow',
    status: 'open',
    ...overrides,
  };
}

const EMPTY: SummarySections = { overdue: [], today: [], inboxCount: 0, noDue: [], noDueTotal: 0 };

const DATE = new Date('2026-09-25T04:00:00Z'); // Fri 25 Sep in Europe/Moscow

describe('renderSummary (SPEC §13.4, plan.md Task 3.5)', () => {
  it('renders the header with the Russian weekday/date label', () => {
    const { text } = renderSummary(EMPTY, { date: DATE, zone: 'Europe/Moscow' });
    expect(text.split('\n')[0]).toBe('☀️ Доброе утро! Сводка на пт, 25 сен');
  });

  it('shows "Задач на сегодня нет 🎉" when every section is empty', () => {
    const { text } = renderSummary(EMPTY, { date: DATE, zone: 'Europe/Moscow' });
    expect(text).toBe('☀️ Доброе утро! Сводка на пт, 25 сен\nЗадач на сегодня нет 🎉');
  });

  it('renders sections in SPEC §13.4 order, with no "awaiting review" section (D40)', () => {
    const s: SummarySections = {
      overdue: [task({ id: 1 })],
      today: [task({ id: 2 })],
      inboxCount: 4,
      noDue: [task({ id: 3, dueAt: null, dueAllDay: false, dueTz: null })],
      noDueTotal: 1,
    };
    const { text } = renderSummary(s, { date: DATE, zone: 'Europe/Moscow' });
    const lines = text.split('\n');

    expect(lines[0]).toBe('☀️ Доброе утро! Сводка на пт, 25 сен');
    expect(lines[1]).toBe('🔴 Просрочено (1):');
    expect(lines[2]).toContain('T1');
    expect(lines[3]).toBe('🟡 Сегодня (1):');
    expect(lines[4]).toContain('T2');
    expect(lines[5]).toBe('📥 Неразобранные предложения: 4 → /inbox');
    expect(lines[6]).toBe('⚪ Без срока (1):');
    expect(lines[7]).toBe('• T3 «Купить краски»');
    expect(text).not.toContain('Ждут вашей проверки');
  });

  it('omits empty sections entirely', () => {
    const s: SummarySections = { ...EMPTY, today: [task({ id: 1 })] };
    const { text } = renderSummary(s, { date: DATE, zone: 'Europe/Moscow' });
    expect(text).not.toContain('Просрочено');
    expect(text).not.toContain('Неразобранные');
    expect(text).not.toContain('Без срока');
    expect(text).toContain('🟡 Сегодня (1):');
  });

  it("shows the no-due section's top-5-oldest with an overflow footer (SPEC §13.4)", () => {
    const noDue = Array.from({ length: 5 }, (_, i) =>
      task({ id: i + 1, dueAt: null, dueAllDay: false, dueTz: null }),
    );
    const s: SummarySections = { ...EMPTY, noDue, noDueTotal: 7 };
    const { text } = renderSummary(s, { date: DATE, zone: 'Europe/Moscow' });

    expect(text).toContain('⚪ Без срока (7):');
    for (let i = 1; i <= 5; i++) expect(text).toContain(`T${String(i)}`);
    expect(text).toContain('… ещё 2 → /tasks');
  });

  it('shows the fixed [📋 Все задачи] [📥 Разобрать] button row', () => {
    const { buttons } = renderSummary(EMPTY, { date: DATE, zone: 'Europe/Moscow' });
    expect(buttons).toEqual([
      [
        { text: '📋 Все задачи', data: 'v1:l:all:0' },
        { text: '📥 Разобрать', data: 'v1:p:nbx:0' },
      ],
    ]);
  });

  it('keeps the text at or under 4096 chars with 200 overdue tasks, truncating with "ещё N"', () => {
    const overdue = Array.from({ length: 200 }, (_, i) => task({ id: i + 1, title: 'А'.repeat(120) }));
    const s: SummarySections = { ...EMPTY, overdue };
    const { text } = renderSummary(s, { date: DATE, zone: 'Europe/Moscow' });

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text).toContain('🔴 Просрочено (200):');
    expect(text).toMatch(/… ещё \d+ → \/tasks/);
  });

  it('keeps the text at or under 4096 chars with 200 tasks split between overdue and today', () => {
    const overdue = Array.from({ length: 100 }, (_, i) => task({ id: i + 1, title: 'Б'.repeat(120) }));
    const today = Array.from({ length: 100 }, (_, i) => task({ id: i + 1000, title: 'В'.repeat(120) }));
    const s: SummarySections = { ...EMPTY, overdue, today };
    const { text } = renderSummary(s, { date: DATE, zone: 'Europe/Moscow' });

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text).toContain('🔴 Просрочено (100):');
    expect(text).toContain('🟡 Сегодня (100):');
  });

  it('escapes HTML in task titles', () => {
    const s: SummarySections = { ...EMPTY, today: [task({ id: 1, title: 'A <b> & B' })] };
    const { text } = renderSummary(s, { date: DATE, zone: 'Europe/Moscow' });
    expect(text).toContain('A &lt;b&gt; &amp; B');
  });
});
