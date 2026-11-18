import { describe, expect, it } from 'vitest';
import {
  checkWebhookSignature,
  constructEvent,
  SnappliWebhookError,
  signWebhookPayload,
  verifyWebhook,
  webhookDeliveryId,
  webhookHeaders,
} from '../src/index.js';

// Vector calculado con el algoritmo de webhook-delivery.service.ts:
// createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
const SECRET = 'whsec_test_vector';
const TS = 1763400000;
const BODY =
  '{"event":"contact.created","contact":{"id":"c1","displayName":"José Ñandú"},"trigger":{"source":"TEST","userId":null,"deliveryId":"d1"}}';
const SIGNATURE = 'ae1d2ef69526bede49b47121b05cb351db3ee4b0eae4001e94eccb34651ef2b9';

const headers = (overrides: Record<string, string> = {}) => ({
  'X-Snappli-Timestamp': String(TS),
  'X-Snappli-Signature': SIGNATURE,
  'Idempotency-Key': 'd1',
  ...overrides,
});

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SnappliWebhookError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('signWebhookPayload', () => {
  it('coincide con el vector del backend (hex sin prefijo)', () => {
    expect(signWebhookPayload(BODY, SECRET, TS)).toEqual({ signature: SIGNATURE, timestamp: TS });
  });

  it('firma igual el texto y sus bytes UTF-8', () => {
    expect(signWebhookPayload(Buffer.from(BODY), SECRET, TS).signature).toBe(SIGNATURE);
  });

  it('webhookHeaders arma las mismas cabeceras que Snappli', () => {
    expect(webhookHeaders({ body: BODY, deliveryId: 'd1', secret: SECRET, timestamp: TS })).toEqual(
      {
        'Content-Type': 'application/json',
        'User-Agent': 'Snappli-Webhook/1.0',
        'Idempotency-Key': 'd1',
        'X-Snappli-Delivery-Id': 'd1',
        'X-Snappli-Timestamp': String(TS),
        'X-Snappli-Signature': SIGNATURE,
      },
    );
    expect(webhookHeaders({ body: BODY, deliveryId: 'd1' })).not.toHaveProperty(
      'X-Snappli-Signature',
    );
  });
});

describe('verifyWebhook', () => {
  it('acepta el cuerpo crudo y devuelve el evento', () => {
    const event = verifyWebhook(BODY, headers(), SECRET, { now: TS + 10 });
    expect(event.event).toBe('contact.created');
    expect(event.contact.displayName).toBe('José Ñandú');
  });

  it('acepta Buffer, Headers de fetch y cabeceras en minúsculas o repetidas', () => {
    expect(
      verifyWebhook(Buffer.from(BODY), new Headers(headers()), SECRET, { now: TS }).event,
    ).toBe('contact.created');
    expect(
      verifyWebhook(
        BODY,
        { 'x-snappli-timestamp': [String(TS)], 'x-snappli-signature': SIGNATURE },
        SECRET,
        { now: TS },
      ).event,
    ).toBe('contact.created');
  });

  it('rechaza el cuerpo reparseado (otro espaciado)', () => {
    const reparsed = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(reason(() => verifyWebhook(reparsed, headers(), SECRET, { now: TS }))).toBe(
      'bad_signature',
    );
  });

  it('rechaza otro secreto, una firma de otra longitud o con basura', () => {
    expect(reason(() => verifyWebhook(BODY, headers(), 'otro', { now: TS }))).toBe('bad_signature');
    expect(
      reason(() =>
        verifyWebhook(BODY, headers({ 'X-Snappli-Signature': 'abc' }), SECRET, { now: TS }),
      ),
    ).toBe('bad_signature');
    expect(
      reason(() =>
        verifyWebhook(BODY, headers({ 'X-Snappli-Signature': 'z'.repeat(64) }), SECRET, {
          now: TS,
        }),
      ),
    ).toBe('bad_signature');
  });

  it('tolera el prefijo sha256= y mayúsculas en el hex', () => {
    const sig = `sha256=${SIGNATURE.toUpperCase()}`;
    expect(
      verifyWebhook(BODY, headers({ 'X-Snappli-Signature': sig }), SECRET, { now: TS }).event,
    ).toBe('contact.created');
  });

  it('aplica la tolerancia de tiempo (300 s por defecto, en los dos sentidos)', () => {
    expect(reason(() => verifyWebhook(BODY, headers(), SECRET, { now: TS + 300 }))).toBeUndefined();
    expect(reason(() => verifyWebhook(BODY, headers(), SECRET, { now: TS + 301 }))).toBe(
      'timestamp_out_of_range',
    );
    expect(reason(() => verifyWebhook(BODY, headers(), SECRET, { now: TS - 301 }))).toBe(
      'timestamp_out_of_range',
    );
    expect(
      reason(() =>
        verifyWebhook(BODY, headers(), SECRET, { now: TS + 1000, toleranceSeconds: 1000 }),
      ),
    ).toBeUndefined();
    expect(
      reason(() =>
        verifyWebhook(BODY, headers({ 'X-Snappli-Timestamp': 'ayer' }), SECRET, { now: TS }),
      ),
    ).toBe('timestamp_out_of_range');
  });

  it('dice qué cabecera falta', () => {
    expect(reason(() => verifyWebhook(BODY, {}, SECRET))).toBe('missing_signature');
    expect(
      reason(() => verifyWebhook(BODY, { 'X-Snappli-Signature': SIGNATURE }, SECRET, { now: TS })),
    ).toBe('missing_timestamp');
  });

  it('exige el secreto', () => {
    expect(() => verifyWebhook(BODY, headers(), '')).toThrow(TypeError);
  });

  it('firma válida pero cuerpo que no es de Snappli', () => {
    const body = '{"hola":1}';
    const { signature } = signWebhookPayload(body, SECRET, TS);
    expect(
      reason(() =>
        verifyWebhook(body, headers({ 'X-Snappli-Signature': signature }), SECRET, { now: TS }),
      ),
    ).toBe('invalid_payload');
    const text = 'no json';
    const sig2 = signWebhookPayload(text, SECRET, TS).signature;
    expect(
      reason(() =>
        verifyWebhook(text, headers({ 'X-Snappli-Signature': sig2 }), SECRET, { now: TS }),
      ),
    ).toBe('invalid_json');
  });
});

describe('utilidades', () => {
  it('checkWebhookSignature devuelve el motivo sin lanzar', () => {
    expect(checkWebhookSignature(BODY, SECRET, TS, SIGNATURE, { now: TS })).toEqual({
      valid: true,
    });
    expect(checkWebhookSignature(BODY, SECRET, TS, SIGNATURE, { now: TS + 999 })).toMatchObject({
      valid: false,
      reason: 'timestamp_out_of_range',
    });
  });

  it('webhookDeliveryId lee Idempotency-Key o X-Snappli-Delivery-Id', () => {
    expect(webhookDeliveryId({ 'idempotency-key': 'a' })).toBe('a');
    expect(webhookDeliveryId(new Headers({ 'X-Snappli-Delivery-Id': 'b' }))).toBe('b');
    expect(webhookDeliveryId({})).toBeUndefined();
  });

  it('constructEvent parsea sin firma', () => {
    expect(constructEvent(BODY).trigger.deliveryId).toBe('d1');
  });
});
