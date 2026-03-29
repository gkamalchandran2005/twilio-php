'use strict';

// =============================================================================
//  AttendNow — Geofence Employee Attendance Management System
//  Single-file Node.js + Express + SQLite application
//
//  QUICK START
//  -----------
//    1. cd geofence-attendance-app
//    2. npm install
//    3. node app.js
//    4. Open http://localhost:3000 in your browser
//
//  DEFAULT ACCOUNTS
//  ----------------
//    Admin    : admin@company.com  / Admin123!
//    Employee : alice@company.com  / Employee123!
//
//  ADMIN REGISTRATION CODE (for new admin sign-ups): ADMIN2024
//
//  FEATURES
//  --------
//    • Animated login / registration pages (gradients, micro-interactions)
//    • Employee dashboard: live GPS map, geofence status, clock-in / clock-out
//    • Admin dashboard: geofence management (map-based), attendance review,
//      user management, analytics cards
//    • Haversine geofence validation (server-side)
//    • JWT authentication, bcrypt password hashing
//    • SQLite database (auto-created as attendance.db)
// =============================================================================

const express     = require('express');
const Database    = require('better-sqlite3');
const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const { v4: uuidv4 } = require('uuid');

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'attend-now-jwt-secret-change-in-prod';
if (!process.env.JWT_SECRET) {
  console.warn('\x1b[33m  [WARN] JWT_SECRET not set — using insecure default. Set JWT_SECRET env var in production.\x1b[0m');
}
const DB_PATH    = path.join(__dirname, 'attendance.db');

