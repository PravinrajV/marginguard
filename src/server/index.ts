import { writeSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { createAdvisory } from '../adapters/advisory';
import { UnconfiguredPayPalSandbox, createPayPal } from '../adapters/paypal';
import { SQLiteStore } from './store';
import { seedWithSandboxSale } from './sandbox-sale';
import { PublicDemoRefusedError, resolveRuntimeConfig } from './runtime-config';

const runtime = boot();

function boot() {
  let store: SQLiteStore | undefined;
  try {
    const config = resolveRuntimeConfig(process.env);
    const paypal = config.publicDemo ? new UnconfiguredPayPalSandbox() : createPayPal(process.env);
    store = new SQLiteStore('.data/marginguard.sqlite', { seed: seedWithSandboxSale });
    const app = createApp(store, createAdvisory(process.env), paypal, config);
    app.get('/*', serveStatic({ root: './dist' }));
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, () => {
      console.log(
        config.publicDemo
          ? `MarginGuard public fixture demo / ${config.publicOrigin} / bind ${config.hostname}:${config.port}`
          : 'MarginGuard local / http://127.0.0.1:8787',
      );
    });
    return { store, server };
  } catch (error) {
    store?.close();
    if (error instanceof PublicDemoRefusedError) {
      writeSync(2, `${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
function close() {
  runtime.server.close(() => {
    runtime.store.close();
    process.exit(0);
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
