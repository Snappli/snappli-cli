import type { WebhookMappingResult, WebhookResponseMapping } from './generated/index.js';

/**
 * JSONPath mínimo, igual que el de Snappli: `$.a.b`, `$.a[0].b`, `$.items[*].nombre`. Devuelve
 * `undefined` si no existe. Con `[*]` devuelve la lista de coincidencias.
 */
export function readJsonPath(data: unknown, path: string): unknown {
  const tokens = path
    .trim()
    .replace(/^\$\.?/, '')
    .split(/\.|(?=\[)/)
    .filter(Boolean);
  let current: unknown[] = [data];
  let spread = false;
  for (const token of tokens) {
    const index = token.match(/^\[(\d+|\*)\]$/);
    const next: unknown[] = [];
    for (const item of current) {
      if (index) {
        if (!Array.isArray(item)) continue;
        if (index[1] === '*') {
          next.push(...item);
          spread = true;
        } else if (item[Number(index[1])] !== undefined) next.push(item[Number(index[1])]);
      } else if (item && typeof item === 'object' && token in (item as Record<string, unknown>)) {
        next.push((item as Record<string, unknown>)[token]);
      }
    }
    current = next;
  }
  if (spread) return current;
  return current[0];
}

/** Lo que la IA ve de la respuesta de una operación de conector, como máximo. */
export const CONNECTOR_RESULT_MAX_CHARS = 2048;
/** Tamaño máximo de la respuesta de un conector. */
export const CONNECTOR_RESPONSE_MAX_BYTES = 1024 * 1024;

/**
 * Lo que leería la IA de una respuesta de conector: los campos de `responseMap` (o el JSON entero),
 * recortado a 2048 caracteres. `mapped: false` = falta definir qué campos devolver.
 */
export function shapeConnectorResponse(
  body: string,
  responseMap?: Record<string, string> | null,
): { text: string; mapped: boolean; truncated: boolean } {
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    return { ...truncate(body.replace(/\s+/g, ' ')), mapped: false };
  }
  if (responseMap && Object.keys(responseMap).length) {
    const shaped = Object.fromEntries(
      Object.entries(responseMap).map(([key, path]) => [key, readJsonPath(data, path) ?? null]),
    );
    return { ...truncate(JSON.stringify(shaped)), mapped: true };
  }
  return { ...truncate(JSON.stringify(data)), mapped: false };
}

function truncate(text: string): { text: string; truncated: boolean } {
  return text.length > CONNECTOR_RESULT_MAX_CHARS
    ? { text: `${text.slice(0, CONNECTOR_RESULT_MAX_CHARS)}…(recortado)`, truncated: true }
    : { text, truncated: false };
}

/**
 * Qué rellenaría el mapeo de respuesta de un webhook con este cuerpo (como «Probar» en el panel).
 * Solo lee: no conoce los tipos de tus campos ni si existen, eso lo comprueba Snappli al aplicarlo.
 * El mapeo solo se aplica si la respuesta es 2xx.
 */
export function previewResponseMapping(
  mapping: Pick<WebhookResponseMapping, 'fields'> & { note?: string | null | undefined },
  body: string,
): WebhookMappingResult & { note: string | null } {
  const warnings: string[] = [];
  let data: unknown;
  if (!body.trim()) warnings.push('La respuesta vino vacía');
  else {
    try {
      data = JSON.parse(body);
    } catch {
      warnings.push('La respuesta no es JSON');
    }
  }
  const values: Record<string, string | null> = {};
  const fields = Object.entries(mapping.fields ?? {}).map(([key, path]) => {
    const raw = data === undefined ? undefined : readJsonPath(data, path);
    const value = raw === undefined || raw === null || typeof raw === 'object' ? null : String(raw);
    values[key] = value;
    return {
      key,
      path,
      value,
      saved: false,
      ...(value === null
        ? { reason: raw === undefined ? `No está ${path} en la respuesta` : 'Sin valor simple' }
        : {}),
    };
  });
  const note = mapping.note?.trim() ? renderMappingNote(mapping.note, values) || null : null;
  return { fields, tagsAdded: [], noteAdded: false, warnings, note };
}

/** Pone en la nota los valores leídos: `{{clave_del_campo}}`. */
export function renderMappingNote(template: string, values: Record<string, string | null>): string {
  return template
    .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
      const normalized = key.replace(/^(contact\.)?(custom\.)?/, '');
      return values[normalized] ?? '';
    })
    .trim();
}
