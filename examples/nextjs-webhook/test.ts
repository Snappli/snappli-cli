// Sirve el route handler con un servidor mínimo (sin Next) y lo prueba con el CLI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { snappli } from '../run-cli.ts';

const secret = 'whsec_ejemplo';
process.env.SNAPPLI_WEBHOOK_SECRET = secret;
const { POST } = await import('./app/api/webhooks/snappli/route.ts');

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (typeof value === 'string') headers.set(key, value);
  const response = await POST(
    new Request(`http://localhost${req.url}`, {
      method: 'POST',
      headers,
      body: Buffer.concat(chunks),
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/snappli`;

try {
  const ok = await snappli([
    'webhooks',
    'trigger',
    'conversation.escalated',
    '--to',
    url,
    '--secret',
    secret,
    '--repeat',
  ]);
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.response.body, {
    data: { id: 'LEAD-1', event: 'conversation.escalated' },
  });
  assert.deepEqual(ok.json.repeat.body, ok.json.response.body);
  const bad = await snappli(['webhooks', 'trigger', 'contact.created', '--to', url], {
    SNAPPLI_WEBHOOK_SECRET: '',
  });
  assert.equal(bad.json.response.status, 401, 'sin firma se rechaza');
  console.log('nextjs-webhook: ok');
} finally {
  server.close();
}
