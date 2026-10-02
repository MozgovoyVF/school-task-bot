import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, forwardedDm } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, proposals } from '../../../src/db/schema/index.js';
import type { ProposalPayload } from '../../../src/domain/proposals/repo.js';

// plan.md Task 3.10: `src/bot/handlers/dmFreeText.ts`/`forwards.ts` end to end. `/task` in a group is
// covered by `tests/integration/bot/groupIntake.test.ts`; `/new` by `tests/integration/bot/newTask.test.ts`
// — this file covers the other two manual-creation entry points. `createBotHarness()`'s default `ai: null`
// (no OPENROUTER_API_KEY) means every draft here goes through `extractSingle`'s D19 fallback (title = the
// first 80 characters) rather than a real/fixture LLM call — exactly the "LLM unavailable" acceptance case,
// exercised here end to end through the bot layer on top of `tests/integration/ai/extractSingle.test.ts`'s
// own direct unit coverage of that fallback.

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };

async function makeOwner(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'owner',
    displayName: tgUser.firstName,
  });
  return userRow;
}

async function makeMember(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'member',
    displayName: tgUser.firstName,
  });
  return userRow;
}

async function allProposals(harness: BotHarness) {
  return harness.db.select().from(proposals).where(eq(proposals.workspaceId, harness.deps.workspace.id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('DM free text (plan.md Task 3.10, SPEC §12.1)', () => {
  it("the Owner's free text becomes a draft card, sent inline with the usual accept/edit/reject buttons", async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, 'купить бумагу для принтера'));

    const rows = await allProposals(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'manual', chatId: null, policyDecision: 'shown' });
    expect(rows[0]?.notifiedAt).not.toBeNull();
    const payload = rows[0]?.payload as ProposalPayload;
    expect(payload.origin).toBe('manual_dm');
    expect(payload.title).toBe('купить бумагу для принтера');

    const sent = harness.calls.find((c) => c.method === 'sendMessage');
    expect(sent).toBeDefined();
    const payloadKeyboard = (sent?.payload as { reply_markup?: { inline_keyboard?: unknown[][] } })
      .reply_markup?.inline_keyboard;
    expect(payloadKeyboard?.[0]).toHaveLength(3); // accept / edit / reject
  });

  it("a Member's free text gets a polite decline — no LLM call, no proposal", async () => {
    const harness = await createBotHarness();
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, 'купить бумагу для принтера'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.manualTask.membersNotSupported]);
    expect(await allProposals(harness)).toHaveLength(0);
  });
});

describe('DM forwards (plan.md Task 3.10, D18)', () => {
  it('two forwards arriving within the burst window are combined into one draft, quoting the first', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(forwardedDm(OWNER, 'первое сообщение'));
    await harness.send(forwardedDm(OWNER, 'второе сообщение'));
    await sleep(3200); // > FORWARD_BURST_MS (3000ms) — lets the buffer's timer flush exactly once

    const rows = await allProposals(harness);
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as ProposalPayload;
    expect(payload.origin).toBe('forward');
    // The *quote* is only ever the first forwarded message (D18/SPEC §12.1) — the *title* (D19's fallback,
    // `ai: null` by default) is the first 80 characters of the whole combined batch, both messages joined.
    expect(payload.quote).toBe('первое сообщение');
    expect(payload.title).toBe('первое сообщение\n\nвторое сообщение');
    expect(rows[0]?.notifiedAt).not.toBeNull();
  }, 10_000);
});
