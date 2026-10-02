import { describe, it, expect } from 'vitest';
import { loadPrompt, renderTemplate } from '../../../src/ai/prompts.js';
import { parseExtraction } from '../../../src/ai/schemas.js';

const DATA_VARS = [
  'now_local',
  'weekday',
  'workspace_tz',
  'participants',
  'open_tasks',
  'open_proposals',
  'context_messages',
  'new_messages',
];

describe('loadPrompt (D27)', () => {
  it('substitutes the profile into system and leaves no {profile} placeholder', () => {
    const bundle = loadPrompt({ name: 'extractor', version: 'extractor.v1', profile: 'school_ru' });
    expect(bundle.system).toContain('школы французского языка');
    expect(bundle.system).not.toContain('{profile}');
  });

  it('userTemplate contains all 8 data variables', () => {
    const bundle = loadPrompt({ name: 'extractor', version: 'extractor.v1', profile: 'school_ru' });
    for (const name of DATA_VARS) {
      expect(bundle.userTemplate).toContain(`{${name}}`);
    }
  });

  it('loads examples.school_ru.json, and every example parses as a valid ExtractionResult', () => {
    const bundle = loadPrompt({ name: 'extractor', version: 'extractor.v1', profile: 'school_ru' });
    expect(bundle.examples.length).toBeGreaterThanOrEqual(8);
    // D47 (plan.md Task 3.15) added 3 more synthetic examples (13 total) — bumped from 10.
    expect(bundle.examples.length).toBeLessThanOrEqual(14);
    for (const example of bundle.examples) {
      const parsed: unknown = JSON.parse(example.assistant);
      const result = parseExtraction(parsed);
      expect(result.ok).toBe(true);
    }
  });

  it('extractor.single shares the same 8 data variables and its own single-action instruction', () => {
    const bundle = loadPrompt({
      name: 'extractor.single',
      version: 'extractor.single.v1',
      profile: 'school_ru',
    });
    for (const name of DATA_VARS) {
      expect(bundle.userTemplate).toContain(`{${name}}`);
    }
    expect(bundle.system).toContain('ровно одно действие create');
  });

  it('parseDate has no {profile} placeholder and no few-shot examples', () => {
    const bundle = loadPrompt({ name: 'parseDate', version: 'parseDate.v1', profile: 'school_ru' });
    expect(bundle.system).not.toContain('{profile}');
    expect(bundle.examples).toEqual([]);
  });

  it('rejects a version that does not match the given name', () => {
    expect(() => loadPrompt({ name: 'parseDate', version: 'extractor.v1', profile: 'school_ru' })).toThrow();
  });
});

describe('renderTemplate', () => {
  it('fills in a known variable', () => {
    expect(renderTemplate('a {x}', { x: 'ok' })).toBe('a ok');
  });

  it('throws on a missing variable', () => {
    expect(() => renderTemplate('a {x}', {})).toThrow();
  });

  it('never treats JSON-like text (no leading word char after "{") as a placeholder', () => {
    expect(renderTemplate('return {"actions": []}', {})).toBe('return {"actions": []}');
  });
});
