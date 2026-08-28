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
        // A new deploy changes chunk hashes; without these, the old service worker
        // keeps serving a cached shell that points at chunks the deploy deleted,
        // which blanks the app for returning visitors until a hard refresh. Take
        // control of open pages immediately and purge the stale precache so the
        // fresh shell + chunks load on the next visit.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Don't precache foreign chain-spec data the app never loads (Vara-only);
        // these stay fetchable on demand but don't bloat the service-worker install.
        globIgnores: [
          '**/ksmcc3-*.js',
          '**/westend2-*.js',
          '**/rococo_v2_2-*.js',
          '**/paseo-*.js',
        ],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // No runtime caching. The only rule here matched https://rpc.vara.network,
        // but the app talks to the node over a WebSocket, which service workers do
        // not intercept — so it never fired (audit L-13). Chain reads and prices
        // must not be served from a cache anyway: a stale balance or price on a
        // trading screen is worse than a slow one.
        runtimeCaching: [],
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
