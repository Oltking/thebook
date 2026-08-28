import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (no CDN). Chakra Petch = angular display; JetBrains Mono = data.
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource/chakra-petch/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './index.css'
import './styles/responsive.css'
import App from './App.tsx'
import { Providers } from './Providers'

// Safety net for deploys: if a lazy chunk 404s because a new build replaced it
// (the service worker's skipWaiting/clientsClaim usually prevents this, but a page
// open across the deploy can still race), reload to pull the fresh shell. A
// timestamp window rate-limits reloads to at most one per 30s, so a genuinely
// missing chunk can't spin a tight reload loop.
function reloadForStaleChunk() {
  const KEY = 'thebook:chunk-reloaded-at';
  const now = Date.now();
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (now - last < 30_000) return;
    sessionStorage.setItem(KEY, String(now));
  } catch { /* private mode: fall through and reload */ }
  window.location.reload();
}
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  reloadForStaleChunk();
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e as PromiseRejectionEvent)?.reason?.message ?? (e as PromiseRejectionEvent)?.reason ?? '');
  if (/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(msg)) {
    reloadForStaleChunk();
  }
});

// A chunk that is missing but served as the SPA fallback comes back as HTML with
// HTTP 200, so it never looks like a load failure. The browser instead refuses to
// execute it, citing the MIME type, or chokes on the leading `<`. Neither produces
// a rejection the handler above would see, which is how a returning user ends up on
// a broken page with nothing recovering it.
window.addEventListener('error', (e) => {
  const msg = String(e?.message ?? '');
  if (/Unexpected token '<'|MIME type|not a valid JavaScript MIME/i.test(msg)) {
    reloadForStaleChunk();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
)
