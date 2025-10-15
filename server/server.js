import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const SIM_VERSION = process.env.SIM_VERSION || '1.16';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN || '';

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null;

const veloCache = new Map();
const raceModeFromLaps = laps => (Number(laps) === 3 ? 6 : 3);

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

function buildPostDataOfficial({ track_id, laps, offset=0, count=200 }) {
  return `track_id=${track_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&protected_track_value=1&race_mode=${raceModeFromLaps(laps)}`;
}
function buildPostDataUnofficial({ online_id, laps, offset=0, count=200 }) {
  return `online_id=${online_id}&sim_version=${SIM_VERSION}&offset=${offset}&count=${count}&race_mode=${raceModeFromLaps(laps)}`;
}
async function callVelocidrone(postData) {
  if (!VELO_API_TOKEN) {
    const e = new Error('Falta VELO_API_TOKEN'); e.status = 401; throw e;
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
  return { status: res.status, ok: res.ok, text };
}

async function resolveTrack(query) {
  const q_track_id = Number(query.track_id);
  const q_laps = Number(query.laps);
  const q_online_id = query.online_id ? String(query.online_id) : null;

  if (q_online_id && [1,3].includes(q_laps)) {
    return { is_official: false, online_id: q_online_id, laps: q_laps };
  }
  if (q_track_id && [1,3].includes(q_laps)) {
    return { is_official: true, track_id: q_track_id, laps: q_laps };
  }
  if (supabase) {
    const { data } = await supabase
      .from('tracks')
      .select('track_id, laps, is_official, online_id')
      .eq('active', true)
      .order('laps', { ascending: true })
      .limit(1);
    if (data && data.length) {
      const t = data[0];
      return {
        is_official: !!t.is_official,
        track_id: t.track_id ? Number(t.track_id) : null,
        online_id: t.online_id || null,
        laps: Number(t.laps)
      };
    }
  }
  return { is_official: true, track_id: null, online_id: null, laps: null };
}

// API
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    supabase: !!supabase,
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

app.post('/api/tracks/upsert', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase no configurado' });
    const { is_official=true, track_id=null, online_id=null, laps=1, active=true, name=null } = req.body || {};
    if (![1,3].includes(Number(laps))) return res.status(400).json({ error:'laps debe ser 1 o 3' });
    if (is_official && !track_id) return res.status(400).json({ error:'Falta track_id para oficial' });
    if (!is_official && !online_id) return res.status(400).json({ error:'Falta online_id para no oficial' });

    const payload = { is_official, laps:Number(laps), active: !!active };
    if (name) payload.name = String(name);
    if (is_official) { payload.track_id = Number(track_id); payload.online_id = null; }
    else { payload.track_id = null; payload.online_id = String(online_id); }

    const { data, error } = await supabase
      .from('tracks')
      .upsert(payload, { onConflict: is_official ? 'track_id' : 'online_id' })
      .select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok:true, track:data && data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const track = await resolveTrack(req.query);
    const { is_official, track_id, online_id, laps } = track;
    if (![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos. laps debe ser 1 o 3.' });

    let postData;
    if (is_official) {
      if (!track_id) return res.status(400).json({ error: 'Falta track_id para track oficial.' });
      postData = buildPostDataOfficial({ track_id, laps });
    } else {
      if (!online_id) return res.status(400).json({ error: 'Falta online_id para track no oficial.' });
      postData = buildPostDataUnofficial({ online_id, laps });
    }

    const key = `${is_official?'ofc':'unofc'}:${track_id||online_id}:${laps}`;
    const now = Date.now();
    let cached = veloCache.get(key);
    if (!cached || now - cached.time > CACHE_TTL_MS) {
      const out = await callVelocidrone(postData);
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      const json = JSON.parse(out.text);
      cached = { time: now, raw: Array.isArray(json.tracktimes) ? json.tracktimes : [] };
      veloCache.set(key, cached);
    }

    const raw = cached.raw;
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

    const bypass = (req.query.filter || '').toLowerCase() === 'all';
    let allowedUserIds = null;
    if (!bypass && supabase) {
      const { data: pilots } = await supabase
        .from('pilots')
        .select('user_id')
        .eq('active', true);
      if (pilots && pilots.length) allowedUserIds = new Set(pilots.map(p => Number(p.user_id)));
      else allowedUserIds = new Set();
    }

    const filtered = allowedUserIds ? mapped.filter(x => allowedUserIds.has(x.user_id)) : mapped;

    const bestMap = new Map();
    for (const r of filtered) {
      const prev = bestMap.get(r.user_id);
      if (!prev || (Number.isFinite(r.lap_time_ms) && r.lap_time_ms < prev.lap_time_ms)) bestMap.set(r.user_id, r);
    }
    const results = Array.from(bestMap.values()).sort((a,b)=>{
      const am = Number.isFinite(a.lap_time_ms) ? a.lap_time_ms : Number.MAX_SAFE_INTEGER;
      const bm = Number.isFinite(b.lap_time_ms) ? b.lap_time_ms : Number.MAX_SAFE_INTEGER;
      return am - bm;
    }).map((r,i)=>({ position:i+1, ...r }));

    res.json({
      is_official, track_id: track_id ?? null, online_id: online_id ?? null, laps,
      meta: { raw_count: raw.length, filtered_count: filtered.length, returned_count: results.length, bypass_filter: bypass },
      results
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use('/api', (req,res)=>res.status(404).json({ error:'API route not found' }));

// STATIC (prioriza ./public)
const candidates = [
  path.resolve(__dirname, './public'),
  path.resolve(__dirname, '../frontend'),
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '.')
];

let STATIC_ROOT = null;
for (const dir of candidates) {
  try {
    const idx = path.join(dir, 'index.html');
    if (fs.existsSync(dir) && fs.existsSync(idx)) {
      STATIC_ROOT = dir;
      console.log('[STATIC] Encontrado index.html en:', idx);
      break;
    } else {
      console.log('[STATIC] No index en:', idx);
    }
  } catch (e) {
    console.log('[STATIC] Error comprobando', dir, e?.message);
  }
}

if (!STATIC_ROOT) {
  console.error('[FATAL] No se encontró ningún index.html en rutas:', candidates);
  app.get('*', (req, res) => res.status(500).send('Static index.html not found. Checked: ' + candidates.join(' | ')));
} else {
  app.use(express.static(STATIC_ROOT));
  app.get('/admin', (req, res) => res.sendFile(path.join(STATIC_ROOT, 'admin.html')));
  app.get('*', (req, res) => res.sendFile(path.join(STATIC_ROOT, 'index.html')));
}

app.listen(PORT, () => console.log('✅ Server running on :' + PORT));
