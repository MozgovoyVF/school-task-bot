import { describe, it, expect } from 'vitest';
import { renderReminder, renderOverdueDigest } from '../../../../src/bot/views/reminder.js';
import type { TaskListItem } from '../../../../src/domain/tasks/queries.js';
import { TELEGRAM_TEXT_LIMIT } from '../../../../src/config/constants.js';

const task: TaskListItem = {
  id: 12,
  title: 'Купить краски',
  assigneeName: 'Мария',
  dueAt: new Date('2026-09-25T15:00:00Z'),
  dueAllDay: false,
  dueTz: 'Europe/Moscow',
  status: 'open',
};

const BUTTON_ROW = [
  { text: '✅ Готово', data: 'v1:n:done:12' },
  { text: '⏰ +1 час', data: 'v1:n:hour:12' },
  { text: '📅 Завтра', data: 'v1:n:tmrw:12' },
  { text: '🕐 Выбрать время', data: 'v1:n:pick:12' },
];

describe('renderReminder (SPEC §13.2/§13.3)', () => {
  it('renders a pre_due reminder', () => {
    const { text, buttons } = renderReminder({ kind: 'pre_due', task, viewerZone: 'Europe/Moscow' });
    expect(text).toBe('⏳ Завтра срок\n📌 Купить краски\n👤 Мария · 📅 пт, 25 сен, 18:00');
    expect(buttons).toEqual([BUTTON_ROW]);
  });

  it('renders a due reminder', () => {
    const { text } = renderReminder({ kind: 'due', task, viewerZone: 'Europe/Moscow' });
    expect(text.split('\n')[0]).toBe('🔔 Срок сегодня');
  });

  it('renders an overdue reminder', () => {
    const { text } = renderReminder({ kind: 'overdue', task, viewerZone: 'Europe/Moscow' });
    expect(text.split('\n')[0]).toBe('🔴 Просрочено');
  });

  it('renders a snooze reminder', () => {
    const { text } = renderReminder({ kind: 'snooze', task, viewerZone: 'Europe/Moscow' });
    expect(text.split('\n')[0]).toBe('🔔 Напоминание');
  });

  it("shows the viewer zone when it differs from the due date's own zone (D29)", () => {
    const { text } = renderReminder({ kind: 'due', task, viewerZone: 'Asia/Yekaterinburg' });
    expect(text).toContain('📅 пт, 25 сен, 20:00 (МСК+2)');
  });

  it('escapes HTML in the title and assignee name', () => {
    const { text } = renderReminder({
      kind: 'due',
      task: { ...task, title: 'A <b> & B', assigneeName: '<script>' },
      viewerZone: 'Europe/Moscow',
    });
    expect(text).toContain('📌 A &lt;b&gt; &amp; B');
    expect(text).toContain('👤 &lt;script&gt;');
  });

  it('shows the "not assigned" placeholder for a null assigneeName', () => {
    const { text } = renderReminder({
      kind: 'due',
      task: { ...task, assigneeName: null },
      viewerZone: 'Europe/Moscow',
    });
    expect(text).toContain('👤 Не назначен');
  });

  it('shows "без срока" for a task with no due date', () => {
    const { text } = renderReminder({
      kind: 'due',
      task: { ...task, dueAt: null, dueAllDay: false, dueTz: null },
      viewerZone: 'Europe/Moscow',
    });
    expect(text).toContain('📅 без срока');
  });

  it('every button targets the task id, not a notification row id', () => {
    const { buttons } = renderReminder({
      kind: 'overdue',
      task: { ...task, id: 99 },
      viewerZone: 'Europe/Moscow',
    });
    expect(buttons).toEqual([
      [
        { text: '✅ Готово', data: 'v1:n:done:99' },
        { text: '⏰ +1 час', data: 'v1:n:hour:99' },
        { text: '📅 Завтра', data: 'v1:n:tmrw:99' },
        { text: '🕐 Выбрать время', data: 'v1:n:pick:99' },
      ],
    ]);
  });
});

describe('renderOverdueDigest (SPEC §13.2 — grouped overdue)', () => {
  const second: TaskListItem = {
    id: 15,
    title: 'Отчёт',
    assigneeName: null,
    dueAt: new Date('2026-09-24T07:00:00Z'),
    dueAllDay: true,
    dueTz: 'Europe/Moscow',
    status: 'open',
  };

  it('renders one header line plus one line per task, with no buttons', () => {
    const { text, buttons } = renderOverdueDigest([task, second], 'Europe/Moscow');
    expect(text).toBe(
      '🔴 Просрочено (2):\n' + '• T12 «Купить краски» — пт, 25 сен, 18:00\n' + '• T15 «Отчёт» — чт, 24 сен',
    );
    expect(buttons).toEqual([]);
  });

  it('escapes HTML in each task title', () => {
    const { text } = renderOverdueDigest([{ ...task, title: 'A <b> B' }], 'Europe/Moscow');
    expect(text).toContain('«A &lt;b&gt; B»');
  });

  it('caps the list before crossing the 4096-char limit, appending an overflow footer (review round 1, I4)', () => {
    const items: TaskListItem[] = Array.from({ length: 60 }, (_, i) => ({
      ...task,
      id: i + 1,
      title: 'А'.repeat(120),
    }));

    const { text } = renderOverdueDigest(items, 'Europe/Moscow');

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // The header still reports the true total, even though the body was cut short.
    expect(text).toContain('🔴 Просрочено (60):');
    expect(text).toMatch(/… ещё \d+ → \/tasks$/);
  });

  it('does not add an overflow footer when every row already fits', () => {
    const { text } = renderOverdueDigest([task, second], 'Europe/Moscow');
    expect(text).not.toContain('→ /tasks');
  });
});
