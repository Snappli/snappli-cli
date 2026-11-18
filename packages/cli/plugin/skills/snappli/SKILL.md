---
name: snappli
description: Integra un sistema externo con Snappli (CRM de WhatsApp): recibir y verificar sus webhooks, responder para el mapeo de respuesta, descargar los documentos del contacto, exponer una API que Snappli llama como conector y enviarle eventos firmados para que mande plantillas de WhatsApp. Úsala cuando el usuario quiera integrar su sistema con Snappli, o mencione Snappli, X-Snappli-Signature, X-Snappli-Timestamp, contact.stage.entered, conversation.escalated, un conector de Snappli, una key sk_… de Snappli o @snappli/sdk.
---

# Integrar con Snappli

Snappli es un CRM de WhatsApp con IA. Un sistema externo se integra de tres formas:

| Dirección | Qué es | Cómo se prueba en local |
|---|---|---|
| Snappli → tu servidor | **Webhooks**: `POST` JSON firmado cuando un contacto entra a una etapa, se crea, se actualiza, recibe una etiqueta o se escala | `snappli webhooks trigger`, `snappli webhooks serve` |
| Snappli → tu API | **Conector**: operaciones de lectura y escritura de tu API que la IA llama durante la conversación | `snappli connectors check-response` |
| Tu sistema → Snappli | **Eventos de conector**: `POST` firmado para que Snappli mande una plantilla de WhatsApp al contacto | `snappli events send` |

Herramientas: `npx @snappli/cli …` (o las herramientas MCP `snappli_*`) y el SDK `npm install @snappli/sdk` (Node ≥ 20). Detalle en https://docs.snappli.io/desarrolladores/.

## Reglas

1. La API key (`sk_…`) y los secretos van en `.env` (`SNAPPLI_API_KEY`, `SNAPPLI_WEBHOOK_SECRET`, `SNAPPLI_CONNECTOR_EVENT_SECRET`), nunca en el código ni en logs. `npx @snappli/cli init` los añade vacíos y avisa si `.env` no está en `.gitignore`.
2. Verifica la firma con el **cuerpo crudo**, tal como llegó. Parsear y volver a serializar el JSON cambia los bytes y la firma deja de coincidir.
3. No proceses dos veces la misma entrega: guarda `Idempotency-Key` (= `X-Snappli-Delivery-Id`, igual en todos los reintentos) con un **índice único** y, si ya existe, responde 2xx sin repetir el trabajo.
4. Responde **2xx en menos de 15 s**. Lo pesado (llamadas a otros sistemas, descargas grandes) va a una cola o a segundo plano.
5. Descarga los documentos (`contact.documents.<clave>.url`) enseguida y guárdalos en tu sistema: el enlace caduca (`urlExpiresAt`, 72 h por defecto).
6. Un 4xx, un 5xx o un timeout hacen que Snappli reintente (3 intentos en total, backoff exponencial desde 2 s) y, si todos fallan, deja una nota en el contacto. Ante una firma inválida responde 401 y no proceses nada.

## Webhooks

### Cabeceras

