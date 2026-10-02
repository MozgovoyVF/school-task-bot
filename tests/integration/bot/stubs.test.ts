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

// `/settings` stands in for the whole `STUB_COMMANDS` list (`src/bot/handlers/stubs.ts`, now just
// `/settings` itself) — every one of them is registered the same way, with the same
// `can(actor, 'task.viewAll')` gate. `/tasks` used to be this suite's representative command too, until
// Task 3.7 gave it (and `/today`/`/overdue`/`/archive`) a real handler (`src/bot/handlers/lists.ts`,
// covered by `tests/integration/bot/lists.test.ts`); `/stats` was this suite's second example command
// until Task 3.8 gave it (and `/search`) a real handler too (`src/bot/handlers/stats.ts`/`search.ts`,
// covered by `tests/integration/bot/stats.test.ts`/`search.test.ts`); `/new` was this suite's second
// example command until Task 3.10 gave it a real handler too (`src/bot/conversations/newTask.ts`, covered
// by `tests/integration/bot/newTask.test.ts`) — `/settings` is now the only stub left.
describe('owner-command stubs (/settings)', () => {
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

  it('replies with the "coming soon" stub for the Owner', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));

    expect(harness.replies(OWNER.id)).toEqual([texts.common.comingSoon]);
  });

  it('has no effect in a group, even for the Owner', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);
    const group = { id: -1001, type: 'supergroup' as const, title: 'Учительская' };

    await harness.send(groupText(group, OWNER, '/settings'));

    expect(harness.replies(group.id)).toEqual([]);
  });
});
