/**
 * Loopback is the default. Public fixture demo mode is opt-in.
 * A non-empty PayPal sandbox credential prevents that mode from starting.
 */
export class PublicDemoRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicDemoRefusedError';
  }
}

export type RequestSecurity = {
  publicDemo: boolean;
  allowedHosts: readonly string[];
  allowedOrigins: ReadonlySet<string>;
  secureCookies: boolean;
};

export type RuntimeConfig = RequestSecurity & {
  hostname: string;
  port: number;
  publicOrigin: string | null;
};

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'] as const;
const LOOPBACK_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
];
const LOCAL_PORT = 8787;
const REFUSAL =
  'Public fixture demo cannot start while PAYPAL_SANDBOX_CLIENT_ID or PAYPAL_SANDBOX_CLIENT_SECRET is set. Unset both. This mode serves fixtures only and must not send PayPal sandbox refunds.';

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const rawOrigin = env.PUBLIC_ORIGIN?.trim() ?? '';
  if (!rawOrigin) return localConfig();
  if (
    credentialPresent(env.PAYPAL_SANDBOX_CLIENT_ID) ||
    credentialPresent(env.PAYPAL_SANDBOX_CLIENT_SECRET)
  ) {
    throw new PublicDemoRefusedError(REFUSAL);
  }
  const origin = parsePublicOrigin(rawOrigin);
  return {
    publicDemo: true,
    hostname: bindHost(env.HOST),
    port: bindPort(env.PORT),
    publicOrigin: origin.origin,
    allowedHosts: [...LOOPBACK_HOSTS, origin.hostname],
    allowedOrigins: new Set([...LOOPBACK_ORIGINS, origin.origin]),
    secureCookies: true,
  };
}

export function localRequestSecurity(): RequestSecurity {
  return localConfig();
}

function localConfig(): RuntimeConfig {
  return {
    publicDemo: false,
    hostname: '127.0.0.1',
    port: LOCAL_PORT,
    publicOrigin: null,
    allowedHosts: [...LOOPBACK_HOSTS],
    allowedOrigins: new Set(LOOPBACK_ORIGINS),
    secureCookies: false,
  };
}

function credentialPresent(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

function parsePublicOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicDemoRefusedError(
      'PUBLIC_ORIGIN must be an absolute https origin, such as https://example.com.',
    );
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !host ||
    host.endsWith('.')
  ) {
    throw new PublicDemoRefusedError(
      'PUBLIC_ORIGIN must be an absolute https origin, such as https://example.com, with no path, query, or credentials.',
    );
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
    throw new PublicDemoRefusedError(
      'PUBLIC_ORIGIN must be the public https origin. Loopback stays the default local server.',
    );
  }
  return url;
}

function bindHost(value: string | undefined): string {
  const host = value?.trim() ?? '';
  if (!host) return '0.0.0.0';
  if (host.length > 253 || /[\s/\\]/.test(host)) {
    throw new PublicDemoRefusedError('HOST must be a bind address such as 0.0.0.0.');
  }
  return host;
}

function bindPort(value: string | undefined): number {
  const raw = value?.trim() ?? '';
  if (!raw) return LOCAL_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new PublicDemoRefusedError('PORT must be a whole number from 1 to 65535.');
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new PublicDemoRefusedError('PORT must be a whole number from 1 to 65535.');
  }
  return port;
}
