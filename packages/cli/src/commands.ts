import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectorEventsUrl } from '@snappli/sdk';
import { CliError, createClient, type Env, readSavedConfig, resolveApiUrl } from './config.js';
import {
  checkConnectorResponse,
  connectorLogs,
  DOCS_URL,
  getConnector,
  getDelivery,
  getWebhookIntegration,
  initProject,
  listConnectors,
  listDeliveries,
  listWebhookIntegrations,
  login,
  logout,
  previewMapping,
  type ReceivedDelivery,
  retryDelivery,
  sendEvent,
  startReceiver,
  testConnectorOperation,
  testWebhook,
  triggerWebhook,
  verifySignature,
  webhookExample,
  whoami,
} from './operations.js';
import { formatError, toJson } from './output.js';

export interface Io {
  env: Env;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Todo stdin como texto (para `--file -`). */
  readStdin: () => Promise<string>;
  /** stdin es una terminal (nada canalizado): `login` no espera a leerlo. */
  stdinIsTTY?: boolean;
  fetch?: typeof fetch;
  /** Arranca el servidor MCP por stdio; se inyecta para no cargarlo en cada comando. */
  startMcp?: () => Promise<void>;
  /** Resuelve cuando hay que parar un comando que sigue vivo (`webhooks serve`): Ctrl+C. */
  untilExit?: () => Promise<void>;
  /** Avisa de que el receptor ya escucha (tests). */
  onListening?: (url: string) => void;
}

export const HELP = `snappli: prueba tu integración con Snappli desde la terminal o tu agente.

Uso:
  snappli init [--env-file .env]
      Añade SNAPPLI_API_KEY, SNAPPLI_WEBHOOK_SECRET y SNAPPLI_CONNECTOR_EVENT_SECRET al .env
  snappli webhooks example <evento> [--with-documents]
      Payload de ejemplo válido
  snappli webhooks trigger <evento> --to <url> [--secret s] [--file p.json] [--header 'Nombre: valor']
                           [--mapping m.json] [--repeat] [--with-documents [--hold 10]] [--timeout 15]
      Firma y envía un webhook igual que Snappli y cuenta qué respondió tu servidor
  snappli webhooks verify --secret s --timestamp t --signature sig [--file body.json] [--ignore-time]
      Dice si una firma es válida y, si no, por qué (sin --file lee el cuerpo de stdin)
  snappli webhooks serve [--port 4555] [--secret s] [--respond r.json] [--status 200]
      Receptor local: verifica e imprime cada entrega (una línea JSON por entrega)
  snappli events send <tipo> (--to <url> | --connector <id>) --secret s --data d.json [--event-id id] [--yes]
      Envía un evento firmado de conector a Snappli (--yes si no es localhost: manda un WhatsApp real)
  snappli connectors check-response --file r.json [--map m.json]
      Lo que leería la IA de la respuesta de tu API con ese responseMap

Con API key (snappli login, SNAPPLI_API_KEY o --api-key; cada comando pide un permiso de la key):
  snappli login [--api-key sk_…]     Valida la key y la guarda (sin --api-key la lee de SNAPPLI_API_KEY o stdin)
  snappli logout                     Borra la key guardada
  snappli whoami                     Organización, key y permisos
  snappli webhooks list              Integraciones de webhook, sin secretos          (webhooks:read)
  snappli webhooks get <id>          Una integración                                 (webhooks:read)
  snappli webhooks deliveries [--integration id] [--status FAILED] [--limit 20] [--page 1]
                                     Historial de entregas                           (webhooks:read)
  snappli webhooks deliveries get <id>
                                     Una entrega: cabeceras, respuesta y mapeo       (webhooks:read)
  snappli webhooks mapping-preview <id> --response r.json
                                     Qué rellenaría el mapeo guardado con esa respuesta (webhooks:read)
  snappli webhooks test <id> --yes   «Enviar prueba» del panel: llega a la URL real   (webhooks:test)
  snappli webhooks retry <deliveryId> --yes
                                     Reintenta una entrega: llega a la URL real       (webhooks:test)
  snappli connectors list / get <id> Conectores y operaciones, sin secretos           (connectors:read)
  snappli connectors logs <id>       Últimas 50 llamadas (de la IA y de pruebas)      (connectors:read)
  snappli connectors test <id> <operación> [--args a.json] [--bound b.json] [--allow-write]
                                     Ejecuta la operación como la IA y muestra lo que leería
                                     (--allow-write en escrituras: se ejecutan de verdad) (connectors:test)

  snappli skill                      Imprime la skill de integración (SKILL.md)
  snappli skill install [--dir d]    La copia a .claude/skills/snappli/ (o a --dir)
  snappli mcp                        Servidor MCP por stdio

Eventos: contact.stage.entered, contact.webhook.manual, contact.created, contact.updated,
         contact.tag.assigned, conversation.escalated

Opciones globales:
  --api-key <sk_…>  API key (por defecto SNAPPLI_API_KEY o la guardada con login)
  --api-url <url>   Host de la API (por defecto SNAPPLI_API_URL, el de login o https://api.snappli.io)
  --pretty          JSON indentado
  -h, --help · -v, --version

Variables: SNAPPLI_API_KEY, SNAPPLI_WEBHOOK_SECRET (--secret de webhooks), SNAPPLI_CONNECTOR_EVENT_SECRET (--secret de events).
La salida es JSON en stdout; los errores, JSON en stderr con código de salida 1.
Documentación: ${DOCS_URL}`;

