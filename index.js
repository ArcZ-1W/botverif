/* =====================================================
   WA OTP BOT  -  Baileys + Express
   Jalankan:  npm install  &&  npm start
   Pertama kali jalan menanyakan PORT + KEY API, lalu login WA via pairing code.
   Ganti pengaturan: npm run reset  (atau hapus config.json)
   ===================================================== */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_DIR = path.join(__dirname, 'auth');


/* ---------- input terminal ---------- */
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function loadConfig() {
  const reset = process.argv.includes('--reset');
  if (!reset && fs.existsSync(CONFIG_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (c.port && c.key) return c;
    } catch (_) { /* lanjut minta input */ }
  }

  console.log('\n=== Setup pertama ===');
  let port;
  while (true) {
    const p = parseInt(await ask('Port API (contoh 3000): '), 10);
    if (p >= 1 && p <= 65535) { port = p; break; }
    console.log('Port tidak valid (1-65535).');
  }

  let key;
  while (true) {
    const k = await ask('Key API (kosongkan = generate otomatis, min 8 karakter): ');
    if (!k) { key = crypto.randomBytes(24).toString('hex'); break; }
    if (k.length >= 8) { key = k; break; }
    console.log('Key minimal 8 karakter.');
  }

  const cfg = { port, key };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log('\nTersimpan di config.json');
  console.log('PORT :', port);
  console.log('KEY  :', key, '\n(isi key ini di dasbor admin > Pengaturan bot OTP)\n');
  return cfg;
}

/* ---------- helper ---------- */
function normNumber(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d.length >= 9 && d.length <= 15 ? d : null;
}

function keyOk(cfg, k) {
  const a = Buffer.from(String(k || ''));
  const b = Buffer.from(cfg.key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- WhatsApp ---------- */
let sock = null;
let waReady = false;
let botPhone = null;

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Belum login -> minta nomor bot untuk pairing code (sekali saja)
  if (!state.creds.registered && !botPhone) {
    while (!botPhone) {
      botPhone = normNumber(await ask('\nNomor WhatsApp untuk bot (contoh 08123456789): '));
      if (!botPhone) console.log('Nomor tidak valid.');
    }
  }

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { /* pakai versi bawaan */ }

  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    try {
      await delay(1500);
      const raw = await sock.requestPairingCode(botPhone);
      const code = String(raw).replace(/(.{4})(?=.)/g, '$1-');
      console.log('\n🔑 Pairing code:', code);
      console.log('WhatsApp (nomor ' + botPhone + ') > Perangkat tertaut > Tautkan dengan nomor telepon, lalu masukkan kode di atas.\n');
    } catch (e) {
      console.log('Gagal meminta pairing code:', e && e.message);
    }
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      waReady = true;
      console.log('✅ WhatsApp terhubung');
    }
    if (connection === 'close') {
      waReady = false;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Sesi WhatsApp logout. Hapus folder "auth" lalu jalankan ulang untuk pairing.');
        process.exit(1);
      }
      console.log('⚠️  Terputus, menyambung ulang...');
      setTimeout(startWA, 3000);
    }
  });
}

/* ---------- API ----------
   Dipanggil oleh Supabase (pg_net) lewat fungsi xz_otp_send:
   POST {domain}/send-otp
   Authorization: Bearer <key>
   body: { to: "628xxx", code: "123456", app: "Xozen" }
   OTP dibuat & diverifikasi di database, bot hanya mengirim pesan. */
const recent = new Map(); // nomor -> waktu kirim terakhir (pengaman tambahan)

function startAPI(cfg) {
  const app = express();
  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (req, res) => res.json({ ok: true, whatsapp: waReady }));

  app.post('/send-otp', async (req, res) => {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!keyOk(cfg, bearer || req.get('x-api-key'))) {
      return res.status(401).json({ ok: false, error: 'Key API salah.' });
    }
    try {
      const num = normNumber(req.body && req.body.to);
      const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
      const appName = String((req.body && req.body.app) || 'Xozen').slice(0, 30);
      if (!num || code.length < 4 || code.length > 8) {
        return res.status(400).json({ ok: false, error: 'Data tidak valid.' });
      }
      if (!waReady) return res.status(503).json({ ok: false, error: 'Bot WhatsApp belum terhubung.' });

      const now = Date.now();
      if (now - (recent.get(num) || 0) < 15e3) {
        return res.status(429).json({ ok: false, error: 'Terlalu cepat.' });
      }
      recent.set(num, now);

      const jid = num + '@s.whatsapp.net';
      const [chk] = await sock.onWhatsApp(jid);
      if (!chk || !chk.exists) return res.status(404).json({ ok: false, error: 'Nomor tidak terdaftar di WhatsApp.' });
      const target = chk.jid || jid;

      const plain = `*${code}* adalah kode OTP ${appName} kamu.\nBerlaku 10 menit. Jangan bagikan kode ini ke siapa pun.`;
      await sock.sendMessage(target, { text: plain });

      console.log(`[OTP] terkirim ke ${num.slice(0, 4)}****${num.slice(-3)}`);
      res.json({ ok: true });
    } catch (e) {
      console.error('send error:', e && e.message);
      res.status(500).json({ ok: false, error: 'Gagal mengirim OTP.' });
    }
  });

  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  app.listen(cfg.port, () => {
    console.log(`🚀 API jalan di http://localhost:${cfg.port}`);
    console.log('   POST /send-otp  (Authorization: Bearer <key>)');
    console.log('   Isi domain publik + key ini di dasbor admin (Pengaturan bot OTP).');
  });
}

/* ---------- main ---------- */
(async () => {
  const cfg = await loadConfig();
  startAPI(cfg);
  await startWA();
})();
