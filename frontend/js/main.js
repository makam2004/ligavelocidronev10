function el(tag, attrs={}, children=[]) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v);
  });
  children.forEach(c => n.appendChild(c));
  return n;
}

async function getActiveTracks() {
  const res = await fetch('/api/tracks/active');
  const json = await res.json();
  return json.tracks || [];
}

async function getLeaderboard(track_id, laps) {
  const res = await fetch(`/api/leaderboard?track_id=${track_id}&laps=${laps}`);
  const json = await res.json();
  return json.results || [];
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
  if (!rows.length) { c.innerHTML = '<p class="muted">Sin resultados todavía.</p>'; return; }
  const table = el('table');
  const thead = el('thead');
  thead.innerHTML = `<tr><th>#</th><th>Piloto</th><th>Tiempo</th><th>Modelo</th><th>Versión</th><th>País</th></tr>`;
  table.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach(r => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>${r.position}</td>
      <td>${r.playername}</td>
      <td><code>${r.lap_time}</code></td>
      <td>${r.model_name || ''}</td>
      <td>${r.sim_version || ''}</td>
      <td>${r.country || ''}</td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  c.innerHTML = '';
  c.appendChild(table);
}

async function boot() {
  const tracks = await getActiveTracks();
  if (!tracks.length) {
    document.getElementById('table-container').innerHTML = '<p class="muted">Configura tus tracks activos en la página de Admin.</p>';
    return;
  }
  renderTabs(tracks, async (t) => {
    const data = await getLeaderboard(t.track_id, t.laps);
    renderTable(data);
  });
  // Carga inicial con el primero
  const first = tracks[0];
  const data = await getLeaderboard(first.track_id, first.laps);
  renderTable(data);

  // Auto-refresh cada 10 minutos
  setInterval(async () => {
    const activeTabIdx = [...document.getElementById('track-tabs').children].findIndex(c=>c.classList.contains('active'));
    const t = tracks[activeTabIdx] || first;
    const refreshed = await getLeaderboard(t.track_id, t.laps);
    renderTable(refreshed);
  }, 10 * 60 * 1000);
}

boot();
