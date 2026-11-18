// Generado por scripts/sync-shared.mjs desde snappli-backend/src/shared/connectors.ts. No editar.
import { z } from 'zod';

/**
 * Conectores a sistemas externos de la organización (plan del harness §10).
 * Compartido con el frontend: validación, vistas y plantillas de inicio.
 */

export const CONNECTOR_AUTH_TYPES = ['none', 'api_key_header', 'api_key_query', 'bearer', 'basic'] as const;
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

export const CONNECTOR_OPERATION_KINDS = ['read', 'write'] as const;
export type ConnectorOperationKind = (typeof CONNECTOR_OPERATION_KINDS)[number];

export const CONNECTOR_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Fuentes de un parámetro ligado: la ficha del contacto, nunca lo que escribe. */
export const CONNECTOR_BOUND_SOURCES = ['contact.id', 'contact.phone', 'contact.email', 'contact.name'] as const;
const BOUND_SOURCE = /^(contact\.(id|phone|email|name)|contact\.field\.[a-z0-9_]+)$/i;

const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export const connectorParamPropertySchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  description: z.string().max(300).optional(),
  enum: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export const connectorParamsSchemaSchema = z.object({
  type: z.literal('object').default('object'),
  properties: z
    .record(z.string().regex(PARAM_NAME, 'Nombre de parámetro: minúsculas, números y _'), connectorParamPropertySchema)
    .default({}),
  required: z.array(z.string()).optional(),
});

export const connectorAuthConfigSchema = z
  .object({
    headerName: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional(),
    queryParam: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/).optional(),
    username: z.string().max(200).optional(),
  })
  .strict();

export const connectorInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,23}$/, 'Identificador: minúsculas, números y _ (2–24)'),
  baseUrl: z.string().trim().url().max(500),
  authType: z.enum(CONNECTOR_AUTH_TYPES).default('none'),
  /** Solo al crear o cambiarlo; nunca se devuelve. Vacío = no cambiar. */
  authSecret: z.string().max(4000).optional(),
  clearAuthSecret: z.boolean().optional(),
  authConfig: connectorAuthConfigSchema.optional(),
  defaultHeaders: z
    .record(z.string().regex(/^[A-Za-z0-9-]{1,60}$/), z.string().max(500))
    .refine((h) => Object.keys(h).length <= 20, 'Máximo 20 cabeceras')
    .optional(),
  timeoutMs: z.number().int().min(1000).max(20_000).default(8000),
  rateLimitPerMin: z.number().int().min(1).max(600).default(60),
  departmentIds: z.array(z.string().min(1)).max(50).default([]),
  sensitive: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type ConnectorInput = z.infer<typeof connectorInputSchema>;
export const updateConnectorSchema = connectorInputSchema.partial();

