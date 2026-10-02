import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestDb, truncateAll } from '../../helpers/db.js';
import { fixedClock } from '../../helpers/clock.js';
import { createLogger } from '../../../src/ops/logger.js';
import { ensureDefaultWorkspace } from '../../../src/domain/workspaces/repo.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { memberships, analysisBatches } from '../../../src/db/schema/index.js';
import { extractSingle, type ExtractSingleDeps } from '../../../src/ai/pipeline/extractSingle.js';
import { LlmExtractionProvider } from '../../../src/ai/pipeline/extract.js';
import { FixtureClient } from '../../../src/ai/providers/fixture.js';
import type {
  AiProviders,
  ChatCompletionClient,
  CompletionResponse,
} from '../../../src/ai/providers/types.js';

// plan.md Task 3.10 / D19: `extractSingle` turns one piece of manually-triggered text (`/task`, DM free
// text, a DM forward batch) into exactly one `create` action, falling back to a draft titled from the
// first 80 characters whenever the model is unavailable or returns nothing usable. Lives in
// tests/integration (not tests/unit) because, like `src/ai/pipeline/processBatch.ts`'s own test
// (tests/integration/ai/processBatch.test.ts), the normal-extraction path genuinely needs the workspace's
// real membership/owner rows — faking Drizzle's query builder for that would be more fragile than using the
// real test database every other `src/ai/pipeline/**` integration test already relies on. The LLM call
// itself never touches the network either way (CLAUDE.md): every response comes from `tests/fixtures/llm/*.json`
// via `FixtureClient`.

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/llm/', import.meta.url));

function loadFixture(name: string): CompletionResponse {
  const raw = readFileSync(`${FIXTURES_DIR}${name}.json`, 'utf8');
  return JSON.parse(raw) as CompletionResponse;
}

const db = getTestDb();
beforeEach(() => truncateAll(db));

const UNUSED_CLIENT: ChatCompletionClient = {
  complete(): Promise<CompletionResponse> {
    throw new Error('ChatCompletionClient.complete should not have been called');
  },
};

function extractorFrom(script: ReadonlyArray<CompletionResponse | Error>): {
  extraction: AiProviders['extraction'];
  client: FixtureClient;
} {
  const client = new FixtureClient(script);
  return {
    extraction: new LlmExtractionProvider(client, {
      primary: 'fixture/primary',
      fallback: null,
      jsonSchema: null,
    }),
    client,
  };
}

async function makeDeps(
  clock: ReturnType<typeof fixedClock>,
  extraction: AiProviders['extraction'] | null,
): Promise<ExtractSingleDeps> {
  const workspace = await ensureDefaultWorkspace(db, { name: 'School', timezone: 'Europe/Moscow' });
  const logger = createLogger({ level: 'silent' });
  const ai: AiProviders | null =
    extraction === null
      ? null
      : {
          extraction,
          decision: null,
          client: UNUSED_CLIENT,
          models: { primary: 'fixture/primary', fallback: null },
        };
  return { db, ai, workspace, logger };
}

async function makeOwner(workspaceId: number, tgUserId: number, name: string) {
  const user = await upsertTelegramUser(db, { id: tgUserId, first_name: name });
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: 'owner', displayName: name });
  return user;
}

async function makeMember(workspaceId: number, tgUserId: number, name: string) {
  const user = await upsertTelegramUser(db, { id: tgUserId, first_name: name });
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: 'member', displayName: name });
  return user;
}

describe('extractSingle (plan.md Task 3.10, D19)', () => {
  it('extracts a single create action via the LLM pipeline and records its cost as a kind=manual batch', async () => {
    const clock = fixedClock('2026-10-02T09:00:00Z');
    const { extraction, client } = extractorFrom([loadFixture('valid_assignment')]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeOwner(deps.workspace.id, 900000001, 'Директор');
    const member = await makeMember(deps.workspace.id, 900000002, 'Маша');

    const now = clock.now();
    const action = await extractSingle(deps, {
      text: 'Маша, подготовь расписание к пятнице',
      authorUserId: member.id,
      workspaceId: deps.workspace.id,
      now,
    });

    expect(action.kind).toBe('create');
    expect(action.title).toBe('Подготовить расписание на октябрь');
    // The fixture's `assignee_ref` is `P1` — the owner's own membership was inserted first, so they hold
    // that code (`toParticipants`/`listMembersWithUsers` order by membership id).
    expect(action.assignee).toEqual({ type: 'user', userId: owner.id });
    expect(client.requests).toHaveLength(1);

    const batches = await db.select().from(analysisBatches);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      kind: 'manual',
      chatId: null,
      model: 'fixture/primary',
      error: null,
      promptVersion: 'extractor.single.v1',
    });
    expect(Number(batches[0]?.costUsd)).toBeCloseTo(0.00081, 5);
  });

  it('falls back to a draft titled from the first 80 characters when the LLM is disabled entirely, writing no cost record', async () => {
    const clock = fixedClock('2026-10-02T09:00:00Z');
    const deps = await makeDeps(clock, null);
    const longText = `${'x'.repeat(120)}`;

    const action = await extractSingle(deps, {
      text: longText,
      authorUserId: 999,
      workspaceId: deps.workspace.id,
      now: clock.now(),
    });

    expect(action.kind).toBe('create');
    expect(action.title).toBe('x'.repeat(80));
    expect(action.assignee).toEqual({ type: 'none' });
    expect(action.due).toEqual({
      dueAt: null,
      allDay: false,
      tz: null,
      inPast: false,
      invalid: false,
      dueText: null,
    });

    const batches = await db.select().from(analysisBatches);
    expect(batches).toHaveLength(0);
  });

  it('falls back to the draft (first 80 characters) when every model/attempt fails, still recording the failed batch', async () => {
    const clock = fixedClock('2026-10-02T09:00:00Z');
    // No fallback model configured (`extractorFrom`) — two failures on `fixture/primary` exhaust both
    // attempts (`MAX_ATTEMPTS_PER_MODEL=2`) and the provider throws `ExtractionError`.
    const { extraction } = extractorFrom([loadFixture('schema_violation'), loadFixture('invalid_json')]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeOwner(deps.workspace.id, 900000003, 'Директор');

    const action = await extractSingle(deps, {
      text: 'купить бумагу',
      authorUserId: owner.id,
      workspaceId: deps.workspace.id,
      now: clock.now(),
    });

    expect(action.title).toBe('купить бумагу');
    expect(action.assignee).toEqual({ type: 'none' });

    const batches = await db.select().from(analysisBatches);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.kind).toBe('manual');
    expect(batches[0]?.error).toBe('extraction_failed');
  });

  it('falls back to the draft when the model returns no actions at all', async () => {
    const clock = fixedClock('2026-10-02T09:00:00Z');
    const { extraction } = extractorFrom([loadFixture('empty_actions')]);
    const deps = await makeDeps(clock, extraction);
    const owner = await makeOwner(deps.workspace.id, 900000004, 'Директор');

    const action = await extractSingle(deps, {
      text: 'привет, как дела',
      authorUserId: owner.id,
      workspaceId: deps.workspace.id,
      now: clock.now(),
    });

    expect(action.title).toBe('привет, как дела');

    const batches = await db.select().from(analysisBatches);
    expect(batches).toHaveLength(1);
    // A real, successful call was made (and billed) even though it produced no usable action.
    expect(batches[0]?.error).toBeNull();
  });
});
