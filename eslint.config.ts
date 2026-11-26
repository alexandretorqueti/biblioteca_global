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
      // Diretório de deploy — tem tsconfig próprio, não deve ser lintado.
      'wt-deploy/**',
      // Worktrees locais do motor — já ignorados no git; varredura do eslint
      // neles gera parsing errors 'multiple candidate TSConfigRootDirs'.
      '.motor-v3-worktrees/**',
      'wt-motor-p0/**',
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
