import { SnappliError, SnappliWebhookError } from '@snappli/sdk';
import { CliError } from './config.js';

/** Error como JSON: `{ error: { code, message, … } }`. */
export function formatError(error: unknown) {
  if (error instanceof SnappliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
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
