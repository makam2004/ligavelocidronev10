import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================
// ENV
// ============================
const PORT = process.env.PORT || 3000;
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN;  // Sanctum token
const SIM_VERSION = process.env.SIM_VERSION || '1.16';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // opcional
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;     // opcional

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // clave secreta del lado servidor

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn('Faltan variables de Supabase (SUPABASE_URL, SUPABASE_SERVICE_ROLE).');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
// Utilidades
// ============================
function parseTimeToMs(t) {
  if (!t) return null;
  const parts = t.split(':');
  let h = 0, m = 0, s = 0, ms = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    const [sec, milli] = parts[2].split('.');
    s = parseInt(sec, 10);
    ms = parseInt(milli || '0', 10);
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10);
    const [sec, milli] = parts[1].split('.');
    s = parseInt(sec, 10);
    ms = parseInt(milli || '0', 10);
  } else {
    return null;
  }
  return (((h * 60 + m) * 60) + s) * 1000 + ms;
}

function msToTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const milli = ms % 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n, z=2) => String(n).padStart(z, '0');
  const base = `${h>0 ? pad(h)+':' : ''}${pad(m)}:${pad(s)}`;
  return `${base}.${pad(milli,3)}`;
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return; // opcional
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  });
}

async function fetchLeaderboardFromVelo({ track_id, race_mode, offset=0, count=200, protected_track_value=1 }) {
  if (!VELO_API_TOKEN) throw new Error('Falta VELO_API_TOKEN');
  const postData = `track_id=${track_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&protected_track_value=${protected_track_value}&race_mode=${race_mode}`;

  const res = await fetch(VELO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VELO_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ post_data: postData })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Velocidrone API error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return Array.isArray(json.tracktimes) ? json.tracktimes : [];
}

// ============================
// Rutas API
// ============================

// 1) Lista de tracks activos (para el frontend)
app.get('/api/tracks/active', async (req, res) => {
  const { data, error } = await supabase
    .from('tracks')
    .select('*')
    .eq('active', true)
    .order('laps');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tracks: data });
});

// 2) Leaderboard filtrado por pilotos registrados y detección de mejoras
app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10); // 1 => race_mode 3, 3 => race_mode 6
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });

    const race_mode = laps === 3 ? 6 : 3;

    // 2.1 Pilotos activos de tu liga
    const { data: pilots, error: pilotErr } = await supabase
      .from('pilots').select('user_id, name, country').eq('active', true);
    if (pilotErr) throw pilotErr;
    const pilotMap = new Map(pilots.map(p => [p.user_id, p]));

    // 2.2 Leaderboard completa desde Velocidrone
    const raw = await fetchLeaderboardFromVelo({ track_id, race_mode });

    // 2.3 Filtra por pilotos de tu liga y convierte tiempos a ms
    const filtered = raw
      .filter(r => pilotMap.has(r.user_id))
      .map(r => ({
        user_id: r.user_id,
        playername: r.playername,
        country: r.country,
        model_name: r.model_name,
        sim_version: r.sim_version,
        device_type: r.device_type,
        lap_time: r.lap_time, // string
        lap_time_ms: parseTimeToMs(r.lap_time),
        updated_at: r.updated_at || null
      }))
      .filter(r => Number.isFinite(r.lap_time_ms))
      .sort((a,b) => a.lap_time_ms - b.lap_time_ms)
      .map((r, idx) => ({ position: idx+1, ...r }));

    // 2.4 Detectar y persistir mejoras
    for (const row of filtered) {
      const { data: existing } = await supabase
        .from('results')
        .select('best_time_ms, playername')
        .eq('track_id', track_id)
        .eq('laps', laps)
        .eq('user_id', row.user_id)
        .maybeSingle();

      if (!existing) {
        // Primera vez
        await supabase.from('results').insert({
          track_id, laps, user_id: row.user_id, playername: row.playername, best_time_ms: row.lap_time_ms
        });
        await sendTelegramMessage(`🏁 <b>Nuevo tiempo registrado</b>\n${row.playername} • ${laps} lap(s)\n<code>${msToTime(row.lap_time_ms)}</code>`);
      } else if (row.lap_time_ms < existing.best_time_ms) {
        // Mejora
        await supabase
          .from('results')
          .update({ best_time_ms: row.lap_time_ms, playername: row.playername, updated_at: new Date().toISOString() })
          .eq('track_id', track_id).eq('laps', laps).eq('user_id', row.user_id);
        await sendTelegramMessage(`🔥 <b>Mejora de tiempo</b>\n${row.playername} • ${laps} lap(s)\nDe <code>${msToTime(existing.best_time_ms)}</code> a <code>${msToTime(row.lap_time_ms)}</code>`);
      }
    }

    res.json({ track_id, laps, results: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3) Admin: fijar tracks activos (protegido por cabecera X-Admin-Key)
app.post('/api/admin/set-tracks', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const { entries } = req.body; // [{title, scenery_id, track_id, laps, active}]
  if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: 'Payload inválido' });

  try {
    // Desactiva todos y re-activa lo enviado
    await supabase.from('tracks').update({ active: false });

    for (const e of entries) {
      const { data: exists } = await supabase
        .from('tracks')
        .select('id')
        .eq('track_id', e.track_id)
        .eq('laps', e.laps)
        .maybeSingle();

      if (exists) {
        await supabase
          .from('tracks')
          .update({ title: e.title, scenery_id: e.scenery_id, active: e.active, updated_at: new Date().toISOString() })
          .eq('id', exists.id);
      } else {
        await supabase.from('tracks').insert({
          title: e.title,
          scenery_id: e.scenery_id,
          track_id: e.track_id,
          laps: e.laps,
          active: !!e.active
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ============================
// Archivos estáticos (frontend)
// ============================
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

// fallback para rutas del frontend (si se navega directo)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
