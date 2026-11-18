# snappli-cli

Monorepo pnpm público (MIT) con `@snappli/sdk` (packages/sdk) y `@snappli/cli` (packages/cli: comando `snappli`, servidor MCP y plugin con la skill). Sirve a los integradores para construir y probar su lado de la integración con Snappli. El plan está en `../plan-snappli-cli.md`.

## Desarrollo

- `pnpm install && pnpm build && pnpm test && pnpm test:examples && pnpm typecheck && pnpm lint`.
- El CLI importa el SDK construido: tras cambiar el SDK, `pnpm build` antes de probar el CLI.
- Tests del CLI: inyectan `fetch`, stdin y `untilExit` en `run()` y levantan servidores HTTP locales (`test/helpers.ts`). Nada sale a la red.

## Reglas

- **Nunca escribas a mano** tipos ni constantes que existan en `snappli-backend/src/shared` (payload de webhooks, cabeceras, schemas de conectores). `pnpm sync:shared` los copia a `packages/sdk/src/generated` (no editar esa carpeta); `pnpm sync:shared --check` falla si están desactualizados.
- Lo que no está en `src/shared` (firma de webhooks, `readJsonPath`, mapeo de respuesta, límites de conectores) replica el backend con tests contra los mismos casos: `webhook-delivery.service.ts`, `connector-events.service.ts`, `connector-operation.util.ts`, `webhook-response-mapping.service.ts`, `connector-http.client.ts`. Si cambian allí, cambia aquí.
- La firma de webhooks es hex **sin prefijo**; la de eventos de conector, **con** `sha256=`. No se unifica en el backend porque rompería integraciones.
- CLI y MCP solo llaman a funciones de `packages/cli/src/operations.ts`.
- Seguridad: lo que escribe en Snappli o en el sistema del cliente exige `--yes`/`--allow-write` (CLI) o `SNAPPLI_ALLOW_WRITE=1` (MCP). Las keys y secretos nunca se imprimen completos.
- Salida: JSON en stdout (`--pretty` indenta); errores `{error:{code,message}}` en stderr y código 1.
- Español en mensajes, ayuda, skill y docs. Multiplataforma (CI en Ubuntu y Windows): nada de `rm -rf` ni rutas con `/` fijas en scripts.
- Si cambias comandos, herramientas MCP o la skill, actualiza también `snappli-docs` (`desarrolladores/herramientas.mdx`).

## Release

Changesets: cada PR con cambios en paquetes añade `pnpm changeset`. Al mergear a main, `release.yml` abre «Version packages»; al mergear ese PR publica en npm con provenance (`NPM_TOKEN`). Publicar solo con aprobación del responsable.
