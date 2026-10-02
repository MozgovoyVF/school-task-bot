import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { tasks, workspaces } from '../../../src/db/schema/index.js';
import { searchTasks, escapeLikePattern } from '../../../src/domain/tasks/search.js';
import type { NewTaskRow, TaskRow } from '../../../src/domain/tasks/repo.js';

const db = getTestDb();
beforeEach(() => truncateAll(db));

async function makeWorkspace() {
  return ensureDefaultWorkspace(db, { name: 'Школа', timezone: 'Europe/Moscow' });
}

async function insertTask(workspaceId: number, overrides: Partial<NewTaskRow> = {}): Promise<TaskRow> {
  const now = new Date('2026-09-20T09:00:00Z');
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: 'Подготовить расписание',
      origin: 'manual_dm',
      status: 'open',
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('expected the task row to be inserted');
  return row;
}

describe('searchTasks', () => {
  it('"расписан" finds both "Подготовить расписание" and "Расписание на ноябрь" via ILIKE', async () => {
    const ws = await makeWorkspace();
    const a = await insertTask(ws.id, { title: 'Подготовить расписание' });
    const b = await insertTask(ws.id, { title: 'Расписание на ноябрь' });
    const unrelated = await insertTask(ws.id, { title: 'Купить мел' });

    const r = await searchTasks(db, { workspaceId: ws.id, query: 'расписан', page: 1 });

    const ids = r.items.map((i) => i.id).sort((x, y) => x - y);
    expect(ids).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(ids).not.toContain(unrelated.id);
  });

  it('a typo ("расписане") still finds "Подготовить расписание" via trigram similarity', async () => {
    const ws = await makeWorkspace();
    const task = await insertTask(ws.id, { title: 'Подготовить расписание' });

    const r = await searchTasks(db, { workspaceId: ws.id, query: 'расписане', page: 1 });

    expect(r.items.map((i) => i.id)).toContain(task.id);
  });

  it('"50%" finds "Скидка 50% для группы" but not "Скидка 500" (literal %, not an ILIKE wildcard)', async () => {
    const ws = await makeWorkspace();
    const withPercent = await insertTask(ws.id, { title: 'Скидка 50% для группы' });
    const withoutPercent = await insertTask(ws.id, { title: 'Скидка 500' });

    const r = await searchTasks(db, { workspaceId: ws.id, query: '50%', page: 1 });

    const ids = r.items.map((i) => i.id);
    expect(ids).toContain(withPercent.id);
    expect(ids).not.toContain(withoutPercent.id);
  });

  it('a bare "_" query does not match every task (escaped, not an ILIKE single-char wildcard)', async () => {
    const ws = await makeWorkspace();
    await insertTask(ws.id, { title: 'Подготовить расписание' });
    await insertTask(ws.id, { title: 'Купить мел' });
    const withUnderscore = await insertTask(ws.id, { title: 'Задача A_B' });

    const r = await searchTasks(db, { workspaceId: ws.id, query: '_', page: 1 });

    expect(r.items.map((i) => i.id)).toEqual([withUnderscore.id]);
  });

  it('finds matches in description too, not only title', async () => {
    const ws = await makeWorkspace();
    const task = await insertTask(ws.id, {
      title: 'Собрание',
      description: 'Обсудить расписание на ноябрь',
    });

    const r = await searchTasks(db, { workspaceId: ws.id, query: 'расписание на ноябрь', page: 1 });

    expect(r.items.map((i) => i.id)).toContain(task.id);
  });

  it('also finds archived (done/cancelled) tasks — "по всем статусам"', async () => {
    const ws = await makeWorkspace();
    const done = await insertTask(ws.id, { title: 'Расписание уроков', status: 'done' });
    const cancelled = await insertTask(ws.id, { title: 'Расписание экзаменов', status: 'cancelled' });

    const r = await searchTasks(db, { workspaceId: ws.id, query: 'расписание', page: 1 });

    const ids = r.items.map((i) => i.id);
    expect(ids).toContain(done.id);
    expect(ids).toContain(cancelled.id);
  });

  it('paginates (5 per page) and reports the true total', async () => {
    const ws = await makeWorkspace();
    for (let i = 0; i < 7; i += 1) {
      await insertTask(ws.id, { title: `Расписание ${String(i)}` });
    }

    const page1 = await searchTasks(db, { workspaceId: ws.id, query: 'расписание', page: 1 });
    expect(page1.items).toHaveLength(5);
    expect(page1.total).toBe(7);

    const page2 = await searchTasks(db, { workspaceId: ws.id, query: 'расписание', page: 2 });
    expect(page2.items).toHaveLength(2);

    const ids = [...page1.items, ...page2.items].map((i) => i.id).sort((a, b) => a - b);
    expect(new Set(ids).size).toBe(7);
  });

  it('a page past the last one clamps rather than returning empty/negative offset', async () => {
    const ws = await makeWorkspace();
    await insertTask(ws.id, { title: 'Расписание' });

    const r = await searchTasks(db, { workspaceId: ws.id, query: 'расписание', page: 99 });

    expect(r.items).toHaveLength(1);
    expect(r.total).toBe(1);
  });

  it('never returns a task from a different workspace', async () => {
    const ws1 = await makeWorkspace();
    const [ws2] = await db
      .insert(workspaces)
      .values({ name: 'Другая школа', timezone: 'Europe/Moscow' })
      .returning();
    if (!ws2) throw new Error('expected the second workspace to be inserted');

    await insertTask(ws2.id, { title: 'Расписание в другой школе' });
    const own = await insertTask(ws1.id, { title: 'Расписание в нашей школе' });

    const r = await searchTasks(db, { workspaceId: ws1.id, query: 'расписание', page: 1 });

    expect(r.items.map((i) => i.id)).toEqual([own.id]);
  });
});

describe('escapeLikePattern', () => {
  it("escapes %, _ and \\ for a safe ILIKE ... ESCAPE '\\' substring match", () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    expect(escapeLikePattern('100%_free\\')).toBe('100\\%\\_free\\\\');
  });
});
