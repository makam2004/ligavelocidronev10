import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ============================
// AUTO-DETECCIÓN DE ESTÁTICOS
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
  // Respuesta clara si se hace una petición antes de tener estáticos
  app.get('*', (req, res) => {
    res.status(500).send('Static index.html not found. Checked: ' + candidates.join(' | '));
  });
} else {
  console.log('[STATIC] Sirviendo estáticos desde:', STATIC_ROOT);
  app.use(express.static(STATIC_ROOT));
  app.get('*', (req, res) => {
    res.sendFile(path.join(STATIC_ROOT, 'index.html'));
  });
}

app.listen(PORT, () => console.log(`✅ Server running on :${PORT}`));
