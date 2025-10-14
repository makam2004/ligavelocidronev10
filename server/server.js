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

// ============================
// Endpoint DEBUG
// ============================
app.get('/api/debug', async (req, res) => {
  const mask = v => (v ? v.slice(0, 6) + '…' : null);
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL || null,
    SUPABASE_SERVICE_ROLE_present: !!process.env.SUPABASE_SERVICE_ROLE,
  };
  try {
    const { data: tracks, error: e1 } = await supabase.from('tracks').select('id, track_id, laps, active').limit(2);
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

// ============================
// Admin endpoint fixed (WITH WHERE CLAUSE)
// ============================
app.post('/api/admin/set-tracks', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  try {
    // IMPORTANT: add WHERE to satisfy PostgREST constraint
    const { error: updAllErr } = await supabase
      .from('tracks')
      .update({ active: false })
      .eq('active', true); // <= WHERE clause

    if (updAllErr) {
      console.error('[tracks.update all]', updAllErr);
      return res.status(500).json({ error: updAllErr.message });
    }

    const results = [];

    for (const e of entries) {
      if (!e.track_id || !e.laps || ![1,3].includes(e.laps) || !e.scenery_id) {
        return res.status(400).json({ error: `Entrada inválida: ${JSON.stringify(e)}` });
      }

      const { data: exists, error: selErr } = await supabase
        .from('tracks')
        .select('id')
        .eq('track_id', e.track_id)
        .eq('laps', e.laps)
        .maybeSingle();

      if (selErr) {
        console.error('[tracks.select one]', selErr);
        return res.status(500).json({ error: selErr.message });
      }

      if (exists) {
        const { error: updErr } = await supabase
          .from('tracks')
          .update({
            title: e.title || null,
            scenery_id: e.scenery_id,
            active: !!e.active,
            updated_at: new Date().toISOString()
          })
          .eq('id', exists.id);
        if (updErr) {
          console.error('[tracks.update one]', updErr);
          return res.status(500).json({ error: updErr.message });
        }
        results.push({ action: 'update', id: exists.id, track_id: e.track_id, laps: e.laps });
      } else {
        const { data: insData, error: insErr } = await supabase
          .from('tracks')
          .insert({
            title: e.title || null,
            scenery_id: e.scenery_id,
            track_id: e.track_id,
            laps: e.laps,
            active: !!e.active
          })
          .select('id')
          .single();
        if (insErr) {
          console.error('[tracks.insert]', insErr);
          return res.status(500).json({ error: insErr.message });
        }
        results.push({ action: 'insert', id: insData.id, track_id: e.track_id, laps: e.laps });
      }
    }

    return res.json({ ok: true, results });
  } catch (e) {
    console.error('[admin/set-tracks] unexpected', e);
    return res.status(500).json({ error: e.message });
  }
});

// ============================
// Static frontend fallback
// ============================
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
