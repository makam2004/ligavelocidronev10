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
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000); // 10 min por defecto

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
/** Cache simple en memoria: key => { time, raw } */
const veloCache = new Map();
function cacheKey(track_id, race_mode) {
  return `${track_id}_${race_mode}`;
}

async function fetchVeloRaw({ track_id, race_mode, useCache = true, offset=0, count=200, protected_track_value=1 }) {
  const key = cacheKey(track_id, race_mode);
  const now = Date.now();
  const cached = veloCache.get(key);
  if (useCache && cached && (now - cached.time) < CACHE_TTL_MS) {
    return { raw: cached.raw, from_cache: true };
  }

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
    const err = new Error(`Velocidrone ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  let json;
  try { json = JSON.parse(text); } catch (e) {
    const err = new Error(`Respuesta no JSON de Velocidrone: ${text.slice(0,200)}...`);
    err.status = 502;
    throw err;
  }
  const raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];

  // guarda en caché
  veloCache.set(key, { time: now, raw });
  return { raw, from_cache: false };
}

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

// ============================
// Health & Debug
// ============================
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/debug', async (req, res) => {
  const mask = v => (v ? v.slice(0, 6) + '…' : null);
  try {
    const { data: tracks, error: e1 } = await supabase.from('tracks').select('id, title, track_id, laps, active').order('laps');
    const { data: pilots, error: e2 } = await supabase.from('pilots').select('user_id, name, country, active').order('user_id');
    res.json({
      env: {
        SUPABASE_URL_present: !!SUPABASE_URL,
        SERVICE_ROLE_present: !!SUPABASE_SERVICE_ROLE,
        VELO_API_URL,
        VELO_API_TOKEN_present: !!VELO_API_TOKEN,
        SIM_VERSION,
        CACHE_TTL_MS
      },
      counts: { tracks: tracks?.length || 0, pilots: pilots?.length || 0 },
      samples: { tracks: (tracks||[]).slice(0,5), pilots: (pilots||[]).slice(0,10) },
      service_role_preview: mask(process.env.SUPABASE_SERVICE_ROLE),
      errors: { e1, e2 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: vista de usuarios Velocidrone + solape con pilots
app.get('/api/debug/leaderboard', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
    const useCache = req.query.use_cache !== '0'; // por defecto usa caché
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const { data: pilots, error: pilotErr } = await supabase
      .from('pilots').select('user_id, name, country, active');
    if (pilotErr) return res.status(500).json({ error: pilotErr.message });

    const activePilots = (pilots || []).filter(p => p.active);
    const pilotIds = new Set(activePilots.map(p => p.user_id));

    let raw, from_cache;
    try {
      ({ raw, from_cache } = await fetchVeloRaw({ track_id, race_mode, useCache }));
    } catch (e) {
      // Si rate-limit (429) y hay caché previa, devuélvela
      const key = `${track_id}_${race_mode}`;
      const cached = veloCache.get(key);
      if (e.status === 429 && cached) {
        raw = cached.raw;
        from_cache = true;
      } else {
        throw e;
      }
    }

    const veloUserIds = Array.from(new Set(raw.map(r => r.user_id)));
    const overlap = veloUserIds.filter(id => pilotIds.has(id));

    res.json({
      track_id, laps, race_mode,
      velo_count: raw.length,
      velo_unique_users: veloUserIds.length,
      pilots_active: activePilots.length,
      overlap_count: overlap.length,
      overlap_user_ids: overlap.slice(0, 100),
      from_cache
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message, status });
  }
});

// ============================
// API pública (con caché y manejo de 429)
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

    let raw, from_cache;
    try {
      ({ raw, from_cache } = await fetchVeloRaw({ track_id, race_mode, useCache: true }));
    } catch (e) {
      // Rate limited: si hay caché, devolvemos caché; si no, 503 para el frontend
      const key = cacheKey(track_id, race_mode);
      const cached = veloCache.get(key);
      if (e.status === 429 && cached) {
        raw = cached.raw;
        from_cache = true;
      } else {
        return res.status(503).json({ error: 'Velocidrone está limitando peticiones, intenta de nuevo más tarde.' });
      }
    }

    const base = pilotSet.size === 0 ? raw : raw.filter(r => pilotSet.has(r.user_id));

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

    res.json({ track_id, laps, from_cache: !!from_cache, results });
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
