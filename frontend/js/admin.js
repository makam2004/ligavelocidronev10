function val(id){ return document.getElementById(id).value.trim(); }
function checked(id){ return document.getElementById(id).checked; }

async function save() {
  const adminKey = document.getElementById('adminKey').value.trim();
  const entries = [
    { title: val('t1_title'), scenery_id: +val('t1_scenery'), track_id: +val('t1_track'), laps: 1, active: checked('t1_active') },
    { title: val('t3_title'), scenery_id: +val('t3_scenery'), track_id: +val('t3_track'), laps: 3, active: checked('t3_active') }
  ];

  const res = await fetch('/api/admin/set-tracks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ entries })
  });

  const out = document.getElementById('status');
  if (res.ok) out.textContent = 'Guardado correctamente';
  else {
    const json = await res.json().catch(()=>({}));
    out.textContent = 'Error: ' + (json.error || res.statusText);
  }
}

document.getElementById('saveBtn').addEventListener('click', save);
