import { createApp } from './app.ts';

const apiKey = process.env.CONNECTOR_API_KEY;
if (!apiKey) throw new Error('Falta CONNECTOR_API_KEY');
const port = Number(process.env.PORT ?? 4000);
createApp(apiKey).listen(port, () => console.log(`API del conector en http://localhost:${port}`));
