import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBotHarness } from '../../helpers/botHarness.js';
import { dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { users } from '../../../src/db/schema/index.js';

const SUPERADMIN = { id: 900000001, firstName: 'Anna' };
const STRANGER = { id: 42, firstName: 'Ivan' };

describe('/start', () => {
  it('shows the superadmin help text and marks dm_started_at', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/start'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([texts.start.superadmin()]);

    const [row] = await harness.db.select().from(users).where(eq(users.tgUserId, SUPERADMIN.id));
    expect(row?.dmStartedAt).not.toBeNull();
  });

  it('shows a neutral text for a non-superadmin stranger', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/start'));

    expect(harness.replies(STRANGER.id)).toEqual([texts.start.stranger()]);
  });

  it('/help renders the same overview as /start', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/help'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([texts.start.superadmin()]);
  });
});
