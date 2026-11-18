import { describe, expect, it } from 'vitest';
import { downloadDocument, maskApiKey, Snappli, SnappliError } from '../src/index.js';

const KEY = `sk_${'a1'.repeat(24)}`;

describe('Snappli', () => {
  it('valida el formato de la key sin imprimirla entera', () => {
    expect(() => new Snappli('')).toThrow(SnappliError);
    try {
      new Snappli('sk_live_secreto_muy_largo');
    } catch (error) {
      expect((error as SnappliError).code).toBe('invalid_api_key');
      expect((error as Error).message).not.toContain('secreto_muy_largo');
    }
    expect(maskApiKey(KEY)).toBe('sk_a1a1…');
  });

  it('lista contactos con Bearer y query', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return Response.json({
        data: [{ id: 'c1' }],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });
    }) as unknown as typeof fetch;
    const snappli = new Snappli(KEY, { baseUrl: 'http://api.test/', fetch: fetcher });
    const page = await snappli.contacts.list({ search: 'ana', limit: 5 });
    expect(page.data[0]?.id).toBe('c1');
    expect(calls[0]?.url).toBe('http://api.test/api/v1/contacts?search=ana&limit=5');
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('convierte los errores de la API', async () => {
    const fetcher = (async () =>
      Response.json(
        { statusCode: 403, message: 'Tu plan no incluye la API', error: 'Forbidden' },
        { status: 403 },
      )) as unknown as typeof fetch;
    await expect(new Snappli(KEY, { fetch: fetcher }).contacts.get('x')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'Tu plan no incluye la API',
    });
  });

  it('webhooks: rutas, métodos y cuerpo de la vista previa', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      calls.push({
        method: String(init.method),
        url: String(url),
        ...(init.body ? { body: String(init.body) } : {}),
      });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const snappli = new Snappli(KEY, { baseUrl: 'http://api.test', fetch: fetcher });
    await snappli.me();
    await snappli.webhookIntegrations.list();
    await snappli.webhookIntegrations.get('wh 1');
    await snappli.webhookIntegrations.test('wh1');
    await snappli.webhookIntegrations.previewMapping('wh1', '{"data":{"id":"P-1"}}');
    await snappli.webhookDeliveries.list({ status: 'FAILED', webhookIntegrationId: 'wh1' });
    await snappli.webhookDeliveries.get('d1');
    await snappli.webhookDeliveries.retry('d1');
    await snappli.connectors.list();
    await snappli.connectors.get('cn1');
    await snappli.connectors.logs('cn1');
    await snappli.connectors.testOperation('cn1', 'op1', { args: { fecha: '2026-12-01' } });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://api.test/api', '')}`)).toEqual([
      'GET /v1/me',
      'GET /v1/webhook-integrations',
      'GET /v1/webhook-integrations/wh%201',
      'POST /v1/webhook-integrations/wh1/test',
      'POST /v1/webhook-integrations/wh1/mapping-preview',
      'GET /v1/webhook-deliveries?status=FAILED&webhookIntegrationId=wh1',
      'GET /v1/webhook-deliveries/d1',
      'POST /v1/webhook-deliveries/d1/retry',
      'GET /v1/connectors',
      'GET /v1/connectors/cn1',
      'GET /v1/connectors/cn1/logs',
      'POST /v1/connectors/cn1/operations/op1/test',
    ]);
    expect(JSON.parse(calls[11]?.body ?? '')).toEqual({
      args: { fecha: '2026-12-01' },
      boundValues: {},
      allowWrite: false,
    });
    expect(JSON.parse(calls[4]?.body ?? '')).toEqual({ body: '{"data":{"id":"P-1"}}' });
  });

  it('403 sin permiso y 429 con Retry-After', async () => {
    const forbidden = (async () =>
      Response.json(
        {
          statusCode: 403,
          message: 'La API key no tiene el permiso webhooks:read',
          missingScopes: ['webhooks:read'],
        },
        { status: 403 },
      )) as unknown as typeof fetch;
    await expect(
      new Snappli(KEY, { fetch: forbidden }).webhookIntegrations.list(),
    ).rejects.toMatchObject({
      code: 'forbidden',
      body: { missingScopes: ['webhooks:read'] },
    });
    const limited = (async () =>
      Response.json(
        { statusCode: 429, message: 'Demasiadas solicitudes.' },
        { status: 429, headers: { 'Retry-After': '30' } },
      )) as unknown as typeof fetch;
    await expect(new Snappli(KEY, { fetch: limited }).me()).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Demasiadas solicitudes. Reintenta en 30 s.',
    });
  });
});

describe('downloadDocument', () => {
  const doc = {
    label: 'Cédula',
    status: 'APPROVED' as const,
    storageKey: 'orgs/o/contacts/c/cedula.pdf',
    mimeType: 'application/pdf',
    size: 3,
    fileName: null,
    url: 'https://api.snappli.io/api/webhook-files/tok',
    urlExpiresAt: '2030-01-01T00:00:00.000Z',
  };

  it('descarga los bytes', async () => {
    const fetcher = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/pdf' },
      })) as unknown as typeof fetch;
    const out = await downloadDocument(doc, { fetch: fetcher });
    expect(out).toMatchObject({ contentType: 'application/pdf', fileName: 'cedula.pdf', size: 3 });
  });

  it('avisa si el enlace caducó (antes o en la respuesta)', async () => {
    await expect(
      downloadDocument({ ...doc, urlExpiresAt: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'document_url_expired' });
    const fetcher = (async () =>
      new Response('Enlace inválido o expirado', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadDocument(doc, { fetch: fetcher })).rejects.toMatchObject({
      code: 'document_url_expired',
      status: 404,
    });
  });
});
