# Receptor de webhooks en Next.js (App Router)

Copia `app/api/webhooks/snappli/route.ts` a tu proyecto, instala `@snappli/sdk` y define `SNAPPLI_WEBHOOK_SECRET`. Puntos clave:

- `await request.text()`: el cuerpo crudo. Con `request.json()` la firma no se puede verificar.
- `runtime = 'nodejs'`: el SDK usa `node:crypto`.
- Dedupe por `event.trigger.deliveryId` (en el ejemplo en memoria; en producción, una tabla con índice único).

Pruébalo con tu servidor de desarrollo levantado:

```sh
npx @snappli/cli webhooks trigger contact.stage.entered \
  --to http://localhost:3000/api/webhooks/snappli --secret "$SNAPPLI_WEBHOOK_SECRET" --repeat
```

`pnpm test` sirve el handler sin Next y lo prueba con el CLI (Node 24 y `pnpm build` en la raíz).
