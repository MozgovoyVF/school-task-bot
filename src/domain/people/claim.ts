import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { claimCodes, memberships, users } from '../../db/schema/index.js';
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

/** sha256 hex digest of the (already normalized) code — this is the only form ever stored in the DB. */
export function hashClaimCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
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
  const codeHash = hashClaimCode(normalizeClaimCode(code));
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
 * row lookup to `used_at` runs inside one `db.transaction`, opened with
 * `SELECT ... FOR UPDATE` on the `claim_codes` row (plan.md brief, Step 3).
 * That row lock is what makes two concurrent redeems of the same code
 * resolve to exactly one `ok` — the loser's transaction blocks on the lock
 * until the winner commits, then re-reads `used_at` and sees it already set.
 *
 * Order matters: the previous owner (if any) is demoted/removed *before*
 * the new owner is assigned, so `memberships`' partial unique index
 * (`memberships_one_owner`, at most one `role='owner'` row per workspace —
 * Task 1.2) is never transiently violated by having two owner rows at once.
 *
 * Never logs `input.code` (CLAUDE.md §8) — only `input.code`'s hash is ever
 * looked up, and no code (plaintext or hash) is included in the result.
 */
export async function redeemClaimCode(db: Db, input: RedeemClaimCodeInput): Promise<RedeemClaimCodeResult> {
  const codeHash = hashClaimCode(normalizeClaimCode(input.code));

  return db.transaction(async (tx) => {
    const rows = await tx.select().from(claimCodes).where(eq(claimCodes.codeHash, codeHash)).for('update');
    const row = rows[0];
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.usedAt !== null) return { ok: false, reason: 'used' };
    if (row.expiresAt.getTime() <= input.now.getTime()) return { ok: false, reason: 'expired' };

    const owner = await getOwner(tx, row.workspaceId);
    const previousOwnerUserId = owner?.user.id ?? null;

    if (owner) {
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

    return { ok: true, workspaceId: row.workspaceId, previousOwnerUserId };
  });
}
