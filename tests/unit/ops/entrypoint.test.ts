import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from '../../../src/ops/entrypoint.js';

// Regression for the final phase-0 review (I5): `import.meta.url` percent-encodes non-ASCII
// characters, `process.argv[1]` is the raw filesystem path, so a naive
// `import.meta.url === \`file://${process.argv[1]}\`` never matched on this repo's own checkout
// path (`/Users/.../Разработка/...`) and `pnpm db:migrate` silently did nothing.
describe('isEntrypoint', () => {
  let root: string;
  let script: string;
  let link: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'stb-entry-'));
    const dir = join(root, 'Разработка', 'French School');
    mkdirSync(dir, { recursive: true });
    script = join(dir, 'migrate.ts');
    writeFileSync(script, '');
    link = join(root, 'linked');
    symlinkSync(dir, link);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Node's ESM loader reports the *real* path in import.meta.url.
  const urlOf = (p: string): string => pathToFileURL(p).href;

  it('matches a path containing Cyrillic characters and spaces', () => {
    expect(isEntrypoint(urlOf(realpathSync(script)), script)).toBe(true);
  });

  it('matches when argv[1] goes through a symlink', () => {
    expect(isEntrypoint(urlOf(realpathSync(script)), join(link, 'migrate.ts'))).toBe(true);
  });

  it('does not match a different file', () => {
    expect(isEntrypoint(urlOf(realpathSync(script)), join(root, 'other.ts'))).toBe(false);
  });

  it('returns false when argv[1] is undefined (e.g. node -e / REPL)', () => {
    expect(isEntrypoint(urlOf(script), undefined)).toBe(false);
  });
});
