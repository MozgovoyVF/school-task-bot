import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/globalSetup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/ai/pipeline/**',
        'src/ai/pseudonymize.ts',
        'src/ai/schemas.ts',
        'src/time/**',
        'src/domain/notifications/**',
        'src/domain/proposals/**',
        'src/domain/chats/retention.ts',
        'src/domain/people/claim.ts',
        'src/domain/people/erase.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
