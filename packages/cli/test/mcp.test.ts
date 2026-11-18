import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { testServer } from './helpers.js';

async function connect(env: Record<string, string> = {}, fetcher?: typeof fetch) {
  const server = createMcpServer({ env, version: '9.9.9', ...(fetcher ? { fetch: fetcher } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return {
      isError: result.isError ?? false,
      value: JSON.parse(result.content[0]?.text ?? 'null'),
    };
  };
  return { client, call };
}

describe('servidor MCP', () => {
  it('registra las herramientas de la fase 1', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'snappli_check_connector_response',
      'snappli_send_connector_event',
      'snappli_trigger_webhook',
      'snappli_verify_webhook_signature',
      'snappli_webhook_example',
    ]);
  });

  it('ejemplo, trigger y revisión de respuesta', async () => {
    const { call } = await connect({ SNAPPLI_WEBHOOK_SECRET: 's' });
    const example = await call('snappli_webhook_example', {
      event: 'contact.created',
      with_documents: true,
    });
    expect(example.value.contact.documents.comprobante_pago.status).toBe('PENDING');

    const server = await testServer();
    try {
      const trigger = await call('snappli_trigger_webhook', {
        url: server.url,
        event: 'contact.updated',
        repeat: true,
      });
      expect(trigger.isError).toBe(false);
      expect(trigger.value.request.signed).toBe(true);
      expect(server.received).toHaveLength(2);
    } finally {
      await server.close();
    }

    const check = await call('snappli_check_connector_response', {
      body: '{"id":"A"}',
      response_map: { id: '$.id' },
    });
    expect(check.value.aiSees).toBe('{"id":"A"}');
  });

  it('un evento a Snappli necesita SNAPPLI_ALLOW_WRITE=1', async () => {
    const fetcher = (async () =>
      Response.json({
        status: 'sent',
        messageId: 'm',
        conversationId: 'c',
      })) as unknown as typeof fetch;
    const args = { type: 'pedido.enviado', data: {}, connector_id: 'conn_1', secret: 's' };
    const blocked = await (await connect({}, fetcher)).call('snappli_send_connector_event', args);
    expect(blocked.isError).toBe(true);
    expect(blocked.value.error.code).toBe('write_not_allowed');
    const allowed = await (await connect({ SNAPPLI_ALLOW_WRITE: '1' }, fetcher)).call(
      'snappli_send_connector_event',
      args,
    );
    expect(allowed.value.result.status).toBe('sent');
  });

  it('verificar firma devuelve el motivo', async () => {
    const { call } = await connect();
    const out = await call('snappli_verify_webhook_signature', {
      body: '{}',
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: 'abc',
      secret: 's',
    });
    expect(out.value).toMatchObject({ valid: false, reason: 'bad_signature' });
  });
});
