import { describe, expect, it } from 'vitest';
import {
  buildConnectorEvent,
  connectorEventsUrl,
  SnappliError,
  sendConnectorEvent,
  signConnectorEvent,
} from '../src/index.js';

// Vector calculado con signEvent de connector-events.service.ts:
// `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
const SECRET = 'whsec_test_vector';
const TS = 1763400000;
const BODY = '{"type":"pedido.enviado","data":{"telefono":"+593991234567","pedido":"PED-1"}}';
const SIGNATURE = 'sha256=94d1cdaa0bbe03135163eb93df50578202e0bf52df2f672bcc9cf25dc0190699';

describe('eventos de conector', () => {
  it('firma con prefijo sha256= igual que el backend', () => {
    expect(signConnectorEvent(SECRET, TS, BODY)).toBe(SIGNATURE);
    expect(signConnectorEvent(SECRET, String(TS), Buffer.from(BODY))).toBe(SIGNATURE);
  });

  it('arma el cuerpo {type, data} y las cabeceras', () => {
    const built = buildConnectorEvent({
      secret: SECRET,
      type: 'pedido.enviado',
      data: { telefono: '+593991234567', pedido: 'PED-1' },
      eventId: 'pedido-1-enviado',
      timestamp: TS,
    });
    expect(built.body).toBe(BODY);
    expect(built.headers).toEqual({
      'Content-Type': 'application/json',
      'x-snappli-timestamp': String(TS),
      'x-snappli-signature': SIGNATURE,
      'x-snappli-event-id': 'pedido-1-enviado',
    });
  });

  it('genera un id válido si falta y rechaza uno inválido', () => {
    const built = buildConnectorEvent({ secret: SECRET, type: 't', data: {} });
    expect(built.eventId).toMatch(/^evt_[0-9a-f-]{36}$/);
    for (const eventId of ['corto', 'con espacio', 'x'.repeat(101), 'ñandú-123']) {
      expect(() => buildConnectorEvent({ secret: SECRET, type: 't', data: {}, eventId })).toThrow(
        SnappliError,
      );
    }
  });

  it('URL del endpoint', () => {
    expect(connectorEventsUrl('abc')).toBe(
      'https://api.snappli.io/api/integrations/connectors/abc/events',
    );
    expect(connectorEventsUrl('abc', 'http://localhost:3001/')).toBe(
      'http://localhost:3001/api/integrations/connectors/abc/events',
    );
  });

  it('envía y devuelve el resultado', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ status: 'ignored', reason: 'duplicate' });
    }) as unknown as typeof fetch;
    const out = await sendConnectorEvent({
      url: 'https://x.test/events',
      secret: SECRET,
      type: 'pedido.enviado',
      data: {},
      eventId: 'evento-1',
      fetch: fetcher,
    });
    expect(out).toEqual({
      eventId: 'evento-1',
      result: { status: 'ignored', reason: 'duplicate' },
    });
    expect(seen?.init.method).toBe('POST');
  });

  it('un 401 es un SnappliError unauthorized con el motivo', async () => {
    const fetcher = (async () =>
      Response.json(
        { statusCode: 401, message: 'Firma no válida' },
        { status: 401 },
      )) as unknown as typeof fetch;
    await expect(
      sendConnectorEvent({
        url: 'https://x.test',
        secret: SECRET,
        type: 't',
        data: {},
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
});
