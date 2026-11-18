#!/usr/bin/env node
/**
 * Prueba los paquetes tal como se publican: `pnpm pack` de @snappli/sdk y @snappli/cli, los
 * instala con npm en una carpeta limpia y usa el CLI, el SDK y el servidor MCP instalados. Sirve
 * para comprobar Node 20 (los tests usan Vitest, que exige Node ≥ 22) y el contenido de `files`.
 *
 *   pnpm build && node scripts/smoke.mjs
 *   node scripts/smoke.mjs --tarballs <carpeta>   # con tarballs ya empaquetados (CI)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const arg = process.argv.indexOf('--tarballs');
let tarballs = arg > 0 ? resolve(process.argv[arg + 1]) : undefined;

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', shell: windows, ...options });

if (!tarballs) {
  tarballs = mkdtempSync(join(tmpdir(), 'snappli-tarballs-'));
  for (const pkg of ['sdk', 'cli']) {
    run('pnpm', ['pack', '--pack-destination', tarballs], { cwd: join(root, 'packages', pkg) });
  }
}
const files = readdirSync(tarballs).filter((f) => f.endsWith('.tgz'));
const sdkTgz = files.find((f) => f.startsWith('snappli-sdk-'));
const cliTgz = files.find((f) => f.startsWith('snappli-cli-'));
assert.ok(sdkTgz && cliTgz, `Faltan tarballs en ${tarballs}: ${files.join(', ')}`);

// 1. Contenido publicado: solo dist, plugin, README, LICENSE, CHANGELOG y package.json.
for (const tgz of [sdkTgz, cliTgz]) {
  const list = run('tar', ['-tzf', join(tarballs, tgz)])
    .trim()
    .split(/\r?\n/);
  const unexpected = list.filter(
    (f) =>
      !/^package\/(dist\/|plugin\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(f),
  );
  assert.deepEqual(unexpected, [], `${tgz} publica archivos de más`);
  assert.ok(!list.some((f) => /\.test\.|\/test\/|\/src\//.test(f)), `${tgz} incluye tests o src`);
  if (tgz === cliTgz) {
    assert.ok(list.includes('package/plugin/skills/snappli/SKILL.md'), 'falta la skill');
    assert.ok(list.includes('package/plugin/.claude-plugin/plugin.json'), 'falta plugin.json');
  }
}

// 2. Instalación limpia con npm.
const project = mkdtempSync(join(tmpdir(), 'snappli-smoke-'));
writeFileSync(
  join(project, 'package.json'),
  JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
);
run('npm', ['install', '--no-audit', '--no-fund', join(tarballs, sdkTgz), join(tarballs, cliTgz)], {
  cwd: project,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const bin = join(project, 'node_modules', '@snappli', 'cli', 'dist', 'cli.js');
const cli = (args, input) =>
  run(process.execPath, [bin, ...args], { cwd: project, input, shell: false });

assert.match(cli(['--version']).trim(), /^\d+\.\d+\.\d+/);
const example = JSON.parse(
  cli(['webhooks', 'example', 'contact.stage.entered', '--with-documents']),
);
assert.equal(example.event, 'contact.stage.entered');

// 3. trigger contra un receptor que verifica con el SDK instalado.
mkdirSync(join(project, 'src'));
writeFileSync(
  join(project, 'src', 'receiver.mjs'),
  `import { createServer } from 'node:http';
import { verifyWebhook } from '@snappli/sdk';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const event = verifyWebhook(Buffer.concat(chunks), req.headers, 'whsec_smoke');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: event.trigger.deliveryId } }));
    } catch (error) {
      res.writeHead(401);
      res.end(String(error.reason));
    }
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`,
);
const receiver = spawn(process.execPath, [join(project, 'src', 'receiver.mjs')], { cwd: project });
try {
  const port = await new Promise((done, fail) => {
    receiver.stdout.once('data', (d) => done(String(d).trim()));
    receiver.once('exit', (code) => fail(new Error(`El receptor terminó (${code})`)));
  });
  const out = JSON.parse(
    cli([
      'webhooks',
      'trigger',
      'contact.created',
      '--to',
      `http://127.0.0.1:${port}`,
      '--secret',
      'whsec_smoke',
    ]),
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.response.body.data.id, out.request.deliveryId);
} finally {
  receiver.kill();
}

// 4. events send contra un mock local.
const mock = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const ok = String(req.headers['x-snappli-signature']).startsWith('sha256=');
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'ignored', reason: 'no_mapping' } : {}));
  });
});
await new Promise((done) => mock.listen(0, '127.0.0.1', done));
try {
  const out = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [
      bin,
      'events',
      'send',
      'pedido.enviado',
      '--to',
      `http://127.0.0.1:${mock.address().port}/events`,
      '--secret',
      'whsec_smoke',
      '--data',
      '{"telefono":"+593991234567"}',
    ]);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => (code === 0 ? done(JSON.parse(stdout)) : fail(new Error(stdout))));
  });
  assert.equal(out.result.reason, 'no_mapping');
} finally {
  mock.close();
}

// 5. Servidor MCP por stdio: initialize + tools/list.
const tools = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [bin, 'mcp'], { cwd: project });
  let buffer = '';
  const timer = setTimeout(() => {
    child.kill();
    fail(new Error('El servidor MCP no respondió'));
  }, 15_000);
  child.stdout.on('data', (d) => {
    buffer += d;
    for (const line of buffer.split('\n').slice(0, -1)) {
      const message = JSON.parse(line);
      if (message.id === 2) {
        clearTimeout(timer);
        child.stdin.end();
        done(message.result.tools.map((t) => t.name));
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
});
assert.ok(tools.includes('snappli_trigger_webhook'), `Herramientas: ${tools.join(', ')}`);

console.log(
  `smoke ok con Node ${process.version} en ${process.platform} (${tools.length} herramientas MCP)`,
);
