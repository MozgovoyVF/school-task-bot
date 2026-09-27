import { PENDING_CHAT_TIMEOUT_HOURS } from '../../config/constants.js';
import { listExpiredPendingChats } from '../../domain/chats/repo.js';
import { leaveExpiredPendingChat } from '../../domain/chats/lifecycle.js';
import type { Job } from '../ticker.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Auto-leaves any `pending` chat whose approval window has run out (SPEC
 * §15.1's 72h auto-leave rule, D5). Uses `leaveExpiredPendingChat`, not
 * `leaveChatInternal`: it claims each chat atomically (`status='pending'`
 * only) before calling `messenger.leaveChat`, so an Owner approving a chat
 * between this job's listing query and its per-chat leave call is never
 * silently reversed (the claim just returns `null` for that chat — no
 * leave, no error). One failing chat (e.g. a transient Telegram error from
 * `messenger.leaveChat`, after the claim already flipped the row to `left`)
 * is logged and does not stop the rest.
 */
export const pendingChatsJob: Job = {
  name: 'pendingChats',
  async run(deps) {
    const now = deps.clock.now();
    const cutoff = new Date(now.getTime() - PENDING_CHAT_TIMEOUT_HOURS * HOUR_MS);
    const expired = await listExpiredPendingChats(deps.db, cutoff);

    for (const chat of expired) {
      try {
        await leaveExpiredPendingChat({ db: deps.db, messenger: deps.messenger, clock: deps.clock }, chat.id);
      } catch (err) {
        deps.logger.error({ err, chatId: chat.id }, 'pendingChatsJob: failed to leave an expired pending chat');
      }
    }
  },
};