| Cabecera | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Snappli-Webhook/1.0` |
| `Idempotency-Key`, `X-Snappli-Delivery-Id` | Id de la entrega (siempre) |
| `X-Snappli-Timestamp` | Epoch en **segundos** (si la integración tiene secreto) |
| `X-Snappli-Signature` | HMAC SHA-256 en hex, **sin prefijo**, de `` `${timestamp}.${rawBody}` `` (si tiene secreto) |
| La de autenticación de la integración | Si se configuró en el panel (p. ej. `Authorization: Bearer …`) |

### Eventos y payload

`event` es `contact.stage.entered`, `contact.webhook.manual`, `contact.created`, `contact.updated`, `contact.tag.assigned` o `conversation.escalated`. Todos traen `organizationId`, `sentAt`, `trigger` (`source`: `AI`, `AGENT`, `MANUAL`, `BULK`, `TEST` o `SYSTEM`; `userId`; `deliveryId`) y `contact` (`id`, nombre, `email`, `phone`, `language`, `countryCode`, `tags`, `customFields` y, si los hay, `documents`). Según el evento añaden `pipeline` y `conversation` (etapas), `tag` (etiqueta) o `conversation`, `reason`, `summary`, `departmentId` y `departmentName` (escalado).

No escribas los tipos a mano: usa `WebhookEvent` del SDK (unión discriminada por `event`) o mira un ejemplo real con `npx @snappli/cli webhooks example contact.stage.entered --with-documents`.

`contact.documents.<clave>`: `label`, `status` (`PENDING`, `APPROVED` o `REJECTED`), `storageKey`, `mimeType`, `size`, `fileName` (puede ser `null`), `url` y `urlExpiresAt`. Descárgalos todos y decide según el estado (normalmente, solo das por válidos los `APPROVED`).

### Receptor con el SDK (Express)

```ts
import express from 'express';
import { verifyWebhook, downloadDocument, SnappliWebhookError } from '@snappli/sdk';

const app = express();

// express.raw: el cuerpo llega como Buffer, sin parsear.
app.post('/webhooks/snappli', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.SNAPPLI_WEBHOOK_SECRET!);
  } catch (error) {
    if (error instanceof SnappliWebhookError) return res.status(401).json({ error: error.reason });
    throw error;
  }

  // Dedupe: índice único sobre delivery_id. Si ya estaba, responde lo mismo que la primera vez.
  const deliveryId = event.trigger.deliveryId;
  const previous = await db.webhookDeliveries.findUnique({ where: { deliveryId } });
  if (previous) return res.json(previous.response);

  const pedido = await crearPedido(event.contact); // rápido; lo lento, a una cola
  const response = { data: { id: pedido.id } };
  await db.webhookDeliveries.create({ data: { deliveryId, response } });

  // Descarga todos ya (el enlace caduca) y decide luego según doc.status.
  for (const [clave, doc] of Object.entries(event.contact.documents ?? {})) {
    cola.add('guardar-documento', { clave, doc }); // el worker llama a downloadDocument(doc)
  }
  res.json(response);
});
```

Si el handler está montado después de `express.json()`, el cuerpo ya está parseado y la firma no coincidirá: monta la ruta antes o con `express.raw` propio.

### Next.js (App Router)

```ts
import { verifyWebhook, SnappliWebhookError } from '@snappli/sdk';

export const runtime = 'nodejs'; // el SDK usa node:crypto

export async function POST(request: Request) {
  const rawBody = await request.text(); // crudo: no uses request.json()
  try {
    const event = verifyWebhook(rawBody, request.headers, process.env.SNAPPLI_WEBHOOK_SECRET!);
    // …dedupe por event.trigger.deliveryId y trabajo rápido
    return Response.json({ data: { id: '…' } });
  } catch (error) {
    if (error instanceof SnappliWebhookError) {
      return Response.json({ error: error.reason }, { status: 401 });
    }
    throw error;
  }
}
```

### Sin SDK (otros lenguajes)

```
timestamp = header("X-Snappli-Timestamp"); signature = header("X-Snappli-Signature")
si falta alguno → 401
si |ahora_en_segundos − int(timestamp)| > 300 → 401
esperada = hex(HMAC_SHA256(clave = secreto, mensaje = timestamp + "." + cuerpo_crudo))
si no comparar_en_tiempo_constante(esperada, signature) → 401
```

```python
import hashlib, hmac, time

def verify(secret: str, timestamp: str, raw_body: bytes, signature: str) -> bool:
    if not timestamp or not signature or not timestamp.isdigit():
        return False
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

En Flask usa `request.get_data()`; en Django, `request.body`; en FastAPI, `await request.body()`.

## Responder para el mapeo de respuesta

Con una respuesta **2xx con JSON**, la integración puede copiar valores a campos del contacto, añadir etiquetas y dejar una nota. Devuelve un JSON estable y pequeño, por ejemplo:

