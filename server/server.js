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
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

// ============================
// Supabase
// ============================
let supabase = null;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn('[WARN] SUPABASE_URL or SUPABASE_SERVICE_ROLE not set; /api/tracks/active may return empty.');
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

// ============================
// Cache & helpers
// ============================
const veloCache = new Map();
const cacheKey = (track_id, race_mode) => `${track_id}_${race_mode}`;

function buildPostData({ track_id, race_mode, offset=0, count=200, protected_track_value=1 }) {
  return `track_id=${track_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&protected_track_value=${protected_track_value}&race_mode=${race_mode}`;
}

async function callVelocidrone(postData) {
  if (!VELO_API_TOKEN) { const e = new Error('Falta VELO_API_TOKEN'); e.status = 401; throw e; }
  const res = await fetch(VELO_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VELO_API_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ post_data: postData })
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function parseTimeToMsFlexible(s) {
  if (!s) return null;
  const str = String(s).trim();
  const parts = str.split(':');
  let h=0,m=0,sec=0,ms=0;
  try {
    if (parts.length === 3) {
      h = +parts[0]; m = +parts[1];
      const [ss,mmm] = (parts[2]||'').split('.'); sec = +ss; ms = +(mmm||0);
    } else if (parts.length === 2) {
      m = +parts[0];
      const [ss,mmm] = (parts[1]||'').split('.'); sec = +ss; ms = +(mmm||0);
    } else {
      const [ss,mmm] = str.split('.'); sec = +ss; ms = +(mmm||0);
    }
    if ([h,m,sec].some(n => Number.isNaN(n))) return null;
    return (((h*60+m)*60)+sec)*1000 + (Number.isNaN(ms)?0:ms);
  } catch { return null; }
}

// ============================
// Health
// ============================
app.get('/api/health', (req, res) => res.json({
  ok: true,
  env: {
    supabase_url_present: !!SUPABASE_URL,
    service_role_present: !!SUPABASE_SERVICE_ROLE,
    velo_token_present: !!VELO_API_TOKEN
  }
}));

// ============================
// RAW Velocidrone (con caché)
// ============================
app.get('/api/velo/raw', async (req, res) => {
  try {
    const track_id = +req.query.track_id;
    const laps = +req.query.laps;
    const useCache = req.query.use_cache !== '0';
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    const cached = veloCache.get(key);

    if (useCache && cached && (now - cached.time) < CACHE_TTL_MS) {
      return res.json({ from_cache: true, count: cached.raw.length, sample: cached.raw.slice(0, 20) });
    }

    const out = await callVelocidrone(buildPostData({ track_id, race_mode }));
    if (!out.ok) return res.status(out.status).json({ error: out.text });
    const json = JSON.parse(out.text);
    const raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
    veloCache.set(key, { time: now, raw });
    res.json({ from_cache: false, count: raw.length, sample: raw.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================
// Leaderboard sin filtros (dedup por usuario, por defecto)
// ============================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = +req.query.track_id;
    const laps = +req.query.laps;
    const includeUnparsed = req.query.include_unparsed === '1';
    const uniqueByUser = req.query.unique_by_user !== '0'; // default ON
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    let raw = veloCache.get(key)?.raw;
    if (!raw || (now - (veloCache.get(key)?.time || 0)) >= CACHE_TTL_MS) {
      const out = await callVelocidrone(buildPostData({ track_id, race_mode }));
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      const json = JSON.parse(out.text);
      raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
      veloCache.set(key, { time: now, raw });
    }

    const mapped = raw.map(r => {
      const lap = r.lap_time ?? r.best_time ?? r.time ?? r.laptime ?? r.best_lap ?? r.bestlap ?? '';
      const tms = parseTimeToMsFlexible(lap);
      return {
        user_id: Number(r.user_id),
        playername: r.playername ?? r.name ?? r.username ?? '',
        country: r.country ?? r.flag ?? '',
        model_name: r.model_name ?? r.model ?? '',
        sim_version: r.sim_version ?? r.simversion ?? '',
        device_type: r.device_type ?? r.device ?? '',
        lap_time: lap,
        lap_time_ms: tms
      };
    });

    let bestPerUser = mapped;
    if (uniqueByUser) {
      const bestMap = new Map();
      for (const r of mapped) {
        const k = r.user_id;
        const prev = bestMap.get(k);
        if (!prev || (Number.isFinite(r.lap_time_ms) && r.lap_time_ms < prev.lap_time_ms)) {
          bestMap.set(k, r);
        }
      }
      bestPerUser = Array.from(bestMap.values());
    }

    const hasParsed = bestPerUser.some(m => Number.isFinite(m.lap_time_ms));
    const list = hasParsed || includeUnparsed ? bestPerUser : bestPerUser.slice(0, 50);

    list.sort((a,b) => {
      const am = Number.isFinite(a.lap_time_ms) ? a.lap_time_ms : Number.MAX_SAFE_INTEGER;
      const bm = Number.isFinite(b.lap_time_ms) ? b.lap_time_ms : Number.MAX_SAFE_INTEGER;
      return am - bm;
    });

    const results = list.map((r,i) => ({ position: i+1, ...r }));
    const meta = {
      raw_count: raw.length,
      unique_users: new Set(mapped.map(x => x.user_id)).size,
      returned_count: results.length,
      unique_by_user: !!uniqueByUser
    };
    res.json({ track_id, laps, meta, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================
// Tracks activos (Supabase) — necesario para las pestañas del frontend
// ============================
app.get('/api/tracks/active', async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ tracks: [], warning: 'Supabase no configurado en el servidor' });
    }
    const { data, error } = await supabase
      .from('tracks')
      .select('*')
      .eq('active', true)
      .order('laps', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tracks: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// Static frontend
// ============================
const publicDir = path.resolve(__dirname, '../frontend');
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Start
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
