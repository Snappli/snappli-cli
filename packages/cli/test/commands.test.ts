import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signConnectorEvent } from '@snappli/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { configDir } from '../src/config.js';
import { isGitignored } from '../src/operations.js';
import { cli, testServer } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('general', () => {
  it('ayuda, versión y comando desconocido', async () => {
    expect((await cli([])).stdout).toMatch(/^snappli:/);
    expect((await cli(['--version'])).stdout).toBe('9.9.9\n');
    const unknown = await cli(['nada']);
    expect(unknown.code).toBe(1);
    expect(unknown.error().code).toBe('unknown_command');
    expect((await cli(['webhooks', 'example', '--nope'])).error().code).toBe('invalid_arguments');
  });

  it('--pretty indenta y por defecto es una línea', async () => {
    expect((await cli(['webhooks', 'example', 'contact.created'])).stdout.trim()).not.toContain(
      '\n',
    );
    expect((await cli(['webhooks', 'example', 'contact.created', '--pretty'])).stdout).toContain(
      '\n  ',
    );
  });

  it('carpeta de configuración multiplataforma', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe(join('/x', 'snappli'));
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toContain('snappli');
    expect(configDir({}, 'darwin')).toMatch(/\.config[\\/]snappli$/);
  });
});

describe('events send', () => {
  const SECRET = 'whsec_eventos';

  it('firma con sha256= y explica el resultado (mock local, sin --yes)', async () => {
    const server = await testServer((req, res) => {
      const valid =
        req.headers['x-snappli-signature'] ===
        signConnectorEvent(SECRET, String(req.headers['x-snappli-timestamp']), req.body);
      res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(
        valid ? '{"status":"ignored","reason":"no_mapping"}' : '{"message":"Firma no válida"}',
      );
    });
    close = server.close;
    const out = await cli(
      [
        'events',
        'send',
        'pedido.enviado',
        '--to',
        `${server.url}/events`,
        '--data',
        '{"telefono":"+593991234567"}',
        '--event-id',
        'pedido-1-enviado',
      ],
      { env: { SNAPPLI_CONNECTOR_EVENT_SECRET: SECRET } },
    );
    expect(out.code).toBe(0);
    expect(JSON.parse(server.received[0]?.body ?? '')).toEqual({
      type: 'pedido.enviado',
      data: { telefono: '+593991234567' },
    });
    expect(server.received[0]?.headers['x-snappli-event-id']).toBe('pedido-1-enviado');
    expect(out.json()).toMatchObject({
      eventId: 'pedido-1-enviado',
      result: { status: 'ignored', reason: 'no_mapping' },
    });
    expect(out.json().hint).toMatch(/regla/);

    const bad = await cli([
      'events',
      'send',
      'x',
      '--to',
      server.url,
      '--data',
      '{}',
      '--secret',
      'otro',
    ]);
    expect(bad.code).toBe(1);
    expect(bad.error()).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('contra Snappli exige --yes', async () => {
    const args = [
      'events',
      'send',
      'pedido.enviado',
      '--connector',
      'conn_1',
      '--data',
      '{}',
      '--secret',
      SECRET,
    ];
    const blocked = await cli(args);
    expect(blocked.error().code).toBe('write_not_allowed');

    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return Response.json({ status: 'sent', messageId: 'm1', conversationId: 'c1' });
    }) as unknown as typeof fetch;
    const sent = await cli([...args, '--yes'], { fetch: fetcher });
    expect(sent.code).toBe(0);
    expect(sent.json().result.status).toBe('sent');
    expect(urls[0]).toBe('https://api.snappli.io/api/integrations/connectors/conn_1/events');
    await cli([...args, '--yes', '--api-url', 'https://staging.test'], { fetch: fetcher });
    expect(urls[1]).toBe('https://staging.test/api/integrations/connectors/conn_1/events');
  });

  it('valida secreto, datos e id', async () => {
    expect(
      (await cli(['events', 'send', 't', '--to', 'http://localhost:1', '--data', '{}'])).error()
        .code,
    ).toBe('missing_secret');
    expect(
      (await cli(['events', 'send', 't', '--to', 'http://localhost:1', '--secret', 's'])).error()
        .code,
    ).toBe('missing_data');
    expect(
      (
        await cli([
          'events',
          'send',
          't',
          '--to',
          'http://localhost:1',
          '--secret',
          's',
          '--data',
          '{}',
          '--event-id',
          'x',
        ])
      ).error().code,
    ).toBe('invalid_event_id');
  });
});

