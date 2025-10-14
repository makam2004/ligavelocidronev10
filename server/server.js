import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Debug
app.get('/api/debug', async (req, res) => {
  const mask = v => (v ? v.slice(0, 6) + '…' : null);
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL || null,
    SUPABASE_SERVICE_ROLE_present: !!process.env.SUPABASE_SERVICE_ROLE,
  };
  try {
    const { data: tracks, error: e1 } = await supabase.from('tracks').select('id, track_id, laps, active').limit(5);
    const { data: pilots, error: e2 } = await supabase.from('pilots').select('user_id').limit(2);
    const { data: results, error: e3 } = await supabase.from('results').select('track_id, user_id').limit(2);

    res.json({
      env: { ...env, SUPABASE_SERVICE_ROLE_masked: mask(process.env.SUPABASE_SERVICE_ROLE) },
      tables_ok: !e1 && !e2 && !e3,
      samples: { tracks, pilots, results },
      errors: { e1, e2, e3 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, env });
  }
});

// Tracks active
app.get('/api/tracks/active', async (req, res) => {
  console.log('[GET] /api/tracks/active');
  const { data, error } = await supabase
    .from('tracks')
    .select('*')
    .eq('active', true)
    .order('laps', { ascending: true });
  if (error) {
    console.error('[tracks.active] error', error);
    return res.status(500).json({ error: error.message });
  }
  console.log('[tracks.active] ->', data?.length || 0, 'rows');
  res.json({ tracks: data || [] });
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const track_id = parseInt(req.query.track_id, 10);
    const laps = parseInt(req.query.laps, 10);
    if (!track_id || ![1,3].includes(laps)) return res.status(400).json({ error: 'Parámetros inválidos' });
    const race_mode = laps === 3 ? 6 : 3;

    const { data: pilots, error: pilotErr } = await supabase
      .from('pilots').select('user_id, name, country').eq('active', true);
    if (pilotErr) {
      console.error('[pilots.select] error', pilotErr);
      return res.status(500).json({ error: pilotErr.message });
    }
    const pilotSet = new Set((pilots || []).map(p => p.user_id));

    // NOTE: simulate empty leaderboard if external API disabled in this patch.
    // In tu proyecto original aquí llamas a Velocidrone.
    const raw = []; // reemplazar por fetch real en tu server.js original

    const filtered = raw
      .filter(r => pilotSet.has(r.user_id))
      .map((r, i) => ({ position: i + 1, ...r }));

    res.json({ track_id, laps, results: filtered });
  } catch (err) {
    console.error('[GET] /api/leaderboard error', err);
    res.status(500).json({ error: err.message });
  }
});

// Static
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
