import type { Buttons } from '../../domain/messenger.js';
import type { ChatRow } from '../../domain/chats/repo.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';

export interface ChatsView {
  text: string;
  buttons: Buttons;
}

/** `ChatRow.status` → its `/chats` display label (SPEC §15's four `chat_status` values). */
const STATUS_LABEL: Record<ChatRow['status'], string> = {
  active: texts.chats.statusActive,
  paused: texts.chats.statusPaused,
  pending: texts.chats.statusPending,
  left: texts.chats.statusLeft,
};

function backButtonRow(): Buttons[number] {
  return [{ text: texts.chats.backButton, data: encodeCallback({ entity: 'c', action: 'lst', id: 0 }) }];
}

/**
 * Pure render for `/chats`' list (Task 1.9): a text line per chat with its
 * status label, plus one button per chat (`v1:c:opn:<id>`) that opens
 * {@link renderChatCard} for it. No DB, no I/O (CLAUDE.md §7) — the caller
 * (`bot/handlers/chats.ts`) supplies the already-fetched rows.
 */
export function renderChatList(chats: ChatRow[]): ChatsView {
  if (chats.length === 0) {
    return { text: texts.chats.listEmpty, buttons: [] };
  }

  const lines = [
    texts.chats.listHeader,
    '',
    ...chats.map((chat) =>
      texts.chats.listLine(chat.title ?? texts.chats.untitledChat, STATUS_LABEL[chat.status]),
    ),
  ];
  const buttons: Buttons = chats.map((chat) => [
    {
      text: `${STATUS_LABEL[chat.status]} — ${chat.title ?? texts.chats.untitledChat}`,
      data: encodeCallback({ entity: 'c', action: 'opn', id: chat.id }),
    },
  ]);

  return { text: lines.join('\n'), buttons };
}

/**
 * Pure render for a single chat's `/chats` management card (Task 1.9).
 * `active`/`paused` chats get the full button set — analysis/reactions
 * toggles (`v1:c:ana`/`v1:c:rea`), the pause/resume flip (`v1:c:pau`/
 * `v1:c:res`, whichever applies to the chat's current status) and the leave
 * button (`v1:c:lva`, which asks for confirmation — {@link renderLeaveConfirm}
 * — before `leaveChat` actually runs). `pending`/`left` chats have nothing
 * to manage here (a `pending` chat is decided from its own approval card,
 * Task 1.6; a `left` chat has no bot in it any more), so they only get the
 * back button.
 */
export function renderChatCard(chat: ChatRow): ChatsView {
  const title = chat.title ?? texts.chats.untitledChat;
  const lines = [texts.chats.cardTitle(title), texts.chats.cardStatusLine(STATUS_LABEL[chat.status])];

  if (chat.status === 'pending') {
    return { text: [...lines, '', texts.chats.pendingCardHint].join('\n'), buttons: [backButtonRow()] };
  }
  if (chat.status === 'left') {
    return { text: [...lines, '', texts.chats.leftCardHint].join('\n'), buttons: [backButtonRow()] };
  }

  const pauseOrResumeButton =
    chat.status === 'paused'
      ? { text: texts.chats.resumeButton, data: encodeCallback({ entity: 'c', action: 'res', id: chat.id }) }
      : { text: texts.chats.pauseButton, data: encodeCallback({ entity: 'c', action: 'pau', id: chat.id }) };

  return {
    text: lines.join('\n'),
    buttons: [
      [
        {
          text: texts.chats.analysisButton(chat.analysisEnabled),
          data: encodeCallback({ entity: 'c', action: 'ana', id: chat.id }),
        },
        {
          text: texts.chats.reactionsButton(chat.reactionsEnabled),
          data: encodeCallback({ entity: 'c', action: 'rea', id: chat.id }),
        },
      ],
      [pauseOrResumeButton],
      [
        {
          text: texts.chats.manageLeaveButton,
          data: encodeCallback({ entity: 'c', action: 'lva', id: chat.id }),
        },
      ],
      backButtonRow(),
    ],
  };
}

/**
 * Pure render for the leave-confirmation step between the
 * card's `v1:c:lva` (leave, ask) and `v1:c:lvc` (leave, confirmed) — the
 * "no" button (`v1:c:opn`) just reopens {@link renderChatCard} for the same
 * chat, same as the card's own back-out paths.
 */
export function renderLeaveConfirm(chat: ChatRow): ChatsView {
  const title = chat.title ?? texts.chats.untitledChat;
  return {
    text: texts.chats.leaveConfirmPrompt(title),
    buttons: [
      [
        {
          text: texts.chats.leaveConfirmYes,
          data: encodeCallback({ entity: 'c', action: 'lvc', id: chat.id }),
        },
        {
          text: texts.chats.leaveConfirmNo,
          data: encodeCallback({ entity: 'c', action: 'opn', id: chat.id }),
        },
      ],
    ],
  };
}
