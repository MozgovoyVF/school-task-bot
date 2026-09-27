import { PENDING_CHAT_TIMEOUT_HOURS } from '../../config/constants.js';
import { listExpiredPendingChats } from '../../domain/chats/repo.js';
import { leaveChatInternal } from '../../domain/chats/lifecycle.js';
import type { Job } from '../ticker.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Auto-leaves any `pending` chat whose approval window has run out (SPEC
 * §15.1's 72h auto-leave rule, D5). One failing chat
 * (e.g. a transient Telegram error from `leaveChatInternal`'s
 * `messenger.leaveChat`) is logged and does not stop the rest — the chat's
 * `pending_since` stays put, so it is picked up again next tick.
 */
export const pendingChatsJob: Job = {
  name: 'pendingChats',
  async run(deps) {
    const now = deps.clock.now();
    const cutoff = new Date(now.getTime() - PENDING_CHAT_TIMEOUT_HOURS * HOUR_MS);
    const expired = await listExpiredPendingChats(deps.db, cutoff);

    for (const chat of expired) {
      try {
        await leaveChatInternal({ db: deps.db, messenger: deps.messenger, clock: deps.clock }, chat.id);
      } catch (err) {
        deps.logger.error({ err, chatId: chat.id }, 'pendingChatsJob: failed to leave an expired pending chat');
      }
    }
  },
};
