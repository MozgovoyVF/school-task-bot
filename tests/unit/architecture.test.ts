import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findForbiddenCyrillic } from '../helpers/architecture.js';

describe('findForbiddenCyrillic', () => {
  it('flags Cyrillic outside allowed files', () => {
    expect(
      findForbiddenCyrillic([
        { path: 'src/bot/handlers/dm.ts', content: "reply('Привет')" },
        { path: 'src/bot/texts/ru.ts', content: "export const hi = 'Привет'" },
        { path: 'src/config/constants.ts', content: "export const STOP = ['ок']" },
        { path: 'src/ai/policy.ts', content: 'const x = 1;' },
      ]),
    ).toEqual(['src/bot/handlers/dm.ts']);
  });
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('repository', () => {
  it('keeps user-facing Russian text in src/bot/texts/ru.ts', () => {
    const files = walk('src').map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    expect(findForbiddenCyrillic(files)).toEqual([]);
  });
});