export const connectorOperationInputSchema = z
  .object({
    name: z.string().regex(PARAM_NAME, 'Nombre: minúsculas, números y _ (hasta 40)'),
    description: z.string().trim().min(10).max(600),
    kind: z.enum(CONNECTOR_OPERATION_KINDS),
    method: z.enum(CONNECTOR_HTTP_METHODS),
    path: z.string().trim().min(1).max(500).regex(/^\//, 'La ruta empieza con /'),
    paramsSchema: connectorParamsSchemaSchema.default({ type: 'object', properties: {} }),
    boundParams: z
      .record(z.string().regex(PARAM_NAME), z.string().regex(BOUND_SOURCE, 'Fuente: contact.phone, contact.email, contact.name, contact.id o contact.field.<clave>'))
      .optional(),
    requiresIdentifiedContact: z.boolean().default(false),
    bodyTemplate: z.unknown().optional(),
    responseMap: z
      .record(z.string().regex(PARAM_NAME), z.string().regex(/^\$/, 'Ruta JSONPath que empieza con $'))
      .optional(),
    confirmationTemplate: z.string().trim().max(300).optional(),
    isEnabled: z.boolean().default(true),
  })
  .superRefine((op, ctx) => {
    const params = op.paramsSchema.properties;
    const bound = op.boundParams ?? {};
    for (const name of Object.keys(bound)) {
      if (name in params) ctx.addIssue({ code: 'custom', path: ['boundParams', name], message: `«${name}» no puede ser a la vez parámetro del modelo y ligado` });
    }
    const known = new Set([...Object.keys(params), ...Object.keys(bound), ...Object.keys(bound).map((k) => `bound.${k}`)]);
    for (const match of op.path.matchAll(/\{([a-z0-9_.]+)\}/gi)) {
      if (!known.has(match[1]!)) ctx.addIssue({ code: 'custom', path: ['path'], message: `La ruta usa «{${match[1]}}», que no es un parámetro` });
    }
    if (op.kind === 'write' && !op.confirmationTemplate) {
      ctx.addIssue({ code: 'custom', path: ['confirmationTemplate'], message: 'Las escrituras necesitan un texto de confirmación' });
    }
  });
export type ConnectorOperationInput = z.infer<typeof connectorOperationInputSchema>;

export const testConnectorOperationSchema = z.object({
  args: z.record(z.unknown()).default({}),
  /** Valores de ejemplo para los parámetros ligados (en la prueba no hay contacto). */
  boundValues: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Las escrituras de prueba se ejecutan de verdad: hay que marcarlo. */
  allowWrite: z.boolean().default(false),
});

/** Importar operaciones de OpenAPI 3: la especificación pegada o su URL (https). */
export const connectorOpenApiImportSchema = z
  .object({
    spec: z.string().max(1_000_000).optional(),
    url: z.string().url().max(500).optional(),
  })
  .refine((v) => Boolean(v.spec?.trim()) !== Boolean(v.url?.trim()), 'Pega la especificación o indica su URL (solo una)');

export type ConnectorOpenApiPreview = {
  operations: Array<ConnectorOperationInput & { notes: string[] }>;
  skipped: string[];
};

export type ConnectorOperationView = Omit<ConnectorOperationInput, 'bodyTemplate'> & {
  id: string;
  bodyTemplate: unknown;
  /** Nombre de la herramienta que ve la IA. */
  toolName: string;
};

export type ConnectorView = Omit<ConnectorInput, 'authSecret' | 'clearAuthSecret'> & {
  id: string;
  authSecretConfigured: boolean;
  operations: ConnectorOperationView[];
  createdAt: string;
  updatedAt: string;
};

export type ConnectorTestResult = {
  ok: boolean;
  status?: number;
  /** Lo que vería la IA (recortado) o el error legible. */
  text: string;
  /** Sin responseMap: aviso «define los campos a devolver». */
  mapped: boolean;
};

/** Plantillas de inicio (§10.2): solo nombres, descripciones y esquemas de ejemplo. */
export type ConnectorTemplate = {
  id: string;
  name: string;
  slug: string;
  description: string;
  operations: Array<Omit<ConnectorOperationInput, 'isEnabled'>>;
};

const str = (description: string) => ({ type: 'string' as const, description });

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: 'agenda',
    name: 'Agenda / reservas',
    slug: 'agenda',
    description: 'Disponibilidad, reservar, mis reservas y cancelar.',
    operations: [
      {
        name: 'disponibilidad',
        description: 'Horarios libres para una fecha (y profesional o servicio, si se indica). Úsala antes de proponer una cita.',
        kind: 'read',
        method: 'GET',
        path: '/slots?fecha={fecha}&profesional={profesional}',
        paramsSchema: { type: 'object', properties: { fecha: str('Fecha AAAA-MM-DD'), profesional: str('Nombre del profesional (opcional)') }, required: ['fecha'] },
        requiresIdentifiedContact: false,
        responseMap: { horarios: '$.slots[*].hora' },
      },
      {
        name: 'reservar',
        description: 'Reserva una cita en un horario libre. Solo tras confirmar el contacto.',
        kind: 'write',
        method: 'POST',
        path: '/appointments',
        paramsSchema: { type: 'object', properties: { fecha: str('Fecha AAAA-MM-DD'), hora: str('Hora HH:MM'), servicio: str('Servicio') }, required: ['fecha', 'hora', 'servicio'] },
        boundParams: { telefono: 'contact.phone', nombre: 'contact.name' },
        requiresIdentifiedContact: false,
        responseMap: { id: '$.id', estado: '$.status' },
        confirmationTemplate: 'Reservo {servicio} el {fecha} a las {hora}. ¿Confirmas?',
      },
      {
        name: 'mis_reservas',
        description: 'Próximas reservas del contacto.',
        kind: 'read',
        method: 'GET',
        path: '/appointments?telefono={telefono}',
        paramsSchema: { type: 'object', properties: {} },
        boundParams: { telefono: 'contact.phone' },
        requiresIdentifiedContact: true,
        responseMap: { reservas: '$.appointments' },
      },
    ],
  },
  {
    id: 'pedidos',
    name: 'Pedidos y envíos',
    slug: 'pedidos',
    description: 'Estado de pedidos y devoluciones.',
    operations: [
      {
        name: 'mis_pedidos',
        description: 'Pedidos recientes del contacto con su estado.',
        kind: 'read',
        method: 'GET',
        path: '/orders?telefono={telefono}',
        paramsSchema: { type: 'object', properties: {} },
        boundParams: { telefono: 'contact.phone' },
        requiresIdentifiedContact: true,
        responseMap: { pedidos: '$.orders' },
      },
      {
        name: 'crear_devolucion',
        description: 'Abre una devolución de un pedido del contacto.',
        kind: 'write',
        method: 'POST',
        path: '/returns',
        paramsSchema: { type: 'object', properties: { pedido: str('Número de pedido'), motivo: str('Motivo') }, required: ['pedido', 'motivo'] },
        boundParams: { telefono: 'contact.phone' },
        requiresIdentifiedContact: true,
        responseMap: { id: '$.id' },
        confirmationTemplate: 'Abro la devolución del pedido {pedido} por «{motivo}». ¿Confirmas?',
      },
    ],
  },
  {
    id: 'catalogo',
    name: 'Catálogo y stock',
    slug: 'catalogo',
    description: 'Buscar productos, precio y stock.',
    operations: [
      {
        name: 'precio_y_stock',
        description: 'Precio y unidades disponibles de un producto.',
        kind: 'read',
        method: 'GET',
        path: '/products?q={producto}',
        paramsSchema: { type: 'object', properties: { producto: str('Nombre o código del producto') }, required: ['producto'] },
        requiresIdentifiedContact: false,
        responseMap: { productos: '$.items' },
      },
    ],
  },
  {
    id: 'tickets',
    name: 'Tickets / soporte',
    slug: 'tickets',
    description: 'Crear y consultar tickets.',
    operations: [
      {
        name: 'crear_ticket',
        description: 'Crea un ticket de soporte con el problema del contacto.',
        kind: 'write',
        method: 'POST',
        path: '/tickets',
        paramsSchema: { type: 'object', properties: { asunto: str('Resumen del problema'), detalle: str('Detalle') }, required: ['asunto'] },
        boundParams: { email: 'contact.email' },
        requiresIdentifiedContact: false,
        responseMap: { id: '$.id' },
        confirmationTemplate: 'Creo un ticket: «{asunto}». ¿Confirmas?',
      },
    ],
  },
];

