// app/api/webhooks/snappli/route.ts de tu proyecto Next.js (App Router).
import { SnappliWebhookError, verifyWebhook } from '@snappli/sdk';

// El SDK usa node:crypto: este handler no puede ir en el runtime edge.
export const runtime = 'nodejs';

/** Entregas ya procesadas. En producción: tabla con índice único en delivery_id. */
const processed = new Map<string, unknown>();

export async function POST(request: Request): Promise<Response> {
  // Cuerpo crudo: con request.json() la firma no se puede verificar.
  const rawBody = await request.text();
  let event: ReturnType<typeof verifyWebhook>;
  try {
    event = verifyWebhook(rawBody, request.headers, process.env.SNAPPLI_WEBHOOK_SECRET ?? '');
  } catch (error) {
    if (error instanceof SnappliWebhookError) {
      return Response.json({ error: error.reason }, { status: 401 });
    }
    throw error;
  }

  const deliveryId = event.trigger.deliveryId;
  const previous = processed.get(deliveryId);
  if (previous) return Response.json(previous);

  // Trabajo rápido aquí; lo lento, a una cola (Snappli corta a los 15 s).
  const response = { data: { id: `LEAD-${processed.size + 1}`, event: event.event } };
  processed.set(deliveryId, response);
  return Response.json(response);
}
