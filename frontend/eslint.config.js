import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// NOTE: the installed eslint-plugin-react-hooks / react-refresh use the pre-ESLint-10
// `context.getSourceCode` API and crash under this ESLint. Until they're upgraded we
// run the JS + TypeScript rule sets, which is enough to keep the CI quality gate real.
export default tseslint.config(
  { ignores: ['dist', 'src/lib/sails.ts', 'src/lib/token.ts', 'api/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    linterOptions: {
      // Some source still carries `react-hooks/*` disable directives; that plugin is
      // temporarily unloadable (see above), so don't fail on those unused directives.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // The generated Sails client and cross-program payloads are intentionally loose.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty catch blocks are intentional in best-effort fetches.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
