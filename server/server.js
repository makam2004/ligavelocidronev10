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

// ===== SUPABASE (opcional) =====
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null;

// ===== API MÍNIMA (health) =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    supabase: !!supabase,
  });
});

// ===== AUTO-DETECCIÓN DE ESTÁTICOS =====
// Intenta servir index.html desde varias rutas, para cubrir ambos casos:
// - Root Directory en la raíz del repo (../frontend)
// - Root Directory en /server (./public)
const candidates = [
  path.resolve(__dirname, '../frontend'),
  path.resolve(__dirname, './public'),
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
  app.get('*', (req, res) => res.sendFile(path.join(STATIC_ROOT, 'index.html')));
}

app.listen(PORT, () => console.log('✅ Server running on :' + PORT));
