import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
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
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN;
const SIM_VERSION = process.env.SIM_VERSION || '1.16';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

// Cache simple
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

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Probe crudo
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

// Leaderboard: FORZAR mostrar TODO (sin filtro por pilotos, sin descartar por parseo)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = +req.query.track_id;
    const laps = +req.query.laps;
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    let raw = veloCache.get(key)?.raw;
    if (!raw || (now - veloCache.get(key).time) >= CACHE_TTL_MS) {
      const out = await callVelocidrone(buildPostData({ track_id, race_mode }));
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      const json = JSON.parse(out.text);
      raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
      veloCache.set(key, { time: now, raw });
    }

    // Mapear SIN filtrar nada. Si no se puede parsear, igual se devuelve.
    const normalized = raw.map(r => {
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

    // ordenar: los que no tengan ms van al final, pero todos se devuelven
    normalized.sort((a,b) => {
      const am = Number.isFinite(a.lap_time_ms) ? a.lap_time_ms : Number.MAX_SAFE_INTEGER;
      const bm = Number.isFinite(b.lap_time_ms) ? b.lap_time_ms : Number.MAX_SAFE_INTEGER;
      return am - bm;
    });

    const results = normalized.map((r,i) => ({ position: i+1, ...r }));
    res.json({ track_id, laps, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Static fallback (por si sirve el mismo server para servir frontend)
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
