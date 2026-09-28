import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { createDb } from '../../../src/db/client.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser, getOwner, getMembership } from '../../../src/domain/people/repo.js';
import { createClaimCode, redeemClaimCode, hashClaimCode } from '../../../src/domain/people/claim.js';
import { claimCodes, memberships } from '../../../src/db/schema/index.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stb:stb@localhost:5433/stb_test';

const db = getTestDb();
beforeEach(() => truncateAll(db));

async function setupWorkspaceWithOwner() {
  const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const owner = await upsertTelegramUser(db, { id: 1, first_name: 'Anna' });
  const superadmin = await upsertTelegramUser(db, { id: 900000001, first_name: 'Admin' });
  await db.insert(memberships).values({
    workspaceId: ws.id,
    userId: owner.id,
    role: 'owner',
    displayName: 'Anna',
  });
  return { ws, owner, superadmin };
}

describe('createClaimCode / redeemClaimCode', () => {
  it('redeems a valid code: the new user becomes owner, the previous owner is demoted to member', async () => {
    const { ws, owner, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const { code, expiresAt } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });
    expect(expiresAt.toISOString()).toBe(new Date('2026-09-24T12:00:00Z').toISOString());

    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const result = await redeemClaimCode(db, { code, userId: claimant.id, now });

    expect(result).toEqual({ ok: true, workspaceId: ws.id, previousOwnerUserId: owner.id });

    const newOwner = await getOwner(db, ws.id);
    expect(newOwner?.user.id).toBe(claimant.id);

    const prev = await getMembership(db, ws.id, owner.id);
    expect(prev?.role).toBe('member');
  });

  it('a second redeem of the same code fails with "used"', async () => {
    const { ws, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });
    const claimantA = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const claimantB = await upsertTelegramUser(db, { id: 3, first_name: 'Nina' });

    const first = await redeemClaimCode(db, { code, userId: claimantA.id, now });
    expect(first.ok).toBe(true);

    const second = await redeemClaimCode(db, { code, userId: claimantB.id, now });
    expect(second).toEqual({ ok: false, reason: 'used' });
  });

  it('a code redeemed after its 24h + 1s expiry fails with "expired"', async () => {
    const { ws, superadmin } = await setupWorkspaceWithOwner();
    const createdAt = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now: createdAt,
    });
    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const tooLate = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000 + 1000);

    const result = await redeemClaimCode(db, { code, userId: claimant.id, now: tooLate });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('a code redeemed 1s before its 24h expiry still succeeds', async () => {
    const { ws, superadmin } = await setupWorkspaceWithOwner();
    const createdAt = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now: createdAt,
    });
    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const justInTime = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000 - 1000);

    const result = await redeemClaimCode(db, { code, userId: claimant.id, now: justInTime });
    expect(result.ok).toBe(true);
  });

  it('an unknown code fails with "invalid"', async () => {
    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const result = await redeemClaimCode(db, {
      code: 'ZZZZZZZZ',
      userId: claimant.id,
      now: new Date('2026-09-23T12:00:00Z'),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('previousOwnerAction "remove" deletes the previous owner\'s membership instead of demoting it', async () => {
    const { ws, owner, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'remove',
      now,
    });
    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });

    const result = await redeemClaimCode(db, { code, userId: claimant.id, now });
    expect(result.ok).toBe(true);

    expect(await getMembership(db, ws.id, owner.id)).toBeNull();
  });

  it('a code issued for an empty workspace (no owner yet, issued by superadmin) redeems with previousOwnerUserId=null', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const superadmin = await upsertTelegramUser(db, { id: 900000001, first_name: 'Admin' });
    expect(await getOwner(db, ws.id)).toBeNull();

    const now = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });
    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });

    const result = await redeemClaimCode(db, { code, userId: claimant.id, now });
    expect(result).toEqual({ ok: true, workspaceId: ws.id, previousOwnerUserId: null });

    const newOwner = await getOwner(db, ws.id);
    expect(newOwner?.user.id).toBe(claimant.id);
  });

  it('two concurrent redeems of the same code, on two genuinely separate DB connections, yield exactly one ok', async () => {
    const { ws, owner, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });
    const claimantA = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const claimantB = await upsertTelegramUser(db, { id: 3, first_name: 'Nina' });

    // Two independent postgres.js connections (not the shared, single-connection
    // getTestDb() pool): this is what makes the race genuine — both
    // redeemClaimCode calls hit Postgres over separate sockets at the same
    // time, so it is the row-level `SELECT ... FOR UPDATE` lock inside
    // redeemClaimCode's transaction — not JS-side or connection-pool
    // serialization — that decides which one wins.
    const conn1 = createDb(TEST_DATABASE_URL, { max: 1 });
    const conn2 = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      const [resultA, resultB] = await Promise.all([
        redeemClaimCode(conn1.db, { code, userId: claimantA.id, now }),
        redeemClaimCode(conn2.db, { code, userId: claimantB.id, now }),
      ]);

      const results = [resultA, resultB];
      const oks = results.filter((r) => r.ok);
      const fails = results.filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toEqual({ ok: false, reason: 'used' });

      const winner = oks[0];
      if (!winner?.ok) throw new Error('expected exactly one ok result');
      expect(winner.previousOwnerUserId).toBe(owner.id);

      const newOwner = await getOwner(db, ws.id);
      const winningClaimantId = resultA.ok ? claimantA.id : claimantB.id;
      expect(newOwner?.user.id).toBe(winningClaimantId);

      const prev = await getMembership(db, ws.id, owner.id);
      expect(prev?.role).toBe('member'); // the code's previousOwnerAction was 'demote'
    } finally {
      await conn1.close();
      await conn2.close();
    }
  });

  it(
    'two concurrent redeems of two DIFFERENT still-valid codes for the same workspace, on two genuinely ' +
      'separate DB connections, resolve without throwing — exactly one ok, the other "used" ' +
      '(plan.md D42: the workspace-row lock, not just the per-code lock, is what prevents a raw ' +
      '"memberships_one_owner" unique-constraint crash here)',
    async () => {
      const { ws, owner } = await setupWorkspaceWithOwner();
      const now = new Date('2026-09-23T12:00:00Z');
      const codeA = await createClaimCode(db, {
        workspaceId: ws.id,
        createdByUserId: owner.id,
        previousOwnerAction: 'demote',
        now,
      });
      const codeB = await createClaimCode(db, {
        workspaceId: ws.id,
        createdByUserId: owner.id,
        previousOwnerAction: 'demote',
        now,
      });
      const claimantA = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
      const claimantB = await upsertTelegramUser(db, { id: 3, first_name: 'Nina' });

      const conn1 = createDb(TEST_DATABASE_URL, { max: 1 });
      const conn2 = createDb(TEST_DATABASE_URL, { max: 1 });
      try {
        const settled = await Promise.allSettled([
          redeemClaimCode(conn1.db, { code: codeA.code, userId: claimantA.id, now }),
          redeemClaimCode(conn2.db, { code: codeB.code, userId: claimantB.id, now }),
        ]);

        // The headline assertion: neither call threw (no raw DB error escaping
        // to the caller — the pre-fix behaviour the reviewer reproduced 15/15).
        for (const outcome of settled) expect(outcome.status).toBe('fulfilled');

        const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
        const oks = results.filter((r) => r?.ok);
        const fails = results.filter((r) => r && !r.ok);
        expect(oks).toHaveLength(1);
        expect(fails).toHaveLength(1);
        expect(fails[0]).toEqual({ ok: false, reason: 'used' });

        // Exactly one owner in the end, not zero and not a duplicate-key crash.
        const newOwner = await getOwner(db, ws.id);
        expect(newOwner).not.toBeNull();
      } finally {
        await conn1.close();
        await conn2.close();
      }
    },
  );

  it("a successful redeem invalidates the workspace's other still-unused codes (D42: a transfer is final)", async () => {
    const { ws, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const winning = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });
    const sibling = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });
    const claimant = await upsertTelegramUser(db, { id: 2, first_name: 'Boris' });
    const attacker = await upsertTelegramUser(db, { id: 3, first_name: 'Old Owner Again' });

    const first = await redeemClaimCode(db, { code: winning.code, userId: claimant.id, now });
    expect(first.ok).toBe(true);

    // The old owner (or anyone else) can no longer use the sibling code minted
    // earlier for the same workspace to reclaim/reassign ownership later.
    const second = await redeemClaimCode(db, { code: sibling.code, userId: attacker.id, now });
    expect(second).toEqual({ ok: false, reason: 'used' });

    const newOwner = await getOwner(db, ws.id);
    expect(newOwner?.user.id).toBe(claimant.id);
  });

  it('an owner redeeming their own "remove" code keeps their existing membership (no needless delete+reinsert)', async () => {
    const { ws, owner, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'remove',
      now,
    });

    const result = await redeemClaimCode(db, { code, userId: owner.id, now });
    expect(result).toEqual({ ok: true, workspaceId: ws.id, previousOwnerUserId: owner.id });

    const membership = await getMembership(db, ws.id, owner.id);
    expect(membership?.role).toBe('owner');
    expect(membership?.displayName).toBe('Anna'); // untouched — not reset to a users.firstName fallback
  });

  it('stores only the code hash: searching claim_codes by the plaintext code finds nothing', async () => {
    const { ws, superadmin } = await setupWorkspaceWithOwner();
    const now = new Date('2026-09-23T12:00:00Z');
    const { code } = await createClaimCode(db, {
      workspaceId: ws.id,
      createdByUserId: superadmin.id,
      previousOwnerAction: 'demote',
      now,
    });

    const byPlaintext = await db.select().from(claimCodes).where(eq(claimCodes.codeHash, code));
    expect(byPlaintext).toHaveLength(0);

    const byHash = await db
      .select()
      .from(claimCodes)
      .where(eq(claimCodes.codeHash, hashClaimCode(code)));
    expect(byHash).toHaveLength(1);
  });
});
