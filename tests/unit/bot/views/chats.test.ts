import { describe, it, expect } from 'vitest';
import { renderChatList, renderChatCard, renderLeaveConfirm } from '../../../../src/bot/views/chats.js';
import type { ChatRow } from '../../../../src/domain/chats/repo.js';
import type { Buttons } from '../../../../src/domain/messenger.js';

function makeChat(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    id: 1,
    tgChatId: -1001,
    workspaceId: 1,
    title: 'Учителя французского',
    type: 'supergroup',
    status: 'active',
    analysisEnabled: true,
    reactionsEnabled: true,
    addedByUserId: null,
    noticeSentAt: null,
    pendingSince: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

/** Every `data` in `buttons` must fit Telegram's 64-byte `callback_data` limit (CLAUDE.md §8). */
function assertButtonDataFitsWireLimit(buttons: Buttons): void {
  for (const row of buttons) {
    for (const button of row) {
      if (button.data === undefined) continue;
      expect(Buffer.byteLength(button.data, 'utf8')).toBeLessThanOrEqual(64);
    }
  }
}

describe('renderChatList', () => {
  it('lists every status label (SPEC §15) and a button per chat', () => {
    const chats = [
      makeChat({ id: 1, title: 'Активный чат', status: 'active' }),
      makeChat({ id: 2, title: 'На паузе', status: 'paused' }),
      makeChat({ id: 3, title: 'Ждёт решения', status: 'pending' }),
      makeChat({ id: 4, title: 'Покинутый', status: 'left' }),
    ];

    const view = renderChatList(chats);

    expect(view.text).toBe(
      [
        '💬 Чаты',
        '',
        '🟢 активен — Активный чат',
        '⏸ пауза — На паузе',
        '⏳ ждёт разрешения — Ждёт решения',
        '🚪 покинут — Покинутый',
      ].join('\n'),
    );
    expect(view.buttons).toHaveLength(4);
    assertButtonDataFitsWireLimit(view.buttons);
  });

  it('falls back to the untitled-chat label when a chat has no title', () => {
    const view = renderChatList([makeChat({ title: null })]);
    expect(view.text).toContain('без названия');
  });

  it('shows an empty-state text with no buttons when the bot is in no chats', () => {
    const view = renderChatList([]);
    expect(view.text).toBe('Бот пока не состоит ни в одном чате.');
    expect(view.buttons).toEqual([]);
  });
});

describe('renderChatCard', () => {
  it('an active chat gets the full management keyboard (Task 1.9 brief)', () => {
    const view = renderChatCard(
      makeChat({ id: 7, status: 'active', analysisEnabled: true, reactionsEnabled: true }),
    );

    expect(view.text).toContain('Статус: 🟢 активен');
    expect(view.buttons.map((row) => row.map((b) => b.text))).toEqual([
      ['Анализ: вкл', 'Реакции: вкл'],
      ['⏸ Пауза'],
      ['🚪 Покинуть'],
      ['◀️ Назад'],
    ]);
    assertButtonDataFitsWireLimit(view.buttons);
  });

  it('reflects analysis/reactions off in the button labels', () => {
    const view = renderChatCard(makeChat({ analysisEnabled: false, reactionsEnabled: false }));
    expect(view.buttons[0]?.map((b) => b.text)).toEqual(['Анализ: выкл', 'Реакции: выкл']);
  });

  it('a paused chat offers "Возобновить" instead of "Пауза"', () => {
    const view = renderChatCard(makeChat({ status: 'paused' }));
    expect(view.buttons[1]).toEqual([expect.objectContaining({ text: '▶️ Возобновить' })]);
  });

  it('a pending chat has no manage buttons, only back', () => {
    const view = renderChatCard(makeChat({ status: 'pending' }));
    expect(view.text).toContain('ждёт разрешения');
    expect(view.buttons).toEqual([[expect.objectContaining({ text: '◀️ Назад' })]]);
  });

  it('a left chat has no manage buttons, only back', () => {
    const view = renderChatCard(makeChat({ status: 'left' }));
    expect(view.text).toContain('покинут');
    expect(view.buttons).toEqual([[expect.objectContaining({ text: '◀️ Назад' })]]);
  });
});

describe('renderLeaveConfirm', () => {
  it("asks for confirmation with the chat title, per the brief's exact wording", () => {
    const view = renderLeaveConfirm(makeChat({ id: 3, title: 'Учителя французского' }));
    expect(view.text).toBe('Точно покинуть „Учителя французского“?');
    expect(view.buttons.map((row) => row.map((b) => b.text))).toEqual([['✅ Да, покинуть', '❌ Отмена']]);
    assertButtonDataFitsWireLimit(view.buttons);
  });
});
