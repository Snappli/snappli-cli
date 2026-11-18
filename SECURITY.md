# Seguridad

Si encuentras una vulnerabilidad en el SDK, el CLI o el servidor MCP, **no abras un issue público**. Repórtala de forma privada desde la pestaña **Security → Report a vulnerability** de este repositorio (GitHub Private Vulnerability Reporting).

Incluye la versión, los pasos para reproducirla y su impacto. Respondemos en un plazo de 3 días hábiles y te avisaremos cuando haya una versión corregida.

Para vulnerabilidades en la plataforma de Snappli (api.snappli.io, el panel), usa el mismo canal: lo derivamos al equipo correspondiente.

## Lo que el CLI hace con tus datos

- No envía telemetría. Solo llama a la API de Snappli y a las URLs que indicas.
- Nunca imprime completos la API key ni los secretos, y solo escribe en `~/.config/snappli` (o `%APPDATA%\snappli`) y en el `.env` que indiques.
- Lo que tiene efectos reales (un evento que hace que Snappli mande un WhatsApp) exige `--yes` en el CLI o `SNAPPLI_ALLOW_WRITE=1` en el MCP.
