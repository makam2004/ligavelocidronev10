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

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Probe: muestra exactamente lo que enviamos y lo que recibimos de Velocidrone
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
      sent: {
        url: VELO_API_URL,
        headers: { Authorization: VELO_API_TOKEN ? 'Bearer ***' : 'MISSING', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: { post_data: postData }
      },
      received: {
        status: out.status,
        ok: out.ok,
        headers: out.headers,
        text_snippet: out.text.slice(0, 500),
        json_keys: json ? Object.keys(json) : null,
        tracktimes_len: (json && Array.isArray(json.tracktimes)) ? json.tracktimes.length : null
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Raw Velocidrone (con caché)
app.get('/api/velo/raw', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
    const useCache = req.query.use_cache !== '0';
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;
    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    const cached = veloCache.get(key);
    if (useCache && cached && (now - cached.time) < CACHE_TTL_MS) {
      return res.json({ from_cache: true, count: cached.raw.length, sample: cached.raw.slice(0, 20) });
    }
    const postData = buildPostData({ track_id, race_mode });
    const out = await callVelocidrone(postData);
    if (!out.ok) return res.status(out.status).json({ error: out.text });
    let json;
    try { json = JSON.parse(out.text); } catch { return res.status(502).json({ error: 'Respuesta no JSON', snippet: out.text.slice(0,300) }); }
    const raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
    veloCache.set(key, { time: now, raw });
    res.json({ from_cache: false, count: raw.length, sample: raw.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leaderboard (sin filtros, con caché)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
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

    const results = raw
      .map(r => ({
        user_id: r.user_id,
        playername: r.playername,
        country: r.country,
        model_name: r.model_name,
        sim_version: r.sim_version,
        device_type: r.device_type,
        lap_time: r.lap_time,
        lap_time_ms: (function(t){
          if (!t) return null;
          const parts = t.split(':');
          let h=0,m=0,s=0,ms=0;
          if (parts.length===3){h=parseInt(parts[0]);m=parseInt(parts[1]);const [ss,mmm]=parts[2].split('.');s=parseInt(ss);ms=parseInt(mmm||'0');}
          else if(parts.length===2){m=parseInt(parts[0]);const [ss,mmm]=parts[1].split('.');s=parseInt(ss);ms=parseInt(mmm||'0');}
          else return null;
          return (((h*60+m)*60)+s)*1000+ms;
        })(r.lap_time)
      }))
      .filter(r => Number.isFinite(r.lap_time_ms))
      .sort((a,b) => a.lap_time_ms - b.lap_time_ms)
      .map((r, i) => ({ position: i + 1, ...r }));

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
