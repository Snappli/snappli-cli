import {
  isWebhookEvent,
  signWebhookPayload,
  verifyWebhook,
  WEBHOOK_EVENT_TYPES,
  type WebhookEvent,
} from '@snappli/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { exampleWebhook } from '../src/fixtures.js';
import { cli, testServer } from './helpers.js';

const SECRET = 'whsec_prueba';
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('fixtures (contrato)', () => {
  it('hay un payload válido por cada evento del backend', () => {
    const sources = ['AI', 'AGENT', 'MANUAL', 'BULK', 'TEST', 'SYSTEM'];
    for (const event of WEBHOOK_EVENT_TYPES) {
      const payload: WebhookEvent = exampleWebhook(event, { withDocuments: true });
      expect(isWebhookEvent(payload)).toBe(true);
      expect(payload.event).toBe(event);
      expect(sources).toContain(payload.trigger.source);
      const docs = Object.values(payload.contact.documents ?? {});
      expect(docs.map((d) => d.status).sort()).toEqual(['APPROVED', 'PENDING']);
      for (const doc of docs) {
        expect(doc.url).toMatch(/\/api\/webhook-files\//);
        expect(Date.parse(doc.urlExpiresAt ?? '')).toBeGreaterThan(Date.now());
      }
      if (event === 'contact.stage.entered' || event === 'contact.webhook.manual') {
        expect(payload).toHaveProperty('pipeline.stageName');
        expect(payload).toHaveProperty('conversation.channel');
      }
    }
  });

  it('sin --with-documents no trae documents', async () => {
    const out = await cli(['webhooks', 'example', 'conversation.escalated']);
    expect(out.code).toBe(0);
    expect(out.json().contact.documents).toBeUndefined();
    expect(out.json().departmentName).toBe('Ventas');
  });

  it('evento desconocido', async () => {
    const out = await cli(['webhooks', 'example', 'contact.deleted']);
    expect(out.code).toBe(1);
    expect(out.error().code).toBe('invalid_event_type');
  });
});

describe('webhooks trigger', () => {
  it('firma igual que Snappli y el SDK lo verifica', async () => {
    const server = await testServer();
    close = server.close;
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.stage.entered',
      '--to',
      `${server.url}/hook`,
      '--secret',
      SECRET,
      '--header',
      'Authorization: Bearer abc',
    ]);
    expect(out.code).toBe(0);
    const req = server.received[0];
    expect(req?.headers['user-agent']).toBe('Snappli-Webhook/1.0');
    expect(req?.headers.authorization).toBe('Bearer abc');
    expect(req?.headers['idempotency-key']).toBe(req?.headers['x-snappli-delivery-id']);
    const event = verifyWebhook(req?.body ?? '', req?.headers ?? {}, SECRET);
    expect(event.trigger.deliveryId).toBe(req?.headers['idempotency-key']);
    expect(out.json()).toMatchObject({
      ok: true,
      request: { signed: true, event: 'contact.stage.entered', extraHeaders: ['Authorization'] },
      response: { status: 200, json: true, body: { ok: true } },
    });
    expect(out.stdout).not.toContain('Bearer abc');
  });

  it('usa SNAPPLI_WEBHOOK_SECRET y avisa si no hay secreto', async () => {
    const server = await testServer();
    close = server.close;
    const signed = await cli(['webhooks', 'trigger', 'contact.created', '--to', server.url], {
      env: { SNAPPLI_WEBHOOK_SECRET: SECRET },
    });
    expect(signed.json().request.signed).toBe(true);
    const unsigned = await cli(['webhooks', 'trigger', 'contact.created', '--to', server.url]);
    expect(server.received[1]?.headers['x-snappli-signature']).toBeUndefined();
    expect(unsigned.json().warnings.join(' ')).toMatch(/Sin secreto/);
  });

  it('--repeat reenvía la misma entrega con otra firma', async () => {
    const server = await testServer();
    close = server.close;
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.updated',
      '--to',
      server.url,
      '--secret',
      SECRET,
      '--repeat',
    ]);
    expect(server.received).toHaveLength(2);
    const [a, b] = server.received;
    expect(a?.headers['idempotency-key']).toBe(b?.headers['idempotency-key']);
    expect(a?.body).toBe(b?.body);
    expect(out.json().repeat.status).toBe(200);
    expect(out.json().warnings.join(' ')).toMatch(/dos veces/);
  });

  it('--mapping muestra qué rellenaría y la nota', async () => {
    const server = await testServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"data":{"id":"PED-123"}}');
    });
    close = server.close;
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.stage.entered',
      '--to',
      server.url,
      '--mapping',
      '{"fields":{"id_pedido":"$.data.id","otro":"$.nada"},"note":"Pedido {{id_pedido}}"}',
    ]);
    expect(out.json().mapping).toMatchObject({
      fields: [
        { key: 'id_pedido', value: 'PED-123' },
        { key: 'otro', value: null, reason: 'No está $.nada en la respuesta' },
      ],
      note: 'Pedido PED-123',
    });
  });

  it('mapeo inválido', async () => {
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.created',
      '--to',
      'http://127.0.0.1:1',
      '--mapping',
      '{"fields":{"a":"data.id"}}',
    ]);
    expect(out.error().code).toBe('invalid_mapping');
  });

  it('un 500 y una respuesta no JSON dan aviso; el 500 sale con código 1', async () => {
    const server = await testServer((req, res) => {
      res.writeHead(req.url === '/mal' ? 500 : 200);
      res.end('OK');
    });
    close = server.close;
    const bad = await cli(['webhooks', 'trigger', 'contact.created', '--to', `${server.url}/mal`]);
    expect(bad.code).toBe(1);
    expect(bad.json().warnings.join(' ')).toMatch(/reintentaría/);
    const text = await cli(['webhooks', 'trigger', 'contact.created', '--to', server.url]);
    expect(text.code).toBe(0);
    expect(text.json().warnings.join(' ')).toMatch(/no es JSON/);
  });

  it('corta por tiempo límite', async () => {
    const server = await testServer(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 1000));
      res.end('{}');
    });
    close = server.close;
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.created',
      '--to',
      server.url,
      '--timeout',
      '0.2',
    ]);
    expect(out.code).toBe(1);
    expect(out.json().response.error.code).toBe('timeout');
  });

  it('error de red', async () => {
    const out = await cli(['webhooks', 'trigger', 'contact.created', '--to', 'http://127.0.0.1:1']);
    expect(out.code).toBe(1);
    expect(out.json().response.error.code).toBe('network_error');
  });

  it('--with-documents sirve archivos que el receptor puede descargar', async () => {
    const server = await testServer(async (req, res) => {
      const event = JSON.parse(req.body) as WebhookEvent;
      const docs = Object.values(event.contact.documents ?? {});
      const sizes = await Promise.all(
        docs.map(async (d) => (await (await fetch(d.url ?? '')).arrayBuffer()).byteLength),
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sizes, expected: docs.map((d) => d.size) }));
    });
    close = server.close;
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.stage.entered',
      '--to',
      server.url,
      '--with-documents',
      '--hold',
      '0',
    ]);
    const json = out.json();
    expect(json.response.body.sizes).toEqual(json.response.body.expected);
    expect(json.documents).toEqual([
      { key: 'documento_identidad', status: 'APPROVED', downloads: 1 },
      { key: 'comprobante_pago', status: 'PENDING', downloads: 1 },
    ]);
    expect(json.warnings).toEqual([
      'Sin secreto: la entrega va sin X-Snappli-Signature. Configura un secreto en la integración y pásalo con --secret o SNAPPLI_WEBHOOK_SECRET.',
    ]);
  });

  it('avisa si no se descargaron los documentos', async () => {
    const server = await testServer();
    close = server.close;
    const out = await cli([
      'webhooks',
      'trigger',
      'contact.created',
      '--to',
      server.url,
      '--with-documents',
      '--hold',
      '0',
      '--secret',
      SECRET,
    ]);
    expect(out.json().warnings.join(' ')).toMatch(
      /No se descargaron: documento_identidad, comprobante_pago/,
    );
  });

  it('--file envía un payload propio y conserva su deliveryId', async () => {
    const server = await testServer();
    close = server.close;
    const payload = exampleWebhook('contact.tag.assigned', { deliveryId: 'dlv_real_1' });
    const out = await cli(['webhooks', 'trigger', '--to', server.url, '--file', '-'], {
      stdin: JSON.stringify(payload),
    });
    expect(out.code).toBe(0);
    expect(server.received[0]?.headers['idempotency-key']).toBe('dlv_real_1');
    const bad = await cli(['webhooks', 'trigger', '--to', server.url, '--file', '-'], {
      stdin: '{"hola":1}',
    });
    expect(bad.error().code).toBe('invalid_payload');
  });

  it('valida --to y --header', async () => {
    expect((await cli(['webhooks', 'trigger', 'contact.created'])).error().code).toBe(
      'missing_url',
    );
    expect(
      (await cli(['webhooks', 'trigger', 'contact.created', '--to', 'ftp://x'])).error().code,
    ).toBe('invalid_url');
    expect(
      (
        await cli(['webhooks', 'trigger', 'contact.created', '--to', 'http://x', '--header', 'sin'])
      ).error().code,
    ).toBe('invalid_header');
  });
});

