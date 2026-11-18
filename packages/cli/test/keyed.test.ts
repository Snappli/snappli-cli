import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configFile } from '../src/config.js';
import { cli, type Received, testServer } from './helpers.js';

const KEY = `sk_${'b2'.repeat(24)}`;
const OTHER_KEY = `sk_${'c3'.repeat(24)}`;

const ME = {
  organization: { id: 'org_1', name: 'Demo' },
  apiKey: {
    id: 'key_1',
    name: 'CI',
    keyPrefix: KEY.slice(0, 12),
    scopes: ['contacts:read', 'webhooks:read'],
    createdAt: '2026-11-01T00:00:00.000Z',
  },
  rateLimitPerMin: 120,
};

const json = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** API pública simulada: responde según método y ruta, y rechaza keys distintas de KEY. */
function fakeApi(req: Received, res: ServerResponse) {
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return json(res, 401, { statusCode: 401, message: 'API key inválida' });
  }
  const route = `${req.method} ${req.url}`;
  if (route === 'GET /api/v1/me') return json(res, 200, ME);
  if (route === 'GET /api/v1/webhook-integrations') return json(res, 200, [{ id: 'wh_1' }]);
  if (route === 'GET /api/v1/webhook-integrations/wh_1') return json(res, 200, { id: 'wh_1' });
  if (
    route.startsWith('GET /api/v1/webhook-deliveries?') ||
    route === 'GET /api/v1/webhook-deliveries'
  ) {
    return json(res, 200, { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } });
  }
  if (route === 'GET /api/v1/webhook-deliveries/d_1') return json(res, 200, { id: 'd_1' });
  if (route === 'POST /api/v1/webhook-integrations/wh_1/mapping-preview') {
    return json(res, 200, { fields: [{ key: 'id_pedido', value: 'P-1' }], warnings: [] });
  }
  if (route === 'POST /api/v1/webhook-integrations/wh_1/test') {
    return json(res, 403, {
      statusCode: 403,
      message: 'La API key no tiene el permiso webhooks:test',
      missingScopes: ['webhooks:test'],
    });
  }
  if (route === 'POST /api/v1/webhook-deliveries/d_1/retry') {
    return json(
      res,
      429,
      { statusCode: 429, message: 'Demasiadas solicitudes.' },
      { 'Retry-After': '12' },
    );
  }
  return json(res, 404, { statusCode: 404, message: 'No encontrado' });
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const server = await testServer(fakeApi);
  close = server.close;
  const env = { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'snappli-cfg-')) };
  return { server, env, base: ['--api-url', server.url] };
}

describe('login, whoami y logout', () => {
  it('login valida la key, la guarda con permisos 0600 y no la imprime', async () => {
    const { server, env, base } = await setup();
    const result = await cli(['login', '--api-key', KEY, ...base], { env });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(KEY);
    expect(result.json()).toMatchObject({
      organization: { name: 'Demo' },
      apiKey: { key: `${KEY.slice(0, 12)}…`, scopes: ['contacts:read', 'webhooks:read'] },
      missingScopes: ['webhooks:test', 'connectors:read', 'connectors:test'],
    });
    const file = configFile(env);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ apiKey: KEY, apiUrl: server.url });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    // whoami usa la key y el host guardados.
    const who = await cli(['whoami'], { env });
    expect(who.json()).toMatchObject({ keySource: 'config', apiUrl: server.url });

    const out = await cli(['logout'], { env });
    expect(out.json()).toMatchObject({ loggedOut: true });
    expect((await cli(['whoami'], { env })).error().code).toBe('missing_api_key');
  });

  it('login lee la key de stdin y no guarda una key inválida', async () => {
    const { env, base } = await setup();
    expect((await cli(['login', ...base], { env, stdin: `${KEY}\n` })).code).toBe(0);
    const bad = await cli(['login', '--api-key', OTHER_KEY, ...base], {
      env: { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'snappli-cfg-')) },
    });
    expect(bad.code).toBe(1);
    expect(bad.error()).toMatchObject({ code: 'unauthorized', hint: expect.any(String) });
    expect(bad.stderr).not.toContain(OTHER_KEY);
    const tty = await cli(['login', ...base], { env, stdinIsTTY: true });
    expect(tty.error().code).toBe('missing_api_key');
  });

  it('--api-key y SNAPPLI_API_KEY van antes que la key guardada', async () => {
    const { env, base } = await setup();
    await cli(['login', '--api-key', KEY, ...base], { env });
    await writeFile(configFile(env), JSON.stringify({ apiKey: OTHER_KEY }));
    expect((await cli(['whoami', ...base], { env })).error().code).toBe('unauthorized');
    expect((await cli(['whoami', '--api-key', KEY, ...base], { env })).json().keySource).toBe(
      'flag',
    );
    expect(
      (await cli(['whoami', ...base], { env: { ...env, SNAPPLI_API_KEY: KEY } })).json().keySource,
    ).toBe('env');
  });
});

