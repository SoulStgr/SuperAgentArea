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
    // A Windows CI/desktop box runs the suite with every file in parallel; a model-heavy test that takes a few seconds on a
    // quiet POSIX box can pass the default 5 s on the same box only because it is idle. Keep the tighter limit elsewhere.
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
  },
})
