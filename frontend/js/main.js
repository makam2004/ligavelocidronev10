function el(tag, attrs={}, children=[]) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v);
  });
  children.forEach(c => n.appendChild(c));
  return n;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} - ${text}`);
  }
  return res.json();
}

async function getActiveTracks() {
  return fetchJSON('/api/tracks/active');
}

async function getLeaderboard(track_id, laps) {
  return fetchJSON(`/api/leaderboard?track_id=${track_id}&laps=${laps}`);
}

function renderTabs(tracks, onChange) {
  const tabs = document.getElementById('track-tabs');
  tabs.innerHTML = '';
  tracks.forEach((t, i) => {
    const b = el('button', { class: `tab ${i===0?'active':''}` }, [document.createTextNode(`${t.title || ('Track '+t.track_id)} • ${t.laps} lap${t.laps>1?'s':''}`)]);
    b.addEventListener('click', () => {
      [...tabs.children].forEach(c=>c.classList.remove('active'));
      b.classList.add('active');
      onChange(t);
    });
    tabs.appendChild(b);
  });
}

function renderTable(rows) {
  const c = document.getElementById('table-container');
  if (!rows || !rows.length) { c.innerHTML = '<p class="muted">No hay resultados aún para este track.</p>'; return; }
  const table = el('table');
  table.innerHTML = `
    <thead><tr><th>#</th><th>Piloto</th><th>Tiempo</th><th>Modelo</th><th>Versión</th><th>País</th></tr></thead>
    <tbody>${rows.map(r => `
      <tr>
        <td>${r.position ?? ''}</td>
        <td>${r.playername ?? ''}</td>
        <td><code>${r.lap_time ?? ''}</code></td>
        <td>${r.model_name ?? ''}</td>
        <td>${r.sim_version ?? ''}</td>
        <td>${r.country ?? ''}</td>
      </tr>`).join('')}
    </tbody>`;
  const container = document.getElementById('table-container');
  container.innerHTML = '';
  container.appendChild(table);
}

async function boot() {
  const container = document.getElementById('table-container');
  try {
    const { tracks } = await getActiveTracks();
    if (!tracks || !tracks.length) {
      container.innerHTML = '<p class="muted">No hay tracks activos. Configúralos en la página de Admin.</p>';
      return;
    }
    renderTabs(tracks, async (t) => {
      try {
        const { results } = await getLeaderboard(t.track_id, t.laps);
        renderTable(results);
      } catch (e) {
        container.innerHTML = '<pre class="muted">Error al cargar leaderboard:\n' + e.message + '</pre>';
      }
    });
    // carga inicial
    const first = tracks[0];
    const { results } = await getLeaderboard(first.track_id, first.laps);
    renderTable(results);

    // auto refresh
    setInterval(async () => {
      const activeTabIdx = [...document.getElementById('track-tabs').children].findIndex(c=>c.classList.contains('active'));
      const t = tracks[activeTabIdx] || first;
      try {
        const { results: r } = await getLeaderboard(t.track_id, t.laps);
        renderTable(r);
      } catch (e) {
        container.innerHTML = '<pre class="muted">Error al refrescar leaderboard:\n' + e.message + '</pre>';
      }
    }, 10 * 60 * 1000);
  } catch (e) {
    container.innerHTML = '<pre class="muted">Error al cargar tracks activos:\n' + e.message + '</pre>';
  }
}

boot();
