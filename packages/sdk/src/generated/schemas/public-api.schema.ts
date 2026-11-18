// Generado por scripts/sync-shared.mjs desde snappli-backend/src/shared/schemas/public-api.schema.ts. No editar.
import { z } from 'zod';
import { paginationSchema } from './pagination.schema.js';
import {
  webhookEventTypeSchema,
  type WebhookMappingResult,
  type WebhookResponseMapping,
} from './webhook-integration.schema.js';

/**
 * Permisos de una API key (`Authorization: Bearer sk_…`). Las keys anteriores a los permisos
 * tienen solo `contacts:read`, el acceso que ya tenían.
 */
export const API_KEY_SCOPES = [
  'contacts:read',
  'webhooks:read',
  'webhooks:test',
  'connectors:read',
  'connectors:test',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export const DEFAULT_API_KEY_SCOPES: ApiKeyScope[] = ['contacts:read'];

/** Permisos que hacen algo real (envían a la URL del cliente o ejecutan en su sistema). */
export const API_KEY_ACTION_SCOPES: ApiKeyScope[] = ['webhooks:test', 'connectors:test'];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, { label: string; description: string }> = {
  'contacts:read': {
    label: 'Leer contactos',
    description: 'GET /v1/contacts y /v1/contacts/:id.',
  },
  'webhooks:read': {
    label: 'Leer webhooks',
    description: 'Integraciones (sin secretos), historial de entregas y vista previa del mapeo.',
  },
  'webhooks:test': {
    label: 'Probar webhooks',
    description: 'Envía pruebas y reintenta entregas: llegan de verdad a la URL configurada.',
  },
  'connectors:read': {
    label: 'Leer conectores',
    description: 'Conectores, operaciones (sin secretos) y últimas llamadas.',
  },
  'connectors:test': {
    label: 'Probar conectores',
    description: 'Ejecuta operaciones de un conector en el sistema del cliente.',
  },
};

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(apiKeyScopeSchema)
    .min(1, 'Elige al menos un permiso')
    .transform((scopes) => [...new Set(scopes)])
    .default(DEFAULT_API_KEY_SCOPES),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** Peticiones por minuto y key en la API pública. */
export const PUBLIC_API_RATE_LIMIT_PER_MIN = 120;

/** `GET /v1/me`. */
export interface PublicApiMe {
  organization: { id: string; name: string };
  apiKey: { id: string; name: string; keyPrefix: string; scopes: ApiKeyScope[]; createdAt: string };
  rateLimitPerMin: number;
}

/** Integración de webhook en la API pública: nunca lleva el secreto ni el valor de la cabecera. */
export interface PublicWebhookIntegration {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  hasSecret: boolean;
  authHeaderName: string | null;
  hasAuthHeaderValue: boolean;
  subscribedEvents: z.infer<typeof webhookEventTypeSchema>[];
  stageIds: string[];
  tagIds: string[];
  conditions: unknown;
  fileUrlTtlHours: number;
  skipIfFieldSet: string | null;
  responseMapping: WebhookResponseMapping | null;
  createdAt: string;
}

export const WEBHOOK_DELIVERY_STATUSES = [
  'PENDING',
  'SUCCESS',
  'FAILED',
  'APPROVAL_PENDING',
  'APPROVED',
  'REJECTED',
  'SKIPPED',
] as const;

export type WebhookDeliveryStatusValue = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const publicWebhookDeliveryQuerySchema = paginationSchema.extend({
  webhookIntegrationId: z.string().optional(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
});

export type PublicWebhookDeliveryQuery = z.infer<typeof publicWebhookDeliveryQuerySchema>;

/** Entrega en el listado. El detalle añade cabeceras (redactadas) y el cuerpo de la respuesta. */
export interface PublicWebhookDelivery {
  id: string;
  contactId: string | null;
  stageId: string | null;
  conversationId: string | null;
  webhookIntegrationId: string | null;
  triggerSource: 'AI' | 'AGENT' | 'MANUAL' | 'BULK' | 'TEST' | 'SYSTEM';
  status: WebhookDeliveryStatusValue;
  payload: unknown;
  responseStatus: number | null;
  errorMessage: string | null;
  mappingResult: WebhookMappingResult | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface PublicWebhookDeliveryDetail extends PublicWebhookDelivery {
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
}

/** `POST /v1/webhook-integrations/:id/test`. */
export interface PublicWebhookTestResult {
  success: boolean;
  status: number;
  responseBody: string;
  deliveryId: string;
  mappingResult: WebhookMappingResult | null;
}

/** `POST /v1/webhook-integrations/:id/mapping-preview`: usa el mapeo guardado. */
export const publicMappingPreviewSchema = z.object({
  body: z.string().max(20000),
});

export type PublicMappingPreviewInput = z.infer<typeof publicMappingPreviewSchema>;
