# @snappli/cli

CLI y servidor MCP de [Snappli](https://snappli.io) para integradores: prueba tu receptor de webhooks, tus eventos de conector y las respuestas de tu API desde la terminal o desde tu agente (Claude Code, Cursor, Codex).

```sh
npx @snappli/cli --help
```

## Comandos

| Comando | Qué hace |
|---|---|
| `snappli init` | Añade las variables de Snappli al `.env` y comprueba el `.gitignore` |
| `snappli webhooks example <evento> [--with-documents]` | Payload de ejemplo |
| `snappli webhooks trigger <evento> --to <url> [--secret s] [--repeat] [--with-documents] [--mapping m.json]` | Firma y envía un webhook como Snappli y cuenta qué respondió tu servidor |
| `snappli webhooks verify --secret s --timestamp t --signature sig [--file body.json]` | Por qué una firma no valida |
| `snappli webhooks serve [--port 4555] [--secret s]` | Receptor local que verifica e imprime cada entrega |
| `snappli events send <tipo> --to <url> --secret s --data d.json` | Envía un evento firmado de conector (`--yes` si no es localhost: manda un WhatsApp real) |
| `snappli connectors check-response --file r.json [--map m.json]` | Lo que leería la IA de la respuesta de tu API |
| `snappli skill [install]` | La skill de integración |
| `snappli mcp` | Servidor MCP por stdio |

Salida JSON en stdout (`--pretty` para indentarla); los errores van a stderr con código de salida 1.

## MCP

```sh
claude mcp add snappli -- npx -y @snappli/cli mcp
```

Para Cursor y otros clientes:

```json
{
  "mcpServers": {
    "snappli": { "command": "npx", "args": ["-y", "@snappli/cli", "mcp"] }
  }
}
```

Herramientas: `snappli_webhook_example`, `snappli_trigger_webhook`, `snappli_verify_webhook_signature`, `snappli_send_connector_event` (a Snappli solo con `SNAPPLI_ALLOW_WRITE=1`) y `snappli_check_connector_response`.

También es un plugin de Claude Code (carpeta `plugin/`), con la skill y el servidor MCP.

Documentación: https://docs.snappli.io/desarrolladores/herramientas/
