// Comprueba la definición del conector con los schemas de Snappli y lo que leería la IA con el CLI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { connectorInputSchema, connectorOperationInputSchema } from '@snappli/sdk';
import { snappli } from '../run-cli.ts';
import { createApp } from './app.ts';

const definition = JSON.parse(await readFile(new URL('./connector.json', import.meta.url), 'utf8'));
const connector = connectorInputSchema.safeParse(definition.connector);
assert.ok(connector.success, JSON.stringify(connector.error?.issues));
const operations = definition.operations.map((op: unknown) => {
  const parsed = connectorOperationInputSchema.safeParse(op);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return parsed.data;
});
const op = (name: string) => operations.find((o: { name: string }) => o.name === name);

const apiKey = 'clave-de-prueba';
const server = createApp(apiKey).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...init.headers },
  });

async function aiSees(text: string, responseMap: Record<string, string>) {
  const out = await snappli(
    ['connectors', 'check-response', '--file', '-', '--map', JSON.stringify(responseMap)],
    {},
    text,
  );
  assert.equal(out.code, 0);
  return out.json;
}

try {
  assert.equal((await fetch(`${base}/slots?fecha=2030-01-01`)).status, 401, 'sin key, 401');

  const slots = await (await call('/slots?fecha=2030-01-01')).text();
  const read = await aiSees(slots, op('disponibilidad').responseMap);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.values.horarios, ['09:00', '10:00', '11:00', '15:00', '16:00']);

  // Escritura idempotente: Snappli manda la misma idempotency-key si repite la acción.
  const body = JSON.stringify({
    fecha: '2030-01-01',
    hora: '10:00',
    servicio: 'consulta',
    telefono: '+593991234567',
    nombre: 'María',
  });
  const first = await call('/appointments', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': 'k1' },
  });
  const again = await call('/appointments', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': 'k1' },
  });
  assert.equal(first.status, 201);
  const written = await aiSees(await again.text(), op('reservar').responseMap);
  assert.deepEqual(written.values, { id: 'CITA-1', estado: 'confirmada' });
  const conflict = await call('/appointments', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': 'k2' },
  });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /ocupadas/);

  const mine = await (await call('/appointments?telefono=%2B593991234567')).text();
  const list = await aiSees(mine, op('mis_reservas').responseMap);
  assert.equal(list.values.reservas.length, 1);
  console.log('connector-api: ok');
} finally {
  server.close();
}