const OPTIONS = {
  'api-key': { type: 'string' },
  'api-url': { type: 'string' },
  integration: { type: 'string' },
  limit: { type: 'string' },
  page: { type: 'string' },
  response: { type: 'string' },
  args: { type: 'string' },
  bound: { type: 'string' },
  'allow-write': { type: 'boolean' },
  pretty: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  file: { type: 'string' },
  to: { type: 'string' },
  secret: { type: 'string' },
  header: { type: 'string', multiple: true },
  mapping: { type: 'string' },
  repeat: { type: 'boolean' },
  'with-documents': { type: 'boolean' },
  hold: { type: 'string' },
  timeout: { type: 'string' },
  timestamp: { type: 'string' },
  signature: { type: 'string' },
  tolerance: { type: 'string' },
  'ignore-time': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  respond: { type: 'string' },
  status: { type: 'string' },
  data: { type: 'string' },
  'event-id': { type: 'string' },
  connector: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  map: { type: 'string' },
  'env-file': { type: 'string' },
  dir: { type: 'string' },
} as const;

/** La skill viaja dentro del paquete npm. */
export const SKILL_FILE = fileURLToPath(
  new URL('../plugin/skills/snappli/SKILL.md', import.meta.url),
);

/** Corre el CLI y devuelve el código de salida. */
export async function run(argv: string[], io: Io, version: string): Promise<number> {
  let pretty = false;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
    pretty = values.pretty ?? false;
    const [command, sub, arg, arg2] = positionals;
    const print = (value: unknown) => io.stdout(toJson(value, pretty));
    const keyed = () =>
      createClient({
        env: io.env,
        apiKey: values['api-key'],
        apiUrl: values['api-url'],
        fetch: io.fetch,
        version,
      });
    const timeoutMs = values.timeout ? seconds(values.timeout, '--timeout') * 1000 : undefined;

    if (values.version) {
      io.stdout(`${version}\n`);
      return 0;
    }
    if (values.help || !command || command === 'help') {
      io.stdout(`${HELP}\n`);
      return 0;
    }

    switch (`${command} ${sub ?? ''}`.trim()) {
      case 'init':
        print(await initProject(io.cwd, values['env-file'] ?? '.env'));
        return 0;

      case 'webhooks example':
        print(webhookExample(arg, values['with-documents'] ?? false));
        return 0;

      case 'webhooks trigger': {
        const payload = values.file ? await readJson(io, values.file) : undefined;
        const result = await triggerWebhook({
          url: values.to ?? '',
          event: arg,
          ...(payload !== undefined ? { payload } : {}),
          secret: values.secret ?? io.env.SNAPPLI_WEBHOOK_SECRET,
          headers: parseHeaders(values.header ?? []),
          ...(values.mapping ? { mapping: await readJson(io, values.mapping) } : {}),
          repeat: values.repeat ?? false,
          withDocuments: values['with-documents'] ?? false,
          ...(values.hold ? { holdMs: seconds(values.hold, '--hold', true) * 1000 } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
        print(result);
        return result.ok ? 0 : 1;
      }

      case 'webhooks verify': {
        const body = values.file ? await readText(io, values.file) : await io.readStdin();
        const result = verifySignature({
          secret: values.secret ?? io.env.SNAPPLI_WEBHOOK_SECRET ?? '',
          timestamp: values.timestamp ?? '',
          signature: values.signature ?? '',
          body,
          ...(values.tolerance
            ? { toleranceSeconds: seconds(values.tolerance, '--tolerance') }
            : {}),
          ignoreTime: values['ignore-time'] ?? false,
        });
        print(result);
        return result.valid ? 0 : 1;
      }

      case 'webhooks serve': {
        const port = values.port ? Number(values.port) : 4555;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new CliError('--port debe ser un número de 0 a 65535.', 'invalid_port');
        }
        const status = values.status ? Number(values.status) : 200;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw new CliError('--status debe ser un código HTTP (100–599).', 'invalid_status');
        }
        const respondBody = values.respond
          ? JSON.stringify(await readJson(io, values.respond))
          : undefined;
        const secret = values.secret ?? io.env.SNAPPLI_WEBHOOK_SECRET;
        const receiver = await startReceiver({
          port,
          ...(values.host ? { host: values.host } : {}),
          secret,
          ...(respondBody ? { respondBody } : {}),
          status,
          onDelivery: (delivery: ReceivedDelivery) => print(delivery),
        });
        io.stderr(
          `${toJson(
            {
              listening: receiver.url,
              verifying: Boolean(secret),
              hint: secret
                ? 'Para recibir entregas reales de Snappli expón este puerto con un túnel HTTPS y pon su URL en la integración.'
                : 'Sin --secret ni SNAPPLI_WEBHOOK_SECRET: se muestran las entregas sin verificar la firma.',
            },
            false,
          )}`,
        );
        io.onListening?.(receiver.url);
        await (io.untilExit ?? untilSignal)();
        await receiver.close();
        return 0;
      }

      case 'events send': {
        const url = values.connector
          ? connectorEventsUrl(values.connector, resolveApiUrl(io.env, values['api-url']))
          : values.to;
        if (!url) {
          throw new CliError(
            'Indica --to <url de eventos del conector> o --connector <id>.',
            'missing_url',
          );
        }
        if (!values.data) throw new CliError('Falta --data <archivo.json | JSON>.', 'missing_data');
        const result = await sendEvent({
          url,
          type: arg,
          secret: values.secret ?? io.env.SNAPPLI_CONNECTOR_EVENT_SECRET,
          data: await readJson(io, values.data),
          eventId: values['event-id'],
          timeoutMs,
          allowWrite: values.yes ?? false,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
        print(result);
        return result.result.status === 'failed' ? 1 : 0;
      }

      case 'login': {
        const apiKey = (
          values['api-key'] ??
          io.env.SNAPPLI_API_KEY ??
          (io.stdinIsTTY ? '' : await io.readStdin())
        ).trim();
        if (!apiKey) {
          throw new CliError(
            'Pasa la key con --api-key, SNAPPLI_API_KEY o por stdin (echo $KEY | snappli login).',
            'missing_api_key',
          );
        }
        const saved = await readSavedConfig(io.env);
        const apiUrl = resolveApiUrl(io.env, values['api-url'], saved.apiUrl);
        const { client } = await createClient({
          env: io.env,
          apiKey,
          apiUrl,
          fetch: io.fetch,
          version,
        });
        print(
          await login(client, io.env, {
            apiKey,
            ...(values['api-url'] || io.env.SNAPPLI_API_URL ? { apiUrl } : {}),
          }),
        );
        return 0;
      }

      case 'logout':
        print(await logout(io.env));
        return 0;

      case 'whoami': {
        const { client, source, apiUrl } = await keyed();
        print(await whoami(client, source, apiUrl));
        return 0;
      }

      case 'webhooks list':
        print(await listWebhookIntegrations((await keyed()).client));
        return 0;

      case 'webhooks get':
        print(await getWebhookIntegration((await keyed()).client, arg));
        return 0;

      case 'webhooks deliveries': {
        const { client } = await keyed();
        if (arg === 'get') {
          print(await getDelivery(client, arg2));
          return 0;
        }
        if (arg) {
          throw new CliError(
            `Uso: snappli webhooks deliveries [--integration id] [--status S] o deliveries get <id> (no «${arg}»).`,
            'invalid_arguments',
          );
        }
        print(
          await listDeliveries(client, {
            webhookIntegrationId: values.integration,
            status: values.status,
            ...(values.limit ? { limit: Number(values.limit) } : {}),
            ...(values.page ? { page: Number(values.page) } : {}),
          }),
        );
        return 0;
      }

      case 'webhooks mapping-preview': {
        if (!values.response) {
          throw new CliError(
            'Falta --response <respuesta.json> (o --response - para stdin).',
            'missing_file',
          );
        }
        const body = await readText(io, values.response);
        print(await previewMapping((await keyed()).client, arg, body));
        return 0;
      }

      case 'webhooks test': {
        const result = await testWebhook((await keyed()).client, arg, values.yes ?? false);
        print(result);
        return result.success ? 0 : 1;
      }

      case 'webhooks retry':
        print(await retryDelivery((await keyed()).client, arg, values.yes ?? false));
        return 0;

      case 'connectors list':
        print(await listConnectors((await keyed()).client));
        return 0;

      case 'connectors get':
        print(await getConnector((await keyed()).client, arg));
        return 0;

      case 'connectors logs':
        print(await connectorLogs((await keyed()).client, arg));
        return 0;

      case 'connectors test': {
        const result = await testConnectorOperation((await keyed()).client, {
          connectorId: arg,
          operation: arg2,
          ...(values.args ? { args: await readJson(io, values.args) } : {}),
          ...(values.bound ? { boundValues: await readJson(io, values.bound) } : {}),
          allowWrite: values['allow-write'] ?? false,
        });
        print(result);
        return result.ok ? 0 : 1;
      }

      case 'connectors check-response': {
        if (!values.file) {
          throw new CliError(
            'Falta --file <respuesta.json> (o --file - para stdin).',
            'missing_file',
          );
        }
        print(
          checkConnectorResponse(
            await readText(io, values.file),
            values.map ? await readJson(io, values.map) : undefined,
          ),
        );
        return 0;
      }

      case 'skill':
        io.stdout(await readFile(SKILL_FILE, 'utf8'));
        return 0;

      case 'skill install': {
        const target = resolve(io.cwd, values.dir ?? '.claude/skills/snappli', 'SKILL.md');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(SKILL_FILE, 'utf8'));
        print({ installedTo: target });
        return 0;
      }

      case 'mcp':
        if (!io.startMcp) throw new CliError('MCP no disponible.', 'unexpected_error');
        await io.startMcp();
        return 0;

      default:
        throw new CliError(
          `Comando desconocido: ${positionals.join(' ')}. Usa snappli --help.`,
          'unknown_command',
        );
    }
  } catch (error) {
    const known =
      error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')
        ? new CliError(`${error.message}. Usa snappli --help.`, 'invalid_arguments')
        : error;
    io.stderr(toJson(formatError(known), pretty));
    return 1;
  }
}

function untilSignal(): Promise<void> {
  return new Promise((done) => {
    process.once('SIGINT', () => done());
    process.once('SIGTERM', () => done());
  });
}

function seconds(value: string, flag: string, allowZero = false): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new CliError(`${flag} va en segundos, mayor que 0.`, 'invalid_number');
  }
  return n;
}

/** `Nombre: valor` → { Nombre: valor }. */
export function parseHeaders(list: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const item of list) {
    const index = item.indexOf(':');
    const name = index > 0 ? item.slice(0, index).trim() : '';
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new CliError(
        `--header «${item}» debe tener la forma 'Nombre: valor'.`,
        'invalid_header',
      );
    }
    headers[name] = item.slice(index + 1).trim();
  }
  return headers;
}

async function readText(io: Io, file: string): Promise<string> {
  if (file === '-') return io.readStdin();
  try {
    return await readFile(resolve(io.cwd, file), 'utf8');
  } catch {
    throw new CliError(`No se pudo leer ${file}.`, 'file_not_found');
  }
}

/** Un archivo JSON, `-` (stdin) o JSON en línea (`'{"a":1}'`). */
async function readJson(io: Io, value: string): Promise<unknown> {
  const inline = /^\s*[[{]/.test(value);
  const text = inline ? value : await readText(io, value);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${inline ? 'El JSON' : value} no es JSON válido.`, 'invalid_json');
  }
}
