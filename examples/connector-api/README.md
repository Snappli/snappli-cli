# API de ejemplo para un conector

Una agenda mínima que Snappli puede llamar como conector: `disponibilidad` (lectura), `reservar` (escritura con confirmación) y `mis_reservas` (lectura ligada al teléfono del contacto). `connector.json` tiene la definición que configurarías en el panel.

Muestra lo que Snappli espera de tu API:

- Autenticación `api_key_header` (`x-api-key`).
- Errores con código HTTP correcto y un JSON legible (`{"error":"…"}`): la IA lo lee y se lo explica al contacto.
- Escrituras idempotentes con la cabecera `idempotency-key`.
- Respuestas pequeñas; el `responseMap` elige lo que ve la IA.

```sh
pnpm install
CONNECTOR_API_KEY=… pnpm start   # http://localhost:4000

curl -s -H "x-api-key: …" "http://localhost:4000/slots?fecha=2030-01-01" \
  | npx @snappli/cli connectors check-response --file - --map '{"horarios":"$.slots[*].hora"}'
```

Para usarla de verdad, Snappli necesita una URL HTTPS pública: bloquea `localhost` y las IP privadas.

`pnpm test` valida `connector.json` con los schemas de Snappli y comprueba lo que leería la IA (Node 24 y `pnpm build` en la raíz).
