import type { Bot } from 'grammy';
import { createConversation, type Conversation } from '@grammyjs/conversations';
import type { Db } from '../../db/client.js';
import { can } from '../../domain/people/permissions.js';
import {
  AliasValidationError,
  getMembershipWithUser,
  parseAliases,
  updatePerson,
} from '../../domain/people/repo.js';
import { CONVERSATION_TIMEOUT_MS } from '../../config/constants.js';
import { texts } from '../texts/ru.js';
import { toInlineKeyboard } from '../keyboards/build.js';
import { renderPersonCard } from '../views/people.js';
import { privateOnly } from '../middleware/privateOnly.js';
import type { BotContext } from '../context.js';

export const EDIT_PERSON_CONVERSATION_ID = 'editPerson';

type EditPersonConversation = Conversation<BotContext, BotContext>;

/** Sent instead of a new value to keep the current one unchanged, for either dialog step. */
const SKIP_TOKEN = '-';

/** First step: the member's current name, or `null` if the Owner sent {@link SKIP_TOKEN} (keep it unchanged). */
async function askName(
  conversation: EditPersonConversation,
  ctx: BotContext,
  current: string,
): Promise<string | null> {
  await ctx.reply(texts.people.namePrompt(current), { parse_mode: 'HTML' });
  const textCtx = await conversation.waitFor(':text', {
    otherwise: (otherCtx) => otherCtx.reply(texts.people.textHint, { parse_mode: 'HTML' }),
  });
  const trimmed = textCtx.msg.text.trim();
  return trimmed === SKIP_TOKEN ? null : trimmed;
}

/**
 * Second step: the member's current aliases, or `null` if the Owner sent
 * {@link SKIP_TOKEN}. Loops on an invalid `parseAliases` input (too many
 * aliases / an alias too long) instead of failing the whole dialog, per the
 * brief's Step 1 acceptance case for those limits.
 */
async function askAliases(
  conversation: EditPersonConversation,
  ctx: BotContext,
  current: string[],
): Promise<string[] | null> {
  const currentText = current.length === 0 ? texts.people.noAliases : current.join(', ');
  await ctx.reply(texts.people.aliasesPrompt(currentText), { parse_mode: 'HTML' });

  for (;;) {
    const textCtx = await conversation.waitFor(':text', {
      otherwise: (otherCtx) => otherCtx.reply(texts.people.textHint, { parse_mode: 'HTML' }),
    });
    const trimmed = textCtx.msg.text.trim();
    if (trimmed === SKIP_TOKEN) return null;

    try {
      return parseAliases(trimmed);
    } catch (err) {
      if (!(err instanceof AliasValidationError)) throw err;
      const message =
        err.reason === 'too_many' ? texts.people.aliasesTooMany() : texts.people.aliasesTooLong();
      await textCtx.reply(message, { parse_mode: 'HTML' });
    }
  }
}

function buildEditPersonConversation(db: Db) {
  return async function editPersonConversation(
    conversation: EditPersonConversation,
    ctx: BotContext,
    membershipId: number,
  ): Promise<void> {
    // `ctx.state` is unavailable on the context objects passed directly into
    // a conversation builder (plan.md D41's pre-verified fact) — only on the
    // "outside" context `conversation.external`'s callback receives.
    const actor = await conversation.external((outsideCtx) => outsideCtx.state.actor);
    if (!can(actor, 'people.manage')) return;

    const workspace = await conversation.external((outsideCtx) => outsideCtx.state.workspace);
    const row = await conversation.external(() => getMembershipWithUser(db, membershipId));
    if (!row || !workspace || row.membership.workspaceId !== workspace.id) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const newName = await askName(conversation, ctx, row.membership.displayName);
    const newAliases = await askAliases(conversation, ctx, row.membership.aliases);

    if (newName === null && newAliases === null) {
      await ctx.reply(texts.people.nothingChanged, { parse_mode: 'HTML' });
      return;
    }

    // Re-checked right before the write, not only at entry (this task's brief:
    // every step of this dialog re-checks permission against the DB, not just
    // the initial `/people` entry point) — guards against the Owner role
    // changing (e.g. via `/transfer`) while this dialog was sitting idle,
    // within `CONVERSATION_TIMEOUT_MS`, waiting for the Owner's next message.
    const stillOwner = await conversation.external((outsideCtx) =>
      can(outsideCtx.state.actor, 'people.manage'),
    );
    if (!stillOwner) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    const updated = await conversation.external(() =>
      updatePerson(db, {
        membershipId,
        ...(newName !== null ? { displayName: newName } : {}),
        ...(newAliases !== null ? { aliases: newAliases } : {}),
      }),
    );
    if (!updated) {
      await ctx.reply(texts.common.forbidden, { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(texts.people.saved, { parse_mode: 'HTML' });

    const at = new Date(await conversation.now());
    const card = renderPersonCard({ user: row.user, membership: updated }, workspace, at);
    await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: toInlineKeyboard(card.buttons) });
  };
}

/**
 * Registers the `editPerson` conversation (entered from `people.ts`'s
 * `v1:u:edt:<membershipId>` callback, already DM-only-guarded there). Wrapped
 * in `privateOnly` too (final Phase 1 review's C1 fix) — `@grammyjs/conversations`
 * throws if a `createConversation(...)` middleware runs on an update where
 * `conversations()` itself didn't install its controls first, which is now
 * only true for private chats (`bot.ts`) — see `privateOnly.ts`'s doc comment.
 */
export function registerEditPersonConversation(bot: Bot<BotContext>, deps: { db: Db }): void {
  bot.use(
    privateOnly(
      createConversation(buildEditPersonConversation(deps.db), {
        id: EDIT_PERSON_CONVERSATION_ID,
        maxMillisecondsToWait: CONVERSATION_TIMEOUT_MS,
      }),
    ),
  );
}
