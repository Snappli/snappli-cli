import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectorEventsUrl, WEBHOOK_DELIVERY_STATUSES } from '@snappli/sdk';
import { z } from 'zod';
import { createClient, type Env, resolveApiUrl } from './config.js';
import {
  checkConnectorResponse,
  connectorLogs,
  DOCS_URL,
  getConnector,
  getDelivery,
  getWebhookIntegration,
  listConnectors,
  listDeliveries,
  listWebhookIntegrations,
  previewMapping,
  retryDelivery,
  sendEvent,
  testConnectorOperation,
  testWebhook,
  triggerWebhook,
  verifySignature,
  WEBHOOK_EVENT_TYPES,
  webhookExample,
  whoami,
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
 * Servidor MCP con las mismas operaciones que el CLI. Las de lectura de la cuenta usan la key de
 * `SNAPPLI_API_KEY` o la guardada con `snappli login`. Lo que tiene efectos reales (un evento a una
 * URL que no es local manda un WhatsApp; probar o reintentar un webhook llega a la URL del
 * cliente) exige `SNAPPLI_ALLOW_WRITE=1`; probar y reintentar ni se registran sin él.
 */
export function createMcpServer({ env, version, fetch: fetcher }: McpOptions): McpServer {
  const allowWrite = env.SNAPPLI_ALLOW_WRITE === '1';
  const server = new McpServer(
    { name: 'snappli', version },
    {
      instructions: `Herramientas para construir y probar el lado del integrador con Snappli (CRM de WhatsApp): recibir sus webhooks, exponer una API que Snappli llama como conector y enviarle eventos. Con API key (SNAPPLI_API_KEY o snappli login) también lee las integraciones de webhook y su historial de entregas (qué mandó Snappli de verdad y qué respondió el servidor), y los conectores: su configuración, sus últimas llamadas y probar una operación contra tu API como lo haría la IA. Empieza por snappli_webhook_example para ver el payload, y prueba el receptor con snappli_trigger_webhook contra localhost. Las firmas de webhook son HMAC SHA-256 en hex sin prefijo de "timestamp.body"; las de eventos de conector llevan "sha256=". Documentación: ${DOCS_URL}`,
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

  const keyed = async () => (await createClient({ env, fetch: fetcher, version })).client;
  const KEY_NOTE = 'Necesita API key (SNAPPLI_API_KEY o snappli login)';

  server.registerTool(
    'snappli_account',
    {
      title: 'Cuenta de Snappli',
      description: `${KEY_NOTE}. Organización, nombre y permisos de la key, permisos que le faltan y límite por minuto. Úsalo primero para saber qué herramientas con key funcionarán.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async () => {
      const { client, source, apiUrl } = await createClient({ env, fetch: fetcher, version });
      return whoami(client, source, apiUrl);
    }),
  );

  server.registerTool(
    'snappli_webhook_integrations',
    {
      title: 'Integraciones de webhook',
      description: `${KEY_NOTE} con webhooks:read. Sin id, lista las integraciones de webhook de la organización; con id, devuelve una. Nunca incluye el secreto ni el valor de la cabecera de autenticación (solo hasSecret y hasAuthHeaderValue). Incluye eventos suscritos, filtros y el mapeo de respuesta.`,
      inputSchema: { id: z.string().optional().describe('Id de la integración.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ id }: { id?: string }) =>
      id ? getWebhookIntegration(await keyed(), id) : listWebhookIntegrations(await keyed()),
    ),
  );

  server.registerTool(
    'snappli_webhook_deliveries',
    {
      title: 'Entregas de webhook',
      description: `${KEY_NOTE} con webhooks:read. Sin id, el historial de entregas (más recientes primero) con filtros; con id, el detalle de una: payload real enviado, cabeceras (secretos ocultos), código y cuerpo de la respuesta del servidor, intentos y mappingResult. El payload sirve como entrada para snappli_trigger_webhook contra localhost.`,
      inputSchema: {
        id: z.string().optional().describe('Id de la entrega para ver el detalle.'),
        webhook_integration_id: z.string().optional().describe('Filtrar por integración.'),
        status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional().describe('Filtrar por estado.'),
        limit: z.number().int().min(1).max(100).optional().describe('Por defecto 20.'),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(
      async (args: {
        id?: string;
        webhook_integration_id?: string;
        status?: string;
        limit?: number;
        page?: number;
      }) =>
        args.id
          ? getDelivery(await keyed(), args.id)
          : listDeliveries(await keyed(), {
              webhookIntegrationId: args.webhook_integration_id,
              status: args.status,
              limit: args.limit,
              page: args.page,
            }),
    ),
  );

  server.registerTool(
    'snappli_preview_mapping',
    {
      title: 'Vista previa del mapeo de respuesta',
      description: `${KEY_NOTE} con webhooks:read. Con el mapeo de respuesta guardado en la integración, dice qué campos rellenaría Snappli si el servidor respondiera este cuerpo. No envía ni guarda nada.`,
      inputSchema: {
        id: z.string().describe('Id de la integración.'),
        response_body: z.string().describe('Cuerpo de la respuesta de tu servidor (texto).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ id, response_body }: { id: string; response_body: string }) =>
      previewMapping(await keyed(), id, response_body),
    ),
  );

  server.registerTool(
    'snappli_connectors',
    {
      title: 'Conectores',
      description: `${KEY_NOTE} con connectors:read. Sin id, lista los conectores de la organización; con id, devuelve uno. Incluye URL base, autenticación (sin el secreto: authSecretConfigured), nombres de las cabeceras por defecto (sin valores), límites y operaciones: nombre, descripción (lo que lee la IA), método, ruta, paramsSchema, boundParams, responseMap, confirmationTemplate y toolName.`,
      inputSchema: { id: z.string().optional().describe('Id del conector.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ id }: { id?: string }) =>
      id ? getConnector(await keyed(), id) : listConnectors(await keyed()),
    ),
  );

  server.registerTool(
    'snappli_connector_logs',
    {
      title: 'Llamadas de un conector',
      description: `${KEY_NOTE} con connectors:read. Últimas 50 llamadas del conector (de la IA y de pruebas): operación, parámetros (solo nombres si el conector es sensible), código HTTP, latencia y error. Úsalo para ver por qué falló una llamada de la IA a tu API.`,
      inputSchema: { id: z.string().describe('Id del conector.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ id }: { id: string }) => connectorLogs(await keyed(), id)),
  );

  server.registerTool(
    'snappli_test_connector_operation',
    {
      title: 'Probar operación de conector',
      description: `${KEY_NOTE} con connectors:test. Snappli ejecuta la operación como lo haría la IA, contra tu API real, y devuelve el código y el texto que leería la IA (recortado y con el responseMap aplicado). Las de lectura no cambian nada. Las de escritura se ejecutan de verdad y solo se permiten con SNAPPLI_ALLOW_WRITE=1${allowWrite ? ' (activo)' : ' (no activo: solo lecturas)'}.`,
      inputSchema: {
        connector_id: z.string().describe('Id del conector.'),
        operation: z.string().describe('Id, nombre o toolName de la operación.'),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Argumentos que mandaría la IA, según el paramsSchema.'),
        bound_values: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            'Valores de ejemplo para los parámetros ligados al contacto (en la prueba no hay contacto).',
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    tool(
      async (args: {
        connector_id: string;
        operation: string;
        args?: Record<string, unknown>;
        bound_values?: Record<string, string | number | boolean>;
      }) =>
        testConnectorOperation(await keyed(), {
          connectorId: args.connector_id,
          operation: args.operation,
          args: args.args ?? {},
          boundValues: args.bound_values ?? {},
          allowWrite,
        }),
    ),
  );

  if (allowWrite) {
    server.registerTool(
      'snappli_test_webhook',
      {
        title: 'Enviar prueba de webhook',
        description: `${KEY_NOTE} con webhooks:test. El botón «Enviar prueba» del panel: Snappli envía un payload de prueba a la URL configurada en la integración (llega de verdad) y devuelve el código, la respuesta, el id de la entrega y lo que rellenaría el mapeo.`,
        inputSchema: { id: z.string().describe('Id de la integración.') },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      tool(async ({ id }: { id: string }) => testWebhook(await keyed(), id, allowWrite)),
    );

    server.registerTool(
      'snappli_retry_delivery',
      {
        title: 'Reintentar entrega',
        description: `${KEY_NOTE} con webhooks:test. Vuelve a encolar una entrega (normalmente FAILED): Snappli la envía de nuevo a la URL configurada (llega de verdad). Mira el resultado después con snappli_webhook_deliveries.`,
        inputSchema: { id: z.string().describe('Id de la entrega.') },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      tool(async ({ id }: { id: string }) => retryDelivery(await keyed(), id, allowWrite)),
    );
  }

  return server;
}
