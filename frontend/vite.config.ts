import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'logo.png'],
      manifest: {
        name: 'thebookdex',
        short_name: 'thebookdex',
        description: 'Decentralized exchange on Vara Network',
        theme_color: '#0b0e11',
        background_color: '#0b0e11',
        display: 'standalone',
        display_override: ['window-controls-overlay'],
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'logo.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/rpc\.vara\.network\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'vara-rpc-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60, // 1 hour
              },
            },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('@polkadot')) return 'polkadot';
          if (id.includes('@gear-js')) return 'gear';
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      /* Forward /api/* to Vercel dev server when running `vercel dev` locally */
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom', '@polkadot/util', '@polkadot/util-crypto', '@polkadot/api', '@polkadot/types'],
  },
  optimizeDeps: {
    include: ['@gear-js/api', '@gear-js/react-hooks', 'sails-js', '@polkadot/util', '@polkadot/util-crypto', '@polkadot/types'],
  },
})
