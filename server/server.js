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

// ====== SUPABASE INIT (optional) ======
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null;

// ====== API ROUTES FIRST ======
app.get('/api/health', (req, res) => {
  res.json({ ok: true, supabase: !!supabase });
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

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// ====== STATIC DETECTION ======
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
