import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.wrangler', 'cloudflare/.wrangler']),
  {
    files: ['cloudflare/worker.mjs', 'cloudflare/session.mjs', 'cloudflare/schedule.mjs', 'cloudflare/timetable.mjs', 'cloudflare/attendance-probe.mjs', 'cloudflare/plugin-signing.mjs'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['public/background.js', 'public/monitor/**/*.js', 'relay/web/*.js'],
    ...js.configs.recommended,
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    files: ['relay/*.mjs', 'tests/*.mjs', 'scripts/*.mjs', 'cloudflare/init.mjs', 'cloudflare/test-bark.mjs', 'cloudflare/import-timetable.mjs', 'cloudflare/config.mjs', 'cloudflare/wrangler-command.mjs'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
