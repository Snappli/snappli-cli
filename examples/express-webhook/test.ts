// Prueba el ejemplo con el CLI, como lo haría un integrador: firma, dedupe y documentos.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { snappli } from '../run-cli.ts';
import { createApp, createStore } from './app.ts';

const secret = 'whsec_ejemplo';
const store = createStore();
const server = createApp(secret, store).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/snappli`;

try {
  const ok = await snappli([
    'webhooks',
    'trigger',
    'contact.stage.entered',
    '--to',
    url,
    '--secret',
    secret,
    '--repeat',
    '--with-documents',
    '--mapping',
    '{"fields":{"id_pedido":"$.data.id"}}',
  ]);
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.response.body, { data: { id: 'PED-1' } });
  assert.deepEqual(ok.json.repeat.body, { data: { id: 'PED-1' } }, 'el repetido devuelve lo mismo');
  assert.equal(store.orders.length, 1, 'la entrega repetida no crea otro pedido');
  assert.equal(ok.json.mapping.fields[0].value, 'PED-1');
  assert.deepEqual(
    ok.json.documents.map((d: { downloads: number }) => d.downloads),
    [1, 1],
  );
  assert.equal(store.documents.length, 2);

  const bad = await snappli([
    'webhooks',
    'trigger',
    'contact.created',
    '--to',
    url,
    '--secret',
    'otro',
  ]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.response.status, 401);
  assert.equal(store.orders.length, 1, 'una firma inválida no procesa nada');
  console.log('express-webhook: ok');
} finally {
  server.close();
}
