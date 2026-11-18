#!/usr/bin/env node
import { createRequire } from 'node:module';
import { text } from 'node:stream/consumers';
import { run } from './commands.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const code = await run(
  process.argv.slice(2),
  {
    env: process.env,
    cwd: process.cwd(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin: () => text(process.stdin),
    startMcp: async () => {
      const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
        import('./mcp.js'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
      ]);
      await createMcpServer({ env: process.env, version }).connect(new StdioServerTransport());
      // El proceso sigue vivo mientras el cliente mantenga abierto stdin.
      await new Promise<void>((resolve) => process.stdin.on('close', resolve));
    },
  },
  version,
);
process.exitCode = code;
