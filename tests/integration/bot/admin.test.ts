import { describe, it, expect } from 'vitest';
import { createBotHarness } from '../../helpers/botHarness.js';
import { dmText } from '../../helpers/updates.js';
import { texts } from '../../../src/bot/texts/ru.js';
import type { FakeMessenger } from '../../helpers/fakeMessenger.js';

const SUPERADMIN = { id: 900000001, firstName: 'Anna' };
const STRANGER = { id: 42, firstName: 'Ivan' };

describe('/admin', () => {
  it('forbids a non-superadmin', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/admin'));

    expect(harness.replies(STRANGER.id)).toEqual([texts.common.forbidden]);
  });

  it('shows GIT_SHA and elapsed uptime for a superadmin', async () => {
    const harness = await createBotHarness();
    harness.clock.advance(90_000);

    await harness.send(dmText(SUPERADMIN, '/admin'));

    expect(harness.replies(SUPERADMIN.id)).toEqual([texts.admin.panel('test-sha', 90)]);
  });
});

describe('/testerror', () => {
  it('reports to superadmins and apologizes to the invoking superadmin', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/testerror'));

    const messenger = harness.deps.messenger as FakeMessenger;
    const report = messenger.sent.find((s) => s.chatId === SUPERADMIN.id);
    expect(report?.text).toContain('Test error from /testerror');
    expect(harness.replies(SUPERADMIN.id)).toContain(texts.errors.userFacing);
  });

  it('is silently ignored for a non-superadmin (no reply, no report)', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(STRANGER, '/testerror'));

    expect(harness.replies(STRANGER.id)).toEqual([]);
    const messenger = harness.deps.messenger as FakeMessenger;
    expect(messenger.sent).toEqual([]);
  });
});
