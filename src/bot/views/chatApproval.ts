import type { Buttons } from '../../domain/messenger.js';
import type { ChatRow } from '../../domain/chats/repo.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';

export interface ChatApprovalView {
  text: string;
  buttons: Buttons;
}

/**
 * Pure render for the approval card sent to the Owner/superadmins when a
 * chat is left `pending` (SPEC §15.1): `texts.chats.addedNotice` with the
 * approve/leave buttons (`texts.chats.approveButton`/`.leaveButton`).
 * `chat.id` (the internal DB id, never the Telegram one) is the callback's
 * `id` — CLAUDE.md §8. No DB, no I/O (CLAUDE.md §7); `src/domain/chats/lifecycle.ts` calls this directly
 * to build the card it then sends via `Messenger` (see that file's own
 * doc comment for why a domain module reaches into `bot/views/` here).
 */
export function renderChatApprovalCard(chat: ChatRow, addedByName: string): ChatApprovalView {
  return {
    text: texts.chats.addedNotice(chat.title ?? texts.chats.untitledChat, addedByName),
    buttons: [
      [
        {
          text: texts.chats.approveButton,
          data: encodeCallback({ entity: 'c', action: 'apr', id: chat.id }),
        },
        { text: texts.chats.leaveButton, data: encodeCallback({ entity: 'c', action: 'rej', id: chat.id }) },
      ],
    ],
  };
}
