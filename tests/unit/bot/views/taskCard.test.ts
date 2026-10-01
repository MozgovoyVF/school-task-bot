import { describe, it, expect } from 'vitest';
import { renderTaskCard, type TaskCardView } from '../../../../src/bot/views/taskCard.js';
import { texts } from '../../../../src/bot/texts/ru.js';

function baseView(overrides: Partial<TaskCardView> = {}): TaskCardView {
  return {
    id: 12,
    title: 'Подготовить расписание на октябрь',
    description: null,
    status: 'open',
    priority: 'normal',
    assigneeName: 'Мария',
    due: { at: new Date('2026-10-03T15:00:00Z'), allDay: false, tz: 'Europe/Moscow' },
    quote: null,
    chatTitle: null,
    link: null,
    ...overrides,
  };
}

function buttonTexts(view: TaskCardView): string[] {
  return renderTaskCard(view, 'Europe/Moscow')
    .buttons.flat()
    .map((b) => b.text);
}

describe('renderTaskCard', () => {
  it('shows an open task\'s full management row set, including the "В работу" shortcut', () => {
    const rendered = renderTaskCard(baseView(), 'Europe/Moscow');

    expect(rendered.text).toContain('📌 T12 · Подготовить расписание на октябрь');
    expect(rendered.text).toContain('Статус: открыта · Приоритет: обычный');
    expect(buttonTexts(baseView())).toEqual([
      texts.taskCard.doneButton,
      texts.taskCard.startButton,
      texts.taskCard.editButton,
      texts.taskCard.snoozeButton,
      texts.taskCard.cancelButton,
      texts.taskCard.historyButton,
    ]);
  });

  it('hides the "В работу" shortcut once a task is already in_progress', () => {
    expect(buttonTexts(baseView({ status: 'in_progress' }))).toEqual([
      texts.taskCard.doneButton,
      texts.taskCard.editButton,
      texts.taskCard.snoozeButton,
      texts.taskCard.cancelButton,
      texts.taskCard.historyButton,
    ]);
  });

  it('shows only restore/delete-forever (plus history) for an archived (done/cancelled) task', () => {
    expect(buttonTexts(baseView({ status: 'done' }))).toEqual([
      texts.taskCard.restoreButton,
      texts.taskCard.deleteForeverButton,
      texts.taskCard.historyButton,
    ]);
    expect(buttonTexts(baseView({ status: 'cancelled' }))).toEqual([
      texts.taskCard.restoreButton,
      texts.taskCard.deleteForeverButton,
      texts.taskCard.historyButton,
    ]);
  });

  it('renders the description/quote/link lines only when present, escaping HTML-sensitive characters', () => {
    const rendered = renderTaskCard(
      baseView({
        description: 'Проверить <список> преподавателей',
        quote: 'Маша, подготовь к пятнице',
        chatTitle: 'Преподаватели',
        link: 'https://t.me/c/123/45',
      }),
      'Europe/Moscow',
    );

    expect(rendered.text).toContain('📝 Проверить &lt;список&gt; преподавателей');
    expect(rendered.text).toContain('💬 «Маша, подготовь к пятнице» — «Преподаватели»');
    expect(rendered.text).toContain('🔗 <a href="https://t.me/c/123/45">Открыть сообщение</a>');
  });

  it('omits the description/quote/link lines when absent', () => {
    const rendered = renderTaskCard(baseView(), 'Europe/Moscow');
    expect(rendered.text).not.toContain('📝');
    expect(rendered.text).not.toContain('💬');
    expect(rendered.text).not.toContain('🔗');
  });
});
