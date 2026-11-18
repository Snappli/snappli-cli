# Contribuir

Requisitos: Node 24 (`.nvmrc`) y pnpm 9 (`corepack enable`). Los paquetes publicados funcionan con Node ≥ 20.

```sh
pnpm install
pnpm build          # el CLI usa el SDK construido
pnpm test           # tests de los paquetes
pnpm test:examples  # los ejemplos contra el CLI construido (Node ≥ 22.18)
pnpm typecheck
pnpm lint           # Biome; pnpm format para corregir
```

## Reglas

- Los tipos y constantes del payload, las cabeceras y los schemas de conectores **no se escriben a mano**: vienen de `snappli-backend/src/shared` con `pnpm sync:shared` (a `packages/sdk/src/generated`). Si el backend cambia, sincroniza y revisa el diff.
- El CLI y el MCP son capas delgadas sobre `packages/cli/src/operations.ts`, que solo usa el SDK. Ninguna regla de negocio de Snappli vive aquí.
- Mensajes, ayuda y documentación en español.
- Cada cambio de un paquete lleva un changeset (`pnpm changeset`). Los dos paquetes se versionan juntos.
- Trabajo por rama y PR a `main`; el CI debe quedar en verde en Ubuntu y Windows.