describe('webhooks con key', () => {
  it('list, get, deliveries y deliveries get', async () => {
    const { server, env, base } = await setup();
    const keyEnv = { ...env, SNAPPLI_API_KEY: KEY };
    expect((await cli(['webhooks', 'list', ...base], { env: keyEnv })).json()).toEqual([
      { id: 'wh_1' },
    ]);
    expect((await cli(['webhooks', 'get', 'wh_1', ...base], { env: keyEnv })).json().id).toBe(
      'wh_1',
    );
    const deliveries = await cli(
      [
        'webhooks',
        'deliveries',
        '--integration',
        'wh_1',
        '--status',
        'failed',
        '--limit',
        '5',
        ...base,
      ],
      { env: keyEnv },
    );
    expect(deliveries.code).toBe(0);
    expect(server.received.at(-1)?.url).toBe(
      '/api/v1/webhook-deliveries?webhookIntegrationId=wh_1&status=FAILED&limit=5',
    );
    expect(
      (await cli(['webhooks', 'deliveries', 'get', 'd_1', ...base], { env: keyEnv })).json().id,
    ).toBe('d_1');
    expect(
      (await cli(['webhooks', 'deliveries', '--status', 'raro', ...base], { env: keyEnv })).error()
        .code,
    ).toBe('invalid_status');
    expect(
      (await cli(['webhooks', 'deliveries', '--limit', '500', ...base], { env: keyEnv })).error()
        .code,
    ).toBe('invalid_number');
  });

  it('mapping-preview envía la respuesta como texto', async () => {
    const { server, env, base } = await setup();
    const result = await cli(['webhooks', 'mapping-preview', 'wh_1', '--response', '-', ...base], {
      env: { ...env, SNAPPLI_API_KEY: KEY },
      stdin: '{"data":{"id":"P-1"}}',
    });
    expect(result.json().fields[0].value).toBe('P-1');
    expect(JSON.parse(server.received.at(-1)?.body ?? '')).toEqual({
      body: '{"data":{"id":"P-1"}}',
    });
  });

  it('test y retry exigen --yes y no llaman a la API sin él', async () => {
    const { server, env, base } = await setup();
    const keyEnv = { ...env, SNAPPLI_API_KEY: KEY };
    for (const argv of [
      ['webhooks', 'test', 'wh_1'],
      ['webhooks', 'retry', 'd_1'],
    ]) {
      const result = await cli([...argv, ...base], { env: keyEnv });
      expect(result.error().code).toBe('write_not_allowed');
    }
    expect(server.received).toHaveLength(0);
  });

  it('403 con el permiso que falta y 429 con Retry-After', async () => {
    const { env, base } = await setup();
    const keyEnv = { ...env, SNAPPLI_API_KEY: KEY };
    const test = await cli(['webhooks', 'test', 'wh_1', '--yes', ...base], { env: keyEnv });
    expect(test.code).toBe(1);
    expect(test.error()).toMatchObject({
      code: 'forbidden',
      missingScopes: ['webhooks:test'],
      hint: expect.stringContaining('Configuración → API'),
    });
    const retry = await cli(['webhooks', 'retry', 'd_1', '--yes', ...base], { env: keyEnv });
    expect(retry.error()).toMatchObject({
      code: 'rate_limited',
      message: 'Demasiadas solicitudes. Reintenta en 12 s.',
    });
  });

  it('sin key: error claro sin llamar a nada', async () => {
    const { server, env, base } = await setup();
    const result = await cli(['webhooks', 'list', ...base], { env });
    expect(result.error()).toMatchObject({ code: 'missing_api_key' });
    expect(server.received).toHaveLength(0);
  });
});
