import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { claimCodes, memberships, users, workspaces } from '../../db/schema/index.js';
import { CLAIM_CODE_TTL_HOURS } from '../../config/constants.js';
import { getOwner } from './repo.js';

/**
 * Deliberately excludes visually ambiguous characters (`I`, `O`, `0`, `1`):
 * codes are read aloud/retyped by hand (SPEC §10, point 3). Its length (32)
 * is a power of two, so `byte % CLAIM_ALPHABET.length` below is exactly
 * uniform over a full byte (256 / 32 = 8) — no modulo bias, no rejection
 * sampling needed.
 */
export const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CLAIM_CODE_LENGTH = 8;

/**
 * Generates an 8-character one-time claim code from {@link CLAIM_ALPHABET}.
 * `randomBytes` defaults to `node:crypto`'s CSPRNG; tests inject a
 * deterministic source instead of stubbing global `crypto`.
 */
export function generateClaimCode(randomBytes: (n: number) => Uint8Array = nodeRandomBytes): string {
  const bytes = randomBytes(CLAIM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    const byte = bytes[i];
    if (byte === undefined) {
      throw new Error('generateClaimCode: randomBytes returned fewer bytes than requested');
    }
    const char = CLAIM_ALPHABET[byte % CLAIM_ALPHABET.length];
    if (char === undefined) throw new Error('generateClaimCode: alphabet index out of range');
    code += char;
  }
  return code;
}

/** Uppercases and strips whitespace/hyphens, so users can type/paste a code with either. */
export function normalizeClaimCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * sha256 hex digest of the code — this is the only form ever stored in the
 * DB. Normalizes internally (idempotent on an already-normalized code), so
 * every caller hashes the same way regardless of whether it remembered to
 * normalize first (plan.md D42).
 */
export function hashClaimCode(code: string): string {
  return createHash('sha256').update(normalizeClaimCode(code)).digest('hex');
}

export type PreviousOwnerAction = 'demote' | 'remove';

export interface CreateClaimCodeInput {
  workspaceId: number;
  createdByUserId: number;
  previousOwnerAction: PreviousOwnerAction;
  now: Date;
}

/**
 * Generates a fresh one-time code and stores only its hash (CLAUDE.md §8 /
 * plan.md brief: `redeemClaimCode` — and, by the same rule, this function —
 * never persists or logs the plaintext code). `previousOwnerAction` decides,
 * at redeem time, what happens to whoever is the workspace's owner *then*
 * (there may be none yet — SPEC §10: superadmin can issue a code for an
 * empty workspace).
 */
export async function createClaimCode(
  db: DbOrTx,
  input: CreateClaimCodeInput,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateClaimCode();
  const codeHash = hashClaimCode(code);
  const expiresAt = new Date(input.now.getTime() + CLAIM_CODE_TTL_HOURS * 60 * 60 * 1000);

  await db.insert(claimCodes).values({
    workspaceId: input.workspaceId,
    codeHash,
    createdByUserId: input.createdByUserId,
    previousOwnerAction: input.previousOwnerAction,
    expiresAt,
  });

  return { code, expiresAt };
}

export interface RedeemClaimCodeInput {
  code: string;
  userId: number;
  now: Date;
}

