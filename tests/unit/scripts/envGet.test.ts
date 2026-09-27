import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Regression for the final phase-0 review (I3): scripts/*.sh used to `source .env` as bash, which
// breaks on values docker compose and src/config/env.ts accept (`SUPERADMIN_TG_IDS=111, 222`,
// values with spaces) and would execute `$(...)` inside a value. scripts/lib/common.sh's env_get
// reads values literally instead.
const LIB = resolve('scripts/lib/common.sh');

describe('scripts/lib/common.sh env_get', () => {
  let dir: string;
  let envFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'stb-envget-'));
    envFile = join(dir, '.env');
    writeFileSync(
      envFile,
      [
        '# comment line',
        '',
        'SUPERADMIN_TG_IDS=111, 222',
        'DEFAULT_WORKSPACE_NAME=Французская школа',
        'COMPOSE_PROJECT=stb-dev          # stb-dev | stb-prod',
        'HASH_INSIDE=abc#def',
        'DATABASE_URL=postgres://stb:pw@db:5432/stb?sslmode=disable',
        'DOUBLE="quoted value # not a comment"',
        "SINGLE='single $HOME'",
        'export EXPORTED=yes',
        'EMPTY=',
        'INJECT=$(touch ' + join(dir, 'pwned') + ')',
        'CRLF=windows\r',
        'REPEATED=first',
        'REPEATED=second',
      ].join('\n') + '\n',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (key: string): string =>
    execFileSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; env_get "$1"`, 'bash', key], {
      env: { ...process.env, STB_ENV_FILE: envFile },
      encoding: 'utf8',
    });

  it.each([
    ['SUPERADMIN_TG_IDS', '111, 222'],
    ['DEFAULT_WORKSPACE_NAME', 'Французская школа'],
    ['COMPOSE_PROJECT', 'stb-dev'],
    ['HASH_INSIDE', 'abc#def'],
    ['DATABASE_URL', 'postgres://stb:pw@db:5432/stb?sslmode=disable'],
    ['DOUBLE', 'quoted value # not a comment'],
    ['SINGLE', 'single $HOME'],
    ['EXPORTED', 'yes'],
    ['EMPTY', ''],
    ['CRLF', 'windows'],
    ['REPEATED', 'second'],
    ['MISSING', ''],
  ])('%s -> %j', (key, expected) => {
    expect(get(key)).toBe(expected);
  });

  it('never evaluates values', () => {
    expect(get('INJECT')).toBe(`$(touch ${join(dir, 'pwned')})`);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  // compose (verified on v5.1.1) reads `KEY=   # note` as the literal value "# note", and so does
  // env_get. A key meant to be left empty in .env.example must therefore not carry an inline
  // comment, or `cp .env.example .env` ships the comment text as the value (e.g. an invalid
  // BOOTSTRAP_OWNER_TG_ID that makes EnvSchema reject the whole config).
  it('.env.example has no comment text leaking into values', () => {
    const keys = readFileSync('.env.example', 'utf8')
      .split('\n')
      .map((line) => /^([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(keys.length).toBeGreaterThan(10);
    const leaking = keys.filter((key) =>
      execFileSync('bash', ['-c', `source "${LIB}"; env_get "$1"`, 'bash', key], {
        env: { ...process.env, STB_ENV_FILE: resolve('.env.example') },
        encoding: 'utf8',
      }).startsWith('#'),
    );
    expect(leaking).toEqual([]);
  });

  it('fails when the .env file is missing', () => {
    expect(() =>
      execFileSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; env_get X`], {
        env: { ...process.env, STB_ENV_FILE: join(dir, 'nope.env') },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