describe('webhooks verify', () => {
  const body = JSON.stringify(exampleWebhook('contact.created'));
  const now = Math.floor(Date.now() / 1000);
  const { signature } = signWebhookPayload(body, SECRET, now);
  const args = [
    'webhooks',
    'verify',
    '--secret',
    SECRET,
    '--timestamp',
    String(now),
    '--signature',
  ];

  it('válida', async () => {
    const out = await cli([...args, signature], { stdin: body });
    expect(out.code).toBe(0);
    expect(out.json()).toEqual({ valid: true, hints: [] });
  });

  it('detecta el salto de línea final', async () => {
    const out = await cli([...args, signature], { stdin: `${body}\n` });
    expect(out.code).toBe(1);
    expect(out.json().reason).toBe('bad_signature');
    expect(out.json().hints[0]).toMatch(/salto de línea/);
  });

  it('detecta el JSON reformateado', async () => {
    const out = await cli([...args, signature], {
      stdin: JSON.stringify(JSON.parse(body), null, 2),
    });
    expect(out.json().hints[0]).toMatch(/compactado/);
  });

  it('timestamp viejo, --ignore-time y milisegundos', async () => {
    const old = now - 3600;
    const sig = signWebhookPayload(body, SECRET, old).signature;
    const base = [
      'webhooks',
      'verify',
      '--secret',
      SECRET,
      '--timestamp',
      String(old),
      '--signature',
      sig,
    ];
    expect((await cli(base, { stdin: body })).json().reason).toBe('timestamp_out_of_range');
    expect((await cli([...base, '--ignore-time'], { stdin: body })).json().valid).toBe(true);
    const ms = await cli(
      [
        'webhooks',
        'verify',
        '--secret',
        SECRET,
        '--timestamp',
        String(now * 1000),
        '--signature',
        signature,
      ],
      { stdin: body },
    );
    expect(ms.json().hints.join(' ')).toMatch(/milisegundos/);
  });

  it('faltan datos', async () => {
    expect((await cli(['webhooks', 'verify'], { stdin: body })).error().code).toBe(
      'missing_secret',
    );
  });
});

