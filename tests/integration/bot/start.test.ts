import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness } from '../../helpers/botHarness.js';
import { dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { users } from '../../../src/db/schema/index.js';

const SUPERADMIN = { id: 900000001, firstName: 'Anna' };
const STRANGER = { id: 42, firstName: 'Ivan' };

/**
 * The full first-run `/timezone`-picker flow (button taps, `users.timezone`
 * persistence, the role-help follow-up) is covered end to end in
 * `tests/integration/bot/timezone.test.ts` (Task 1.4). These tests stick to
 * `/start`'s own entry-point responsibilities: marking `dm_started_at`, and
 * gating into that picker versus the plain welcome text.
 */
describe('/start', () => {
  it('marks dm_started_at on first contact, regardless of role', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/start'));

    const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, SUPERADMIN.id));
    expect(row?.dmStartedAt).not.toBeNull();
  });

  it("offers the /timezone picker instead of the welcome text on a brand-new user's first /start", async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/start'));

    expect(harness.replies(STRANGER.id)).toEqual([texts.timezone.prompt]);
  });
});
