import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { UnconfiguredAI } from '../src/adapters/advisory';
import { UnconfiguredPayPalSandbox, type PayPalSandboxAdapter } from '../src/adapters/paypal';
import { createApp } from '../src/server/app';
import { PublicDemoRefusedError, resolveRuntimeConfig } from '../src/server/runtime-config';
import { SQLiteStore } from '../src/server/store';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const secret = 'test-sandbox-client-secret';

it('keeps the default server on loopback when public demo mode is off', () => {
  const config = resolveRuntimeConfig({
    HOST: '0.0.0.0',
    PORT: '39999',
    PAYPAL_SANDBOX_CLIENT_ID: 'test-sandbox-client-id',
    PAYPAL_SANDBOX_CLIENT_SECRET: secret,
  });
  expect(config).toMatchObject({
    publicDemo: false,
    hostname: '127.0.0.1',
    port: 8787,
    publicOrigin: null,
    secureCookies: false,
    allowedHosts: ['127.0.0.1', 'localhost'],
  });
  expect([...config.allowedOrigins]).toEqual([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ]);
});

it('treats a blank PUBLIC_ORIGIN as the loopback server', () => {
  const config = resolveRuntimeConfig({ PUBLIC_ORIGIN: '   ', HOST: '0.0.0.0', PORT: '8080' });
  expect(config.publicDemo).toBe(false);
  expect(config.hostname).toBe('127.0.0.1');
  expect(config.port).toBe(8787);
});

it('allowlists the public https host and uses the platform bind', () => {
  const config = resolveRuntimeConfig({ PUBLIC_ORIGIN: 'https://Example.COM/' });
  expect(config).toMatchObject({
    publicDemo: true,
    hostname: '0.0.0.0',
    port: 8787,
    publicOrigin: 'https://example.com',
    secureCookies: true,
  });
  expect(config.allowedHosts).toEqual(['127.0.0.1', 'localhost', 'example.com']);
  expect(config.allowedOrigins.has('https://example.com')).toBe(true);
  const explicit = resolveRuntimeConfig({
    PUBLIC_ORIGIN: 'https://demo.example:8443',
    HOST: '0.0.0.0',
    PORT: '8080',
  });
  expect(explicit.hostname).toBe('0.0.0.0');
  expect(explicit.port).toBe(8080);
  expect(explicit.publicOrigin).toBe('https://demo.example:8443');
  expect(explicit.allowedHosts).toContain('demo.example');
  expect(explicit.allowedOrigins.has('https://demo.example')).toBe(false);
});

it('rejects a public origin that is not a bare https origin', () => {
  for (const origin of [
    'http://example.com',
    'https://example.com/demo',
    'https://user:password@example.com',
    'https://example.com?next=/',
    'https://127.0.0.1',
    'https://localhost',
    'not a url',
  ]) {
    expect(() => resolveRuntimeConfig({ PUBLIC_ORIGIN: origin }), origin).toThrow(
      PublicDemoRefusedError,
    );
  }
});

it('refuses public demo startup when either PayPal sandbox credential is set', () => {
  for (const creds of [
    { PAYPAL_SANDBOX_CLIENT_ID: 'test-sandbox-client-id' },
    { PAYPAL_SANDBOX_CLIENT_SECRET: secret },
    {
      PAYPAL_SANDBOX_CLIENT_ID: 'test-sandbox-client-id',
      PAYPAL_SANDBOX_CLIENT_SECRET: secret,
    },
    { PAYPAL_SANDBOX_CLIENT_ID: '  test-sandbox-client-id  ' },
  ]) {
    try {
      resolveRuntimeConfig({ PUBLIC_ORIGIN: 'https://example.com', ...creds });
      expect.fail('public demo mode started with a PayPal credential');
    } catch (error) {
      expect(error).toBeInstanceOf(PublicDemoRefusedError);
      expect((error as Error).message).toMatch(/fixtures only/);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('test-sandbox-client-id');
    }
  }
});

it('does not require Cloudflare credentials for the public fixture demo', () => {
  const blank = resolveRuntimeConfig({
    PUBLIC_ORIGIN: 'https://example.com',
    PAYPAL_SANDBOX_CLIENT_ID: ' ',
    PAYPAL_SANDBOX_CLIENT_SECRET: '',
  });
  const withAi = resolveRuntimeConfig({
    PUBLIC_ORIGIN: 'https://example.com',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'token',
  });
  expect(blank.publicDemo).toBe(true);
  expect(withAi.publicDemo).toBe(true);
  expect(withAi.allowedHosts).toContain('example.com');
});

