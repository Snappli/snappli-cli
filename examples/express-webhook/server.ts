import { createApp } from './app.ts';

const secret = process.env.SNAPPLI_WEBHOOK_SECRET;
if (!secret) throw new Error('Falta SNAPPLI_WEBHOOK_SECRET');
const port = Number(process.env.PORT ?? 3000);
createApp(secret).listen(port, () => {
  console.log(`Receptor en http://localhost:${port}/webhooks/snappli`);
});
