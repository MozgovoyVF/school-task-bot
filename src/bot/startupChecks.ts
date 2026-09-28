import type { UserFromGetMe } from 'grammy/types';
import type { Logger } from '../ops/logger.js';
import type { ErrorReporter } from '../ops/errorReporter.js';
import { texts } from './texts/ru.js';

export interface StartupChecksDeps {
  logger: Logger;
  errors: ErrorReporter;
}

/**
 * Checks the bot's own privacy-mode setting (called once from `src/app.ts`
 * right after `bot.init()` resolves `me`): with `can_read_all_group_messages
 * === false`, Telegram only forwards commands/mentions/replies to the bot in
 * a group, never ordinary conversation text — the whole "find tasks in group
 * chats" feature silently stops working. Logs a warn either way it's an
 * issue, then throttled-alerts every superadmin via
 * `errors.alert('privacy_mode', ...)` (`src/ops/errorReporter.ts`'s own
 * once-an-hour-by-default throttle, so this doesn't re-notify on every
 * restart). A `true` `can_read_all_group_messages` is the expected/healthy
 * case and sends nothing.
 */
export async function checkPrivacyMode(deps: StartupChecksDeps, me: UserFromGetMe): Promise<void> {
  if (me.can_read_all_group_messages !== false) return;

  deps.logger.warn('privacy mode is enabled on the bot — group messages are invisible until it is disabled');
  await deps.errors.alert('privacy_mode', texts.admin.privacyModeOn);
}