```json
{ "data": { "id": "PED-123", "estado": "creado" } }
```

En el panel, en el mapeo de respuesta de la integración: `id_pedido ← $.data.id`, nota `Pedido {{id_pedido}} creado`, y «No enviar si ya tiene `id_pedido`» para que una entrega nueva no cree otro pedido. Las rutas admiten `$.a.b` y `$.lista[0].id`. Una respuesta vacía, de texto o no 2xx no rellena nada.

Compruébalo con `npx @snappli/cli webhooks trigger contact.stage.entered --to http://localhost:3000/webhooks/snappli --mapping '{"fields":{"id_pedido":"$.data.id"},"note":"Pedido {{id_pedido}}"}'`.

## Una API para un conector

La IA de Snappli llama a tu API durante la conversación (consultar disponibilidad, pedidos, stock; reservar, crear tickets). Cada operación tiene método, ruta (`/orders?telefono={telefono}`), parámetros, un `responseMap` y, si escribe, un texto de confirmación.

- **Autenticación** admitida: ninguna, API key en cabecera (`x-api-key` por defecto), API key en query (`api_key`), Bearer o Basic.
- **Límites**: tiempo límite de 8 s por defecto (máximo 20 s), respuesta de 1 MB como máximo, hasta 3 redirecciones (solo al mismo host) y 60 llamadas por minuto por defecto. La IA solo ve 2048 caracteres de lo que devuelve el `responseMap`. Una lectura que responde 5xx se reintenta una vez; una escritura, nunca.
- **Red**: URL **HTTPS pública**. Snappli bloquea IP privadas y redes internas, así que `localhost` no sirve para la prueba real (usa un túnel o un entorno de staging).
- **Nombres y descripciones**: la IA decide cuándo llamar por el `name` (minúsculas, números y `_`) y la `description` (mínimo 10 caracteres). Explica cuándo usarla y qué devuelve.
- **Parámetros ligados**: el teléfono, email, nombre, id o un campo del contacto (`contact.phone`, `contact.email`, `contact.name`, `contact.id`, `contact.field.<clave>`) los pone Snappli desde la ficha, no la IA. Úsalos para identificar al cliente, no un parámetro que la IA pueda inventar.
- **Escrituras**: necesitan un texto de confirmación («Reservo {servicio} el {fecha} a las {hora}. ¿Confirmas?»); la IA pide confirmación al contacto antes de llamar. Llevan una cabecera `idempotency-key` estable para la misma conversación, operación y parámetros: guárdala con un índice único y, si se repite, devuelve el resultado anterior sin repetir la acción.
- **Errores**: devuelve el código HTTP correcto (400, 404, 409…) con un JSON legible (`{"error":"No hay horarios ese día"}`): la IA lo lee y se lo explica al contacto.
- **Respuesta**: JSON con solo lo necesario. Comprueba lo que verá la IA con `npx @snappli/cli connectors check-response --file respuesta.json --map '{"horarios":"$.slots[*].hora"}'`.

Los conectores están disponibles con la función de integraciones de IA del plan.

## Enviar eventos a Snappli

Para que Snappli mande una plantilla de WhatsApp aprobada cuando pasa algo en tu sistema (pedido enviado, cita confirmada):

1. En el panel, en el conector: activa los **eventos** (te muestra el secreto una sola vez) y crea una regla por tipo: tipo de evento, cómo buscar al contacto (`$.telefono` o `$.email`), plantilla y parámetros (`$.pedido`…).
2. Envía `POST https://api.snappli.io/api/integrations/connectors/<id>/events` con:
   - cuerpo `{"type": "pedido.enviado", "data": {…}}`;
   - `x-snappli-timestamp`: epoch en segundos (300 s de margen);
   - `x-snappli-signature`: `sha256=` + HMAC SHA-256 en hex de `` `${timestamp}.${body}` `` (**con prefijo**, al contrario que los webhooks);
   - `x-snappli-event-id`: id único y estable del evento (6–100 caracteres `[A-Za-z0-9_.:-]`, p. ej. `pedido-123-enviado`). Uno repetido se ignora.

