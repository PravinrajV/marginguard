import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { createAdvisory } from '../adapters/advisory';
import { createPayPal } from '../adapters/paypal';
import { SQLiteStore } from './store';
import { seedWithSandboxSale } from './sandbox-sale';
const store = new SQLiteStore('.data/marginguard.sqlite', { seed: seedWithSandboxSale });
const app = createApp(store, createAdvisory(process.env), createPayPal(process.env));
app.get('/*', serveStatic({ root: './dist' }));
const server = serve({ fetch: app.fetch, port: 8787, hostname: '127.0.0.1' }, () =>
  console.log('MarginGuard local / http://127.0.0.1:8787'),
);
function close() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
