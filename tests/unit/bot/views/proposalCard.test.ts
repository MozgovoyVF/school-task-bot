import { describe, it, expect } from 'vitest';
import { renderProposalCard } from '../../../../src/bot/views/proposalCard.js';
import { messageLink } from '../../../../src/bot/views/links.js';

const base = {
  id: 7,
  kind: 'create' as const,
  category: 'assignment' as const,
  confidence: 0.87,
  manual: false,
  title: 'Подготовить расписание на октябрь',
  assigneeName: 'Мария',
  assigneeKind: 'user' as const,
  due: { at: new Date('2026-09-25T15:00:00Z'), allDay: false, tz: 'Europe/Moscow' },
  priority: 'normal' as const,
  quote: 'Маша, подготовь расписание к пятнице',
  quoteAuthor: 'Анна',
  chatTitle: 'Преподаватели',
  link: 'https://t.me/c/1234567890/42',
  dueInPast: false,
  duplicateOf: null,
  target: null,
};

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

  it('escapes HTML and truncates the quote to 200 chars before escaping', () => {
    const t = renderProposalCard(
      { ...base, title: 'A <b> & B', quote: '<x>'.repeat(100) },
      'Europe/Moscow',
    ).text;
    expect(t).toContain('A &lt;b&gt; &amp; B');
    expect(t).not.toContain('<x>');
    // '<x>'.repeat(100) is 400 raw chars; truncated to 200 before escaping
    // leaves room for at most 66 full "<x>" -> "&lt;x&gt;" repeats (66*3=198).
    expect(t).not.toContain('&lt;x&gt;'.repeat(67));
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

  it('omits the quote/link lines when there is no source message', () => {
    const t = renderProposalCard(
      { ...base, quote: null, quoteAuthor: null, chatTitle: null, link: null },
      'Europe/Moscow',
    );
    expect(t.text).not.toContain('💬');
    expect(t.text).not.toContain('🔗');
  });

  it('shows kind-specific labels for none/all assignees', () => {
    const none = renderProposalCard({ ...base, assigneeName: null, assigneeKind: 'none' }, 'Europe/Moscow');
    expect(none.text).toContain('👤 Не назначен');
    const all = renderProposalCard({ ...base, assigneeName: null, assigneeKind: 'all' }, 'Europe/Moscow');
    expect(all.text).toContain('👤 Всем');
  });

  it('shows "без срока" when there is no due date', () => {
    const t = renderProposalCard({ ...base, due: null }, 'Europe/Moscow');
    expect(t.text).toContain('📅 без срока');
  });

  it('keeps every card within Telegram limits', () => {
    const t = renderProposalCard(
      { ...base, title: 'я'.repeat(120), quote: 'ж'.repeat(5000) },
      'Europe/Moscow',
    );
    expect(t.text.length).toBeLessThanOrEqual(4096);
    for (const b of t.buttons.flat()) {
      if (b.data !== undefined) expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64);
    }
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
