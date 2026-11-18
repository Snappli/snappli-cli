#!/usr/bin/env node
/**
 * Copia de `snappli-backend/src/shared` los archivos que necesita el SDK (y los que estos importan) a
 * `packages/sdk/src/generated`. Nunca se editan a mano: si cambia el backend, se vuelve a correr.
 *
 *   pnpm sync:shared                     # backend en ../snappli-backend
 *   SNAPPLI_BACKEND_DIR=… pnpm sync:shared
 *   pnpm sync:shared --check             # falla si la copia está desactualizada (CI con el backend)
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(process.env.SNAPPLI_BACKEND_DIR ?? join(root, '..', 'snappli-backend'));
const shared = join(backend, 'src', 'shared');
const target = join(root, 'packages', 'sdk', 'src', 'generated');
const check = process.argv.includes('--check');

/** Puntos de entrada: lo que usa el SDK. Las dependencias relativas se copian solas. */
const ENTRIES = [
  'schemas/webhook-integration.schema.ts',
  'schemas/public-api.schema.ts',
  'connectors.ts',
];

if (!existsSync(shared)) {
  console.error(`No encuentro ${shared}. Clona snappli-backend al lado o usa SNAPPLI_BACKEND_DIR.`);
  process.exit(1);
}

const HEADER = (file) =>
  `// Generado por scripts/sync-shared.mjs desde snappli-backend/src/shared/${file}. No editar.\n`;

const files = new Map();
const queue = [...ENTRIES];
while (queue.length) {
  const file = queue.shift();
  if (files.has(file)) continue;
  const source = await readFile(join(shared, file), 'utf8');
  const rewritten = source.replace(
    /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_match, start, specifier, end) => {
      const dependency = join(dirname(file), `${specifier.replace(/\.(js|ts)$/, '')}.ts`);
      queue.push(dependency);
      return `${start}${specifier.replace(/\.(js|ts)$/, '')}.js${end}`;
    },
  );
  const bare = [...source.matchAll(/from\s+['"]([^./'"][^'"]*)['"]/g)].map((m) => m[1]);
  const foreign = bare.filter((name) => name !== 'zod');
  if (foreign.length) {
    console.error(`${file} importa ${foreign.join(', ')}: el SDK solo admite zod.`);
    process.exit(1);
  }
  files.set(file, `${HEADER(file)}${rewritten}`);
}

const index = `${HEADER('*')}${[...files.keys()]
  .sort()
  .map((file) => `export * from './${file.replace(/\.ts$/, '.js')}';`)
  .join('\n')}\n`;
files.set('index.ts', index);

async function listExisting(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listExisting(path)));
    else out.push(relative(target, path));
  }
  return out;
}

if (check) {
  const stale = [];
  for (const [file, content] of files) {
    const current = await readFile(join(target, file), 'utf8').catch(() => null);
    if (current !== content) stale.push(file);
  }
  const extra = (await listExisting(target)).filter((file) => !files.has(file));
  if (stale.length || extra.length) {
    console.error(`La copia de src/shared está desactualizada: ${[...stale, ...extra].join(', ')}`);
    console.error('Corre pnpm sync:shared y revisa el diff.');
    process.exit(1);
  }
  console.log('src/shared al día.');
} else {
  await rm(target, { recursive: true, force: true });
  for (const [file, content] of files) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await writeFile(join(target, file), content);
  }
  console.log(`Copiados ${files.size - 1} archivos de ${relative(root, shared) || shared}:`);
  for (const file of files.keys()) if (file !== 'index.ts') console.log(`  ${file}`);
}
