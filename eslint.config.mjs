import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['tools/**/*.mjs', 'vite.config.js', 'eslint.config.mjs'],
    languageOptions: {
      // Playwright callbacks are serialized into the browser while their test
      // harness runs under Node, so its files intentionally use both realms.
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
