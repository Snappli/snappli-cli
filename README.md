# Snappli para integradores

SDK, CLI, servidor MCP y skill para construir y probar **tu lado** de una integración con [Snappli](https://snappli.io), sin depender de que alguien mueva contactos en el panel:

- **Recibir webhooks**: verificar la firma, ignorar las entregas repetidas, descargar los documentos y responder un JSON que el mapeo de respuesta pueda leer.
- **Exponer una API para un conector**: lo que la IA de Snappli llama durante la conversación.
- **Enviar eventos a Snappli** para que mande una plantilla de WhatsApp al contacto.

| Paquete | Para qué |
|---|---|
| [`@snappli/sdk`](packages/sdk) | `verifyWebhook`, `downloadDocument`, `sendConnectorEvent`, `readJsonPath` y el cliente de la API pública |
| [`@snappli/cli`](packages/cli) | Comando `snappli`, servidor MCP (`snappli mcp`) y plugin con la skill para Claude Code |

## Empezar

```sh
npm install @snappli/sdk
npx @snappli/cli init

# Prueba tu receptor como si fuera Snappli: firma, reenvío y documentos descargables.
npx @snappli/cli webhooks trigger contact.stage.entered \
  --to http://localhost:3000/webhooks/snappli --secret "$SNAPPLI_WEBHOOK_SECRET" \
  --repeat --with-documents
```

Con tu agente:

```sh
claude mcp add snappli -- npx -y @snappli/cli mcp   # Claude Code
npx @snappli/cli skill install                      # skill en .claude/skills/snappli/
```

Documentación completa: https://docs.snappli.io/desarrolladores/herramientas/

## Ejemplos

- [`examples/express-webhook`](examples/express-webhook): receptor con Express, dedupe y descarga de documentos.
- [`examples/nextjs-webhook`](examples/nextjs-webhook): route handler del App Router con el cuerpo crudo.
- [`examples/connector-api`](examples/connector-api): API que Snappli puede llamar como conector, con su definición.

El CI los ejecuta contra el CLI en cada cambio.

## Licencia

MIT. Para reportar una vulnerabilidad, mira [SECURITY.md](SECURITY.md).
