import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const SIM_VERSION = process.env.SIM_VERSION || '1.16';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN || '';

// Initialize Supabase (optional but needed for filtering)
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null;

// ============================
// Helpers
// ============================
const veloCache = new Map();
const cacheKey = (track_id, race_mode) => `${track_id}_${race_mode}`;

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

function buildPostData({ track_id, race_mode, offset=0, count=200, protected_track_value=1 }) {
  return `track_id=${track_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&protected_track_value=${protected_track_value}&race_mode=${race_mode}`;
}

async function callVelocidrone(postData) {
  if (!VELO_API_TOKEN) {
    const e = new Error('Falta VELO_API_TOKEN');
    e.status = 401;
    throw e;
  }
  // Node 18+ has global fetch
  const res = await fetch(VELO_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VELO_API_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ post_data: postData })
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

// Resolve track & laps from query or from first active track in DB
async function resolveTrackAndLaps(query) {
  let track_id = Number(query.track_id);
  let laps = Number(query.laps);
  if (!track_id || ![1,3].includes(laps)) {
    if (supabase) {
      const { data, error } = await supabase
        .from('tracks')
        .select('track_id,laps')
        .eq('active', true)
        .order('laps', { ascending: true })
        .limit(1);
      if (!error && data && data.length) {
        track_id = Number(data[0].track_id);
        laps = Number(data[0].laps);
      }
    }
  }
  return { track_id, laps };
}

// ============================
// API routes FIRST
// ============================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, supabase: !!supabase,
    env: {
      supabase_url: !!SUPABASE_URL,
      supabase_key: !!SUPABASE_SERVICE_ROLE,
      velo_token: !!VELO_API_TOKEN
    }
  });
});

app.get('/api/tracks/active', async (req, res) => {
  try {
    if (!supabase) return res.json({ tracks: [], warning: 'Supabase no configurado' });
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

// NEW: Real leaderboard with Supabase filtering
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { track_id, laps } = await resolveTrackAndLaps(req.query);
    if (!track_id || ![1,3].includes(laps)) {
      return res.status(400).json({ error: 'Parámetros inválidos: indica track_id y laps=1|3 o configura al menos un track activo.' });
    }
    const race_mode = laps === 3 ? 6 : 3;

    // get raw from cache or Velo API
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

    // map raw
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

    // Supabase filter: only pilots registered (active)
    let allowedUserIds = null;
    if (supabase) {
      const { data: pilots, error: pErr } = await supabase
        .from('pilots')
        .select('user_id')
        .eq('active', true);
      if (pErr) console.error('[Supabase pilots error]', pErr.message);
      if (pilots && pilots.length) {
        allowedUserIds = new Set(pilots.map(p => Number(p.user_id)));
      } else {
        // If no pilots, return empty result to match "solo dados de alta"
        allowedUserIds = new Set();
      }
    }

    const filtered = allowedUserIds
      ? mapped.filter(x => allowedUserIds.has(x.user_id))
      : mapped; // if no supabase configured, return all

    // dedupe: best lap per user
    const bestMap = new Map();
    for (const r of filtered) {
      const k = r.user_id;
      const prev = bestMap.get(k);
      if (!prev || (Number.isFinite(r.lap_time_ms) && r.lap_time_ms < prev.lap_time_ms)) bestMap.set(k, r);
    }
    const bestPerUser = Array.from(bestMap.values());

    // sort
    bestPerUser.sort((a,b) => {
      const am = Number.isFinite(a.lap_time_ms) ? a.lap_time_ms : Number.MAX_SAFE_INTEGER;
      const bm = Number.isFinite(b.lap_time_ms) ? b.lap_time_ms : Number.MAX_SAFE_INTEGER;
      return am - bm;
    });
    const results = bestPerUser.map((r,i) => ({ position: i+1, ...r }));

    const meta = {
      track_id, laps,
      raw_count: raw.length,
      mapped_count: mapped.length,
      filtered_count: filtered.length,
      returned_count: results.length,
      only_registered: !!allowedUserIds
    };

    res.json({ track_id, laps, meta, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// fallback handler for /api (unknown routes)
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// ============================
// STATIC detection (after API)
// ============================
const candidates = [
  path.resolve(__dirname, '../frontend'),
  path.resolve(__dirname, '../public'),
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '.')
];

let STATIC_ROOT = null;
for (const dir of candidates) {
  try {
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))) {
      STATIC_ROOT = dir;
      break;
    }
  } catch {}
}

if (!STATIC_ROOT) {
  console.error('[FATAL] No se encontró ningún index.html. Probé:', candidates);
  app.get('*', (req, res) => res.status(500).send('Static index.html not found. Checked: ' + candidates.join(' | ')));
} else {
  console.log('[STATIC] Sirviendo estáticos desde:', STATIC_ROOT);
  app.use(express.static(STATIC_ROOT));
  app.get('*', (req, res) => res.sendFile(path.join(STATIC_ROOT, 'index.html')));
}

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
