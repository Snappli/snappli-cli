// Generado por scripts/sync-shared.mjs desde snappli-backend/src/shared/schemas/webhook-integration.schema.ts. No editar.
import { z } from 'zod';
import { contactSegmentFiltersSchema } from '../contact-segments.js';
import { paginationSchema } from './pagination.schema.js';

export const WEBHOOK_EVENT_TYPES = [
  'contact.stage.entered',
  'contact.webhook.manual',
  'contact.created',
  'contact.updated',
  'contact.tag.assigned',
  'conversation.escalated',
] as const;

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/** Horas que valen los enlaces de los documentos del payload (se firman en cada intento). */
export const WEBHOOK_FILE_URL_TTL_DEFAULT_HOURS = 72;
export const WEBHOOK_FILE_URL_TTL_MAX_HOURS = 168;

const jsonPathSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^\$(\.[A-Za-z0-9_-]+|\[\d+\])*$/, 'Ruta JSONPath simple, p. ej. $.data.id');

/**
 * Qué hacer con la respuesta 2xx del webhook: copiar valores a campos del
 * contacto (JSONPath → clave del campo), añadir etiquetas y dejar una nota.
 */
export const webhookResponseMappingSchema = z.object({
  fields: z.record(z.string().trim().min(1).max(80), jsonPathSchema).default({}),
  addTagIds: z.array(z.string().min(1)).max(20).default([]),
  note: z.string().trim().max(1000).optional().nullable(),
});

export type WebhookResponseMapping = z.infer<typeof webhookResponseMappingSchema>;

export const webhookResponseMappingPreviewSchema = z.object({
  mapping: webhookResponseMappingSchema,
  body: z.string().max(20000),
});

/** Resultado de aplicar el mapeo de la respuesta, guardado en la entrega. */
export interface WebhookMappingResult {
  fields: Array<{ key: string; path: string; value: string | null; saved: boolean; reason?: string }>;
  tagsAdded: string[];
  noteAdded: boolean;
  warnings: string[];
}

/** Documento del contacto en el payload: `url` se firma al enviar cada intento. */
export interface WebhookContactDocument {
  label: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  storageKey: string;
  mimeType: string;
  size: number;
  fileName: string | null;
  url?: string;
  urlExpiresAt?: string;
}

export const webhookIntegrationInputSchema = z.object({
  label: z.string().trim().min(1, 'El nombre es obligatorio').max(80),
  url: z.string().url('URL inválida'),
  secret: z.string().max(256).optional().nullable(),
  authHeaderName: z.string().trim().max(128).optional().nullable(),
  authHeaderValue: z.string().max(1024).optional().nullable(),
  enabled: z.boolean().optional(),
  subscribedEvents: z.array(webhookEventTypeSchema).optional(),
  stageIds: z.array(z.string().min(1)).optional(),
  tagIds: z.array(z.string().min(1)).optional(),
  conditions: contactSegmentFiltersSchema.nullable().optional(),
  fileUrlTtlHours: z.number().int().min(1).max(WEBHOOK_FILE_URL_TTL_MAX_HOURS).optional(),
  /** No enviar si el contacto ya tiene este campo (p. ej. el ID que devolvió el sistema externo). */
  skipIfFieldSet: z.string().trim().max(80).optional().nullable(),
  responseMapping: webhookResponseMappingSchema.nullable().optional(),
});

export const updateWebhookIntegrationInputSchema =
  webhookIntegrationInputSchema.partial();

export const webhookDeliveryQuerySchema = paginationSchema.extend({
  contactId: z.string().optional(),
  webhookIntegrationId: z.string().optional(),
  status: z
    .enum([
      'PENDING',
      'SUCCESS',
      'FAILED',
      'APPROVAL_PENDING',
      'APPROVED',
      'REJECTED',
      'SKIPPED',
    ])
    .optional(),
});

export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;
export type WebhookIntegrationInput = z.infer<
  typeof webhookIntegrationInputSchema
>;
export type UpdateWebhookIntegrationInput = z.infer<
  typeof updateWebhookIntegrationInputSchema
