import { describe, it, expect } from 'vitest';
import { loadEnv, EnvError } from '../../../src/config/env.js';

const base = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  SUPERADMIN_TG_IDS: '111, 222',
  DATABASE_URL: 'postgres://stb:x@db:5432/stb',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.SUPERADMIN_TG_IDS).toEqual([111, 222]);
    expect(env.APP_ENV).toBe('dev');
    expect(env.TELEGRAM_MODE).toBe('polling');
    expect(env.DEFAULT_TIMEZONE).toBe('Europe/Moscow');
    expect(env.DEFAULT_WORKSPACE_NAME).toBe('Школа');
    expect(env.MIGRATE_ON_START).toBe(true);
    expect(env.LLM_DAILY_BUDGET_USD).toBe(1);
    expect(env.AI_PREFILTER).toBe('off');
    expect(env.AI_PREFILTER_THRESHOLD).toBe(0.15);
    expect(env.HTTP_PORT).toBe(3000);
    expect(env.GIT_SHA).toBe('dev');
  });

  it('lists every missing required variable in one error', () => {
    try {
      loadEnv({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as EnvError).message;
      expect(msg).toContain('TELEGRAM_BOT_TOKEN');
      expect(msg).toContain('SUPERADMIN_TG_IDS');
      expect(msg).toContain('DATABASE_URL');
    }
  });

  it('parses booleans strictly ("false" is false)', () => {
    expect(loadEnv({ ...base, MIGRATE_ON_START: 'false' }).MIGRATE_ON_START).toBe(false);
    expect(() => loadEnv({ ...base, MIGRATE_ON_START: 'yes' })).toThrow(EnvError);
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ ...base, SUPERADMIN_TG_IDS: 'abc' })).toThrow(/SUPERADMIN_TG_IDS/);
    expect(() => loadEnv({ ...base, DEFAULT_TIMEZONE: 'Mars/Base' })).toThrow(/DEFAULT_TIMEZONE/);
    expect(() => loadEnv({ ...base, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
    expect(() => loadEnv({ ...base, AI_PREFILTER_THRESHOLD: '1.5' })).toThrow(/AI_PREFILTER_THRESHOLD/);
  });

  it('requires webhook settings in webhook mode and TypeSafe key for jev', () => {
    expect(() => loadEnv({ ...base, TELEGRAM_MODE: 'webhook' })).toThrow(/TELEGRAM_WEBHOOK_URL/);
    expect(() => loadEnv({ ...base, AI_PREFILTER: 'jev' })).toThrow(/TYPESAFE_API_KEY/);
  });

  it('treats empty strings as unset (as in .env.example)', () => {
    expect(
      loadEnv({ ...base, BOOTSTRAP_OWNER_TG_ID: '', OPENROUTER_API_KEY: '' }).BOOTSTRAP_OWNER_TG_ID,
    ).toBeUndefined();
  });
});
