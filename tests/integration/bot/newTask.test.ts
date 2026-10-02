import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, tasks } from '../../../src/db/schema/index.js';

// plan.md Task 3.10: the `/new` conversation end to end — название → исполнитель → срок → приоритет →
// подтверждение → a real task with `origin='manual_dm'` (SPEC §12.1). No LLM call anywhere in this flow
// (unlike `/task`/DM free text/forwards, which all go through `extractSingle`) — `/new` never needs
// `deps.ai` except for its own free-text due-date step (D23's `den`/`parseDateText`), not exercised here.

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

/** The dialog's own placeholder entity/id (`src/bot/conversations/newTask.ts`'s `MENU_ID`, always 0 —
 * there is no real proposal/task row yet while this dialog is running). */
function p(action: string, arg?: string): string {
  return arg === undefined
    ? encodeCallback({ entity: 'p', action, id: 0 })
    : encodeCallback({ entity: 'p', action, id: 0, arg });
}

async function lastTaskFor(harness: BotHarness) {
  const [row] = await harness.db.select().from(tasks).where(eq(tasks.workspaceId, harness.deps.workspace.id));
  return row;
}

describe('/new conversation (plan.md Task 3.10)', () => {
  it('is forbidden for a Member and never enters the dialog', async () => {
    const harness = await createBotHarness();
    await makeMember(harness, MEMBER);

    await harness.send(dmText(MEMBER, '/new'));

    expect(harness.replies(MEMBER.id)).toEqual([texts.common.forbidden]);
  });

  it('walks название → исполнитель → срок → приоритет → подтверждение and creates a manual_dm task', async () => {
    const harness = await createBotHarness();
    const owner = await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/new'));
    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.newTask.titlePrompt);

    // Название.
    await harness.send(dmText(OWNER, 'Купить бумагу'));

    // Исполнитель → "Я" (the Owner).
    await harness.send(callback(OWNER, p('ame'), botKeyboardMessage(OWNER)));

    // Срок → "Без срока".
    await harness.send(callback(OWNER, p('dno'), botKeyboardMessage(OWNER)));

    // Приоритет → "высокий".
    await harness.send(callback(OWNER, p('phi'), botKeyboardMessage(OWNER)));

    // Подтверждение.
    expect(harness.replies(OWNER.id).at(-1)).toContain(texts.newTask.menuHeader);
    await harness.send(callback(OWNER, p('ncy'), botKeyboardMessage(OWNER)));

    const task = await lastTaskFor(harness);
    expect(task?.title).toBe('Купить бумагу');
    expect(task?.assigneeUserId).toBe(owner.id);
    expect(task?.priority).toBe('high');
    expect(task?.dueAt).toBeNull();
    expect(task?.origin).toBe('manual_dm');
    expect(task?.proposalId).toBeNull();
    expect(task?.createdByUserId).toBe(owner.id);

    expect(harness.replies(OWNER.id).at(-1)).toBe(
      texts.proposalDecide.createdCard(task!.id, 'Купить бумагу'),
    );
  });

  it('cancels without creating a task', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/new'));
    await harness.send(dmText(OWNER, 'Что-то'));
    await harness.send(callback(OWNER, p('ano'), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('dno'), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('pno'), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, p('ncn'), botKeyboardMessage(OWNER)));

    expect(harness.replies(OWNER.id).at(-1)).toBe(texts.newTask.cancelled);
    expect(await lastTaskFor(harness)).toBeUndefined();
  });
});
