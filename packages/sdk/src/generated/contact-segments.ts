// Generado por scripts/sync-shared.mjs desde snappli-backend/src/shared/contact-segments.ts. No editar.
import { z } from 'zod';

export const contactChannelSchema = z.enum([
  'WHATSAPP',
  'MANUAL',
  'EMAIL',
  'WIDGET',
  'INSTAGRAM',
  'MESSENGER',
  'TELEGRAM',
]);

export const contactFieldFilterOpSchema = z.enum([
  'exists',
  'not_exists',
  'eq',
  'neq',
  'contains',
  'not_contains',
]);

export const contactSegmentFilterRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('channel'),
    op: z.literal('has'),
    value: contactChannelSchema,
  }),
  z.object({
    type: z.literal('tag'),
    op: z.enum(['has_any', 'has_all']),
    value: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('contact_field'),
    fieldRef: z.string().min(1),
    op: contactFieldFilterOpSchema,
    value: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('custom_field'),
    fieldId: z.string().min(1),
    op: z.enum(['eq', 'neq', 'contains']),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('last_channel'),
    op: z.literal('is'),
    value: contactChannelSchema,
  }),
  z.object({
    type: z.literal('last_inbound'),
    op: z.enum(['within', 'older_than']),
    value: z.string().regex(/^\d+[dhm]$/, 'Duración inválida (ej. 7d, 24h)'),
  }),
  z.object({
    type: z.literal('pipeline_stage'),
    op: z.enum(['is_any', 'is_none']),
    value: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('pipeline_stage_age'),
    op: z.enum(['within', 'older_than']),
    value: z.string().regex(/^\d+[dhm]$/, 'Duración inválida (ej. 7d, 24h)'),
  }),
]);

export const contactSegmentFiltersSchema = z
  .object({
    operator: z.enum(['and', 'or']).default('and'),
    rules: z.array(contactSegmentFilterRuleSchema).default([]),
  })
  .superRefine((data, ctx) => {
    data.rules.forEach((rule, index) => {
      if (
        rule.type === 'pipeline_stage' &&
        rule.op === 'is_any' &&
        (!rule.value || rule.value.length === 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Selecciona al menos una etapa',
          path: ['rules', index, 'value'],
        });
      }
    });
  });

export const createContactSegmentSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  filters: contactSegmentFiltersSchema,
});

export const updateContactSegmentSchema = createContactSegmentSchema.partial();

export type ContactFieldFilterOp = z.infer<typeof contactFieldFilterOpSchema>;
export type ContactSegmentFilterRule = z.infer<typeof contactSegmentFilterRuleSchema>;
export type ContactSegmentFilters = z.infer<typeof contactSegmentFiltersSchema>;
export type CreateContactSegmentInput = z.infer<typeof createContactSegmentSchema>;
export type UpdateContactSegmentInput = z.infer<typeof updateContactSegmentSchema>;
