/**
 * PATCH: coerción numérica de user_id para evitar mismatch (string vs number)
 * Aplica en /api/debug/leaderboard y /api/leaderboard
 */
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

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VELO_API_URL = process.env.VELO_API_URL || 'https://velocidrone.co.uk/api/leaderboard';
const VELO_API_TOKEN = process.env.VELO_API_TOKEN;
const SIM_VERSION = process.env.SIM_VERSION || '1.16';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

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

function parseTimeToMsFlexible(r) {
  const val = r.lap_time ?? r.best_time ?? r.time ?? r.laptime ?? r.best_lap ?? r.bestlap ?? null;
  if (val == null) return null;
  const s = String(val).trim();
  const parts = s.split(':');
  let h=0,m=0,sec=0,ms=0;
  try {
    if (parts.length === 3) { h=+parts[0]; m=+parts[1]; const [ss,mmm]=(parts[2]||'').split('.'); sec=+ss; ms=+(mmm||0); }
    else if (parts.length === 2) { m=+parts[0]; const [ss,mmm]=(parts[1]||'').split('.'); sec=+ss; ms=+(mmm||0); }
    else if (parts.length === 1) { const [ss,mmm]=(parts[0]||'').split('.'); sec=+ss; ms=+(mmm||0); }
    else return null;
    if ([h,m,sec].some(n => Number.isNaN(n))) return null;
    return (((h*60+m)*60)+sec)*1000 + (Number.isNaN(ms)?0:ms);
  } catch { return null; }
}
const normalizeTimeString = r => r.lap_time ?? r.best_time ?? r.time ?? r.laptime ?? r.best_lap ?? r.bestlap ?? '';

app.get('/api/debug/leaderboard', async (req, res) => {
  try {
    const track_id = +req.query.track_id;
    const laps = +req.query.laps;
    const useCache = req.query.use_cache !== '0';
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const { data: pilots } = await supabase.from('pilots').select('user_id, name, country, active');
    const activePilots = (pilots||[]).filter(p => p.active);
    const pilotIds = new Set(activePilots.map(p => Number(p.user_id)).filter(n => Number.isFinite(n)));

    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    const cached = veloCache.get(key);
    let raw;
    if (useCache && cached && (now - cached.time) < CACHE_TTL_MS) raw = cached.raw;
    else {
      const out = await callVelocidrone(buildPostData({ track_id, race_mode }));
      if (!out.ok) return res.status(out.status).json({ error: out.text });
      const json = JSON.parse(out.text);
      raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
      veloCache.set(key, { time: now, raw });
    }

    const veloUserIds = Array.from(new Set(raw.map(r => Number(r.user_id)).filter(n => Number.isFinite(n))));
    const overlap = veloUserIds.filter(id => pilotIds.has(id));

    res.json({
      track_id, laps, race_mode,
      velo_count: raw.length,
      velo_unique_users: veloUserIds.length,
      pilots_active: activePilots.length,
      overlap_count: overlap.length,
      overlap_user_ids: overlap.slice(0, 100)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = +req.query.track_id;
    const laps = +req.query.laps;
    const includeUnparsed = req.query.include_unparsed === '1';
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const { data: pilots, error: pilotErr } = await supabase
      .from('pilots').select('user_id, name, country').eq('active', true);
    if (pilotErr) return res.status(500).json({ error: pilotErr.message });
    const pilotSet = new Set((pilots || []).map(p => Number(p.user_id)).filter(n => Number.isFinite(n)));

    const key = cacheKey(track_id, race_mode);
    const now = Date.now();
    const cached = veloCache.get(key);
    let raw;
    if (cached && (now - cached.time) < CACHE_TTL_MS) {
      raw = cached.raw;
    } else {
      const out = await callVelocidrone(buildPostData({ track_id, race_mode }));
      if (!out.ok) return res.status(out.status === 429 ? 503 : out.status).json({ error: out.text });
      const json = JSON.parse(out.text);
      raw = Array.isArray(json.tracktimes) ? json.tracktimes : [];
      veloCache.set(key, { time: now, raw });
    }

    const filtered = raw.filter(r => pilotSet.has(Number(r.user_id)));

    let mapped = filtered.map(r => {
      const tms = parseTimeToMsFlexible(r);
      return {
        user_id: Number(r.user_id),
        playername: r.playername ?? r.name ?? r.username ?? '',
        country: r.country ?? r.flag ?? '',
        model_name: r.model_name ?? r.model ?? '',
        sim_version: r.sim_version ?? r.simversion ?? '',
        device_type: r.device_type ?? r.device ?? '',
        lap_time: normalizeTimeString(r),
        lap_time_ms: tms
      };
    });

    const hasParsed = mapped.some(m => Number.isFinite(m.lap_time_ms));
    if (!hasParsed && !includeUnparsed) mapped = mapped.slice(0, 50);

    mapped.sort((a,b) => {
      const am = Number.isFinite(a.lap_time_ms) ? a.lap_time_ms : Number.MAX_SAFE_INTEGER;
      const bm = Number.isFinite(b.lap_time_ms) ? b.lap_time_ms : Number.MAX_SAFE_INTEGER;
      return am - bm;
    });

    const results = mapped.map((r,i) => ({ position: i+1, ...r }));
    res.json({ track_id, laps, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Nota: no incluimos el resto de rutas para mantener el parche pequeño.
