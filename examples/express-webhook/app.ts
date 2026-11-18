import {
  downloadDocument,
  SnappliWebhookError,
  verifyWebhook,
  type WebhookEvent,
} from '@snappli/sdk';
import express from 'express';

/** Lo que guardarías en tu base de datos. Aquí, en memoria para el ejemplo. */
export interface Store {
  /** delivery_id → respuesta enviada. En producción: tabla con índice único en delivery_id. */
  deliveries: Map<string, unknown>;
  orders: Array<{ id: string; contactId: string; event: string }>;
  documents: Array<{ key: string; status: string; fileName: string; size: number }>;
}

export function createStore(): Store {
  return { deliveries: new Map(), orders: [], documents: [] };
}

export function createApp(secret: string, store: Store = createStore()) {
  const app = express();

  // express.raw: el cuerpo llega como Buffer, sin parsear, para verificar la firma.
  // Si tu app usa express.json() globalmente, monta esta ruta antes.
  app.post('/webhooks/snappli', express.raw({ type: 'application/json' }), (req, res) => {
    let event: WebhookEvent;
    try {
      event = verifyWebhook(req.body, req.headers, secret);
    } catch (error) {
      if (error instanceof SnappliWebhookError) {
        res.status(401).json({ error: error.reason });
        return;
      }
      throw error;
    }

    // Entrega repetida (reintento de Snappli): misma respuesta, sin repetir el trabajo.
    const deliveryId = event.trigger.deliveryId;
    if (store.deliveries.has(deliveryId)) {
      res.json(store.deliveries.get(deliveryId));
      return;
    }

    // Trabajo rápido: crear el registro y responder. Snappli corta a los 15 s.
    const order = {
      id: `PED-${store.orders.length + 1}`,
      contactId: event.contact.id,
      event: event.event,
    };
    store.orders.push(order);
    // Esta respuesta la puede leer el mapeo de respuesta: id_pedido ← $.data.id
    const response = { data: { id: order.id } };
    store.deliveries.set(deliveryId, response);
    res.json(response);

    // Lo lento, después de responder (en producción, una cola). Los enlaces caducan: descarga ya.
    for (const [key, doc] of Object.entries(event.contact.documents ?? {})) {
      downloadDocument(doc)
        .then((file) => {
          // Guarda file.bytes en tu almacenamiento y decide según doc.status (APPROVED, PENDING…).
          store.documents.push({
            key,
            status: doc.status,
            fileName: file.fileName,
            size: file.size,
          });
        })
        .catch((error: unknown) => console.error(`No se pudo descargar ${key}:`, error));
    }
  });

  return app;
}
