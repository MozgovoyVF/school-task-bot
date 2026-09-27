import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { getTestDb, truncateAll } from '../../../helpers/db.js';
import { getState, setState } from '../../../../src/domain/system/appState.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

const HeartbeatSchema = z.object({ at: z.string() });

describe('appState', () => {
  it('returns null for a key with no row', async () => {
    expect(await getState(db, 'heartbeat', HeartbeatSchema)).toBeNull();
  });

  it('round-trips a value through set/get, validated by the given schema', async () => {
    const now = new Date('2026-09-23T12:00:00Z');
    await setState(db, 'heartbeat', { at: '2026-09-23T12:00:00Z' }, now);

    expect(await getState(db, 'heartbeat', HeartbeatSchema)).toEqual({ at: '2026-09-23T12:00:00Z' });
  });

  it('overwrites the value and updated_at on a second set for the same key', async () => {
    const first = new Date('2026-09-23T12:00:00Z');
    const second = new Date('2026-09-23T13:00:00Z');
    await setState(db, 'heartbeat', { at: '2026-09-23T12:00:00Z' }, first);
    await setState(db, 'heartbeat', { at: '2026-09-23T13:00:00Z' }, second);

    expect(await getState(db, 'heartbeat', HeartbeatSchema)).toEqual({ at: '2026-09-23T13:00:00Z' });
  });

  it('rejects a stored value that fails the given schema', async () => {
    const now = new Date('2026-09-23T12:00:00Z');
    await setState(db, 'heartbeat', { wrong: true }, now);

    await expect(getState(db, 'heartbeat', HeartbeatSchema)).rejects.toThrow();
  });
});