describe('webhooks serve', () => {
  it('verifica, marca repetidos, rechaza firmas malas y responde --respond', async () => {
    let stop: () => void = () => {};
    let listening: (url: string) => void = () => {};
    const ready = new Promise<string>((r) => {
      listening = r;
    });
    const running = cli(
      [
        'webhooks',
        'serve',
        '--port',
        '0',
        '--host',
        '127.0.0.1',
        '--secret',
        SECRET,
        '--respond',
        '{"data":{"id":"X"}}',
      ],
      {
        onListening: (url) => listening(url),
        untilExit: () =>
          new Promise<void>((r) => {
            stop = r;
          }),
      },
    );
    const url = await ready;
    const good = await cli([
      'webhooks',
      'trigger',
      'contact.created',
      '--to',
      url,
      '--secret',
      SECRET,
      '--repeat',
    ]);
    expect(good.json().response.body).toEqual({ data: { id: 'X' } });
    const bad = await cli([
      'webhooks',
      'trigger',
      'contact.created',
      '--to',
      url,
      '--secret',
      'otro',
    ]);
    expect(bad.json().response.status).toBe(401);
    stop();
    const out = await running;
    expect(out.code).toBe(0);
    const lines = out.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.verified, l.duplicate, l.responseStatus])).toEqual([
      [true, false, 200],
      [true, true, 200],
      [false, false, 401],
    ]);
    expect(lines[2].reason).toBe('bad_signature');
    expect(JSON.parse(out.stderr).verifying).toBe(true);
  });
});
