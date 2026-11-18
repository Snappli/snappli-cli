# @snappli/sdk

## 0.3.0

### Minor Changes

- a1d4554: Conectores con API key: `connectors.list/get/logs/testOperation` en el SDK; `connectors list/get/logs/test` en el CLI (la operación por id o nombre; escrituras con `--allow-write`); herramientas MCP `snappli_connectors`, `snappli_connector_logs` y `snappli_test_connector_operation` (escrituras solo con `SNAPPLI_ALLOW_WRITE=1`).

## 0.2.0

### Minor Changes

- e040871: Webhooks con API key: `Snappli.me()`, `webhookIntegrations` y `webhookDeliveries` en el SDK; `login`, `logout`, `whoami` y `webhooks list/get/deliveries/mapping-preview/test/retry` en el CLI; herramientas MCP `snappli_account`, `snappli_webhook_integrations`, `snappli_webhook_deliveries`, `snappli_preview_mapping` y, con `SNAPPLI_ALLOW_WRITE=1`, `snappli_test_webhook` y `snappli_retry_delivery`. Tipos de la API pública sincronizados desde el backend.

## 0.1.0

### Minor Changes

- 107b034: Primera versión: SDK (verificación de webhooks, descarga de documentos, eventos de conector, JSONPath y cliente de la API pública), CLI (`init`, `webhooks example/trigger/verify/serve`, `events send`, `connectors check-response`, `skill`), servidor MCP y plugin con la skill para Claude Code.