```ts
import { sendConnectorEvent, connectorEventsUrl } from '@snappli/sdk';

const { result } = await sendConnectorEvent({
  url: connectorEventsUrl(process.env.SNAPPLI_CONNECTOR_ID!),
  secret: process.env.SNAPPLI_CONNECTOR_EVENT_SECRET!,
  type: 'pedido.enviado',
  data: { telefono: '+593991234567', pedido: 'PED-123' },
  eventId: `pedido-PED-123-enviado`,
});
```

La respuesta es siempre 200 si la firma vale: `{"status":"sent","messageId","conversationId"}`, `{"status":"ignored","reason":"no_mapping" | "no_contact" | "duplicate"}` o `{"status":"failed","reason"}`. Un 401 significa firma, hora o id del evento inválidos, o eventos no activos en el conector. No reintentes un `ignored`; un `failed` o un error de red sí, con el **mismo** `eventId`.

## Cómo comprobarlo

```sh
npx @snappli/cli webhooks trigger contact.stage.entered --to http://localhost:3000/webhooks/snappli \
  --secret "$SNAPPLI_WEBHOOK_SECRET" --repeat --with-documents
```

Muestra el código, el tiempo, la respuesta y avisos; `--repeat` reenvía la misma entrega (debe procesarse una vez) y `--with-documents` sirve archivos reales y cuenta si tu receptor los descargó. Además:

- `npx @snappli/cli webhooks verify --secret … --timestamp … --signature … --file body.json`: por qué una firma no valida.
- `npx @snappli/cli webhooks serve --port 4555`: receptor local para ver, con un túnel, qué manda Snappli de verdad.
- `npx @snappli/cli events send pedido.enviado --to http://localhost:4000/mock --secret … --data '{"telefono":"+593…"}'`: prueba la firma contra un mock. Contra Snappli exige `--yes`, porque manda un WhatsApp real.
- `npx @snappli/cli connectors check-response --file r.json --map m.json`: lo que leería la IA.

Después, en el panel: **Enviar prueba** en la integración y el historial de entregas (código, respuesta y resultado del mapeo).

## Paso a producción

- URL HTTPS pública con certificado válido.
- Secreto propio por integración, rotado si se compartió (por chat, en un ticket…).
- Dedupe persistente (base de datos con índice único), no en memoria.
- Respuesta en menos de 15 s también con carga; trabajo pesado en cola.
- Documentos descargados y guardados al recibirlos.
- Logs sin datos personales completos (teléfono, email, documentos) ni secretos.
- Alertas si las entregas fallan (el historial de Snappli lo muestra y deja nota en el contacto).

## Errores frecuentes

| Síntoma | Causa |
|---|---|
| `bad_signature` siempre | El cuerpo se parseó antes de verificar (`express.json()`, `request.json()`), se reformateó, o el secreto es de otra integración |
| `bad_signature` solo al probar con un archivo | El archivo tiene un salto de línea final que no venía en la entrega (`webhooks verify` lo detecta) |
| `timestamp_out_of_range` | Reloj del servidor desfasado (usa NTP), timestamp en milisegundos o entrega antigua reenviada a mano |
| Evento rechazado con 401 | Falta el prefijo `sha256=`, falta `x-snappli-event-id`, el secreto no es el de eventos del conector o el reloj está desfasado |
| `ignored: no_mapping` | El `type` no coincide exactamente con una regla activa |
| `ignored: no_contact` | La ruta del contacto de la regla no apunta al teléfono o email, o el contacto no existe en Snappli |
| Documento con 404 | El enlace caducó: descárgalo al recibir el webhook (reintentar la entrega genera uno nuevo) |
| El mapeo no rellena nada | La respuesta no es 2xx, no es JSON o la ruta no existe (`trigger --mapping` lo muestra) |
| Pedidos duplicados | No hay dedupe por `Idempotency-Key`, o falta «No enviar si ya tiene …» en la integración |
