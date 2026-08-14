import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat config — Biblioteca Global v2.
 * Regra do projeto: 100% TypeScript, `no-explicit-any` = erro.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      // Backup da v1 — referência apenas, nunca lintado.
      'biblioteca_old/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
