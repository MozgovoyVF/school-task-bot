import { describe, it, expect } from 'vitest';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, groupText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships } from '../../../src/db/schema/index.js';

const OWNER = { id: 100, firstName: 'Anna' };
const MEMBER = { id: 200, firstName: 'Boris' };
const STRANGER = { id: 300, firstName: 'Ivan' };

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

// `STUB_COMMANDS` (`src/bot/handlers/stubs.ts`) is now empty — every `OWNER_COMMANDS` row has a real
// handler (`/settings` was the last one, landed in Task 3.11: `src/bot/handlers/settings.ts`/
// `src/bot/conversations/settings.ts`). This file keeps `/settings`'s own entry-gate smoke tests (the
// stub-era `can(actor, 'task.viewAll')` checks were review round 1's I1 fix, now
// `can(actor, 'settings.manage')` — same Owner-only shape) rather than duplicating them again in a
// dedicated `settings.test.ts`; the full menu/section behaviour is this task's own optional coverage, not
// required by plan.md's D43 list.
describe('/settings entry gate', () => {
  it('is forbidden for a Member (review round 1, I1)', async () => {
    const harness = await createBotHarness();
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, '/settings'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
  });

  it('is forbidden for a stranger with no membership at all (review round 1, I1)', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/settings'));

    expect(harness.replies(STRANGER.id)).toEqual([texts.common.forbidden]);
  });

  it('opens the settings menu for the Owner', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));

    expect(harness.replies(OWNER.id)).toEqual([texts.settings.menuHeader]);
  });

  it('has no effect in a group, even for the Owner', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const group = { id: -1001, type: 'supergroup' as const, title: 'Учительская' };

    await harness.send(groupText(group, OWNER, '/settings'));

    expect(harness.replies(group.id)).toEqual([]);
  });
});
