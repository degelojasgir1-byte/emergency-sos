// Emergency SOS — Backend V1
// Code link only, single-use, 30 min expiry, revocable.
// Urgent push: poll + alarm repeating 30s x10 until ack.
// Runs on PORT 3002 locally, process.env.PORT on host (Render/Railway) — NEVER 20128.
// In-memory for V1 — Supabase swap is next without changing API.

import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: true }));
app.use(express.json());

// ── In-memory stores (V1) ──
const invites = new Map(); // code -> { id, code, from, circleId, createdAt, expiresAt, used, revoked }
const users = new Map();   // deviceId -> { deviceId, name, circleId, joinedAt }
const circles = new Map(); // circleId -> Set<deviceId>
const soses = []; // array of { id, from, targets, message, locationLink, medicalNotes, time, acks: Set, createdAt }
const pushQueue = []; // array of { id, toDeviceId, sosId, attempt, createdAt, delivered }

function now(){ return Date.now(); }
function isInviteValid(inv){
  if(!inv) return {ok:false, reason:"Invite not found"};
  if(inv.revoked) return {ok:false, reason:"Invite revoked"};
  if(inv.used) return {ok:false, reason:"Invite already used"};
  if(now() > inv.expiresAt) return {ok:false, reason:"Invite expired (30 min)"};
  return {ok:true};
}
function ensureCircleFor(deviceId){
  const u = users.get(deviceId);
  if(u && u.circleId && circles.has(u.circleId)) return u.circleId;
  const circleId = nanoid(8);
  circles.set(circleId, new Set(deviceId ? [deviceId] : []));
  if(deviceId){
    users.set(deviceId, { deviceId, name: u?.name || "You", circleId, joinedAt: now() });
  }
  return circleId;
}

// ── Health ──
app.get("/api/health", (req,res)=>res.json({ok:true, time: new Date().toISOString(), invites: invites.size, users: users.size, soses: soses.length}));
app.get("/", (req,res)=>res.json({ok:true, service:"emergency-sos-backend", health:"/api/health"}));
app.get("/health", (req,res)=>res.json({ok:true}));

// ── Invites ──
// POST /api/invites  { from, fromName? } -> { code, link, webLink, circleId, expiresAt }
app.post("/api/invites", (req,res)=>{
  const { from, fromName } = req.body;
  // ensure inviter has a circle
  let circleId = null;
  if(from){
    circleId = ensureCircleFor(from);
    // update name if provided
    if(fromName){
      const u = users.get(from);
      if(u) u.name = fromName;
    }
  } else {
    circleId = nanoid(8);
    circles.set(circleId, new Set());
  }
  const code = nanoid(8);
  const createdAt = now();
  const expiresAt = createdAt + 30*60*1000;
  const id = nanoid(10);
  const inv = { id, code, from: from||null, circleId, createdAt, expiresAt, used:false, revoked:false };
  invites.set(code, inv);
  const link = `sos://${code}`;
  // webLink will be filled by client using its own web base, but provide template
  res.json({ code, link, circleId, expiresAt, id });
});

app.get("/api/invites/:code", (req,res)=>{
  const inv = invites.get(req.params.code);
  if(!inv) return res.status(404).json({error:"Not found"});
  const v=isInviteValid(inv);
  res.json({...inv, valid:v.ok, reason: v.ok?null:v.reason});
});

app.post("/api/invites/:code/accept", (req,res)=>{
  const inv = invites.get(req.params.code);
  const v=isInviteValid(inv);
  if(!v.ok) return res.status(400).json({error:v.reason});
  const { deviceId, name } = req.body;
  if(!deviceId) return res.status(400).json({error:"deviceId required"});
  inv.used = true;
  const circleId = inv.circleId || ensureCircleFor(inv.from);
  if(!circles.has(circleId)) circles.set(circleId, new Set());
  circles.get(circleId).add(deviceId);
  // also ensure inviter is in circle
  if(inv.from && !circles.get(circleId).has(inv.from)){
    circles.get(circleId).add(inv.from);
    ensureCircleFor(inv.from);
  }
  users.set(deviceId, { deviceId, name: name||"Friend", circleId, joinedAt: now() });
  // ensure inviter user exists
  if(inv.from && !users.has(inv.from)){
    users.set(inv.from, { deviceId: inv.from, name: "Inviter", circleId, joinedAt: now() });
  }
  res.json({ok:true, circleId, deviceId, members: [...circles.get(circleId)]});
});

