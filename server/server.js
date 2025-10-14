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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN;
const SIM_VERSION = process.env.SIM_VERSION || '1.16';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
// Utils
// ============================
function parseTimeToMs(t) {
  if (!t) return null;
  const parts = t.split(':');
  let h = 0, m = 0, s = 0, ms = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    const [sec, milli] = parts[2].split('.');
    s = parseInt(sec, 10); ms = parseInt(milli || '0', 10);
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10);
    const [sec, milli] = parts[1].split('.');
    s = parseInt(sec, 10); ms = parseInt(milli || '0', 10);
  } else return null;
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

async function fetchLeaderboardFromVelo({ track_id, race_mode, offset=0, count=200, protected_track_value=1 }) {
  if (!VELO_API_TOKEN) throw new Error('Falta VELO_API_TOKEN en variables de entorno.');
  const postData = `track_id=${track_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&protected_track_value=${protected_track_value}&race_mode=${race_mode}`;

  const res = await fetch(VELO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VELO_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ post_data: postData })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Velocidrone ${res.status}: ${text}`);
  }
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(`Respuesta no JSON de Velocidrone: ${text.slice(0,200)}...`);
  }
  return Array.isArray(json.tracktimes) ? json.tracktimes : [];
}

// ============================
// Health & Debug
// ============================
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/debug', async (req, res) => {
  const mask = v => (v ? v.slice(0, 6) + '…' : null);
  try {
    const { data: tracks, error: e1 } = await supabase.from('tracks').select('id, track_id, laps, active').limit(5);
    res.json({
      env: {
        SUPABASE_URL_present: !!SUPABASE_URL,
        SERVICE_ROLE_present: !!SUPABASE_SERVICE_ROLE,
        VELO_API_URL,
        VELO_API_TOKEN_present: !!VELO_API_TOKEN,
        SIM_VERSION
      },
      tracks, errors: { e1 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw Velocidrone (sin filtrar) – diagnóstico
app.get('/api/velo/raw', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;
    const raw = await fetchLeaderboardFromVelo({ track_id, race_mode });
    res.json({ count: raw.length, sample: raw.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// API pública
// ============================
app.get('/api/tracks/active', async (req, res) => {
  const { data, error } = await supabase
    .from('tracks').select('*').eq('active', true).order('laps', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tracks: data || [] });
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const { data: pilots, error: pilotErr } = await supabase
      .from('pilots').select('user_id, name, country').eq('active', true);
    if (pilotErr) return res.status(500).json({ error: pilotErr.message });

    const pilotSet = new Set((pilots || []).map(p => p.user_id));
    const raw = await fetchLeaderboardFromVelo({ track_id, race_mode });

    // Si no hay pilotos dados de alta, devolvemos sin filtrar para comprobar que lee datos
    const base = (pilotSet.size === 0) ? raw : raw.filter(r => pilotSet.has(r.user_id));

    const results = base
      .map(r => ({
        user_id: r.user_id,
        playername: r.playername,
        country: r.country,
        model_name: r.model_name,
        sim_version: r.sim_version,
        device_type: r.device_type,
        lap_time: r.lap_time,
        lap_time_ms: parseTimeToMs(r.lap_time)
      }))
      .filter(r => Number.isFinite(r.lap_time_ms))
      .sort((a,b) => a.lap_time_ms - b.lap_time_ms)
      .map((r, i) => ({ position: i + 1, ...r }));

    res.json({ track_id, laps, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// Static frontend
// ============================
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
