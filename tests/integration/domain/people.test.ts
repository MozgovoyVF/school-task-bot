import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import {
  upsertTelegramUser,
  ensureMembership,
  getOwner,
  getMembership,
  listMembers,
  markDmStarted,
  markDmBlocked,
  setUserTimezone,
  bootstrapOwner,
} from '../../../src/domain/people/repo.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { createContextMiddleware } from '../../../src/bot/middleware/context.js';
import { chats, memberships } from '../../../src/db/schema/index.js';
import type { BotContext } from '../../../src/bot/context.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

describe('people repo', () => {
  it('upsertTelegramUser inserts, then updates username/names on conflict', async () => {
    const first = await upsertTelegramUser(db, { id: 555, username: 'anna', first_name: 'Anna' });
    expect(first.username).toBe('anna');
    expect(first.lastName).toBeNull();

    const second = await upsertTelegramUser(db, {
      id: 555,
      username: 'anna2',
      first_name: 'Anna',
      last_name: 'Petrova',
    });
    expect(second.id).toBe(first.id);
    expect(second.username).toBe('anna2');
    expect(second.lastName).toBe('Petrova');
  });

  it('ensureMembership creates a member row, and leaves an existing membership untouched', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const user = await upsertTelegramUser(db, { id: 1, first_name: 'Maria' });

    const created = await ensureMembership(db, { workspaceId: ws.id, userId: user.id, displayName: 'Maria' });
    expect(created.role).toBe('member');
    expect(created.displayName).toBe('Maria');

    const again = await ensureMembership(db, {
      workspaceId: ws.id,
      userId: user.id,
      displayName: 'Someone else',
    });
    expect(again.id).toBe(created.id);
    expect(again.displayName).toBe('Maria');
    expect(again.role).toBe('member');
  });

  it('ensureMembership does not demote an existing owner or rename them', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const user = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: user.id, role: 'owner', displayName: 'Anna' });

    const result = await ensureMembership(db, {
      workspaceId: ws.id,
      userId: user.id,
      displayName: 'Not Anna',
    });

    expect(result.role).toBe('owner');
    expect(result.displayName).toBe('Anna');
  });

  it('getOwner returns the owner user+membership, or null when there is none', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    expect(await getOwner(db, ws.id)).toBeNull();

    const user = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: user.id, role: 'owner', displayName: 'Anna' });

    const owner = await getOwner(db, ws.id);
    expect(owner?.user.id).toBe(user.id);
    expect(owner?.membership.role).toBe('owner');
  });

  it('getMembership and listMembers read back what was created', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const u1 = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    const u2 = await upsertTelegramUser(db, { id: 2, first_name: 'Maria' });
    await ensureMembership(db, { workspaceId: ws.id, userId: u1.id, displayName: 'Anna' });
    await ensureMembership(db, { workspaceId: ws.id, userId: u2.id, displayName: 'Maria' });

    expect((await getMembership(db, ws.id, u1.id))?.displayName).toBe('Anna');
    expect(await getMembership(db, ws.id, 999)).toBeNull();
    expect(await listMembers(db, ws.id)).toHaveLength(2);
  });

  it('markDmStarted sets dm_started_at once and does not overwrite it later', async () => {
    const user = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    expect(user.dmStartedAt).toBeNull();

    const first = new Date('2026-09-23T10:00:00Z');
    const updated = await markDmStarted(db, user.id, first);
    expect(updated?.dmStartedAt?.toISOString()).toBe(first.toISOString());

    const second = new Date('2026-09-23T11:00:00Z');
    const again = await markDmStarted(db, user.id, second);
    expect(again).toBeNull(); // already set — no row matched the `WHERE dm_started_at IS NULL`
  });

  it('markDmBlocked toggles dm_blocked', async () => {
    const user = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    const blocked = await markDmBlocked(db, user.id, true);
    expect(blocked?.dmBlocked).toBe(true);
    const unblocked = await markDmBlocked(db, user.id, false);
    expect(unblocked?.dmBlocked).toBe(false);
  });

  it('setUserTimezone stores the zone', async () => {
    const user = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    const updated = await setUserTimezone(db, user.id, 'Asia/Yekaterinburg');
    expect(updated?.timezone).toBe('Asia/Yekaterinburg');
  });

  describe('bootstrapOwner', () => {
    it('creates the owner user+membership when there is none yet', async () => {
      const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
      const outcome = await bootstrapOwner(db, { workspaceId: ws.id, tgUserId: 777 });
      expect(outcome).toBe('created');

      const owner = await getOwner(db, ws.id);
      expect(owner?.user.tgUserId).toBe(777);
      expect(owner?.membership.role).toBe('owner');
    });

    it('returns "exists" without changing anything when an owner is already set', async () => {
      const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
      const first = await bootstrapOwner(db, { workspaceId: ws.id, tgUserId: 777 });
      expect(first).toBe('created');

      const second = await bootstrapOwner(db, { workspaceId: ws.id, tgUserId: 888 });
      expect(second).toBe('exists');

      const owner = await getOwner(db, ws.id);
      expect(owner?.user.tgUserId).toBe(777);
    });

    it('reuses an existing users row (e.g. the owner already DMed the bot) instead of erroring on conflict', async () => {
      const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
      const preexisting = await upsertTelegramUser(db, { id: 777, first_name: 'Anna' });

      const outcome = await bootstrapOwner(db, { workspaceId: ws.id, tgUserId: 777 });
      expect(outcome).toBe('created');

      const owner = await getOwner(db, ws.id);
      expect(owner?.user.id).toBe(preexisting.id);
    });

    it('returns "skipped" without touching the DB when no BOOTSTRAP_OWNER_TG_ID is configured', async () => {
      const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
      const outcome = await bootstrapOwner(db, { workspaceId: ws.id, tgUserId: undefined });
      expect(outcome).toBe('skipped');
      expect(await getOwner(db, ws.id)).toBeNull();
    });
  });
});