app.post("/api/invites/:code/revoke", (req,res)=>{
  const inv=invites.get(req.params.code);
  if(!inv) return res.status(404).json({error:"Not found"});
  inv.revoked=true;
  res.json({ok:true});
});

// ── Circles ──
app.get("/api/circles/:id", (req,res)=>{
  const set = circles.get(req.params.id);
  if(!set) return res.status(404).json({error:"Circle not found"});
  const members = [...set].map(id=> users.get(id) || { deviceId: id, name: "Unknown", circleId: req.params.id });
  res.json({ circleId: req.params.id, members });
});
app.get("/api/users/:deviceId", (req,res)=>{
  const u = users.get(req.params.deviceId);
  if(!u) return res.status(404).json({error:"User not found"});
  res.json(u);
});

// ── SOS ──
// POST /api/sos  { from, targets, message, locationLink, medicalNotes }
app.post("/api/sos", (req,res)=>{
  const { from, targets, message, locationLink, medicalNotes } = req.body;
  const id = nanoid(12);
  const entry = { id, from: from||null, targets: targets||"All", message: message||"", locationLink: locationLink||"Location unavailable", medicalNotes: medicalNotes||null, time: new Date().toLocaleString([], {dateStyle:"medium", timeStyle:"short"}), createdAt: now(), acks: new Set() };
  soses.unshift(entry);
  // Enqueue urgent pushes scoped to sender's circle
  let memberIds = [];
  if(from && users.has(from)){
    const cid = users.get(from).circleId;
    const set = circles.get(cid);
    if(set) memberIds = [...set].filter(mid => mid !== from);
  }
  // Fallback V1: if no circle yet, push to all known users except sender (for testing)
  if(memberIds.length===0){
    memberIds = [...users.keys()].filter(mid => mid !== from);
  }
  for(const deviceId of memberIds){
    pushQueue.push({ id: nanoid(10), toDeviceId: deviceId, sosId: id, attempt: 0, createdAt: now(), delivered: false });
  }
  res.json({id, time: entry.time, pushedTo: memberIds.length});
});

// GET /api/sos — list (optionally ?deviceId to filter by circle)
app.get("/api/sos", (req,res)=>{
  const { deviceId } = req.query;
  if(deviceId && users.has(deviceId)){
    const cid = users.get(deviceId).circleId;
    const set = circles.get(cid);
    const memberIds = set ? new Set([...set, deviceId]) : null;
    const filtered = soses.filter(s => !memberIds || memberIds.has(s.from) || s.from===deviceId);
    return res.json(filtered.map(s=>({...s, acks: [...s.acks]})));
  }
  res.json(soses.map(s=>({...s, acks: [...s.acks]})));
});

// ── Push polling (V1) ──
// GET /api/push?deviceId=xxx  -> pending pushes for that device (urgent, repeat every 30s x10)
app.get("/api/push", (req,res)=>{
  const { deviceId } = req.query;
  if(!deviceId) return res.status(400).json({error:"deviceId required"});
  const pending = pushQueue.filter(p=>p.toDeviceId===deviceId && !p.delivered && p.attempt < 10);
  const due = pending.filter(p=>{
    const ageSec = (now()-p.createdAt)/1000;
    const nextAttemptAt = p.attempt * 30;
    return ageSec >= nextAttemptAt;
  });
  const out = due.map(p=>{
    const sos = soses.find(s=>s.id===p.sosId);
    if(!sos) return null;
    if(sos.acks.has(deviceId)) return null;
    return { pushId: p.id, sosId: p.sosId, attempt: p.attempt+1, max: 10, intervalSec: 30, sos: {...sos, acks:[...sos.acks]} };
  }).filter(Boolean);
  due.forEach(p=>{ if(out.find(o=>o.pushId===p.id)) p.attempt++; });
  res.json(out);
});

// POST /api/push/:sosId/ack  { deviceId }
app.post("/api/push/:sosId/ack", (req,res)=>{
  const { deviceId } = req.body;
  const sos = soses.find(s=>s.id===req.params.sosId);
  if(!sos) return res.status(404).json({error:"SOS not found"});
  if(deviceId) sos.acks.add(deviceId);
  for(const p of pushQueue){ if(p.sosId===req.params.sosId && p.toDeviceId===deviceId) p.delivered=true; }
  res.json({ok:true, acks:[...sos.acks]});
});

app.listen(PORT, "0.0.0.0", ()=>console.log(`Emergency SOS backend on http://localhost:${PORT}  (0.0.0.0:${PORT})`));
