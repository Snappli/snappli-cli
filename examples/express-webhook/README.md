# Receptor de webhooks con Express

Verifica la firma con el cuerpo crudo, ignora las entregas repetidas, responde un JSON que el mapeo de respuesta puede leer y descarga los documentos después de responder.

```sh
pnpm install
SNAPPLI_WEBHOOK_SECRET=whsec_… pnpm start        # http://localhost:3000/webhooks/snappli

# En otra terminal:
npx @snappli/cli webhooks trigger contact.stage.entered \
  --to http://localhost:3000/webhooks/snappli --secret whsec_… \
  --repeat --with-documents --mapping '{"fields":{"id_pedido":"$.data.id"}}'
```

`pnpm test` hace lo mismo de forma automática (necesita Node 24 y el CLI construido: `pnpm build` en la raíz).

El dedupe y los pedidos están en memoria para que el ejemplo sea corto. En producción usa una tabla con índice único en `delivery_id` y una cola para las descargas.