describe('context middleware: actor.role resolution', () => {
  it('resolves the actor role for a group update via the chat’s own workspace_id', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: owner.id, role: 'owner', displayName: 'Anna' });
    await db.insert(chats).values({ tgChatId: -100123, type: 'supergroup', workspaceId: ws.id });

    const middleware = createContextMiddleware({
      db,
      config: { SUPERADMIN_TG_IDS: [] },
      clock: fixedClock('2026-09-23T12:00:00Z'),
      workspace: ws,
    });

    const ctx = {
      from: { id: 1, is_bot: false, first_name: 'Anna' },
      chat: { id: -100123, type: 'supergroup', title: 'Group' },
    } as unknown as BotContext;

    await middleware(ctx, async () => {});

    expect(ctx.state.actor.role).toBe('owner');
    expect(ctx.state.workspace?.id).toBe(ws.id);
    expect(ctx.state.membership?.role).toBe('owner');
  });

  it('leaves actor.role null for a group chat that has no workspace_id yet (pending approval)', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    await db.insert(chats).values({ tgChatId: -100456, type: 'supergroup', workspaceId: null });

    const middleware = createContextMiddleware({
      db,
      config: { SUPERADMIN_TG_IDS: [] },
      clock: fixedClock('2026-09-23T12:00:00Z'),
      workspace: ws,
    });

    const ctx = {
      from: { id: 2, is_bot: false, first_name: 'Stranger' },
      chat: { id: -100456, type: 'supergroup', title: 'Group' },
    } as unknown as BotContext;

    await middleware(ctx, async () => {});

    expect(ctx.state.actor.role).toBeNull();
    expect(ctx.state.workspace).toBeNull();
  });

  it('resolves the actor role for a DM update via the single default workspace (MVP)', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const member = await upsertTelegramUser(db, { id: 3, first_name: 'Maria' });
    await ensureMembership(db, { workspaceId: ws.id, userId: member.id, displayName: 'Maria' });

    const middleware = createContextMiddleware({
      db,
      config: { SUPERADMIN_TG_IDS: [] },
      clock: fixedClock('2026-09-23T12:00:00Z'),
      workspace: ws,
    });

    const ctx = {
      from: { id: 3, is_bot: false, first_name: 'Maria' },
      chat: { id: 3, type: 'private', first_name: 'Maria' },
    } as unknown as BotContext;

    await middleware(ctx, async () => {});

    expect(ctx.state.actor.role).toBe('member');
    expect(ctx.state.actor.dmStarted).toBe(true);
    expect(ctx.state.workspace?.id).toBe(ws.id);
  });
});