describe('connectors check-response', () => {
  it('muestra lo que leería la IA y avisa de rutas que faltan', async () => {
    const body = JSON.stringify({ slots: [{ hora: '09:00' }, { hora: '10:00' }], total: 2 });
    const out = await cli(
      [
        'connectors',
        'check-response',
        '--file',
        '-',
        '--map',
        '{"responseMap":{"horarios":"$.slots[*].hora","sede":"$.sede"}}',
      ],
      { stdin: body },
    );
    expect(out.json()).toMatchObject({
      json: true,
      mapped: true,
      values: { horarios: ['09:00', '10:00'], sede: null },
      aiSees: '{"horarios":["09:00","10:00"],"sede":null}',
      overLimit: false,
    });
    expect(out.json().warnings.join(' ')).toMatch(/«sede»/);
  });

  it('sin mapa, no JSON y más de 1 MB', async () => {
    const noMap = await cli(['connectors', 'check-response', '--file', '-'], { stdin: '{"a":1}' });
    expect(noMap.json().mapped).toBe(false);
    const text = await cli(['connectors', 'check-response', '--file', '-'], { stdin: 'hola' });
    expect(text.json().json).toBe(false);
    const big = await cli(['connectors', 'check-response', '--file', '-'], {
      stdin: JSON.stringify({ x: 'y'.repeat(1024 * 1024) }),
    });
    expect(big.json()).toMatchObject({ overLimit: true, truncated: true });
    expect((await cli(['connectors', 'check-response'])).error().code).toBe('missing_file');
    expect(
      (
        await cli(['connectors', 'check-response', '--file', '-', '--map', '[1]'], { stdin: '{}' })
      ).error().code,
    ).toBe('invalid_response_map');
  });
});

describe('init y skill', () => {
  it('añade las variables que faltan y avisa si .env no está en .gitignore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snappli-init-'));
    await writeFile(join(dir, '.env'), 'OTRA=1\nSNAPPLI_WEBHOOK_SECRET=ya');
    const first = await cli(['init'], { cwd: dir });
    expect(first.json()).toMatchObject({
      created: false,
      added: ['SNAPPLI_API_KEY', 'SNAPPLI_CONNECTOR_EVENT_SECRET'],
      gitignored: false,
    });
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      'OTRA=1\nSNAPPLI_WEBHOOK_SECRET=ya\nSNAPPLI_API_KEY=\nSNAPPLI_CONNECTOR_EVENT_SECRET=\n',
    );
    await writeFile(join(dir, '.gitignore'), 'node_modules\n.env*\n');
    const second = await cli(['init'], { cwd: dir });
    expect(second.json()).toMatchObject({ added: [], gitignored: true, warnings: [] });
  });

  it('isGitignored', () => {
    expect(isGitignored('.env', '.env')).toBe(true);
    expect(isGitignored('/.env\n', '.env')).toBe(true);
    expect(isGitignored('*.env', '.env')).toBe(true);
    expect(isGitignored('.env.*', '.env')).toBe(false);
    expect(isGitignored('.env*\n!.env', '.env')).toBe(false);
    expect(isGitignored('# .env', '.env')).toBe(false);
  });

  it('imprime e instala la skill', async () => {
    const skill = await cli(['skill']);
    expect(skill.stdout).toMatch(/^---\nname: snappli\n/);
    const dir = await mkdtemp(join(tmpdir(), 'snappli-skill-'));
    const out = await cli(['skill', 'install'], { cwd: dir });
    expect(out.json().installedTo).toBe(join(dir, '.claude', 'skills', 'snappli', 'SKILL.md'));
    expect(await readFile(out.json().installedTo, 'utf8')).toBe(skill.stdout);
  });
});
