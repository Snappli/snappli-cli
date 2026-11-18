import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectorEventsUrl } from '@snappli/sdk';
import { z } from 'zod';
import { type Env, resolveApiUrl } from './config.js';
import {
  checkConnectorResponse,
  DOCS_URL,
  sendEvent,
  triggerWebhook,
  verifySignature,
  WEBHOOK_EVENT_TYPES,
  webhookExample,
} from './operations.js';
import { formatError } from './output.js';

export interface McpOptions {
  env: Env;
  version: string;
  fetch?: typeof fetch;
}

const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (error: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(formatError(error), null, 2) }],
  isError: true,
});

const tool =
  <A>(handler: (args: A) => Promise<unknown> | unknown) =>
  async (args: A) => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };

/**
 * Servidor MCP con las mismas operaciones que el CLI. Ninguna herramienta de esta fase necesita API
 * key. Lo que tiene efectos reales en Snappli (un evento a una URL que no es local manda un
 * WhatsApp) exige `SNAPPLI_ALLOW_WRITE=1`.
 */
export function createMcpServer({ env, version, fetch: fetcher }: McpOptions): McpServer {
  const allowWrite = env.SNAPPLI_ALLOW_WRITE === '1';
  const server = new McpServer(
    { name: 'snappli', version },
    {
      instructions: `Herramientas para construir y probar el lado del integrador con Snappli (CRM de WhatsApp): recibir sus webhooks, exponer una API que Snappli llama como conector y enviarle eventos. Empieza por snappli_webhook_example para ver el payload, y prueba el receptor con snappli_trigger_webhook contra localhost. Las firmas de webhook son HMAC SHA-256 en hex sin prefijo de "timestamp.body"; las de eventos de conector llevan "sha256=". Documentación: ${DOCS_URL}`,
    },
  );

  server.registerTool(
    'snappli_webhook_example',
    {
      title: 'Webhook de ejemplo',
      description:
        'Payload de ejemplo válido de un webhook de Snappli para el evento indicado, con datos coherentes. Con with_documents incluye contact.documents (uno APPROVED y otro PENDING) con url y urlExpiresAt. No envía nada: sirve para escribir los tipos y los tests del receptor.',
      inputSchema: {
        event: z.enum(WEBHOOK_EVENT_TYPES).describe('Tipo de evento.'),
        with_documents: z.boolean().optional().describe('Incluir documentos del contacto.'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ event, with_documents }: { event: string; with_documents?: boolean }) =>
      webhookExample(event, with_documents ?? false),
    ),
  );

  server.registerTool(
    'snappli_trigger_webhook',
    {
      title: 'Probar receptor de webhooks',
      description:
        'Firma y envía un webhook a la URL indicada (tu servidor, p. ej. http://localhost:3000/webhooks/snappli) con las mismas cabeceras que Snappli (X-Snappli-Signature, X-Snappli-Timestamp, Idempotency-Key, X-Snappli-Delivery-Id). Devuelve el código, el tiempo, la respuesta, avisos (no 2xx, más de 15 s, respuesta no JSON) y, con mapping, qué campos rellenaría el mapeo de respuesta. Con repeat reenvía la misma entrega para probar el dedupe. Con with_documents sirve archivos reales en un puerto local y cuenta si tu receptor los descargó. Nunca envía a la URL configurada en Snappli.',
      inputSchema: {
        url: z.string().url().describe('URL de tu receptor.'),
        event: z
          .enum(WEBHOOK_EVENT_TYPES)
          .optional()
          .describe('Evento de ejemplo a enviar (o usa payload).'),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Payload propio en vez del de ejemplo (p. ej. uno real del historial).'),
        secret: z
          .string()
          .optional()
          .describe('Secreto de la integración. Por defecto SNAPPLI_WEBHOOK_SECRET.'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Cabeceras extra, p. ej. la de autenticación de la integración.'),
        mapping: z
          .object({
            fields: z.record(z.string(), z.string()).optional(),
            note: z.string().optional(),
          })
          .optional()
          .describe(
            'Mapeo de respuesta: {"fields":{"id_pedido":"$.data.id"},"note":"…{{id_pedido}}"}.',
          ),
        repeat: z.boolean().optional().describe('Reenviar con la misma Idempotency-Key.'),
        with_documents: z.boolean().optional().describe('Incluir documentos descargables.'),
        timeout_seconds: z
          .number()
          .positive()
          .max(120)
          .optional()
          .describe('Por defecto 15 (como Snappli).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(
      async (args: {
        url: string;
        event?: string;
        payload?: Record<string, unknown>;
        secret?: string;
        headers?: Record<string, string>;
        mapping?: { fields?: Record<string, string>; note?: string };
        repeat?: boolean;
        with_documents?: boolean;
        timeout_seconds?: number;
      }) =>
        triggerWebhook({
          url: args.url,
          event: args.event,
          ...(args.payload ? { payload: args.payload } : {}),
          secret: args.secret ?? env.SNAPPLI_WEBHOOK_SECRET,
          headers: args.headers ?? {},
          ...(args.mapping ? { mapping: args.mapping } : {}),
          repeat: args.repeat ?? false,
          withDocuments: args.with_documents ?? false,
          ...(args.timeout_seconds ? { timeoutMs: args.timeout_seconds * 1000 } : {}),
          ...(fetcher ? { fetch: fetcher } : {}),
        }),
    ),
  );

  server.registerTool(
    'snappli_verify_webhook_signature',
    {
      title: 'Verificar firma de webhook',
      description:
        'Comprueba una firma X-Snappli-Signature con el secreto, la marca de tiempo y el cuerpo crudo exacto, y explica el fallo (reformateo del JSON, salto de línea final, milisegundos, prefijo sha256=, reloj).',
      inputSchema: {
        body: z.string().describe('Cuerpo crudo tal como llegó.'),
        timestamp: z.string().describe('Valor de X-Snappli-Timestamp.'),
        signature: z.string().describe('Valor de X-Snappli-Signature.'),
        secret: z.string().optional().describe('Por defecto SNAPPLI_WEBHOOK_SECRET.'),
        ignore_time: z
          .boolean()
          .optional()
          .describe('No comprobar la hora (entrega antigua copiada del historial).'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(
      (args: {
        body: string;
        timestamp: string;
        signature: string;
        secret?: string;
        ignore_time?: boolean;
      }) =>
        verifySignature({
          body: args.body,
          timestamp: args.timestamp,
          signature: args.signature,
          secret: args.secret ?? env.SNAPPLI_WEBHOOK_SECRET ?? '',
          ignoreTime: args.ignore_time ?? false,
        }),
    ),
  );

  server.registerTool(
    'snappli_send_connector_event',
    {
      title: 'Enviar evento a Snappli',
      description: `Envía un evento firmado (POST /api/integrations/connectors/:id/events, cuerpo {type, data}, firma sha256= y x-snappli-event-id) y devuelve el resultado: sent, ignored (no_mapping, no_contact, duplicate) o failed, con una pista. Si la URL no es local, Snappli manda un WhatsApp real al contacto: eso solo se permite con SNAPPLI_ALLOW_WRITE=1${allowWrite ? ' (activo)' : ' (no activo: solo URLs locales o mocks)'}.`,
      inputSchema: {
        type: z
          .string()
          .min(1)
          .describe('Tipo de evento, el de la regla del panel (p. ej. pedido.enviado).'),
        data: z.record(z.string(), z.unknown()).describe('Datos del evento.'),
        url: z.string().url().optional().describe('URL de eventos del conector (o un mock local).'),
        connector_id: z.string().optional().describe('Id del conector, en vez de url.'),
        secret: z.string().optional().describe('Por defecto SNAPPLI_CONNECTOR_EVENT_SECRET.'),
        event_id: z
          .string()
          .optional()
          .describe('Id estable del evento (6–100 de [A-Za-z0-9_.:-]); si falta se genera.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(
      async (args: {
        type: string;
        data: Record<string, unknown>;
        url?: string;
        connector_id?: string;
        secret?: string;
        event_id?: string;
      }) =>
        sendEvent({
          url:
            args.url ??
            (args.connector_id ? connectorEventsUrl(args.connector_id, resolveApiUrl(env)) : ''),
          type: args.type,
          data: args.data,
          secret: args.secret ?? env.SNAPPLI_CONNECTOR_EVENT_SECRET,
          eventId: args.event_id,
          allowWrite,
          ...(fetcher ? { fetch: fetcher } : {}),
        }),
    ),
  );

  server.registerTool(
    'snappli_check_connector_response',
    {
      title: 'Revisar respuesta de conector',
      description:
        'Dada la respuesta de tu API (texto) y el responseMap de la operación, devuelve lo que leería la IA de Snappli (recortado a 2048 caracteres), los valores de cada campo y avisos: rutas que no existen, más de 1 MB, respuesta no JSON. Es local: no llama a nada.',
      inputSchema: {
        body: z.string().describe('Cuerpo de la respuesta de tu API.'),
        response_map: z
          .record(z.string(), z.string())
          .optional()
          .describe('{"campo":"$.ruta"}, como en la operación del conector.'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ body, response_map }: { body: string; response_map?: Record<string, string> }) =>
      checkConnectorResponse(body, response_map),
    ),
  );

  return server;
}
