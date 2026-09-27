import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const noClock = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use clock.now() (src/time/clock.ts)',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use clock.now()',
  },
  {
    selector: "CallExpression[callee.object.name='DateTime'][callee.property.name='now']",
    message: 'Use clock.now()',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'src/db/migrations'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/domain/**', 'src/ai/**', 'src/time/**', 'src/scheduler/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['grammy', '@grammyjs/*'], message: 'Domain must not depend on grammY; use Messenger' },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noClock],
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