it('serves the configured public host with disconnected adapters and no network call', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Network forbidden in this test'));
  const store = new SQLiteStore(':memory:');
  try {
    const security = resolveRuntimeConfig({ PUBLIC_ORIGIN: 'https://example.com' });
    const app = createApp(store, new UnconfiguredAI(), new UnconfiguredPayPalSandbox(), security);
    const opened = await app.request('https://example.com/api/session');
    expect(opened.status).toBe(200);
    const cookie = opened.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-mg_session=');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Domain=/i);
    const body = await opened.json();
    expect(body).toMatchObject({
      mode: 'PUBLIC_FIXTURE_DEMO',
      paypal: 'NOT_CONNECTED',
      ai: 'NOT_CONNECTED',
    });
    const headers = {
      Cookie: cookie.split(';')[0],
      Origin: 'https://example.com',
      'X-CSRF-Token': body.csrf,
      'Content-Type': 'application/json',
    };
    const reset = await app.request('https://example.com/api/reset', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(reset.status).toBe(200);
    expect(reset.headers.get('set-cookie')).toContain('Secure');
    expect(
      (
        await app.request('https://example.com/api/reset', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await app.request('http://example.com/api/session')).status).toBe(200);
    expect((await app.request('https://www.example.com/api/session')).status).toBe(403);
    const denied = await app.request('https://evil.example/api/session');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'This host is not allowed for the fixture demo.',
    });
    expect((await app.request('http://127.0.0.1:8787/api/session')).status).toBe(200);
    expect(network).not.toHaveBeenCalled();
  } finally {
    store.close();
    network.mockRestore();
  }
});

it('refuses to build a public app around a configured PayPal adapter', () => {
  const store = new SQLiteStore(':memory:');
  const paypal: PayPalSandboxAdapter = {
    configured: true,
    refund: () => Promise.reject(new Error('refund must not be called')),
  };
  try {
    expect(() =>
      createApp(
        store,
        new UnconfiguredAI(),
        paypal,
        resolveRuntimeConfig({ PUBLIC_ORIGIN: 'https://example.com' }),
      ),
    ).toThrow(PublicDemoRefusedError);
  } finally {
    store.close();
  }
});

it('default app access stays limited to loopback hosts', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Network forbidden in this test'));
  const store = new SQLiteStore(':memory:');
  try {
    const app = createApp(store);
    const denied = await app.request('http://evil.example/api/session');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Local loopback access only.' });
    const allowed = await app.request('http://localhost:8787/api/session');
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).mode).toBe('LOCAL_FIXTURES');
    const cookie = allowed.headers.get('set-cookie') ?? '';
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('__Host-');
    expect(network).not.toHaveBeenCalled();
  } finally {
    store.close();
    network.mockRestore();
  }
});

it('npm start without PUBLIC_ORIGIN listens on 127.0.0.1 only', async () => {
  expect(portListening(8787)).toBe(false);
  const child = startServer({ HOST: '0.0.0.0', PORT: '39999' });
  try {
    await child.waitFor((output) => output.stdout.includes('http://127.0.0.1:8787'));
    expect(child.output().stdout).not.toContain('public fixture demo');
    expect(listeningAddresses(8787)).toEqual(['127.0.0.1']);
    expect(portListening(39999)).toBe(false);
  } finally {
    await child.stop();
  }
});

it('public demo mode binds the platform address when PayPal credentials are absent', async () => {
  const port = 18787;
  expect(portListening(port)).toBe(false);
  const child = startServer({ PUBLIC_ORIGIN: 'https://example.com', PORT: String(port) });
  try {
    await child.waitFor((output) =>
      output.stdout.includes(
        `MarginGuard public fixture demo / https://example.com / bind 0.0.0.0:${port}`,
      ),
    );
    expect(listeningAddresses(port)).toContain('0.0.0.0');
  } finally {
    await child.stop();
  }
});

it('public demo mode exits before listen when a PayPal credential is set', async () => {
  const port = 18788;
  const child = startServer({
    PUBLIC_ORIGIN: 'https://example.com',
    HOST: '127.0.0.1',
    PORT: String(port),
    PAYPAL_SANDBOX_CLIENT_SECRET: secret,
  });
  try {
    const code = await child.exited;
    expect(code).toBe(1);
    const output = child.output();
    expect(output.stderr).toMatch(/fixtures only/);
    expect(output.stderr).not.toContain(secret);
    expect(output.stdout).not.toContain('public fixture demo');
    expect(portListening(port)).toBe(false);
  } finally {
    await child.stop();
  }
});

function startServer(extra: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/server/index.ts'],
    {
      cwd: root,
      env: childEnv(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit\n${stdout}\n${stderr}`));
    }, 8000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return {
    exited,
    output: () => ({ stdout, stderr }),
    async waitFor(match: (output: { stdout: string; stderr: string }) => boolean) {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (match({ stdout, stderr })) return;
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(`timed out waiting for server\n${stdout}\n${stderr}`);
    },
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited.catch(() => 1);
      clearTimeout(killer);
    },
  };
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
  };
  return { ...env, ...extra };
}

function listeningAddresses(port: number): string[] {
  const needle = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const found = new Set<string>();
  let table = '';
  try {
    table = readFileSync('/proc/net/tcp', 'utf8');
  } catch {
    return [];
  }
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const local = parts[1]?.toUpperCase();
    if (!local || parts[3]?.toUpperCase() !== '0A' || !local.endsWith(needle)) continue;
    const address = local.slice(0, local.length - needle.length);
    found.add(ipv4FromProc(address));
  }
  return [...found].sort();
}

function portListening(port: number): boolean {
  return listeningAddresses(port).length > 0;
}

function ipv4FromProc(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes
    .reverse()
    .map((byte) => Number.parseInt(byte, 16))
    .join('.');
}
