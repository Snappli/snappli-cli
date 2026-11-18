import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_URL } from '@snappli/sdk';

/** Error del CLI con un código estable. */
export class CliError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

export type Env = Record<string, string | undefined>;

/**
 * Carpeta de configuración: `$XDG_CONFIG_HOME/snappli`, `%APPDATA%\snappli` en Windows o
 * `~/.config/snappli`. Aquí se guardará la key de `snappli login` (fase 2), con permisos 0600.
 */
export function configDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'snappli');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'snappli');
  return join(homedir(), '.config', 'snappli');
}

/** Host de la API: `--api-url`, `SNAPPLI_API_URL` o `https://api.snappli.io`. */
export function resolveApiUrl(env: Env, flag?: string): string {
  return (flag || env.SNAPPLI_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}

/** Muestra solo el principio de un secreto. */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > 10 ? `${value.slice(0, 6)}…` : '…';
}
