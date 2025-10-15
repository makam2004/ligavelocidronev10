# Liga Velocidrone – Servidor (API + Frontend estático)
Este servicio expone rutas:
- GET /api/tracks/active
- GET /api/leaderboard?track_id=...&laps=1|3
- POST /api/admin/set-tracks (cabecera x-admin-key)
Y además sirve el frontend desde / (carpeta /public).

## Variables de entorno
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE
- VELO_API_URL
- VELO_API_TOKEN
- SIM_VERSION
- TELEGRAM_BOT_TOKEN (opcional)
- TELEGRAM_CHAT_ID (opcional)
- ADMIN_KEY
- PORT (por defecto 3000)
