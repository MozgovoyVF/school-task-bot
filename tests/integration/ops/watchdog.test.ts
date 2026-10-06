import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { FakeMessenger } from '../../helpers/fakeMessenger.js';
import { createErrorReporter } from '../../../src/ops/errorReporter.js';
import { createLogger } from '../../../src/ops/logger.js';
import { checkTickerGapOnStart } from '../../../src/ops/watchdog.js';
import { setState } from '../../../src/domain/system/appState.js';
import { HEARTBEAT_KEY } from '../../../src/scheduler/ticker.js';
import { texts } from '../../../src/bot/texts/ru.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const SUPERADMIN_IDS = [111, 222];

function makeDeps(clock: ReturnType<typeof fixedClock>) {
  const messenger = new FakeMessenger();
  const logger = createLogger({ level: 'silent' });
  const errors = createErrorReporter({ db, messenger, clock, logger, superadminIds: SUPERADMIN_IDS });
  return { db, clock, logger, errors, messenger };
}

describe('checkTickerGapOnStart', () => {
  it('alerts every superadmin when the stored heartbeat is more than 2 minutes stale', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    // The heartbeat was written 5 minutes before "now" — e.g. the process crashed or was redeployed
    // and the ticker loop was not running in the meantime.
    const heartbeatAt = new Date(clock.now().getTime() - 5 * 60_000);
    await setState(db, HEARTBEAT_KEY, { at: heartbeatAt.toISOString() }, heartbeatAt);
    const deps = makeDeps(clock);

    await checkTickerGapOnStart(deps);

    expect(deps.messenger.sent.map((m) => m.chatId).sort()).toEqual(SUPERADMIN_IDS.sort());
    for (const m of deps.messenger.sent) {
      expect(m.text).toBe(texts.errors.tickerGap(5 * 60_000));
      expect(m.text).toContain('5 мин');
    }
  });

  it('sends nothing when the stored heartbeat is only 30 seconds old', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const heartbeatAt = new Date(clock.now().getTime() - 30_000);
    await setState(db, HEARTBEAT_KEY, { at: heartbeatAt.toISOString() }, heartbeatAt);
    const deps = makeDeps(clock);

    await checkTickerGapOnStart(deps);

    expect(deps.messenger.sent).toEqual([]);
  });

  it('sends nothing when there is no heartbeat row at all (fresh install, never ticked)', async () => {
    const clock = fixedClock('2026-09-23T12:00:00Z');
    const deps = makeDeps(clock);

    await checkTickerGapOnStart(deps);

    expect(deps.messenger.sent).toEqual([]);
  });
});
