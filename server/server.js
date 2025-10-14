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

// ENV
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN;
const SIM_VERSION = process.env.SIM_VERSION || '1.16';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Cache
const veloCache = new Map();
const cacheKey = (track_id, race_mode) => `${track_id}_${race_mode}`;

function buildPostData({ track_id, race_mode, offset=0, count=200, protected_track_value=1 }) {
  return `track_id=${track_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&protected_track_value=${protected_track_value}&race_mode=${race_mode}`;
}

async function callVelocidrone(postData) {
  if (!VELO_API_TOKEN) {
    const e = new Error('Falta VELO_API_TOKEN');
    e.status = 401;
    throw e;
  }
  const res = await fetch(VELO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VELO_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ post_data: postData })
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text, headers: Object.fromEntries(res.headers.entries()) };
}

// ----- robust time parsing -----
function parseTimeToMsFlexible(r) {
  // try multiple field names commonly seen
  const val = r.lap_time ?? r.best_time ?? r.time ?? r.laptime ?? r.best_lap ?? r.bestlap ?? null;
  if (val == null) return null;
  const s = String(val).trim();
  // formats: hh:mm:ss.mmm, mm:ss.mmm, ss.mmm, m:ss, etc.
  const parts = s.split(':');
  let h=0,m=0,sec=0,ms=0;
  try {
    if (parts.length === 3) {
      h = parseInt(parts[0],10);
      m = parseInt(parts[1],10);
      const [ss,mmm] = parts[2].split('.');
      sec = parseInt(ss,10);
      ms = parseInt(mmm||'0',10);
    } else if (parts.length === 2) {
      m = parseInt(parts[0],10);
      const [ss,mmm] = parts[1].split('.');
      sec = parseInt(ss,10);
      ms = parseInt(mmm||'0',10);
    } else if (parts.length === 1) {
      const [ss,mmm] = parts[0].split('.');
      sec = parseInt(ss,10);
      ms = parseInt(mmm||'0',10);
    } else {
      return null;
    }
    if ([h,m,sec].some(n => Number.isNaN(n))) return null;
    const total = (((h*60+m)*60)+sec)*1000 + (Number.isNaN(ms)?0:ms);
    return total;
  } catch {
    return null;
  }
}

function normalizeTimeString(r) {
  // returns the string value to display
  return r.lap_time ?? r.best_time ?? r.time ?? r.laptime ?? r.best_lap ?? r.bestlap ?? '';
}

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Probe (igual que antes)
app.get('/api/probe', async (req, res) => {
  const track_id = parseInt(req.query.track_id, 10);
  const laps = parseInt(req.query.laps, 10);
  if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
  const race_mode = laps === 3 ? 6 : 3;
  const postData = buildPostData({ track_id, race_mode });

  try {
    const out = await callVelocidrone(postData);
    let json = null;
    try { json = JSON.parse(out.text); } catch {}
    res.json({
      sent: { url: VELO_API_URL, body: { post_data: postData } },
      received: {
        status: out.status,
        ok: out.ok,
        json_keys: json ? Object.keys(json) : null,
        // muestra claves del primer registro para ver nombres de campos reales
        first_item_keys: (json && Array.isArray(json.tracktimes) && json.tracktimes[0]) ? Object.keys(json.tracktimes[0]) : null,
        tracktimes_len: (json && Array.isArray(json.tracktimes)) ? json.tracktimes.length : null
      }
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Leaderboard (sin filtros por pilotos) — más tolerante
app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
    const includeUnparsed = req.query.include_unparsed === '1';
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    const cached = veloCache.get(key);
    let raw;
    if (cached && (now - cached.time) < CACHE_TTL_MS) {
      raw = cached.raw;
    } else {
      const postData = buildPostData({ track_id, race_mode });
      const out = await callVelocidrone(postData);
      if (!out.ok) return res.status(out.status === 429 ? 503 : out.status).json({ error: out.text });
      let json;
      try { json = JSON.parse(out.text); } catch { return res.status(502).json({ error: 'Respuesta no JSON' }); }
      raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
      veloCache.set(key, { time: now, raw });
    }

    // map results with robust field picking
    let mapped = raw.map(r => {
      const tms = parseTimeToMsFlexible(r);
      return {
        user_id: r.user_id ?? r.userid ?? r.userId ?? null,
        playername: r.playername ?? r.name ?? r.username ?? '',
        country: r.country ?? r.flag ?? '',
        model_name: r.model_name ?? r.model ?? '',
        sim_version: r.sim_version ?? r.simversion ?? '',
        device_type: r.device_type ?? r.device ?? '',
        lap_time: normalizeTimeString(r),
        lap_time_ms: tms
      };
    });

    // If parser failed for all, still return unparsed when requested
    const hasParsed = mapped.some(m => Number.isFinite(m.lap_time_ms));
    if (!hasParsed && !includeUnparsed) {
      // Try not to drop everything: include top 50 with unparsed times
      mapped = mapped.slice(0, 50);
    }

    // Sort with fallback: entries without ms go to the end
    mapped.sort((a,b) => {
      const am = Number.isFinite(a.lap_time_ms) ? a.lap_time_ms : Number.MAX_SAFE_INTEGER;
      const bm = Number.isFinite(b.lap_time_ms) ? b.lap_time_ms : Number.MAX_SAFE_INTEGER;
      return am - bm;
    });

    const results = mapped.map((r,i) => ({ position: i+1, ...r }));
    res.json({ track_id, laps, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tracks activos
app.get('/api/tracks/active', async (req, res) => {
  const { data, error } = await supabase.from('tracks').select('*').eq('active', true).order('laps', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tracks: data || [] });
});

// Static
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