/** Evento entrante → plantilla de WhatsApp (§10.5). */
export const connectorEventMappingInputSchema = z.object({
  eventType: z.string().trim().regex(/^[a-z0-9_.-]{2,60}$/i, 'Tipo: letras, números, punto, guion o _'),
  contactBy: z.enum(['phone', 'email']).default('phone'),
  contactPath: z.string().trim().regex(/^\$/, 'Ruta JSONPath que empieza con $'),
  templateName: z.string().trim().min(1).max(200),
  templateLanguage: z.string().trim().min(2).max(10).default('es'),
  bodyParameterPaths: z.array(z.string().trim().regex(/^\$/, 'Ruta JSONPath que empieza con $')).max(20).default([]),
  isEnabled: z.boolean().default(true),
});
export type ConnectorEventMappingInput = z.infer<typeof connectorEventMappingInputSchema>;
export type ConnectorEventMappingView = ConnectorEventMappingInput & { id: string };

export type ConnectorEventsView = {
  enabled: boolean;
  /** Ruta pública que llama el sistema externo. */
  endpointPath: string;
  mappings: ConnectorEventMappingView[];
};

/** Solo al activar o rotar: el secreto se muestra una vez. */
export type ConnectorEventSecret = { secret: string; endpointPath: string };

/** Cabeceras que firma el sistema externo. */
export const CONNECTOR_EVENT_HEADERS = {
  timestamp: 'x-snappli-timestamp',
  signature: 'x-snappli-signature',
  eventId: 'x-snappli-event-id',
} as const;
