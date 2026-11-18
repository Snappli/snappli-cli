# @snappli/sdk

SDK de [Snappli](https://snappli.io) para integradores (Node ≥ 20): verifica webhooks, descarga los documentos del contacto, envía eventos de conector y lee la API pública.

```sh
npm install @snappli/sdk
```

## Recibir un webhook

```ts
import { verifyWebhook, SnappliWebhookError } from '@snappli/sdk';

// rawBody: el cuerpo tal como llegó (string o Buffer), sin parsear.
try {
  const event = verifyWebhook(rawBody, req.headers, process.env.SNAPPLI_WEBHOOK_SECRET!);
  // event.event: 'contact.stage.entered' | 'contact.created' | …
  // Ignora los repetidos por event.trigger.deliveryId (= Idempotency-Key).
} catch (error) {
  if (error instanceof SnappliWebhookError) {
    // error.reason: missing_signature | bad_signature | timestamp_out_of_range | invalid_json | …
  }
}
```

Los documentos (`event.contact.documents.<clave>`) se descargan con `downloadDocument(doc)`; el enlace caduca, así que hazlo al recibir el webhook.

## Enviar un evento a Snappli

```ts
import { sendConnectorEvent, connectorEventsUrl } from '@snappli/sdk';

const { result } = await sendConnectorEvent({
  url: connectorEventsUrl('<id del conector>'),
  secret: process.env.SNAPPLI_CONNECTOR_EVENT_SECRET!,
  type: 'pedido.enviado',
  data: { telefono: '+593991234567', pedido: 'PED-123' },
  eventId: 'pedido-PED-123-enviado',
});
// result.status: 'sent' | 'ignored' | 'failed'
```

## API pública

```ts
import { Snappli } from '@snappli/sdk';

const snappli = new Snappli(process.env.SNAPPLI_API_KEY!);
const me = await snappli.me(); // organización y permisos de la key
const failed = await snappli.webhookDeliveries.list({ status: 'FAILED' }); // webhooks:read
```

`contacts.list/get` (`contacts:read`), `webhookIntegrations.list/get/previewMapping` y `webhookDeliveries.list/get` (`webhooks:read`), `webhookIntegrations.test` y `webhookDeliveries.retry` (`webhooks:test`). Un 403 trae el permiso que falta en `error.body.missingScopes`; un 429, el tiempo de espera en el mensaje.

## Más

| Función | Para qué |
|---|---|
| `signWebhookPayload`, `webhookHeaders` | Firmar como Snappli en tus tests |
| `webhookDeliveryId(headers)` | Id de la entrega para el dedupe |
| `readJsonPath`, `previewResponseMapping`, `shapeConnectorResponse` | Ver en local qué leería el mapeo de respuesta o la IA |
| `signConnectorEvent`, `buildConnectorEvent` | Firmar un evento sin enviarlo |
| `new Snappli(apiKey).contacts.list()` / `.get(id)` | API pública (`sk_…`) |
| `WebhookEvent`, `WebhookContactDocument`, `ConnectorEventResult`… | Tipos, generados desde el backend |

Documentación: https://docs.snappli.io/desarrolladores/herramientas/ · Para probar desde la terminal: [`@snappli/cli`](https://www.npmjs.com/package/@snappli/cli).
