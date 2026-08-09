import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { VitePWA } from 'vite-plugin-pwa'

const holidaysAsset = () => ({
  name: 'atr-desk-holidays-asset',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'holidays.json',
      source: readFileSync(new URL('./holidays.json', import.meta.url), 'utf8'),
    })
  },
})

export default defineConfig({
  base: '/nepse-momentum-trader/',
  plugins: [
    holidaysAsset(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon-192.png', 'icon-512.png', 'holidays.json'],
      manifest: {
        name: 'ATR Desk // NEPSE Momentum Tracker',
        short_name: 'ATR Desk',
        description: 'Local-first NEPSE momentum risk desk',
        theme_color: '#0b1117',
        background_color: '#0b1117',
        display: 'standalone',
        start_url: '/nepse-momentum-trader/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json,woff2}'],
        runtimeCaching: [{
          urlPattern: /\/holidays\.json$/,
          handler: 'NetworkFirst',
          options: { cacheName: 'nepse-holidays', expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 370 } }
        }]
      }
    })
  ],
  server: { port: 5173, strictPort: true },
  build: { sourcemap: true }
})
