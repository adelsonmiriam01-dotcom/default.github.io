import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';

// --- Configuration ---
const PORT = process.env.PORT || 5000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialize Supabase Admin Client (bypasses RLS for server-side writes)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const app = express();

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));

// CORS: Replace with your Render frontend URL or keep '*' for testing
const allowedOrigins = [
  'https://your-frontend.onrender.com', // Update this!
  'http://localhost:3000',
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Allow Postman/mobile
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS not allowed'), false);
    }
    return callback(null, true);
  },
  credentials: true,
}));

// Multer: Use memory storage to stream directly to Supabase
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max, matches frontend
});

// --- Helper: Get Client IP ---
const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
};

// --- Routes ---

// 1. Health Check (Render will ping this)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 2. Session Report (IP, Battery, Time)
app.post('/api/session', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const { battery, charging, time, tz, ua, ip: reportedIp } = req.body;

    // Use reported IP if provided, else fallback to request IP
    const finalIp = reportedIp || clientIp;

    const { data, error } = await supabaseAdmin
      .from('sessions')
      .insert([
        {
          ip_address: finalIp,
          battery_level: battery,
          is_charging: charging,
          captured_at: time || new Date().toISOString(),
          timezone: tz,
          user_agent: ua,
        },
      ])
      .select();

    if (error) throw error;

    console.log(`[Session] Saved for IP: ${finalIp}`);
    res.status(201).json({ success: true, id: data[0].id });
  } catch (err) {
    console.error('[Session Error]', err.message);
    res.status(500).json({ error: 'Failed to save session data' });
  }
});

// 3. Audio Upload Endpoint
app.post('/api/audio', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const clientIp = getClientIp(req);
    const { time, ip: reportedIp } = req.body;
    const finalIp = reportedIp || clientIp;
    const timestamp = time || new Date().toISOString();
    const fileExt = 'webm'; // or extract from mimetype
    const fileName = `${finalIp}/${Date.now()}_${crypto.randomUUID()}.${fileExt}`;

    // 1. Upload to Supabase Storage
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('audio-clips')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (storageError) throw storageError;

    // 2. Get Public URL (or use signed URL if private)
    const { data: urlData } = supabaseAdmin.storage
      .from('audio-clips')
      .getPublicUrl(fileName);

    // 3. Save metadata to Database
    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('audio_clips')
      .insert([
        {
          ip_address: finalIp,
          file_path: storageData.path,
          public_url: urlData.publicUrl,
          captured_at: timestamp,
          size_bytes: req.file.size,
          mime_type: req.file.mimetype,
        },
      ])
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
    // Handle Multer file size limit
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max 2MB.' });
    }
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

// --- Error Handling Middleware ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[Global Error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
