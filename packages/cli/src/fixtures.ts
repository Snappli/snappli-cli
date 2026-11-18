import { randomBytes } from 'node:crypto';
import type {
  WebhookContactDocument,
  WebhookContactPayload,
  WebhookConversationPayload,
  WebhookEvent,
  WebhookEventType,
} from '@snappli/sdk';
import { WEBHOOK_EVENT_TYPES } from '@snappli/sdk';

export { WEBHOOK_EVENT_TYPES };

export interface ExampleOptions {
  withDocuments?: boolean;
  /** Base de las URLs de los documentos (el servidor local de `trigger --with-documents`). */
  documentBaseUrl?: string;
  deliveryId?: string;
  now?: Date;
}

/** Archivos de ejemplo que sirve `trigger --with-documents`. */
export const SAMPLE_FILES: Record<string, { mimeType: string; fileName: string; bytes: Buffer }> = {
  documento_identidad: {
    mimeType: 'image/png',
    fileName: 'cedula.png',
    // PNG de 1×1 px.
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    ),
  },
  comprobante_pago: {
    mimeType: 'application/pdf',
    fileName: 'comprobante.pdf',
    bytes: Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    ),
  },
};

export const newDeliveryId = () => `dlv_test_${randomBytes(8).toString('hex')}`;

function documents(
  baseUrl: string,
  tokens: Record<string, string>,
  expiresAt: string,
): Record<string, WebhookContactDocument> {
  const doc = (key: string, label: string, status: WebhookContactDocument['status']) => {
    const file = SAMPLE_FILES[key];
    if (!file) throw new Error(`Sin archivo de ejemplo para ${key}`);
    return {
      label,
      status,
      storageKey: `orgs/org_ejemplo/contacts/contact_ejemplo/${key}${file.fileName.slice(file.fileName.lastIndexOf('.'))}`,
      mimeType: file.mimeType,
      size: file.bytes.byteLength,
      fileName: key === 'comprobante_pago' ? file.fileName : null,
      url: `${baseUrl.replace(/\/+$/, '')}/api/webhook-files/${tokens[key] ?? key}`,
      urlExpiresAt: expiresAt,
    };
  };
  return {
    documento_identidad: doc('documento_identidad', 'Documento de identidad', 'APPROVED'),
    comprobante_pago: doc('comprobante_pago', 'Comprobante de pago', 'PENDING'),
  };
}

/**
 * Payload de ejemplo válido para cada evento, con datos coherentes (origen del disparo, etapa,
 * conversación). Con `withDocuments`, dos documentos: uno aprobado y otro pendiente.
 */
export function exampleWebhook(
  event: WebhookEventType,
  options: ExampleOptions & { documentTokens?: Record<string, string> } = {},
): WebhookEvent {
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const deliveryId = options.deliveryId ?? newDeliveryId();
  const contact: WebhookContactPayload = {
    id: 'contact_ejemplo',
    firstName: 'María',
    lastName: 'Ejemplo',
    displayName: 'María Ejemplo',
    email: 'maria@ejemplo.com',
    phone: '+593991234567',
    language: 'es',
    countryCode: 'EC',
    tags: ['cliente-nuevo'],
    customFields: { ciudad: 'Quito', plan_interes: 'Pro' },
    ...(options.withDocuments
      ? {
          documents: documents(
            options.documentBaseUrl ?? 'https://api.snappli.io',
            options.documentTokens ?? {},
            new Date(now.getTime() + 72 * 3600_000).toISOString(),
          ),
        }
      : {}),
  };
  const conversation: WebhookConversationPayload = {
    id: 'conv_ejemplo',
    channel: 'whatsapp',
    lastMessageAt: iso,
  };
  const base = { organizationId: 'org_ejemplo', sentAt: iso };
  const trigger = (source: 'AI' | 'AGENT' | 'MANUAL' | 'SYSTEM', userId: string | null = null) => ({
    source,
    userId,
    deliveryId,
  });

  switch (event) {
    case 'contact.stage.entered':
      return {
        event,
        ...base,
        contact,
        pipeline: {
          stageId: 'stage_calificado',
          stageName: 'Calificado',
          previousStageId: 'stage_nuevo',
          previousStageName: 'Nuevo',
        },
        conversation,
        trigger: trigger('AI'),
      };
    case 'contact.webhook.manual':
      return {
        event,
        ...base,
        contact,
        pipeline: {
          stageId: 'stage_calificado',
          stageName: 'Calificado',
          previousStageId: null,
          previousStageName: null,
        },
        conversation,
        trigger: trigger('MANUAL', 'user_agente'),
      };
    case 'contact.created':
      return { event, ...base, contact, trigger: trigger('SYSTEM') };
    case 'contact.updated':
      return { event, ...base, contact, trigger: trigger('AGENT', 'user_agente') };
    case 'contact.tag.assigned':
      return {
        event,
        ...base,
        contact,
        tag: { id: 'tag_cliente_nuevo', name: 'cliente-nuevo', source: 'AI' },
        trigger: trigger('AI'),
      };
    case 'conversation.escalated':
      return {
        event,
        ...base,
        contact,
        conversation,
        reason: 'El contacto pidió hablar con una persona',
        summary: 'Quiere contratar el plan Pro y pregunta por la facturación anual.',
        departmentId: 'dept_ventas',
        departmentName: 'Ventas',
        trigger: trigger('AI'),
      };
  }
}