// =============================================================================
//  DATABASE
// =============================================================================

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'employee',
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS geofences (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    latitude      REAL NOT NULL,
    longitude     REAL NOT NULL,
    radius_meters INTEGER NOT NULL DEFAULT 100,
    address       TEXT DEFAULT '',
    created_by    TEXT REFERENCES employees(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS attendance_records (
    id             TEXT PRIMARY KEY,
    employee_id    TEXT NOT NULL REFERENCES employees(id),
    geofence_id    TEXT REFERENCES geofences(id),
    date           TEXT NOT NULL,
    clock_in_at    TEXT,
    clock_out_at   TEXT,
    clock_in_lat   REAL,
    clock_in_lng   REAL,
    clock_out_lat  REAL,
    clock_out_lng  REAL,
    status         TEXT NOT NULL DEFAULT 'open',
    worked_minutes INTEGER,
    flags          TEXT DEFAULT '[]',
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed default accounts and a sample geofence
(function seed() {
  if (!db.prepare('SELECT id FROM employees WHERE email=?').get('admin@company.com')) {
    db.prepare('INSERT INTO employees (id,name,email,password,role) VALUES (?,?,?,?,?)')
      .run(uuidv4(), 'System Admin', 'admin@company.com', bcrypt.hashSync('Admin123!', 10), 'admin');
  }
  if (!db.prepare('SELECT id FROM employees WHERE email=?').get('alice@company.com')) {
    db.prepare('INSERT INTO employees (id,name,email,password,role) VALUES (?,?,?,?,?)')
      .run(uuidv4(), 'Alice Johnson', 'alice@company.com', bcrypt.hashSync('Employee123!', 10), 'employee');
  }
  if (!db.prepare('SELECT id FROM employees WHERE email=?').get('bob@company.com')) {
    db.prepare('INSERT INTO employees (id,name,email,password,role) VALUES (?,?,?,?,?)')
      .run(uuidv4(), 'Bob Martin', 'bob@company.com', bcrypt.hashSync('Employee123!', 10), 'employee');
  }
  if (!db.prepare('SELECT id FROM geofences LIMIT 1').get()) {
    db.prepare('INSERT INTO geofences (id,name,latitude,longitude,radius_meters,address) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), 'Head Office', 40.7128, -74.006, 200, '1 Broadway, New York, NY');
    db.prepare('INSERT INTO geofences (id,name,latitude,longitude,radius_meters,address) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), 'Downtown Branch', 40.7484, -73.9967, 150, '34th St, New York, NY');
  }
})();

// =============================================================================
//  UTILITIES
// =============================================================================

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function makeToken(emp) {
  return jwt.sign({ id: emp.id, email: emp.email, role: emp.role }, JWT_SECRET, { expiresIn: '8h' });
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function minutesBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// =============================================================================
//  MIDDLEWARE
// =============================================================================

const app = express();
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// =============================================================================
//  AUTH ROUTES
// =============================================================================

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM employees WHERE email=?').get(email))
    return res.status(409).json({ error: 'Email already registered' });
  const id = uuidv4();
  db.prepare('INSERT INTO employees (id,name,email,password) VALUES (?,?,?,?)')
    .run(id, name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10));
  const emp = db.prepare('SELECT id,name,email,role,status FROM employees WHERE id=?').get(id);
  res.json({ token: makeToken(emp), employee: emp });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const emp = db.prepare("SELECT * FROM employees WHERE email=? AND status='active'")
    .get((email || '').trim().toLowerCase());
  if (!emp || !bcrypt.compareSync(password || '', emp.password))
    return res.status(401).json({ error: 'Invalid email or password' });
  const { password: _pw, ...safe } = emp;
  res.json({ token: makeToken(safe), employee: safe });
});

app.post('/api/auth/admin/register', (req, res) => {
  const { name, email, password, adminCode } = req.body || {};
  if (adminCode !== 'ADMIN2024') return res.status(403).json({ error: 'Invalid admin registration code' });
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (db.prepare('SELECT id FROM employees WHERE email=?').get(email))
    return res.status(409).json({ error: 'Email already registered' });
  const id = uuidv4();
  db.prepare('INSERT INTO employees (id,name,email,password,role) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), 'admin');
  const emp = db.prepare('SELECT id,name,email,role,status FROM employees WHERE id=?').get(id);
  res.json({ token: makeToken(emp), employee: emp });
});

// =============================================================================
//  GEOFENCE ROUTES
// =============================================================================

app.get('/api/geofences', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM geofences WHERE is_active=1 ORDER BY created_at DESC').all());
});

app.post('/api/geofences', adminOnly, (req, res) => {
  const { name, latitude, longitude, radius_meters, address } = req.body || {};
  if (!name || latitude == null || longitude == null)
    return res.status(400).json({ error: 'name, latitude, longitude are required' });
  const id = uuidv4();
  db.prepare('INSERT INTO geofences (id,name,latitude,longitude,radius_meters,address,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, name.trim(), +latitude, +longitude, +(radius_meters || 100), address || '', req.user.id);
  res.json(db.prepare('SELECT * FROM geofences WHERE id=?').get(id));
});

app.put('/api/geofences/:id', adminOnly, (req, res) => {
  const { name, latitude, longitude, radius_meters, address } = req.body || {};
  db.prepare('UPDATE geofences SET name=?,latitude=?,longitude=?,radius_meters=?,address=? WHERE id=?')
    .run(name, +latitude, +longitude, +(radius_meters || 100), address || '', req.params.id);
  res.json(db.prepare('SELECT * FROM geofences WHERE id=?').get(req.params.id));
});

app.delete('/api/geofences/:id', adminOnly, (req, res) => {
  db.prepare('UPDATE geofences SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// =============================================================================
//  ATTENDANCE ROUTES
// =============================================================================

app.post('/api/attendance/checkin', auth, (req, res) => {
  const { latitude, longitude } = req.body || {};
  const today = getToday();
  if (db.prepare('SELECT id FROM attendance_records WHERE employee_id=? AND date=? AND clock_out_at IS NULL').get(req.user.id, today))
    return res.status(409).json({ error: 'Already clocked in today. Please clock out first.' });

  const flags = [];
  let gfId = null;

  if (latitude != null && longitude != null) {
    const gfs = db.prepare('SELECT * FROM geofences WHERE is_active=1').all();
    const match = gfs.find(gf => haversine(+latitude, +longitude, gf.latitude, gf.longitude) <= gf.radius_meters + 50);
    if (match) { gfId = match.id; }
    else { flags.push('outside_geofence'); }
  } else {
    flags.push('no_gps');
  }

  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO attendance_records
    (id,employee_id,geofence_id,date,clock_in_at,clock_in_lat,clock_in_lng,flags)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, gfId, today, now,
      latitude != null ? +latitude : null,
      longitude != null ? +longitude : null,
      JSON.stringify(flags));
  res.json({ success: true, record: db.prepare('SELECT * FROM attendance_records WHERE id=?').get(id) });
});

app.post('/api/attendance/checkout', auth, (req, res) => {
  const { latitude, longitude } = req.body || {};
  const today  = getToday();
  const record = db.prepare('SELECT * FROM attendance_records WHERE employee_id=? AND date=? AND clock_out_at IS NULL')
    .get(req.user.id, today);
  if (!record) return res.status(404).json({ error: 'No open attendance record found' });

  const now    = new Date().toISOString();
  const worked = minutesBetween(record.clock_in_at, now);
  db.prepare(`UPDATE attendance_records
    SET clock_out_at=?,clock_out_lat=?,clock_out_lng=?,status='complete',worked_minutes=? WHERE id=?`)
    .run(now,
      latitude != null ? +latitude : null,
      longitude != null ? +longitude : null,
      worked, record.id);
  res.json({ success: true, record: db.prepare('SELECT * FROM attendance_records WHERE id=?').get(record.id) });
});

app.get('/api/attendance/today', auth, (req, res) => {
  const r = db.prepare(`
    SELECT ar.*, g.name AS geofence_name FROM attendance_records ar
    LEFT JOIN geofences g ON g.id=ar.geofence_id
    WHERE ar.employee_id=? AND ar.date=?`).get(req.user.id, getToday());
  res.json({ record: r || null });
});

app.get('/api/attendance/history', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT ar.*, g.name AS geofence_name FROM attendance_records ar
    LEFT JOIN geofences g ON g.id=ar.geofence_id
    WHERE ar.employee_id=? ORDER BY ar.date DESC LIMIT 30`).all(req.user.id));
});

app.get('/api/attendance/all', adminOnly, (req, res) => {
  const { date } = req.query;
  const base = `SELECT ar.*, e.name AS employee_name, e.email, g.name AS geofence_name
    FROM attendance_records ar
    JOIN employees e ON e.id=ar.employee_id
    LEFT JOIN geofences g ON g.id=ar.geofence_id`;
  res.json(date
    ? db.prepare(base + ' WHERE ar.date=? ORDER BY ar.clock_in_at DESC').all(date)
    : db.prepare(base + ' ORDER BY ar.date DESC, ar.clock_in_at DESC LIMIT 200').all());
});

// =============================================================================
//  EMPLOYEE MANAGEMENT
// =============================================================================

app.get('/api/employees', adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,name,email,role,status,created_at FROM employees ORDER BY created_at DESC').all());
});

app.put('/api/employees/:id/status', adminOnly, (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'inactive', 'suspended'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE employees SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ success: true });
});

// =============================================================================
//  DASHBOARD STATS
// =============================================================================

app.get('/api/stats', adminOnly, (req, res) => {
  const today = getToday();
  const totalEmp  = db.prepare("SELECT COUNT(*) c FROM employees WHERE role='employee' AND status='active'").get().c;
  const present   = db.prepare('SELECT COUNT(DISTINCT employee_id) c FROM attendance_records WHERE date=?').get(today).c;
  const late      = db.prepare("SELECT COUNT(*) c FROM attendance_records WHERE date=? AND flags LIKE '%late%'").get(today).c;
  const avgObj    = db.prepare('SELECT AVG(worked_minutes) avg FROM attendance_records WHERE date=? AND worked_minutes IS NOT NULL').get(today);
  res.json({
    totalEmployees: totalEmp,
    presentToday  : present,
    absentToday   : Math.max(0, totalEmp - present),
    lateToday     : late,
    avgHoursToday : avgObj.avg ? +(avgObj.avg / 60).toFixed(1) : 0,
  });
});

// =============================================================================
//  FRONTEND  (Embedded Single-Page Application)
// =============================================================================

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AttendNow — Geofence Attendance</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
/* ---- RESET & BASE ---- */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:'Segoe UI',system-ui,sans-serif;background:#0f0e17;color:#fff}
button{cursor:pointer;border:none;outline:none;font-family:inherit}
input,select{font-family:inherit}
a{color:inherit;text-decoration:none}

/* ---- CSS VARIABLES ---- */
:root{
  --primary:#6c63ff;--primary2:#48b2e8;
  --coral:#ff6b6b;--amber:#ffd93d;
  --success:#06d6a0;--error:#ef476f;--warning:#ffd93d;
  --bg:#0f0e17;--surface:#1e1e2e;--surface2:#272740;
  --text:#fff;--muted:#a9a9c8;
  --radius:14px;--gap:16px;
}

/* ---- PAGES ---- */
.page{display:none;min-height:100vh;width:100%}
.page.active{display:flex}

/* ---- AUTH PAGES ---- */
.auth-bg{
  flex:1;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(-45deg,#0d0b24,#1a1040,#0d2040,#06223a);
  background-size:400% 400%;
  animation:gradShift 10s ease infinite;
  position:relative;overflow:hidden;
}
.auth-bg.admin-bg{background:linear-gradient(-45deg,#0a0a14,#1a1028,#0e1e3a,#0a0a14)}

@keyframes gradShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}

/* floating orbs */
.orb{position:absolute;border-radius:50%;filter:blur(60px);opacity:.35;animation:orbFloat 12s ease-in-out infinite}
.orb1{width:300px;height:300px;background:var(--primary);top:-80px;left:-60px;animation-delay:0s}
.orb2{width:200px;height:200px;background:var(--primary2);bottom:40px;right:-40px;animation-delay:-4s}
.orb3{width:150px;height:150px;background:var(--coral);top:50%;right:20%;animation-delay:-8s}
@keyframes orbFloat{0%,100%{transform:translate(0,0)}33%{transform:translate(20px,-30px)}66%{transform:translate(-15px,20px)}}

.auth-card{
  position:relative;z-index:1;
  background:rgba(30,30,46,.75);
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border:1px solid rgba(255,255,255,.12);
  border-radius:24px;padding:40px 36px;width:100%;max-width:420px;
  box-shadow:0 24px 64px rgba(0,0,0,.5);
  animation:cardUp .5s cubic-bezier(.34,1.56,.64,1);
}
@keyframes cardUp{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}

.admin-accent{
  position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,#ffd93d,#ff6b6b,#ffd93d);
  border-radius:24px 24px 0 0;
  animation:accentSlide .8s ease forwards;
}
@keyframes accentSlide{from{transform:scaleX(0);transform-origin:left}to{transform:scaleX(1)}}

.auth-logo{text-align:center;margin-bottom:28px}
.auth-logo .logo-icon{
  width:64px;height:64px;border-radius:50%;
  background:linear-gradient(135deg,var(--primary),var(--primary2));
  display:inline-flex;align-items:center;justify-content:center;
  font-size:28px;margin-bottom:12px;
  animation:logoPulse 3s ease-in-out infinite;
  box-shadow:0 0 0 0 rgba(108,99,255,.4);
}
@keyframes logoPulse{0%,100%{box-shadow:0 0 0 0 rgba(108,99,255,.4)}50%{box-shadow:0 0 0 14px rgba(108,99,255,0)}}

.auth-logo h1{font-size:1.6rem;font-weight:700;background:linear-gradient(90deg,#fff,var(--muted));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.auth-logo p{color:var(--muted);font-size:.85rem;margin-top:4px}

.admin-badge{
  display:inline-block;letter-spacing:4px;font-size:.65rem;font-weight:700;
  color:var(--amber);text-transform:uppercase;border:1px solid rgba(255,217,61,.3);
  padding:3px 10px;border-radius:20px;margin-bottom:8px;
}

/* ---- FORM ELEMENTS ---- */
.form-group{margin-bottom:18px;position:relative}
.form-group label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:6px;font-weight:500}
.form-group input,.form-group select{
  width:100%;padding:13px 16px;background:rgba(255,255,255,.07);
  border:1.5px solid rgba(255,255,255,.12);border-radius:10px;
  color:#fff;font-size:.95rem;transition:border-color .25s,box-shadow .25s;
}
.form-group input:focus,.form-group select:focus{
  outline:none;border-color:var(--primary);
  box-shadow:0 0 0 3px rgba(108,99,255,.25);
}
.form-group input.error{border-color:var(--error);animation:shake .15s ease 3}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
.form-group input::placeholder{color:rgba(255,255,255,.3)}

.eye-btn{
  position:absolute;right:14px;top:38px;background:none;
  color:var(--muted);font-size:1rem;padding:4px;
}
.eye-btn:hover{color:#fff}

.form-error{color:var(--error);font-size:.78rem;margin-top:6px;display:none}
.form-error.show{display:block;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}

/* ---- BUTTONS ---- */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:13px 24px;border-radius:10px;font-size:.95rem;font-weight:600;
  transition:transform .15s,box-shadow .15s,opacity .15s;
}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{
  background:linear-gradient(135deg,var(--primary),var(--primary2));
  color:#fff;width:100%;box-shadow:0 6px 24px rgba(108,99,255,.4);
}
.btn-primary:hover:not(:disabled){box-shadow:0 8px 30px rgba(108,99,255,.55);transform:translateY(-1px)}
.btn-admin{background:linear-gradient(135deg,#ffd93d,#ff9f43);color:#0a0a14;width:100%;box-shadow:0 6px 24px rgba(255,217,61,.3)}
.btn-admin:hover:not(:disabled){box-shadow:0 8px 30px rgba(255,217,61,.45);transform:translateY(-1px)}
.btn-success{background:linear-gradient(135deg,var(--success),#04c785);color:#0a1a12;min-width:160px}
.btn-success:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(6,214,160,.4)}
.btn-danger{background:linear-gradient(135deg,var(--error),#c0392b);color:#fff}
.btn-sm{padding:7px 14px;font-size:.82rem;border-radius:8px}
.btn-outline{background:transparent;border:1.5px solid rgba(255,255,255,.2);color:var(--muted)}
.btn-outline:hover{border-color:var(--primary);color:#fff}
.btn-loading .btn-text{display:none}
.btn-loading .spinner{display:inline-block}
.spinner{display:none;width:18px;height:18px;border:2.5px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- AUTH EXTRAS ---- */
.auth-divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--muted);font-size:.82rem}
.auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:rgba(255,255,255,.1)}
.auth-link{text-align:center;margin-top:20px;font-size:.85rem;color:var(--muted)}
.auth-link a,.auth-link span{color:var(--primary);cursor:pointer;font-weight:500}
.auth-link a:hover,.auth-link span:hover{text-decoration:underline}

.otp-group{display:flex;gap:10px;justify-content:center;margin:8px 0}
.otp-input{
  width:46px;height:54px;text-align:center;font-size:1.3rem;font-weight:700;
  background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.15);
  border-radius:10px;color:#fff;transition:border-color .2s,box-shadow .2s;
}
.otp-input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(108,99,255,.3)}
.otp-input.filled{border-color:var(--success);background:rgba(6,214,160,.12)}

/* ---- APP SHELL ---- */
.app-shell{display:none;flex-direction:column;height:100vh;overflow:hidden}
.app-shell.active{display:flex}

.topbar{
  background:linear-gradient(90deg,var(--surface),var(--surface2));
  padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0;
  box-shadow:0 2px 16px rgba(0,0,0,.3);
}
.topbar-brand{font-weight:700;font-size:1.1rem;display:flex;align-items:center;gap:8px}
.topbar-brand span{
  background:linear-gradient(90deg,var(--primary),var(--primary2));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
}
.topbar-right{display:flex;align-items:center;gap:14px}
.topbar-user{font-size:.85rem;color:var(--muted)}
.topbar-user strong{color:#fff}
.avatar{
  width:36px;height:36px;border-radius:50%;
  background:linear-gradient(135deg,var(--primary),var(--primary2));
  display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:.85rem;cursor:pointer;flex-shrink:0;
}
.logout-btn{font-size:.8rem;color:var(--muted);background:none;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.1)}
.logout-btn:hover{color:#fff;border-color:var(--error)}

/* ---- EMPLOYEE LAYOUT ---- */
.emp-layout{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px}

/* ---- GEOFENCE STATUS CARD ---- */
.gf-card{
  background:var(--surface);border-radius:var(--radius);padding:20px;
  border:1px solid rgba(255,255,255,.07);
  animation:slideIn .4s cubic-bezier(.34,1.56,.64,1);
}
@keyframes slideIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}

.gf-status-row{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.gf-pulse{
  width:48px;height:48px;border-radius:50%;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;font-size:1.4rem;
  position:relative;
}
.gf-pulse.inside{background:rgba(6,214,160,.15);color:var(--success)}
.gf-pulse.outside{background:rgba(239,71,111,.1);color:var(--error)}
.gf-pulse.unknown{background:rgba(169,169,200,.1);color:var(--muted)}
.gf-pulse.inside::after{
  content:'';position:absolute;inset:-4px;border-radius:50%;
  border:2px solid var(--success);opacity:.6;
  animation:ringPulse 2s ease-in-out infinite;
}
@keyframes ringPulse{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(1.25);opacity:0}}

.gf-info h3{font-size:1rem;font-weight:600;margin-bottom:2px}
.gf-info p{font-size:.8rem;color:var(--muted)}

.clock-btn-wrap{position:relative}
.clock-btn{
  width:100%;padding:16px;border-radius:12px;font-size:1rem;font-weight:700;
  letter-spacing:.5px;position:relative;overflow:hidden;
  transition:transform .15s,box-shadow .15s;
}
.clock-btn.in{
  background:linear-gradient(135deg,var(--success),#04c785);
  color:#0a1a12;box-shadow:0 6px 24px rgba(6,214,160,.35);
}
.clock-btn.out{
  background:linear-gradient(135deg,var(--coral),#ff4757);
  color:#fff;box-shadow:0 6px 24px rgba(255,107,107,.35);
}
.clock-btn:hover:not(:disabled){transform:translateY(-2px)}
.clock-btn:active:not(:disabled){transform:scale(.97)}
.clock-btn:disabled{opacity:.45;cursor:not-allowed}
.clock-btn .ripple{
  position:absolute;border-radius:50%;background:rgba(255,255,255,.3);
  transform:scale(0);animation:rippleAnim .6s ease-out;
  pointer-events:none;
}
@keyframes rippleAnim{to{transform:scale(4);opacity:0}}

/* ---- MINI MAP ---- */
#emp-map{height:200px;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1)}

/* ---- STAT CARDS ---- */
.stat-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat-card{
  background:var(--surface);border-radius:var(--radius);padding:16px;
  border:1px solid rgba(255,255,255,.07);
}
.stat-card .stat-val{font-size:1.6rem;font-weight:700;line-height:1}
.stat-card .stat-lbl{font-size:.75rem;color:var(--muted);margin-top:4px}
.stat-success .stat-val{color:var(--success)}
.stat-warn .stat-val{color:var(--warning)}
.stat-info .stat-val{color:var(--primary2)}

/* ---- SECTION TITLE ---- */
.section-title{
  font-size:.8rem;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:12px;
}

/* ---- HISTORY LIST ---- */
.history-list{display:flex;flex-direction:column;gap:8px}
.history-item{
  background:var(--surface);border-radius:10px;padding:14px 16px;
  display:flex;align-items:center;justify-content:space-between;
  border:1px solid rgba(255,255,255,.06);
  animation:rowIn .35s ease both;
}
.history-item:nth-child(1){animation-delay:.05s}
.history-item:nth-child(2){animation-delay:.10s}
.history-item:nth-child(3){animation-delay:.15s}
.history-item:nth-child(4){animation-delay:.20s}
.history-item:nth-child(5){animation-delay:.25s}
@keyframes rowIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}
.history-date{font-size:.9rem;font-weight:600}
.history-meta{font-size:.75rem;color:var(--muted);margin-top:2px}
.history-right{text-align:right}
.badge{
  display:inline-block;padding:3px 9px;border-radius:20px;font-size:.72rem;font-weight:600;
}
.badge-ok{background:rgba(6,214,160,.15);color:var(--success)}
.badge-late{background:rgba(255,217,61,.15);color:var(--warning)}
.badge-open{background:rgba(108,99,255,.15);color:var(--primary)}
.badge-absent{background:rgba(239,71,111,.15);color:var(--error)}

/* ---- ADMIN LAYOUT ---- */
.admin-layout{flex:1;display:flex;overflow:hidden}
.sidebar{
  width:220px;flex-shrink:0;background:var(--surface);
  border-right:1px solid rgba(255,255,255,.07);
  padding:20px 12px;display:flex;flex-direction:column;gap:4px;
  overflow-y:auto;
}
.sidebar-item{
  display:flex;align-items:center;gap:10px;
  padding:11px 14px;border-radius:10px;
  font-size:.88rem;font-weight:500;color:var(--muted);cursor:pointer;
  transition:background .2s,color .2s;
}
.sidebar-item:hover{background:rgba(255,255,255,.06);color:#fff}
.sidebar-item.active{background:rgba(108,99,255,.18);color:#fff}
.sidebar-item .si-icon{font-size:1.1rem;flex-shrink:0}
.admin-content{flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:20px}

/* ---- ADMIN STAT ROW ---- */
.admin-stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
@media(max-width:900px){.admin-stat-row{grid-template-columns:repeat(2,1fr)}}
.admin-stat{
  background:var(--surface);border-radius:var(--radius);padding:18px;
  border:1px solid rgba(255,255,255,.07);
}
.admin-stat .asv{font-size:2rem;font-weight:800;line-height:1}
.admin-stat .asl{font-size:.75rem;color:var(--muted);margin-top:4px}

/* ---- TABLE ---- */
.table-wrap{background:var(--surface);border-radius:var(--radius);border:1px solid rgba(255,255,255,.07);overflow:hidden}
.table-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07);
}
.table-header h3{font-size:.95rem;font-weight:600}
.table-header .header-actions{display:flex;gap:8px;align-items:center}
table{width:100%;border-collapse:collapse}
th{padding:10px 16px;text-align:left;font-size:.75rem;color:var(--muted);
   font-weight:600;text-transform:uppercase;letter-spacing:.8px;
   border-bottom:1px solid rgba(255,255,255,.06)}
td{padding:12px 16px;font-size:.88rem;border-bottom:1px solid rgba(255,255,255,.04)}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.03)}
.tbl-empty{text-align:center;color:var(--muted);padding:32px;font-size:.9rem}

/* ---- GEOFENCE MAP ---- */
#admin-map{height:360px;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1)}
.gf-map-controls{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;
}
.gf-form{
  background:var(--surface2);border-radius:12px;padding:18px;
  border:1px solid rgba(255,255,255,.1);
  display:none;
  animation:fadeIn .2s ease;
}
.gf-form.open{display:block}
.gf-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){.gf-form-grid{grid-template-columns:1fr}}
.gf-form-actions{display:flex;gap:8px;margin-top:12px}

/* ---- FILTER BAR ---- */
.filter-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.filter-bar input,.filter-bar select{
  background:var(--surface);border:1.5px solid rgba(255,255,255,.1);
  border-radius:8px;color:#fff;padding:8px 12px;font-size:.85rem;
}
.filter-bar input:focus,.filter-bar select:focus{outline:none;border-color:var(--primary)}

/* ---- TOAST ---- */
.toast-wrap{position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px}
.toast{
  background:var(--surface2);border-radius:10px;padding:12px 18px;
  font-size:.88rem;min-width:240px;max-width:320px;
  box-shadow:0 8px 32px rgba(0,0,0,.4);border-left:4px solid var(--primary);
  animation:toastIn .3s cubic-bezier(.34,1.56,.64,1);
}
.toast.success{border-color:var(--success)}
.toast.error{border-color:var(--error)}
.toast.warning{border-color:var(--warning)}
@keyframes toastIn{from{opacity:0;transform:translateX(60px)}to{opacity:1;transform:translateX(0)}}
@keyframes toastOut{to{opacity:0;transform:translateX(60px)}}

/* ---- MISC ---- */
.loading-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;
  display:none;align-items:center;justify-content:center;
}
.loading-overlay.show{display:flex}
.big-spinner{width:44px;height:44px;border:4px solid rgba(255,255,255,.2);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite}

.pill-status{padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:600}
.pill-active{background:rgba(6,214,160,.15);color:var(--success)}
.pill-inactive{background:rgba(239,71,111,.12);color:var(--error)}
.pill-suspended{background:rgba(255,217,61,.12);color:var(--warning)}

.consent-box{
  background:rgba(108,99,255,.1);border:1px solid rgba(108,99,255,.3);
  border-radius:10px;padding:14px;font-size:.82rem;color:var(--muted);
  margin:12px 0;
}
.consent-box strong{color:#fff}
.consent-row{display:flex;align-items:flex-start;gap:8px;margin-top:8px}
.consent-row input[type=checkbox]{width:16px;height:16px;margin-top:2px;accent-color:var(--primary);flex-shrink:0}

.admin-only{display:none}
.emp-only{display:none}
.flex-1{flex:1}
</style>
</head>
<body>
<div class="toast-wrap" id="toasts"></div>
<div class="loading-overlay" id="loadingOverlay"><div class="big-spinner"></div></div>

<!-- ===================== EMPLOYEE AUTH ===================== -->
<div class="page" id="page-emp-login">
  <div class="auth-bg">
    <div class="orb orb1"></div><div class="orb orb2"></div><div class="orb orb3"></div>
    <div class="auth-card">
      <div class="auth-logo">
        <div class="logo-icon">&#128205;</div>
        <h1>AttendNow</h1>
        <p>Your attendance, simplified</p>
      </div>
      <form id="empLoginForm" onsubmit="empLogin(event)">
        <div class="form-group">
          <label>Email address</label>
          <input type="email" id="el-email" placeholder="you@company.com" required autocomplete="email">
          <div class="form-error" id="el-email-err"></div>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="el-pass" placeholder="Enter password" required autocomplete="current-password">
          <button type="button" class="eye-btn" onclick="togglePwd('el-pass',this)">&#128065;</button>
          <div class="form-error" id="el-pass-err"></div>
        </div>
        <div class="form-error" id="el-form-err" style="margin-bottom:12px"></div>
        <button type="submit" class="btn btn-primary" id="el-submit">
          <span class="btn-text">Sign In &rarr;</span><span class="spinner"></span>
        </button>
      </form>
      <div class="auth-divider">or</div>
      <div class="auth-link">No account? <span onclick="showPage('page-emp-register')">Register here</span></div>
      <div class="auth-link" style="margin-top:8px"><span onclick="showPage('page-adm-login')">&#128274; Admin Portal</span></div>
    </div>
  </div>
</div>

<div class="page" id="page-emp-register">
  <div class="auth-bg">
    <div class="orb orb1"></div><div class="orb orb2"></div>
    <div class="auth-card">
      <div class="auth-logo">
        <div class="logo-icon">&#128100;</div>
        <h1>Create Account</h1>
        <p>Register as an employee</p>
      </div>
      <form id="empRegForm" onsubmit="empRegister(event)">
        <div class="form-group">
          <label>Full name</label>
          <input type="text" id="er-name" placeholder="Your full name" required>
        </div>
        <div class="form-group">
          <label>Work email</label>
          <input type="email" id="er-email" placeholder="you@company.com" required>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="er-pass" placeholder="Min. 6 characters" required>
          <button type="button" class="eye-btn" onclick="togglePwd('er-pass',this)">&#128065;</button>
        </div>
        <div class="consent-box">
          <strong>&#128205; Location Access</strong>
          <p style="margin-top:4px">This app uses your GPS location only while you are near registered work zones to log attendance. Location is <em>not</em> tracked outside your geofence.</p>
          <div class="consent-row"><input type="checkbox" id="er-consent1" required><label for="er-consent1">I agree to location-based clock-in</label></div>
          <div class="consent-row"><input type="checkbox" id="er-consent2" required><label for="er-consent2">I understand my data is encrypted</label></div>
        </div>
        <div class="form-error" id="er-form-err" style="margin-bottom:12px"></div>
        <button type="submit" class="btn btn-primary" id="er-submit">
          <span class="btn-text">Create Account</span><span class="spinner"></span>
        </button>
      </form>
      <div class="auth-link" style="margin-top:16px">Already registered? <span onclick="showPage('page-emp-login')">Sign in</span></div>
    </div>
  </div>
</div>

<!-- ===================== ADMIN AUTH ===================== -->
<div class="page" id="page-adm-login">
  <div class="auth-bg admin-bg">
    <div class="orb orb1" style="background:#ffd93d;opacity:.15"></div>
    <div class="orb orb2" style="background:#ff6b6b;opacity:.15"></div>
    <div class="auth-card">
      <div class="admin-accent"></div>
      <div class="auth-logo">
        <div class="admin-badge">Admin Portal</div>
        <div class="logo-icon" style="background:linear-gradient(135deg,#ffd93d,#ff9f43)">&#128737;</div>
        <h1>AttendNow Admin</h1>
        <p>Elevated access — authorised personnel only</p>
      </div>
      <form id="admLoginForm" onsubmit="admLogin(event)">
        <div class="form-group">
          <label>Admin email</label>
          <input type="email" id="al-email" placeholder="admin@company.com" required autocomplete="email">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="al-pass" placeholder="Enter password" required autocomplete="current-password">
          <button type="button" class="eye-btn" onclick="togglePwd('al-pass',this)">&#128065;</button>
        </div>
        <div class="form-error" id="al-form-err" style="margin-bottom:12px"></div>
        <button type="submit" class="btn btn-admin" id="al-submit">
          <span class="btn-text">Sign In &rarr;</span><span class="spinner"></span>
        </button>
      </form>
      <div class="auth-link" style="margin-top:16px"><span onclick="showPage('page-adm-register')">Register admin account</span></div>
      <div class="auth-link" style="margin-top:6px"><span onclick="showPage('page-emp-login')">&larr; Employee Login</span></div>
    </div>
  </div>
</div>

<div class="page" id="page-adm-register">
  <div class="auth-bg admin-bg">
    <div class="orb orb1" style="background:#ffd93d;opacity:.15"></div>
    <div class="auth-card">
      <div class="admin-accent"></div>
      <div class="auth-logo">
        <div class="admin-badge">New Admin</div>
        <div class="logo-icon" style="background:linear-gradient(135deg,#ffd93d,#ff9f43)">&#128737;</div>
        <h1>Admin Registration</h1>
      </div>
      <form id="admRegForm" onsubmit="admRegister(event)">
        <div class="form-group">
          <label>Full name</label>
          <input type="text" id="ar-name" placeholder="Admin name" required>
        </div>
        <div class="form-group">
          <label>Work email</label>
          <input type="email" id="ar-email" placeholder="admin@company.com" required>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="ar-pass" placeholder="Min. 6 characters" required>
          <button type="button" class="eye-btn" onclick="togglePwd('ar-pass',this)">&#128065;</button>
        </div>
        <div class="form-group">
          <label>Admin Registration Code</label>
          <input type="text" id="ar-code" placeholder="Enter code provided by IT" required>
        </div>
        <div class="form-error" id="ar-form-err" style="margin-bottom:12px"></div>
        <button type="submit" class="btn btn-admin" id="ar-submit">
          <span class="btn-text">Create Admin Account</span><span class="spinner"></span>
        </button>
      </form>
      <div class="auth-link" style="margin-top:16px"><span onclick="showPage('page-adm-login')">&larr; Admin Login</span></div>
    </div>
  </div>
</div>

<!-- ===================== EMPLOYEE DASHBOARD ===================== -->
<div class="app-shell" id="shell-emp">
  <div class="topbar">
    <div class="topbar-brand"><span>&#128205;</span><span>AttendNow</span></div>
    <div class="topbar-right">
      <span class="topbar-user">Welcome, <strong id="emp-username">—</strong></span>
      <div class="avatar" id="emp-avatar">A</div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
  </div>
  <div class="emp-layout" id="empLayout">

    <!-- Geofence Status + Clock -->
    <div class="gf-card">
      <div class="gf-status-row">
        <div class="gf-pulse unknown" id="gf-pulse">&#128205;</div>
        <div class="gf-info">
          <h3 id="gf-status-title">Checking location…</h3>
          <p id="gf-status-sub">Requesting GPS permission</p>
        </div>
      </div>
      <div style="margin-bottom:14px">
        <div id="emp-map"></div>
      </div>
      <div class="clock-btn-wrap">
        <button class="clock-btn in" id="clockBtn" onclick="handleClock()" disabled>
          <span class="btn-text" id="clockBtnText">&#9208; Getting location…</span>
          <span class="spinner"></span>
        </button>
      </div>
    </div>

    <!-- Today's record -->
    <div id="today-card" style="display:none">
      <div class="section-title">Today</div>
      <div class="stat-row">
        <div class="stat-card stat-success">
          <div class="stat-val" id="td-in">—</div>
          <div class="stat-lbl">Clock In</div>
        </div>
        <div class="stat-card stat-info">
          <div class="stat-val" id="td-out">—</div>
          <div class="stat-lbl">Clock Out</div>
        </div>
      </div>
    </div>

    <!-- Stats -->
    <div>
      <div class="section-title">This Week</div>
      <div class="stat-row">
        <div class="stat-card stat-success">
          <div class="stat-val" id="week-hrs">—</div>
          <div class="stat-lbl">Hours worked</div>
        </div>
        <div class="stat-card stat-warn">
          <div class="stat-val" id="week-days">—</div>
          <div class="stat-lbl">Days present</div>
        </div>
      </div>
    </div>

    <!-- History -->
    <div>
      <div class="section-title">Recent Attendance</div>
      <div class="history-list" id="hist-list">
        <div class="tbl-empty">Loading…</div>
      </div>
    </div>

    <p style="text-align:center;color:var(--muted);font-size:.75rem;margin-top:8px">
      &#128737; Location tracked only within your work zone &nbsp;|&nbsp; Data encrypted end-to-end
    </p>
  </div>
</div>

<!-- ===================== ADMIN DASHBOARD ===================== -->
<div class="app-shell" id="shell-adm">
  <div class="topbar">
    <div class="topbar-brand"><span style="color:var(--amber)">&#128737;</span><span>Admin Portal</span></div>
    <div class="topbar-right">
      <span class="topbar-user">Admin: <strong id="adm-username">—</strong></span>
      <div class="avatar" id="adm-avatar" style="background:linear-gradient(135deg,#ffd93d,#ff9f43);color:#0a0a14">A</div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
  </div>
  <div class="admin-layout">
    <div class="sidebar">
      <div class="sidebar-item active" onclick="admTab('overview')" id="tab-overview">
        <span class="si-icon">&#128202;</span> Overview
      </div>
      <div class="sidebar-item" onclick="admTab('geofences')" id="tab-geofences">
        <span class="si-icon">&#128205;</span> Geofences
      </div>
      <div class="sidebar-item" onclick="admTab('attendance')" id="tab-attendance">
        <span class="si-icon">&#128197;</span> Attendance
      </div>
      <div class="sidebar-item" onclick="admTab('users')" id="tab-users">
        <span class="si-icon">&#128101;</span> Users
      </div>
    </div>
    <div class="admin-content" id="admContent">

      <!-- Overview Tab -->
      <div id="adm-overview">
        <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:16px">Dashboard Overview</h2>
        <div class="admin-stat-row" id="statsRow">
          <div class="admin-stat"><div class="asv" id="st-total">—</div><div class="asl">Total Employees</div></div>
          <div class="admin-stat"><div class="asv" id="st-present" style="color:var(--success)">—</div><div class="asl">Present Today</div></div>
          <div class="admin-stat"><div class="asv" id="st-absent" style="color:var(--error)">—</div><div class="asl">Absent Today</div></div>
          <div class="admin-stat"><div class="asv" id="st-avghrs" style="color:var(--primary2)">—</div><div class="asl">Avg Hours Today</div></div>
        </div>
        <div class="table-wrap" style="margin-top:4px">
          <div class="table-header"><h3>Today's Attendance</h3><button class="btn btn-outline btn-sm" onclick="admTab('attendance')">View all</button></div>
          <div id="overview-att-body"><table><tbody><tr><td class="tbl-empty">Loading…</td></tr></tbody></table></div>
        </div>
      </div>

      <!-- Geofences Tab -->
      <div id="adm-geofences" style="display:none">
        <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:16px">Geofence Management</h2>
        <div class="gf-map-controls">
          <button class="btn btn-primary btn-sm" onclick="toggleGfForm()">&#43; Add Geofence</button>
          <span style="font-size:.82rem;color:var(--muted)">Click on the map to place a geofence centre</span>
        </div>

        <div class="gf-form" id="gfForm">
          <h4 style="margin-bottom:14px;font-size:.95rem">&#128205; <span id="gfFormTitle">New Geofence</span></h4>
          <input type="hidden" id="gf-edit-id">
          <div class="gf-form-grid">
            <div class="form-group"><label>Name</label><input type="text" id="gf-name" placeholder="e.g. Head Office"></div>
            <div class="form-group"><label>Radius (meters)</label><input type="number" id="gf-radius" value="100" min="20" max="2000"></div>
            <div class="form-group"><label>Latitude</label><input type="number" id="gf-lat" step="any" placeholder="40.7128"></div>
            <div class="form-group"><label>Longitude</label><input type="number" id="gf-lng" step="any" placeholder="-74.0060"></div>
            <div class="form-group" style="grid-column:1/-1"><label>Address (optional)</label><input type="text" id="gf-addr" placeholder="Street, City, Country"></div>
          </div>
          <div class="gf-form-actions">
            <button class="btn btn-primary btn-sm" onclick="saveGeofence()">&#10003; Save</button>
            <button class="btn btn-outline btn-sm" onclick="cancelGfForm()">Cancel</button>
          </div>
        </div>

        <div id="admin-map" style="margin-bottom:16px"></div>

        <div class="table-wrap">
          <div class="table-header"><h3>All Geofences</h3></div>
          <table><thead><tr><th>Name</th><th>Centre</th><th>Radius</th><th>Address</th><th>Actions</th></tr></thead>
          <tbody id="gf-table-body"><tr><td class="tbl-empty" colspan="5">Loading…</td></tr></tbody></table>
        </div>
      </div>

      <!-- Attendance Tab -->
      <div id="adm-attendance" style="display:none">
        <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:16px">Attendance Records</h2>
        <div class="filter-bar" style="margin-bottom:16px">
          <input type="date" id="att-filter-date" onchange="loadAllAttendance()">
          <input type="text" id="att-filter-emp" placeholder="Search employee…" oninput="filterAttTable()" style="min-width:180px">
          <select id="att-filter-status" onchange="filterAttTable()">
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="complete">Complete</option>
          </select>
          <button class="btn btn-outline btn-sm" onclick="exportCSV()">&#11015; CSV</button>
        </div>
        <div class="table-wrap">
          <table><thead><tr><th>Employee</th><th>Date</th><th>Clock In</th><th>Clock Out</th><th>Worked</th><th>Location</th><th>Status</th></tr></thead>
          <tbody id="att-table-body"><tr><td class="tbl-empty" colspan="7">Select a date above or leave blank for recent records</td></tr></tbody></table>
        </div>
      </div>

      <!-- Users Tab -->
      <div id="adm-users" style="display:none">
        <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:16px">User Management</h2>
        <div class="filter-bar" style="margin-bottom:16px">
          <input type="text" id="usr-filter" placeholder="Search by name or email…" oninput="filterUsrTable()" style="min-width:220px">
          <select id="usr-role-filter" onchange="filterUsrTable()">
            <option value="">All roles</option>
            <option value="employee">Employee</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div class="table-wrap">
          <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody id="usr-table-body"><tr><td class="tbl-empty" colspan="6">Loading…</td></tr></tbody></table>
        </div>
      </div>

    </div><!-- /admContent -->
  </div>
</div>

<script>
// ==========================================================================
//  STATE
// ==========================================================================
var S = {
  token: localStorage.getItem('attendnow_token'),
  user: null,
  empMap: null, empMapInit: false,
  admMap: null, admMapInit: false,
  admMapClickListener: false,
  gfLayers: {},
  previewCircle: null,
  watchId: null,
  currentPos: null,
  geofences: [],
  todayRecord: null,
  allAttendance: [],
  allUsers: []
};
try { S.user = JSON.parse(localStorage.getItem('attendnow_user') || 'null'); } catch(e) {}

// ==========================================================================
//  UTILITIES
// ==========================================================================
function $(id){ return document.getElementById(id); }

function showPage(id){
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.app-shell').forEach(function(s){ s.classList.remove('active'); });
  var el = $(id);
  if(el){ el.classList.add('active'); }
}

function showShell(id){
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.app-shell').forEach(function(s){ s.classList.remove('active'); });
  var el = $(id);
  if(el){ el.classList.add('active'); }
}

function toast(msg, type){
  type = type || 'info';
  var wrap = $('toasts');
  var t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(function(){
    t.style.animation = 'toastOut .3s ease forwards';
    setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 3500);
}

function setLoading(btnId, loading){
  var btn = $(btnId);
  if(!btn) return;
  if(loading){ btn.classList.add('btn-loading'); btn.disabled = true; }
  else { btn.classList.remove('btn-loading'); btn.disabled = false; }
}

function togglePwd(inputId, btn){
  var inp = $(inputId);
  if(inp.type === 'password'){ inp.type = 'text'; btn.innerHTML = '&#128064;'; }
  else { inp.type = 'password'; btn.innerHTML = '&#128065;'; }
}

function showErr(id, msg){
  var el = $(id);
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
}
function clearErr(id){
  var el = $(id);
  if(!el) return;
  el.textContent = '';
  el.classList.remove('show');
}

async function api(method, path, body){
  var opts = {
    method: method,
    headers: { 'Content-Type': 'application/json' }
  };
  if(S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
  if(body) opts.body = JSON.stringify(body);
  var res = await fetch(path, opts);
  var data = await res.json();
  if(!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtTime(iso){
  if(!iso) return '—';
  var d = new Date(iso);
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function fmtDate(str){
  if(!str) return '—';
  var d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'});
}
function fmtMins(m){
  if(m == null) return '—';
  var h = Math.floor(m/60), mn = m%60;
  return h + 'h ' + (mn<10?'0':'')+mn+'m';
}
function todayStr(){
  return new Date().toISOString().slice(0,10);
}

function haversineJS(lat1,lng1,lat2,lng2){
  var R=6371000;
  var dL=(lat2-lat1)*Math.PI/180, dG=(lng2-lng1)*Math.PI/180;
  var a=Math.sin(dL/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ==========================================================================
//  BOOTSTRAP
// ==========================================================================
window.addEventListener('DOMContentLoaded', function(){
  if(S.token && S.user){
    if(S.user.role === 'admin'){ enterAdminDashboard(); }
    else { enterEmpDashboard(); }
  } else {
    showPage('page-emp-login');
  }
});

function saveSession(token, user){
  S.token = token; S.user = user;
  localStorage.setItem('attendnow_token', token);
  localStorage.setItem('attendnow_user', JSON.stringify(user));
}

function logout(){
  S.token = null; S.user = null;
  localStorage.removeItem('attendnow_token');
  localStorage.removeItem('attendnow_user');
  if(S.watchId){ navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  showPage('page-emp-login');
}

// ==========================================================================
//  AUTH HANDLERS
// ==========================================================================
async function empLogin(e){
  e.preventDefault();
  clearErr('el-form-err');
  setLoading('el-submit', true);
  try {
    var data = await api('POST','/api/auth/login',{
      email: $('el-email').value.trim(),
      password: $('el-pass').value
    });
    saveSession(data.token, data.employee);
    enterEmpDashboard();
  } catch(err){
    showErr('el-form-err', err.message);
  }
  setLoading('el-submit', false);
}

async function empRegister(e){
  e.preventDefault();
  if(!$('er-consent1').checked || !$('er-consent2').checked){
    showErr('er-form-err','Please accept the consent checkboxes to continue'); return;
  }
  clearErr('er-form-err');
  setLoading('er-submit', true);
  try {
    var data = await api('POST','/api/auth/register',{
      name: $('er-name').value.trim(),
      email: $('er-email').value.trim(),
      password: $('er-pass').value
    });
    saveSession(data.token, data.employee);
    enterEmpDashboard();
    toast('Account created! Welcome &#127881;', 'success');
  } catch(err){
    showErr('er-form-err', err.message);
  }
  setLoading('er-submit', false);
}

async function admLogin(e){
  e.preventDefault();
  clearErr('al-form-err');
  setLoading('al-submit', true);
  try {
    var data = await api('POST','/api/auth/login',{
      email: $('al-email').value.trim(),
      password: $('al-pass').value
    });
    if(data.employee.role !== 'admin'){
      throw new Error('This account does not have admin access');
    }
    saveSession(data.token, data.employee);
    enterAdminDashboard();
  } catch(err){
    showErr('al-form-err', err.message);
  }
  setLoading('al-submit', false);
}

async function admRegister(e){
  e.preventDefault();
  clearErr('ar-form-err');
  setLoading('ar-submit', true);
  try {
    var data = await api('POST','/api/auth/admin/register',{
      name: $('ar-name').value.trim(),
      email: $('ar-email').value.trim(),
      password: $('ar-pass').value,
      adminCode: $('ar-code').value.trim()
    });
    saveSession(data.token, data.employee);
    enterAdminDashboard();
    toast('Admin account created!', 'success');
  } catch(err){
    showErr('ar-form-err', err.message);
  }
  setLoading('ar-submit', false);
}

// ==========================================================================
//  EMPLOYEE DASHBOARD
// ==========================================================================
function enterEmpDashboard(){
  showShell('shell-emp');
  $('emp-username').textContent = S.user.name;
  $('emp-avatar').textContent = S.user.name.charAt(0).toUpperCase();
  loadEmpDashboard();
}

async function loadEmpDashboard(){
  loadHistory();
  loadTodayRecord();
  initEmpMap();
  startLocationWatch();
}

function initEmpMap(){
  if(S.empMapInit) return;
  S.empMapInit = true;
  setTimeout(function(){
    S.empMap = L.map('emp-map').setView([40.7128,-74.006],13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'&copy; OpenStreetMap contributors',
      maxZoom:19
    }).addTo(S.empMap);
    S.empMapMarker = L.marker([40.7128,-74.006]).addTo(S.empMap).bindPopup('You');
    // Draw geofences
    api('GET','/api/geofences').then(function(gfs){
      S.geofences = gfs;
      gfs.forEach(function(gf){
        L.circle([gf.latitude,gf.longitude],{
          radius: gf.radius_meters,
          color: '#6c63ff', fillColor:'#6c63ff', fillOpacity:0.12, weight:2
        }).addTo(S.empMap).bindPopup(gf.name);
      });
    });
  }, 150);
}

function startLocationWatch(){
  if(!navigator.geolocation){
    updateGfStatus(null, null);
    return;
  }
  S.watchId = navigator.geolocation.watchPosition(
    function(pos){
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      S.currentPos = {lat:lat, lng:lng, accuracy:pos.coords.accuracy};
      if(S.empMap){
        S.empMapMarker.setLatLng([lat,lng]);
        S.empMap.setView([lat,lng],16);
      }
      updateGfStatus(lat, lng);
    },
    function(err){
      console.warn('GPS:', err.message);
      updateGfStatus(null, null);
    },
    {enableHighAccuracy:true, maximumAge:30000, timeout:15000}
  );
}

async function updateGfStatus(lat, lng){
  var gfs = S.geofences;
  if(!gfs || !gfs.length){
    try { gfs = await api('GET','/api/geofences'); S.geofences = gfs; }
    catch(e){}
  }

  var pulse = $('gf-pulse');
  var title = $('gf-status-title');
  var sub   = $('gf-status-sub');
  var btn   = $('clockBtn');
  var btnTxt= $('clockBtnText');

  if(lat == null){
    pulse.className='gf-pulse unknown'; pulse.innerHTML='&#128205;';
    title.textContent='GPS unavailable';
    sub.textContent='Enable location permission to use geofence clock-in';
    btn.disabled=false;
    // Allow manual clock-in even without GPS
    updateClockButton();
    return;
  }

  var matched = null;
  for(var i=0;i<gfs.length;i++){
    var dist = haversineJS(lat, lng, gfs[i].latitude, gfs[i].longitude);
    if(dist <= gfs[i].radius_meters + 50){
      matched = gfs[i];
      break;
    }
  }

  if(matched){
    pulse.className='gf-pulse inside'; pulse.innerHTML='&#10003;';
    title.textContent='Inside work zone';
    sub.textContent = matched.name + ' &#8226; GPS active';
  } else {
    pulse.className='gf-pulse outside'; pulse.innerHTML='&#10007;';
    title.textContent='Outside work zone';
    sub.textContent = 'Move to a registered work location to clock in';
  }

  updateClockButton();
}

async function updateClockButton(){
  try {
    var data = await api('GET','/api/attendance/today');
    S.todayRecord = data.record;
    var btn = $('clockBtn');
    var txt = $('clockBtnText');
    if(S.todayRecord && !S.todayRecord.clock_out_at){
      btn.className='clock-btn out'; btn.disabled=false;
      txt.textContent = '&#9209; Clock Out (since ' + fmtTime(S.todayRecord.clock_in_at) + ')';
      showTodayCard(S.todayRecord);
    } else {
      btn.className='clock-btn in'; btn.disabled=false;
      txt.textContent='&#9654; Clock In';
      if(S.todayRecord && S.todayRecord.clock_out_at) showTodayCard(S.todayRecord);
    }
  } catch(e){}
}

async function handleClock(){
  var btn = $('clockBtn');
  btn.disabled = true;
  $('clockBtnText').style.display='none';
  btn.querySelector('.spinner').style.display='inline-block';

  var lat = S.currentPos ? S.currentPos.lat : null;
  var lng = S.currentPos ? S.currentPos.lng : null;

  try {
    if(S.todayRecord && !S.todayRecord.clock_out_at){
      await api('POST','/api/attendance/checkout',{latitude:lat,longitude:lng});
      toast('Clocked out &#128075; Have a great day!','success');
    } else {
      await api('POST','/api/attendance/checkin',{latitude:lat,longitude:lng});
      toast('Clocked in &#127881; Welcome to work!','success');
    }
    loadTodayRecord();
    loadHistory();
  } catch(err){
    toast(err.message,'error');
  }

  $('clockBtnText').style.display='';
  btn.querySelector('.spinner').style.display='none';
  updateClockButton();
}

function showTodayCard(rec){
  $('today-card').style.display='block';
  $('td-in').textContent  = fmtTime(rec.clock_in_at);
  $('td-out').textContent = rec.clock_out_at ? fmtTime(rec.clock_out_at) : '(open)';
}

async function loadTodayRecord(){
  try {
    var data = await api('GET','/api/attendance/today');
    S.todayRecord = data.record;
    if(S.todayRecord) showTodayCard(S.todayRecord);
  } catch(e){}
}

async function loadHistory(){
  var list = $('hist-list');
  try {
    var recs = await api('GET','/api/attendance/history');
    if(!recs.length){ list.innerHTML='<div class="tbl-empty">No attendance records yet</div>'; return; }

    // Compute week stats
    var weekStart = new Date(); weekStart.setDate(weekStart.getDate()-weekStart.getDay());
    var weekMins=0, weekDays=0;
    recs.forEach(function(r){
      var d=new Date(r.date+'T00:00:00');
      if(d>=weekStart && r.worked_minutes){ weekMins+=r.worked_minutes; weekDays++; }
    });
    $('week-hrs').textContent = Math.round(weekMins/60*10)/10 + 'h';
    $('week-days').textContent = weekDays;

    list.innerHTML = recs.slice(0,8).map(function(r){
      var status = r.clock_out_at ? 'badge-ok' : 'badge-open';
      var statusTxt = r.clock_out_at ? 'Complete' : 'Open';
      if((r.flags||'').includes('late')) { status='badge-late'; statusTxt='Late'; }
      return '<div class="history-item">' +
        '<div><div class="history-date">' + fmtDate(r.date) + '</div>' +
        '<div class="history-meta">' + fmtTime(r.clock_in_at) + ' &rarr; ' + fmtTime(r.clock_out_at) +
        (r.geofence_name ? ' &bull; ' + r.geofence_name : '') + '</div></div>' +
        '<div class="history-right">' +
        '<div style="font-weight:600;font-size:.9rem">' + fmtMins(r.worked_minutes) + '</div>' +
        '<div class="badge ' + status + '">' + statusTxt + '</div></div></div>';
    }).join('');
  } catch(e){ list.innerHTML='<div class="tbl-empty">Could not load history</div>'; }
}

// ==========================================================================
//  ADMIN DASHBOARD
// ==========================================================================
function enterAdminDashboard(){
  showShell('shell-adm');
  $('adm-username').textContent = S.user.name;
  $('adm-avatar').textContent   = S.user.name.charAt(0).toUpperCase();
  admTab('overview');
}

function admTab(tab){
  ['overview','geofences','attendance','users'].forEach(function(t){
    $('adm-' + t).style.display = t===tab ? 'block' : 'none';
    $('tab-' + t).classList.toggle('active', t===tab);
  });
  if(tab==='overview')    loadAdmOverview();
  if(tab==='geofences')   loadAdmGeofences();
  if(tab==='attendance')  loadAllAttendance();
  if(tab==='users')       loadUsers();
}

// ---- Overview ----
async function loadAdmOverview(){
  try {
    var stats = await api('GET','/api/stats');
    $('st-total').textContent  = stats.totalEmployees;
    $('st-present').textContent= stats.presentToday;
    $('st-absent').textContent = stats.absentToday;
    $('st-avghrs').textContent = stats.avgHoursToday + 'h';
    // Load today's attendance preview
    var recs = await api('GET','/api/attendance/all?date=' + todayStr());
    renderOverviewTable(recs);
  } catch(e){ console.error(e); }
}

function renderOverviewTable(recs){
  var body = $('overview-att-body');
  if(!recs.length){ body.innerHTML='<div class="tbl-empty">No attendance records for today</div>'; return; }
  body.innerHTML='<table><thead><tr><th>Employee</th><th>Clock In</th><th>Clock Out</th><th>Location</th><th>Status</th></tr></thead><tbody>' +
    recs.map(function(r){
      var cls = r.clock_out_at ? 'badge-ok' : (r.status==='open'?'badge-open':'badge-absent');
      var lbl = r.clock_out_at ? 'Complete' : 'Open';
      return '<tr><td><strong>' + esc(r.employee_name) + '</strong><br><small style="color:var(--muted)">' + esc(r.email) + '</small></td>' +
        '<td>' + fmtTime(r.clock_in_at) + '</td>' +
        '<td>' + fmtTime(r.clock_out_at) + '</td>' +
        '<td>' + esc(r.geofence_name||'—') + '</td>' +
        '<td><span class="badge ' + cls + '">' + lbl + '</span></td></tr>';
    }).join('') + '</tbody></table>';
}

// ---- Geofences ----
var admGfEditId = null;

async function loadAdmGeofences(){
  var data = await api('GET','/api/geofences');
  S.geofences = data;
  renderGfTable(data);
  initAdmMap(data);
}

function initAdmMap(gfs){
  if(S.admMapInit){
    // Update layers
    Object.values(S.gfLayers).forEach(function(l){ S.admMap.removeLayer(l); });
    S.gfLayers = {};
    gfs.forEach(function(gf){ addGfLayer(gf); });
    return;
  }
  S.admMapInit = true;
  setTimeout(function(){
    S.admMap = L.map('admin-map').setView([40.7128,-74.006],13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'&copy; OpenStreetMap',maxZoom:19
    }).addTo(S.admMap);
    gfs.forEach(function(gf){ addGfLayer(gf); });

    S.admMap.on('click', function(e){
      if(!$('gfForm').classList.contains('open')) return;
      $('gf-lat').value = e.latlng.lat.toFixed(6);
      $('gf-lng').value = e.latlng.lng.toFixed(6);
      updatePreviewCircle(e.latlng.lat, e.latlng.lng, +$('gf-radius').value||100);
      toast('Location pinned! Fill in the form and click Save.','info');
    });

    $('gf-radius').addEventListener('input', function(){
      var lat = parseFloat($('gf-lat').value), lng = parseFloat($('gf-lng').value);
      if(!isNaN(lat)&&!isNaN(lng)) updatePreviewCircle(lat,lng,+this.value||100);
    });
  }, 150);
}

function addGfLayer(gf){
  if(S.gfLayers[gf.id]) S.admMap.removeLayer(S.gfLayers[gf.id]);
  var group = L.layerGroup();
  L.circle([gf.latitude,gf.longitude],{
    radius:gf.radius_meters, color:'#6c63ff',fillColor:'#6c63ff',fillOpacity:.15,weight:2
  }).addTo(group).bindPopup('<b>' + esc(gf.name) + '</b><br>' + esc(gf.address||''));
  L.marker([gf.latitude,gf.longitude]).addTo(group).bindPopup('<b>' + esc(gf.name) + '</b>');
  group.addTo(S.admMap);
  S.gfLayers[gf.id] = group;
}

function updatePreviewCircle(lat,lng,r){
  if(S.previewCircle) S.admMap.removeLayer(S.previewCircle);
  S.previewCircle = L.circle([lat,lng],{radius:r,color:'#ffd93d',fillColor:'#ffd93d',fillOpacity:.2,dashArray:'6'}).addTo(S.admMap);
  S.admMap.setView([lat,lng],14);
}

function renderGfTable(gfs){
  var tbody = $('gf-table-body');
  if(!gfs.length){ tbody.innerHTML='<tr><td class="tbl-empty" colspan="5">No geofences yet</td></tr>'; return; }
  tbody.innerHTML = gfs.map(function(gf){
    return '<tr>' +
      '<td><strong>' + esc(gf.name) + '</strong></td>' +
      '<td style="font-size:.8rem;color:var(--muted)">' + gf.latitude.toFixed(5) + ', ' + gf.longitude.toFixed(5) + '</td>' +
      '<td>' + gf.radius_meters + ' m</td>' +
      '<td style="font-size:.8rem">' + esc(gf.address||'—') + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="editGf(this.dataset.id)" data-id="' + gf.id + '" style="margin-right:4px">Edit</button>' +
      '<button class="btn btn-danger btn-sm" onclick="deleteGf(this.dataset.id)" data-id="' + gf.id + '">Delete</button></td></tr>';
  }).join('');
}

function toggleGfForm(){
  $('gfForm').classList.toggle('open');
  if($('gfForm').classList.contains('open')){
    clearGfForm(); $('gfFormTitle').textContent='New Geofence';
  }
}

function cancelGfForm(){
  $('gfForm').classList.remove('open');
  if(S.previewCircle){ S.admMap.removeLayer(S.previewCircle); S.previewCircle=null; }
}

function clearGfForm(){
  admGfEditId=null;
  $('gf-edit-id').value='';
  ['gf-name','gf-lat','gf-lng','gf-addr'].forEach(function(id){ $(id).value=''; });
  $('gf-radius').value='100';
}

function editGf(id){
  var gf = S.geofences.find(function(g){ return g.id===id; });
  if(!gf) return;
  $('gfForm').classList.add('open');
  $('gfFormTitle').textContent='Edit Geofence';
  admGfEditId = id;
  $('gf-name').value   = gf.name;
  $('gf-lat').value    = gf.latitude;
  $('gf-lng').value    = gf.longitude;
  $('gf-radius').value = gf.radius_meters;
  $('gf-addr').value   = gf.address||'';
  updatePreviewCircle(gf.latitude, gf.longitude, gf.radius_meters);
  $('admContent').scrollTo(0,0);
}

async function saveGeofence(){
  var name   = $('gf-name').value.trim();
  var lat    = parseFloat($('gf-lat').value);
  var lng    = parseFloat($('gf-lng').value);
  var radius = parseInt($('gf-radius').value)||100;
  var addr   = $('gf-addr').value.trim();
  if(!name||isNaN(lat)||isNaN(lng)){ toast('Name, latitude and longitude are required','error'); return; }
  try {
    if(admGfEditId){
      await api('PUT','/api/geofences/'+admGfEditId,{name,latitude:lat,longitude:lng,radius_meters:radius,address:addr});
      toast('Geofence updated','success');
    } else {
      await api('POST','/api/geofences',{name,latitude:lat,longitude:lng,radius_meters:radius,address:addr});
      toast('Geofence created','success');
    }
    cancelGfForm();
    loadAdmGeofences();
  } catch(err){ toast(err.message,'error'); }
}

async function deleteGf(id){
  if(!confirm('Delete this geofence? Existing attendance records will be preserved.')) return;
  try {
    await api('DELETE','/api/geofences/'+id);
    toast('Geofence deleted','success');
    loadAdmGeofences();
  } catch(err){ toast(err.message,'error'); }
}

// ---- Attendance ----
async function loadAllAttendance(){
  var date = $('att-filter-date').value;
  var url  = '/api/attendance/all' + (date ? '?date='+date : '');
  try {
    S.allAttendance = await api('GET', url);
    filterAttTable();
  } catch(e){ toast('Failed to load attendance','error'); }
}

function filterAttTable(){
  var empF    = ($('att-filter-emp').value||'').toLowerCase();
  var statusF = $('att-filter-status').value;
  var recs    = S.allAttendance.filter(function(r){
    var matchEmp    = !empF || r.employee_name.toLowerCase().includes(empF) || r.email.toLowerCase().includes(empF);
    var matchStatus = !statusF || r.status===statusF;
    return matchEmp && matchStatus;
  });
  var tbody = $('att-table-body');
  if(!recs.length){ tbody.innerHTML='<tr><td class="tbl-empty" colspan="7">No records found</td></tr>'; return; }
  tbody.innerHTML = recs.map(function(r){
    var cls = r.clock_out_at ? 'badge-ok' : 'badge-open';
    var lbl = r.clock_out_at ? 'Complete' : 'Open';
    if((r.flags||'').includes('outside_geofence')){ cls='badge-late'; lbl='Outside Zone'; }
    return '<tr>' +
      '<td><strong>' + esc(r.employee_name) + '</strong><br><small style="color:var(--muted)">' + esc(r.email) + '</small></td>' +
      '<td>' + fmtDate(r.date) + '</td>' +
      '<td>' + fmtTime(r.clock_in_at) + '</td>' +
      '<td>' + fmtTime(r.clock_out_at) + '</td>' +
      '<td>' + fmtMins(r.worked_minutes) + '</td>' +
      '<td style="font-size:.8rem">' + esc(r.geofence_name||'—') + '</td>' +
      '<td><span class="badge ' + cls + '">' + lbl + '</span></td></tr>';
  }).join('');
}

function exportCSV(){
  var rows = [['Employee','Email','Date','Clock In','Clock Out','Worked Minutes','Location','Status']];
  S.allAttendance.forEach(function(r){
    rows.push([r.employee_name,r.email,r.date,
      r.clock_in_at||'',r.clock_out_at||'',
      r.worked_minutes||'',r.geofence_name||'',r.status]);
  });
  var csv = rows.map(function(r){ return r.map(function(c){ return '"'+(c+'').replace(/"/g,'""')+'"'; }).join(','); }).join('\\n'); // \\n here → \n in HTML output → newline in browser JS
  var a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='attendance_'+todayStr()+'.csv'; a.click();
}

// ---- Users ----
async function loadUsers(){
  try {
    S.allUsers = await api('GET','/api/employees');
    filterUsrTable();
  } catch(e){ toast('Failed to load users','error'); }
}

function filterUsrTable(){
  var txt  = ($('usr-filter').value||'').toLowerCase();
  var role = $('usr-role-filter').value;
  var users= S.allUsers.filter(function(u){
    var m = !txt || u.name.toLowerCase().includes(txt) || u.email.toLowerCase().includes(txt);
    var r = !role || u.role===role;
    return m&&r;
  });
  var tbody = $('usr-table-body');
  if(!users.length){ tbody.innerHTML='<tr><td class="tbl-empty" colspan="6">No users found</td></tr>'; return; }
  tbody.innerHTML = users.map(function(u){
    var scls = u.status==='active'?'pill-active':(u.status==='inactive'?'pill-inactive':'pill-suspended');
    return '<tr>' +
      '<td><strong>' + esc(u.name) + '</strong></td>' +
      '<td style="font-size:.85rem">' + esc(u.email) + '</td>' +
      '<td><span class="badge" style="background:rgba(108,99,255,.15);color:var(--primary)">' + u.role + '</span></td>' +
      '<td><span class="pill-status ' + scls + '">' + u.status + '</span></td>' +
      '<td style="font-size:.8rem;color:var(--muted)">' + (u.created_at||'').slice(0,10) + '</td>' +
      '<td>' + (u.id!==S.user.id ?
        '<button class="btn btn-sm btn-outline" onclick="toggleUserStatus(this.dataset.uid,this.dataset.status)" data-uid="' + u.id + '" data-status="' + u.status + '">' +
        (u.status==='active'?'Deactivate':'Activate') + '</button>' : '<span style="color:var(--muted);font-size:.8rem">(you)</span>') +
      '</td></tr>';
  }).join('');
}

async function toggleUserStatus(id, current){
  var next = current==='active' ? 'inactive' : 'active';
  try {
    await api('PUT','/api/employees/'+id+'/status',{status:next});
    toast('User ' + (next==='active'?'activated':'deactivated'),'success');
    loadUsers();
  } catch(err){ toast(err.message,'error'); }
}

// ---- XSS-safe escape ----
function esc(s){
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;

app.get('/', (_req, res) => res.type('html').send(PAGE));

// =============================================================================
//  START SERVER
// =============================================================================
app.listen(PORT, () => {
  console.log('\n\x1b[35m\x1b[1m  AttendNow\x1b[0m  — Geofence Attendance System');
  console.log('\x1b[36m  http://localhost:' + PORT + '\x1b[0m\n');
  console.log('  Default accounts:');
  console.log('    \x1b[33mAdmin\x1b[0m    admin@company.com   \x1b[90m/\x1b[0m Admin123!');
  console.log('    \x1b[32mEmployee\x1b[0m alice@company.com   \x1b[90m/\x1b[0m Employee123!');
  console.log('    \x1b[32mEmployee\x1b[0m bob@company.com     \x1b[90m/\x1b[0m Employee123!\n');
  console.log('  \x1b[90mAdmin registration code: ADMIN2024\x1b[0m');
  console.log('  \x1b[90mDatabase: ' + DB_PATH + '\x1b[0m\n');
});