export type RedeemClaimCodeResult =
  | { ok: true; workspaceId: number; previousOwnerUserId: number | null }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/**
 * Redeems a one-time claim code. Requires `Db` (not `DbOrTx`, unlike most of
 * `domain/`) because it must own its own transaction: everything from the
 * row lookups to `used_at` runs inside one `db.transaction` (plan.md brief,
 * Step 3; extended by plan.md D42).
 *
 * Locking, in this fixed order (D42 — always workspace row, then code row,
 * so the two locks below can never deadlock against each other):
 *
 * 1. An un-locked peek at `claim_codes` by hash, only to learn which
 *    workspace this code belongs to (`invalid` short-circuits here without
 *    taking any lock, for an unknown/garbage code).
 * 2. `SELECT ... FOR UPDATE` on that `workspaces` row. This is what
 *    serializes redemption *per workspace*, not just per code: two
 *    *different* still-valid codes for the same workspace lock different
 *    `claim_codes` rows and would otherwise never block each other, so both
 *    could pass their own row's checks and then race each other's
 *    membership writes straight into `memberships_one_owner`'s partial
 *    unique index — a raw, unhandled `duplicate key value` error (D42's
 *    repro). With the workspace lock, the loser simply blocks here until
 *    the winner commits.
 * 3. `SELECT ... FOR UPDATE` on the `claim_codes` row itself (plan.md
 *    brief's original Step 3) — this is what makes two concurrent redeems
 *    of the *same* code resolve to exactly one `ok`.
 *
 * Order matters for the writes too: the previous owner (if any, and if not
 * the very user redeeming — self-claims skip this to avoid losing their
 * existing membership's aliases/notification settings for no reason) is
 * demoted/removed *before* the new owner is assigned, so
 * `memberships_one_owner` is never transiently violated by having two owner
 * rows at once (Task 1.2).
 *
 * Finally (D42), every other still-unused code for this workspace is marked
 * used too: without this, a transfer isn't actually final for up to
 * `CLAIM_CODE_TTL_HOURS` — a sibling code from an earlier or repeated
 * `/transfer` tap would still redeem later and let the previous owner
 * reclaim the workspace.
 *
 * Never logs `input.code` (CLAUDE.md §8) — only `input.code`'s hash is ever
 * looked up, and no code (plaintext or hash) is included in the result.
 */
export async function redeemClaimCode(db: Db, input: RedeemClaimCodeInput): Promise<RedeemClaimCodeResult> {
  const codeHash = hashClaimCode(input.code);

  return db.transaction(async (tx) => {
    const peekRows = await tx
      .select({ workspaceId: claimCodes.workspaceId })
      .from(claimCodes)
      .where(eq(claimCodes.codeHash, codeHash))
      .limit(1);
    const peek = peekRows[0];
    if (!peek) return { ok: false, reason: 'invalid' };

    await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, peek.workspaceId))
      .for('update');

    const rows = await tx.select().from(claimCodes).where(eq(claimCodes.codeHash, codeHash)).for('update');
    const row = rows[0];
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.usedAt !== null) return { ok: false, reason: 'used' };
    if (row.expiresAt.getTime() <= input.now.getTime()) return { ok: false, reason: 'expired' };

    const owner = await getOwner(tx, row.workspaceId);
    const previousOwnerUserId = owner?.user.id ?? null;
    const isSelfClaim = owner?.user.id === input.userId;

    if (owner && !isSelfClaim) {
      if (row.previousOwnerAction === 'demote') {
        await tx.update(memberships).set({ role: 'member' }).where(eq(memberships.id, owner.membership.id));
      } else {
        await tx.delete(memberships).where(eq(memberships.id, owner.membership.id));
      }
    }

    const [existingMembership] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, input.userId)))
      .limit(1);

    if (existingMembership) {
      await tx.update(memberships).set({ role: 'owner' }).where(eq(memberships.id, existingMembership.id));
    } else {
      const [claimingUser] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
      await tx.insert(memberships).values({
        workspaceId: row.workspaceId,
        userId: input.userId,
        role: 'owner',
        displayName: claimingUser?.firstName ?? 'Owner',
      });
    }

    await tx
      .update(claimCodes)
      .set({ usedAt: input.now, usedByUserId: input.userId })
      .where(eq(claimCodes.id, row.id));

    await tx
      .update(claimCodes)
      .set({ usedAt: input.now })
      .where(
        and(
          eq(claimCodes.workspaceId, row.workspaceId),
          ne(claimCodes.id, row.id),
          isNull(claimCodes.usedAt),
        ),
      );

    return { ok: true, workspaceId: row.workspaceId, previousOwnerUserId };
  });
}
