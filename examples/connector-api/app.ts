import express, { type NextFunction, type Request, type Response } from 'express';

interface Appointment {
  id: string;
  fecha: string;
  hora: string;
  servicio: string;
  telefono: string;
  nombre: string | null;
  status: 'confirmada';
}

const HOURS = ['09:00', '10:00', '11:00', '15:00', '16:00'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * API que Snappli llama como conector: lecturas rápidas, errores con JSON legible (la IA los lee y
 * se los explica al contacto) y escrituras idempotentes con la cabecera idempotency-key.
 */
export function createApp(apiKey: string) {
  const appointments: Appointment[] = [];
  /** idempotency-key → respuesta. En producción: tabla con índice único. */
  const idempotent = new Map<string, Appointment>();
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // Autenticación api_key_header (x-api-key), la que se configura en el conector.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-api-key') !== apiKey) {
      res.status(401).json({ error: 'API key inválida' });
      return;
    }
    next();
  });

  app.get('/slots', (req, res) => {
    const fecha = String(req.query.fecha ?? '');
    if (!DATE.test(fecha)) {
      res.status(400).json({ error: 'La fecha debe tener el formato AAAA-MM-DD' });
      return;
    }
    const taken = new Set(appointments.filter((a) => a.fecha === fecha).map((a) => a.hora));
    res.json({ fecha, slots: HOURS.filter((h) => !taken.has(h)).map((hora) => ({ hora })) });
  });

  app.post('/appointments', (req, res) => {
    const key = req.header('idempotency-key');
    const previous = key ? idempotent.get(key) : undefined;
    if (previous) {
      res.status(200).json(previous);
      return;
    }
    const { fecha, hora, servicio, telefono, nombre } = req.body ?? {};
    if (!DATE.test(String(fecha)) || !HOURS.includes(String(hora)) || !servicio || !telefono) {
      res
        .status(400)
        .json({ error: 'Faltan datos: fecha (AAAA-MM-DD), hora libre, servicio y teléfono' });
      return;
    }
    if (appointments.some((a) => a.fecha === fecha && a.hora === hora)) {
      res.status(409).json({ error: `Las ${hora} del ${fecha} ya están ocupadas` });
      return;
    }
    const appointment: Appointment = {
      id: `CITA-${appointments.length + 1}`,
      fecha,
      hora,
      servicio,
      telefono,
      nombre: nombre ?? null,
      status: 'confirmada',
    };
    appointments.push(appointment);
    if (key) idempotent.set(key, appointment);
    res.status(201).json(appointment);
  });

  app.get('/appointments', (req, res) => {
    const telefono = String(req.query.telefono ?? '');
    res.json({
      appointments: appointments
        .filter((a) => a.telefono === telefono)
        .map(({ id, fecha, hora, servicio }) => ({ id, fecha, hora, servicio })),
    });
  });

  return app;
}
