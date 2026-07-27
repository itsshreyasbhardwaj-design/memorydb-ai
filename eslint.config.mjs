import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**',
      '**/*.d.ts', '**/.venv/**', '**/playwright-report/**', '**/test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      // Underscore-prefixed bindings are an explicit "intentionally unused" marker.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` is banned, but explicit `unknown` casts at boundaries are fine.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Tests and benchmarks legitimately use loose typing and console output.
    files: ['**/*.test.ts', '**/*.bench.ts', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.tsx'],
    rules: {
      // React components frequently take structurally-typed props.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
