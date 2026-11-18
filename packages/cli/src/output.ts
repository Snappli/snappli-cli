import { SnappliError, SnappliWebhookError } from '@snappli/sdk';
import { CliError } from './config.js';

/** Error como JSON: `{ error: { code, message, … } }`. */
export function formatError(error: unknown) {
  if (error instanceof SnappliError) {
    const missingScopes =
      error.status === 403 && error.body && typeof error.body === 'object'
        ? (error.body as { missingScopes?: unknown }).missingScopes
        : undefined;
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(Array.isArray(missingScopes)
          ? {
              missingScopes,
              hint: 'Crea una key con ese permiso en Configuración → API del panel (los permisos no se pueden cambiar en una key existente).',
            }
          : {}),
        ...(error.status === 401
          ? { hint: 'La key no es válida o fue revocada. Usa snappli login con una key activa.' }
          : {}),
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.body !== undefined && error.body !== '' ? { response: error.body } : {}),
      },
    };
  }
  if (error instanceof SnappliWebhookError) {
    return { error: { code: error.reason, message: error.message } };
  }
  if (error instanceof CliError) {
    return { error: { code: error.code, message: error.message, ...(error.details ?? {}) } };
  }
  if (error instanceof Error && error.name === 'TypeError') {
    return { error: { code: 'invalid_argument', message: error.message } };
  }
  return {
    error: {
      code: 'unexpected_error',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export const toJson = (value: unknown, pretty: boolean) =>
  `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;
