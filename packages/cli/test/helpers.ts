import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Io, run } from '../src/commands.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => any;
  error: () => any;
}

export async function cli(
  argv: string[],
  options: Partial<Io> & { stdin?: string } = {},
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await run(
    argv,
    {
      env: {},
      cwd: process.cwd(),
      readStdin: async () => options.stdin ?? '',
      ...options,
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    },
    '9.9.9',
  );
  return {
    code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
    error: () => JSON.parse(stderr).error,
  };
}

export interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Servidor HTTP de prueba; `handler` decide la respuesta. */
export async function testServer(
  handler: (req: Received, res: ServerResponse) => void | Promise<void> = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  },
) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(entry);
      await handler(entry, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
