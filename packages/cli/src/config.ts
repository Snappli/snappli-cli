import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_URL, maskApiKey, Snappli } from '@snappli/sdk';

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
 * `~/.config/snappli`. Aquí guarda `snappli login` la key, con permisos 0600.
 */
export function configDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'snappli');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'snappli');
  return join(homedir(), '.config', 'snappli');
}

/** Host de la API: `--api-url`, `SNAPPLI_API_URL`, el guardado con `login` o `https://api.snappli.io`. */
export function resolveApiUrl(env: Env, flag?: string, saved?: string): string {
  return (flag || env.SNAPPLI_API_URL || saved || DEFAULT_API_URL).replace(/\/+$/, '');
}

/** Lo que guarda `snappli login`. */
export interface SavedConfig {
  apiKey?: string;
  apiUrl?: string;
}

export function configFile(env: Env): string {
  return join(configDir(env), 'config.json');
}

export async function readSavedConfig(env: Env): Promise<SavedConfig> {
  try {
    const parsed = JSON.parse(await readFile(configFile(env), 'utf8')) as SavedConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Escribe la config solo para el usuario (0600; la carpeta, 0700). */
export async function saveConfig(env: Env, config: SavedConfig): Promise<string> {
  const file = configFile(env);
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` no cambia los permisos de un archivo que ya existía.
  await chmod(file, 0o600).catch(() => {});
  return file;
}

/** Borra la key guardada. Devuelve si había algo. */
export async function deleteConfig(env: Env): Promise<boolean> {
  const file = configFile(env);
  const existed = Object.keys(await readSavedConfig(env)).length > 0;
  await rm(file, { force: true });
  return existed;
}

export type ApiKeySource = 'flag' | 'env' | 'config';

export interface ClientOptions {
  env: Env;
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  version: string;
}

/**
 * Cliente de la API pública con la key de `--api-key`, `SNAPPLI_API_KEY` o la guardada con
 * `snappli login` (en ese orden).
 */
export async function createClient(options: ClientOptions): Promise<{
  client: Snappli;
  source: ApiKeySource;
  apiUrl: string;
}> {
  const saved = await readSavedConfig(options.env);
  const [apiKey, source]: [string | undefined, ApiKeySource] = options.apiKey
    ? [options.apiKey, 'flag']
    : options.env.SNAPPLI_API_KEY
      ? [options.env.SNAPPLI_API_KEY, 'env']
      : [saved.apiKey, 'config'];
  if (!apiKey) {
    throw new CliError(
      'Falta la API key. Usa snappli login, SNAPPLI_API_KEY o --api-key (crea una en Configuración → API del panel).',
      'missing_api_key',
    );
  }
  const apiUrl = resolveApiUrl(options.env, options.apiUrl, saved.apiUrl);
  const client = new Snappli(apiKey, {
    baseUrl: apiUrl,
    userAgent: `snappli-cli/${options.version}`,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { client, source, apiUrl };
}

export { maskApiKey };

/** Muestra solo el principio de un secreto. */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > 10 ? `${value.slice(0, 6)}…` : '…';
}
