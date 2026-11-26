import js from '@eslint/js'
import tseslint from 'typescript-eslint'
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.wrangler/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'worker/bindings.d.ts',
      '.vite/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
