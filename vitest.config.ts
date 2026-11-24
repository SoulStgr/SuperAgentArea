import { configDefaults, defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
// The service script is POSIX-only by design (Python fcntl, tmux, sleep); its spec cannot run on Windows.
const windowsExcludes = process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: [...configDefaults.exclude, ...windowsExcludes],
    setupFiles: ['vitest.setup.ts'],
  },
})
