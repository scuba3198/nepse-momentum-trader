import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(new URL('./tests/pwa-register.mock.js', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/vitest.setup.js'],
    include: ['tests/component.test.js'],
    coverage: { reporter: ['text'] }
  }
})
