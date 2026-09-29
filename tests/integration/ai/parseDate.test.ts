import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { createLogger } from '../../../src/ops/logger.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { analysisBatches } from '../../../src/db/schema/index.js';
import { parseDateText, type ParseDateDeps } from '../../../src/ai/pipeline/parseDate.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import type { AiProviders, CompletionResponse } from '../../../src/ai/providers/types.js';

// plan.md Task 2.14: `parseDateText`'s own pipeline step (prompt `parseDate.v1` → `Due` schema →
// `resolveDue`), against `FixtureClient` (CLAUDE.md forbids real LLM calls in tests). Needs a real DB
// (reads `settings.fuzzyTimes`, writes its own `analysis_batches` row) — an integration test, unlike the
// pure `src/time/quickDue.ts` (`tests/unit/time/quickDue.test.ts`).

const db = getTestDb();
beforeEach(() => truncateAll(db));

function response(content: string): CompletionResponse {
  return {
    content,
    usage: { inputTokens: 12, outputTokens: 6, costUsd: 0.0002 },
    model: 'fixture/primary',
    raw: {},
  };
}

async function makeDeps(script: ReadonlyArray<CompletionResponse | Error>): Promise<ParseDateDeps> {
  const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const ai: AiProviders = {
    extraction: {
      extract() {
        throw new Error('extraction should not be used by parseDateText');
      },
    },
    decision: null,
    client: new FixtureClient(script),
    models: { primary: 'fixture/primary', fallback: null },
  };
  return { db, workspace, ai, logger: createLogger({ level: 'silent' }) };
}

const NOW = new Date('2026-09-23T12:00:00+03:00'); // среда, МСК

describe('parseDateText (plan.md Task 2.14)', () => {
  it('«в четверг в 11» resolves to 2026-09-24T08:00Z', async () => {
    const deps = await makeDeps([
      response(
        JSON.stringify({ due_local: '2026-09-24T11:00', time_hint: 'none', due_text: 'в четверг в 11' }),
      ),
    ]);

    const resolved = await parseDateText(deps, 'в четверг в 11', { zone: 'Europe/Moscow', now: NOW });

    expect(resolved).toMatchObject({
      dueAt: new Date('2026-09-24T08:00:00.000Z'),
      allDay: false,
      invalid: false,
    });

    const [batch] = await deps.db.select().from(analysisBatches).where(eq(analysisBatches.kind, 'manual'));
    expect(batch).toMatchObject({ kind: 'manual', status: 'done', model: 'fixture/primary', error: null });
  });

  it('a garbage response returns null (the user sees "не удалось разобрать дату")', async () => {
    const deps = await makeDeps([response('not valid json at all')]);

    const resolved = await parseDateText(deps, 'абвгд', { zone: 'Europe/Moscow', now: NOW });

    expect(resolved).toBeNull();
    const [batch] = await deps.db.select().from(analysisBatches).where(eq(analysisBatches.kind, 'manual'));
    expect(batch).toMatchObject({ kind: 'manual', status: 'done', error: 'invalid_json' });
  });

  it('a well-formed "nothing recognized" Due also returns null, not a dateless ResolvedDue', async () => {
    const deps = await makeDeps([
      response(JSON.stringify({ due_local: null, time_hint: 'none', due_text: null })),
    ]);

    const resolved = await parseDateText(deps, 'бла-бла-бла', { zone: 'Europe/Moscow', now: NOW });

    expect(resolved).toBeNull();
  });

  it('returns null without calling the client when AI is disabled', async () => {
    const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
    const deps: ParseDateDeps = { db, workspace, ai: null, logger: createLogger({ level: 'silent' }) };

    const resolved = await parseDateText(deps, '15.10 14:00', { zone: 'Europe/Moscow', now: NOW });

    expect(resolved).toBeNull();
  });
});
