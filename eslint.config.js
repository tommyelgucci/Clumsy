import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `functions/` is a separate, self-contained deployable package (its
  // own package.json/node_modules, Node/Cloud Functions runtime instead
  // of the browser) with its own lint step (`npm --prefix functions run
  // lint`, currently `tsc --noEmit`) — not this (browser-oriented, React
  // Hooks-aware) config's concern.
  { ignores: ['dist', 'ios', 'functions'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
