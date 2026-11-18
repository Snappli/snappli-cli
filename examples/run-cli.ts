import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Ejecuta el CLI recién construido (`packages/cli/dist`) y devuelve su salida JSON. */
export function snappli(
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<{ code: number; json: any; stderr: string }> {
  const bin = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } });
    child.stdin.end(stdin ?? '');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code: code ?? 1, json: stdout ? JSON.parse(stdout) : null, stderr });
      } catch {
        reject(new Error(`Salida no JSON: ${stdout}\n${stderr}`));
      }
    });
  });
}
