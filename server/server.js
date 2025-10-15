import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE) : null;
const VELO_API_TOKEN = process.env.VELO_API_TOKEN || '';
const VELO_API_URL = 'https://velocidrone.co.uk/api/leaderboard';
const SIM_VERSION = '1.16';
const CACHE_TTL_MS = 300000;
const veloCache = new Map();

function raceModeFromLaps(laps){ return laps==3?6:3; }
function parseTimeToMsFlexible(t){ if(!t)return null; const p=t.split(':').map(parseFloat); return p.length===2?(p[0]*60+p[1])*1000:p[0]*1000; }

async function resolveTrack(){
  if(supabase){
    const { data } = await supabase.from('tracks').select('*').eq('active',true).limit(1);
    if(data && data.length) return data[0];
  }
  return { track_id:null, laps:1, is_official:true, online_id:null };
}

async function callVelocidrone(postData){
  const res = await fetch(VELO_API_URL, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${VELO_API_TOKEN}`,'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({ post_data: postData })
  });
  const text = await res.text();
  return { ok:res.ok, status:res.status, text };
}

app.get('/api/leaderboard', async (req,res)=>{
  try{
    const track = await resolveTrack();
    if(!track) return res.status(404).json({error:'No active track'});
    const { is_official, track_id, online_id, laps } = track;

    let postData = is_official ? 
      `track_id=${track_id}&sim_version=${SIM_VERSION}&race_mode=${raceModeFromLaps(laps)}` :
      `online_id=${online_id}&sim_version=${SIM_VERSION}&race_mode=${raceModeFromLaps(laps)}`;

    const cacheKey = `${is_official?'ofc':'unofc'}:${track_id||online_id}:${laps}`;
    const now = Date.now();
    let cached = veloCache.get(cacheKey);
    if(!cached || now - cached.time > CACHE_TTL_MS){
      const out = await callVelocidrone(postData);
      if(!out.ok) return res.status(out.status).json({error:out.text});
      const json = JSON.parse(out.text);
      cached = { time: now, raw: json.tracktimes || [] };
      veloCache.set(cacheKey, cached);
    }
    const raw = cached.raw;
    const mapped = raw.map(r=>({ user_id:Number(r.user_id), playername:r.playername, lap_time:r.lap_time, lap_time_ms:parseTimeToMsFlexible(r.lap_time) }));

    let pilotsSet = new Set();
    if(supabase){
      const { data } = await supabase.from('pilots').select('user_id').eq('active',true);
      if(data) pilotsSet = new Set(data.map(p=>Number(p.user_id)));
    }
    const filtered = mapped.filter(x=>pilotsSet.has(x.user_id));
    const results = filtered.sort((a,b)=>a.lap_time_ms-b.lap_time_ms).map((r,i)=>({position:i+1,...r}));

    res.json({ is_official, track_id, online_id, laps, meta:{raw_count:raw.length,filtered_count:filtered.length,returned_count:results.length}, results });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// serve frontend
const staticDir = path.resolve('./frontend');
app.use(express.static(staticDir));
app.get('*',(req,res)=>{
  const file = path.join(staticDir,'index.html');
  if(fs.existsSync(file)) res.sendFile(file);
  else res.status(404).send('index.html not found');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>console.log('Server running on',PORT));
