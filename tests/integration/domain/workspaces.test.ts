import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import {
  ensureDefaultWorkspace,
  getWorkspace,
  getSettings,
  updateSettings,
  listWorkspaces,
} from '../../../src/domain/workspaces/repo.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

describe('workspaces repo', () => {
  it('ensureDefaultWorkspace called twice creates only one row', async () => {
    const first = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
    const second = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });

    expect(second.id).toBe(first.id);
    expect(await listWorkspaces(db)).toHaveLength(1);
  });

  it('getWorkspace returns the row by id, and null for a missing id', async () => {
    const created = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });

    expect((await getWorkspace(db, created.id))?.id).toBe(created.id);
    expect(await getWorkspace(db, created.id + 999)).toBeNull();
  });

  it('getSettings returns defaults for a freshly created workspace', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });

    const settings = await getSettings(db, ws.id);

    expect(settings.summary).toEqual({ enabled: true, time: '09:00', forMembers: false });
  });

  it('updateSettings persists the patch, getSettings returns the merged result', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });

    const updated = await updateSettings(db, ws.id, { summary: { time: '08:30' } });
    expect(updated.summary).toEqual({ enabled: true, time: '08:30', forMembers: false });

    const reloaded = await getSettings(db, ws.id);
    expect(reloaded.summary).toEqual({ enabled: true, time: '08:30', forMembers: false });
    expect(reloaded.reminders).toEqual(updated.reminders);
  });

  it('updateSettings throws on an invalid patch and does not persist it', async () => {
    const ws = await ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });

    await expect(updateSettings(db, ws.id, { summary: { time: '25:00' } })).rejects.toThrow();

    const settings = await getSettings(db, ws.id);
    expect(settings.summary.time).toBe('09:00');
  });
});