>;
export type WebhookDeliveryQueryInput = z.infer<
  typeof webhookDeliveryQuerySchema
>;

export interface WebhookContactPayload {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  language: string | null;
  countryCode: string | null;
  tags: string[];
  /** Campos personalizados, sin los de tipo archivo (esos van en `documents`). */
  customFields: Record<string, unknown>;
  /** Campos de tipo archivo con su estado; la `url` firmada se añade al enviar. */
  documents?: Record<string, WebhookContactDocument>;
}

export interface WebhookPipelinePayload {
  stageId: string | null;
  stageName: string | null;
  previousStageId: string | null;
  previousStageName: string | null;
}

export interface WebhookConversationPayload {
  id: string | null;
  channel: string | null;
  lastMessageAt: string | null;
}

export interface WebhookTriggerPayload {
  source: 'AI' | 'AGENT' | 'MANUAL' | 'BULK' | 'TEST' | 'SYSTEM';
  userId: string | null;
  deliveryId: string;
}

interface WebhookBasePayload {
  organizationId: string;
  sentAt: string;
  trigger: WebhookTriggerPayload;
}

export interface WebhookPipelineEventPayload extends WebhookBasePayload {
  event: 'contact.stage.entered' | 'contact.webhook.manual';
  contact: WebhookContactPayload;
  pipeline: WebhookPipelinePayload;
  conversation: WebhookConversationPayload;
}

export interface WebhookContactEventPayload extends WebhookBasePayload {
  event: 'contact.created' | 'contact.updated';
  contact: WebhookContactPayload;
}

export interface WebhookTagAssignedPayload extends WebhookBasePayload {
  event: 'contact.tag.assigned';
  contact: WebhookContactPayload;
  tag: { id: string; name: string; source: 'AI' | 'AGENT' | 'MANUAL' };
}

export interface WebhookConversationEscalatedPayload extends WebhookBasePayload {
  event: 'conversation.escalated';
  contact: WebhookContactPayload;
  conversation: WebhookConversationPayload;
  reason?: string | null;
  /** Resumen del traspaso escrito por la IA (skill `escalar_a_humano`). */
  summary?: string | null;
  departmentId: string | null;
  departmentName: string | null;
}

export type WebhookOutboundPayload =
  | WebhookPipelineEventPayload
  | WebhookContactEventPayload
  | WebhookTagAssignedPayload
  | WebhookConversationEscalatedPayload;

export const DEFAULT_WEBHOOK_SUBSCRIBED_EVENTS: WebhookEventType[] = [
  'contact.stage.entered',
  'contact.webhook.manual',
];

export function buildWebhookTestPayload(
  organizationId: string,
): WebhookPipelineEventPayload {
  const now = new Date().toISOString();
  return {
    event: 'contact.webhook.manual',
    organizationId,
    contact: {
      id: 'contact_test',
      firstName: 'María',
      lastName: 'Ejemplo',
      displayName: 'María Ejemplo',
      email: 'maria@ejemplo.com',
      phone: '+573001234567',
      language: 'es',
      countryCode: 'CO',
      tags: ['test'],
      customFields: {},
      documents: {
        documento_identidad: {
          label: 'Documento de identidad',
          status: 'APPROVED',
          storageKey: 'orgs/ejemplo/contacts/contact_test/documento_identidad.jpg',
          mimeType: 'image/jpeg',
          size: 120000,
          fileName: null,
          url: 'https://api.snappli.io/api/webhook-files/ejemplo',
          urlExpiresAt: now,
        },
      },
    },
    pipeline: {
      stageId: 'stage_test',
      stageName: 'Calificado',
      previousStageId: 'stage_prev',
      previousStageName: 'Nuevo',
    },
    conversation: {
      id: 'conv_test',
      channel: 'whatsapp',
      lastMessageAt: now,
    },
    trigger: {
      source: 'TEST',
      userId: null,
      deliveryId: 'delivery_test',
    },
    sentAt: now,
  };
}
