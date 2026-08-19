/**
 * server.js — Sipariş Bildirim Paneli (Node.js / Express)
 * WhatsApp Cloud API + MongoDB
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { MongoClient } from 'mongodb';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_DIR = __dirname;

const PORT = parseInt(process.env.PORT || '8000', 10);
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = 'siparis_paneli';
const COL_USERS = 'users';
const COL_SESSIONS = 'sessions';
const COL_PROFILES = 'profiles';
const COL_EXCEL_FILES = 'excel_files';
const COL_STATUSES = 'order_statuses';
const COL_WA_CONFIG = 'whatsapp_config';
const COL_WEBHOOK_LOGS = 'webhook_logs';
const WA_API_BASE = 'https://graph.facebook.com/v25.0';

// ── MongoDB ────────────────────────────────────────────────────────────────────
let _client = null;
let _db = null;

async function getDB() {
    if (_db) return _db;
    if (!MONGODB_URI) throw new Error('MONGODB_URI ortam değişkeni ayarlanmamış.');
    _client = new MongoClient(MONGODB_URI);
    await _client.connect();
    _db = _client.db(DB_NAME);
    console.log('[DB] MongoDB bağlantısı kuruldu.');
    return _db;
}

// ── Kullanıcı ve Kimlik Doğrulama (Auth) ───────────────────────────────────────
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
}

function verifyPassword(password, hash, salt) {
    try {
        const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
    } catch {
        return false;
    }
}

const activeSessions = new Map(); // token -> { username, name, expiresAt }

async function loadSessions() {
    try {
        const db = await getDB();
        const docs = await db.collection(COL_SESSIONS).find({}).toArray();
        activeSessions.clear();
        const now = Date.now();
        for (const doc of docs) {
            if (!doc.expiresAt || doc.expiresAt > now) {
                activeSessions.set(doc.token, {
                    username: doc.username,
                    name: doc.name,
                    expiresAt: doc.expiresAt
                });
            }
        }
    } catch (e) {
        console.error('[Sessions] Yükleme hatası:', e.message);
    }
}

async function saveSession(token, sessionData) {
    activeSessions.set(token, sessionData);
    try {
        const db = await getDB();
        await db.collection(COL_SESSIONS).updateOne(
            { token },
            { $set: { token, ...sessionData } },
            { upsert: true }
        );
    } catch (e) {
        console.error('[Sessions] Kayıt hatası:', e.message);
    }
}

async function deleteSession(token) {
    activeSessions.delete(token);
    try {
        const db = await getDB();
        await db.collection(COL_SESSIONS).deleteOne({ token });
    } catch (e) {
        console.error('[Sessions] Silme hatası:', e.message);
    }
}

async function initUsers() {
    try {
        const db = await getDB();
        const count = await db.collection(COL_USERS).countDocuments();
        if (count === 0) {
            const { hash, salt } = hashPassword('admin123');
            await db.collection(COL_USERS).insertOne({
                username: 'admin',
                password_hash: hash,
                salt: salt,
                name: 'Yönetici',
                created_at: new Date()
            });
            console.log('[Auth] Varsayılan kullanıcı oluşturuldu → Kullanıcı Adı: admin / Şifre: admin123');
        }
    } catch (e) {
        console.error('[Auth] Kullanıcı tablosu başlatma hatası:', e.message);
    }
}

// ── In-memory cache ───────────────────────────────────────────────────────────
let profiles = [];
let sendingStatus = {}; // { orderId: { status, error, hidden, hidden_at, order_data } }

// ── Profil yardımcıları ───────────────────────────────────────────────────────
async function loadProfiles() {
    try {
        const db = await getDB();
        const docs = await db.collection(COL_PROFILES).find({}, { projection: { _id: 0 } }).toArray();
        if (docs.length > 0) {
            profiles = docs;
        } else {
            profiles = [{ id: 'naturan', name: 'Naturan', directory: 'Naturan' }];
            await db.collection(COL_PROFILES).insertMany(profiles.map(p => ({ ...p })));
        }
        for (const p of profiles) {
            const dir = path.join(WORKSPACE_DIR, p.directory || p.id);
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (e) {
        console.error('[Profiles] Yükleme hatası:', e.message);
        profiles = [{ id: 'naturan', name: 'Naturan', directory: 'Naturan' }];
    }
}

async function saveProfile(profile) {
    const db = await getDB();
    await db.collection(COL_PROFILES).updateOne({ id: profile.id }, { $set: profile }, { upsert: true });
}

async function deleteProfileFromDB(profileId) {
    const db = await getDB();
    await db.collection(COL_PROFILES).deleteOne({ id: profileId });
}

function getProfile(profileId) {
    const p = profiles.find(p => p.id === profileId);
    if (!p) throw Object.assign(new Error('Profil bulunamadı.'), { status: 404 });
    return p;
}

function getProfileDirectory(profileId) {
    const p = getProfile(profileId);
    const dir = path.resolve(WORKSPACE_DIR, p.directory || p.id);
    if (!dir.startsWith(path.resolve(WORKSPACE_DIR))) {
        throw Object.assign(new Error('Geçersiz profil klasörü.'), { status: 400 });
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function profileIdFromName(name) {
    return name
        .replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
        .replace(/ş/g, 's').replace(/Ş/g, 'S').replace(/ç/g, 'c').replace(/Ç/g, 'C')
        .replace(/ö/g, 'o').replace(/Ö/g, 'O').replace(/ü/g, 'u').replace(/Ü/g, 'U')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Durum yardımcıları ────────────────────────────────────────────────────────
async function loadStatuses() {
    try {
        const db = await getDB();
        const docs = await db.collection(COL_STATUSES).find({}).toArray();
        sendingStatus = {};
        for (const doc of docs) {
            const id = doc.order_id;
            const { _id, order_id, ...rest } = doc;
            sendingStatus[id] = rest;
        }
    } catch (e) {
        console.error('[Statuses] Yükleme hatası:', e.message);
    }
}

async function saveStatusToDB(orderId) {
    try {
        const db = await getDB();
        const data = sendingStatus[orderId] || {};
        await db.collection(COL_STATUSES).updateOne(
            { order_id: orderId },
            { $set: { order_id: orderId, ...data } },
            { upsert: true }
        );
    } catch (e) {
        console.error('[Statuses] Kayıt hatası:', orderId, e.message);
    }
}

async function deleteStatusFromDB(orderId) {
    try {
        const db = await getDB();
        await db.collection(COL_STATUSES).deleteOne({ order_id: orderId });
    } catch (e) {
        console.error('[Statuses] Silme hatası:', orderId, e.message);
    }
}

async function resetStatusesInDB(profileId) {
    try {
        const db = await getDB();
        await db.collection(COL_STATUSES).deleteMany({ order_id: new RegExp(`^${profileId}\\|`) });
    } catch (e) {
        console.error('[Statuses] Sıfırlama hatası:', e.message);
    }
}

// ── WA Config ──────────────────────────────────────────────────────────────────
async function getWAConfig() {
    let dbConfig = {};
    try {
        const db = await getDB();
        const doc = await db.collection(COL_WA_CONFIG).findOne({ _id: 'main' });
        if (doc) {
            const { _id, ...rest } = doc;
            dbConfig = rest;
        }
    } catch (e) {
        console.error('[WAConfig] Okuma hatası:', e.message);
    }
    return {
        phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        access_token: process.env.WHATSAPP_ACCESS_TOKEN || '',
        template_name: dbConfig.template_name || process.env.WHATSAPP_TEMPLATE_NAME || '',
        template_language: dbConfig.template_language || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'tr',
        parameter_mapping: dbConfig.parameter_mapping || []
    };
}

async function saveWAConfigToDB(config) {
    const db = await getDB();
    const updateData = {
        template_name: config.template_name || '',
        template_language: config.template_language || 'tr',
        parameter_mapping: config.parameter_mapping || []
    };
    await db.collection(COL_WA_CONFIG).updateOne(
        { _id: 'main' },
        { $set: { _id: 'main', ...updateData } },
        { upsert: true }
    );
}

// ── WhatsApp Cloud API ─────────────────────────────────────────────────────────
function getCargoTrackingLink(order) {
    if (!order) return '';
    if (order['Kargo Takip Linki']) return order['Kargo Takip Linki'];
    if (order['Kargo Takip']) return order['Kargo Takip'];
    const cargoCompany = String(order['Kargo Firması'] || order['Kargo'] || order['Kargo Adı'] || '').toLowerCase();
    if (cargoCompany.includes('ptt')) {
        return 'https://www.turkiye.gov.tr/ptt-gonderi-takip';
    }
    if (cargoCompany.includes('surat') || cargoCompany.includes('sürat')) {
        return 'https://suratkargo.com.tr/KargoTakip/';
    }
    return '';
}

function buildTemplateComponents(order, paramMapping) {
    if (!paramMapping || paramMapping.length === 0) return [];
    const sorted = [...paramMapping].sort((a, b) => (a.param_index || 0) - (b.param_index || 0));
    const parameters = sorted.map(p => {
        let val = order?.[p.column];
        if ((val === undefined || val === null || val === '') && (p.column === 'Kargo Takip Linki' || p.column === 'Kargo Takip')) {
            val = getCargoTrackingLink(order);
        } else if (p.column === 'PTT Takip Linki') {
            val = 'https://www.turkiye.gov.tr/ptt-gonderi-takip';
        } else if (p.column === 'Sürat Kargo Takip Linki' || p.column === 'Surat Kargo Takip Linki') {
            val = 'https://suratkargo.com.tr/KargoTakip/';
        }
        return {
            type: 'text',
            text: String(val ?? '')
        };
    });
    if (parameters.length === 0) return [];
    return [{ type: 'body', parameters }];
}

async function sendWhatsAppTemplate(phone, order, waConfig) {
    const { phone_number_id, access_token, template_name, template_language, parameter_mapping } = waConfig;
    if (!phone_number_id || !access_token || !template_name) {
        return { success: false, error: 'WA API yapılandırması eksik.' };
    }

    // Telefon numarasını temizle
    let phoneClean = String(phone).replace(/\D/g, '');
    if (phoneClean.startsWith('0') && phoneClean.length === 11) phoneClean = '90' + phoneClean.slice(1);
    else if (!phoneClean.startsWith('90') && phoneClean.length === 10) phoneClean = '90' + phoneClean;

    const components = buildTemplateComponents(order, parameter_mapping || []);
    const payload = {
        messaging_product: 'whatsapp',
        to: phoneClean,
        type: 'template',
        template: {
            name: template_name,
            language: { code: template_language || 'tr' },
            components
        }
    };

    try {
        const resp = await fetch(`${WA_API_BASE}/${phone_number_id}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (resp.ok && data.messages) {
            return { success: true, message_id: data.messages[0]?.id || '' };
        }
        const err = data.error || {};
        return { success: false, error: err.message || JSON.stringify(data) };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ── Excel Veritabanı Kalıcılığı (MongoDB Sync) ────────────────────────────────
async function saveExcelFileToDB(profileId, filename, buffer) {
    try {
        const db = await getDB();
        await db.collection(COL_EXCEL_FILES).updateOne(
            { profile_id: profileId, filename },
            {
                $set: {
                    profile_id: profileId,
                    filename,
                    data: buffer,
                    updated_at: new Date()
                }
            },
            { upsert: true }
        );
    } catch (e) {
        console.error('[Excel] DB kayıt hatası:', filename, e.message);
    }
}

async function deleteExcelFileFromDB(profileId, filename) {
    try {
        const db = await getDB();
        await db.collection(COL_EXCEL_FILES).deleteOne({ profile_id: profileId, filename });
    } catch (e) {
        console.error('[Excel] DB silme hatası:', filename, e.message);
    }
}

async function syncExcelFilesFromDB() {
    try {
        const db = await getDB();
        const docs = await db.collection(COL_EXCEL_FILES).find({}).toArray();
        let syncedCount = 0;
        for (const doc of docs) {
            try {
                const dir = getProfileDirectory(doc.profile_id);
                const filePath = path.join(dir, doc.filename);
                if (!fs.existsSync(filePath) && doc.data) {
                    const buf = Buffer.isBuffer(doc.data) ? doc.data : doc.data?.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data);
                    fs.writeFileSync(filePath, buf);
                    syncedCount++;
                }
            } catch (err) {
                console.warn(`[Excel Sync] Dosya yazılamadı (${doc.filename}):`, err.message);
            }
        }
        if (syncedCount > 0) {
            console.log(`[Excel Sync] MongoDB'den ${syncedCount} Excel dosyası diske geri yüklendi.`);
        }
    } catch (e) {
        console.error('[Excel Sync] Eşitleme hatası:', e.message);
    }
}

// ── Excel yardımcıları ─────────────────────────────────────────────────────────
async function readExcelFile(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return [];

    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, colNum) => {
        headers[colNum] = cell.value != null ? String(cell.value) : '';
    });

    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
        if (rowNum === 1) return;
        const obj = {};
        headers.forEach((header, colNum) => {
            if (!header) return;
            const cell = row.getCell(colNum);
            let val = cell.value;
            if (val === null || val === undefined) val = '';
            else if (typeof val === 'object' && val instanceof Date) {
                val = val.toISOString().replace('T', ' ').slice(0, 19);
            } else if (typeof val === 'object' && val?.result !== undefined) {
                val = val.result ?? ''; // Formula cell
            } else if (typeof val === 'object' && val?.richText) {
                val = val.richText.map(r => r.text).join('');
            } else {
                val = String(val);
            }
            obj[header] = val;
        });
        rows.push(obj);
    });
    return rows;
}

// ── Gönderim arka plan görevi ──────────────────────────────────────────────────
async function runSendingTask(orderId, phone, order) {
    sendingStatus[orderId] = { ...sendingStatus[orderId], status: 'sending', error: '' };
    await saveStatusToDB(orderId);

    try {
        console.log(`[WA] Cloud API ile gönderiliyor → ${phone} (${orderId})`);
        const waConfig = await getWAConfig();
        const result = await sendWhatsAppTemplate(phone, order, waConfig);

        if (result.success) {
            sendingStatus[orderId] = { ...sendingStatus[orderId], status: 'sent', error: '' };
            console.log(`[WA] Gönderildi → ${phone}`);
        } else {
            sendingStatus[orderId] = { ...sendingStatus[orderId], status: 'failed', error: result.error };
            console.error(`[WA] Başarısız (${phone}): ${result.error}`);
        }
    } catch (e) {
        sendingStatus[orderId] = { ...sendingStatus[orderId], status: 'failed', error: e.message };
        console.error(`[WA] Hata (${phone}):`, e.message);
    }
    await saveStatusToDB(orderId);
}

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();

// Meta X-Hub-Signature-256 doğrulaması için ham gövdeyi (rawBody) yakala
app.use(express.json({
    limit: '50mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use((req, res, next) => {
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});

// Dosya yükleme (multer — memory store, sonra diske yaz)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Health ─────────────────────────────────────────────────────────────────────
app.get(['/api/health', '/health', '/api/ping'], (req, res) => {
    res.json({ ok: true, status: 'ok', timestamp: Date.now() });
});

// ── Meta Webhook Güvenlik Middleware (X-Hub-Signature-256) ─────────────────────
function verifyMetaWebhookSignature(req, res, next) {
    const appSecret = process.env.APP_SECRET || process.env.WHATSAPP_APP_SECRET;

    // Canlı ortamda APP_SECRET varsa imza kontrolü zorunludur
    if (!appSecret) {
        // Geliştirme kolaylığı için APP_SECRET tanımlanmadıysa uyarı vererek geç
        return next();
    }

    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!signatureHeader) {
        console.warn('⚠️ [Webhook Güvenlik] X-Hub-Signature-256 başlığı eksik!');
        return res.status(401).json({ error: 'X-Hub-Signature-256 header missing' });
    }

    const [algo, signature] = String(signatureHeader).split('=');
    if (algo !== 'sha256' || !signature) {
        console.warn('⚠️ [Webhook Güvenlik] Geçersiz imza formatı.');
        return res.status(401).json({ error: 'Invalid signature format' });
    }

    try {
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
        const expectedSignature = crypto
            .createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');

        const sigBuffer = Buffer.from(signature, 'utf8');
        const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

        if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
            console.warn('❌ [Webhook Güvenlik] Geçersiz imza! İstek Meta kaynaklı değil veya APP_SECRET hatalı.');
            return res.status(403).json({ error: 'Invalid webhook signature' });
        }
    } catch (err) {
        console.error('❌ [Webhook Güvenlik] İmza kontrolü sırasında hata:', err.message);
        return res.status(403).json({ error: 'Signature verification error' });
    }

    next();
}

// ── Meta Webhook Asenkron Veri İşleme (Coexistence Destekli) ──────────────────
async function handleWebhookPayload(body) {
    if (!body || body.object !== 'whatsapp_business_account') {
        return;
    }

    const entries = body.entry || [];
    for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
            if (change.field !== 'messages') continue;
            const value = change.value || {};
            const metadata = value.metadata || {};

            // 1. WhatsApp Mesaj Durum Güncellemeleri (sent, delivered, read, failed)
            if (Array.isArray(value.statuses) && value.statuses.length > 0) {
                for (const statusObj of value.statuses) {
                    const recipient = statusObj.recipient_id;
                    const status = statusObj.status; // sent, delivered, read, failed
                    const msgId = statusObj.id;

                    if (status === 'failed') {
                        const errDetails = statusObj.errors ? JSON.stringify(statusObj.errors) : 'Bilinmeyen hata';
                        console.error(`🔴 [WA Status] Mesaj iletilemedi → Alıcı: ${recipient} | ID: ${msgId} | Hata: ${errDetails}`);
                    } else {
                        console.log(`🟢 [WA Status] Durum: ${status.toUpperCase()} → Alıcı: ${recipient} | ID: ${msgId}`);
                    }
                }
            }

            // 2. Müşteriden Gelen Mesajlar (Inbound Messages)
            if (Array.isArray(value.messages) && value.messages.length > 0) {
                for (const msg of value.messages) {
                    const from = msg.from;
                    const msgType = msg.type;
                    let textContent = '';

                    if (msgType === 'text') textContent = msg.text?.body || '';
                    else if (msgType === 'button') textContent = msg.button?.text || '';
                    else if (msgType === 'interactive') textContent = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
                    else textContent = `[${msgType.toUpperCase()} MEDYA/VERİ]`;

                    console.log(`📩 [WA Inbound] Gelen Mesaj → Kimden: ${from} | Tip: ${msgType} | İçerik: "${textContent}"`);
                }
            }

            // 3. COEXISTENCE: Mobil WhatsApp Business Uygulamasından Gönderilen Mesaj Yankıları (smb_message_echoes)
            if (Array.isArray(value.smb_message_echoes) && value.smb_message_echoes.length > 0) {
                for (const echo of value.smb_message_echoes) {
                    const to = echo.to;
                    const msgType = echo.type;
                    const text = echo.text?.body || `[${msgType}]`;
                    console.log(`🔄 [WA Coexistence Echo] Telefondaki SMB uygulamasından mesaj gönderildi → Kime: ${to} | İçerik: "${text}"`);
                }
            }

            // 4. COEXISTENCE: Uygulama Durum Senkronizasyonu (smb_app_state_sync)
            if (Array.isArray(value.smb_app_state_sync) && value.smb_app_state_sync.length > 0) {
                console.log(`📱 [WA Coexistence Sync] SMB App durum senkronizasyon olayı alındı (${value.smb_app_state_sync.length} adet işlem).`);
            }

            // 5. COEXISTENCE: Sohbet Geçmişi Senkronizasyonu (history)
            if (Array.isArray(value.history) && value.history.length > 0) {
                console.log(`📜 [WA Coexistence History] Geçmiş mesaj verisi senkronize edildi (${value.history.length} adet geçmiş mesaj).`);
            }
        }
    }

    // İsteğe bağlı: Webhook olayını MongoDB'ye asenkron arşivle
    try {
        const db = await getDB().catch(() => null);
        if (db) {
            await db.collection(COL_WEBHOOK_LOGS).insertOne({
                received_at: new Date(),
                payload: body
            });
        }
    } catch (dbErr) {
        // Log hatası akışı durdurmaz
    }
}

// ── Webhook Rotaları (GET: Doğrulama, POST: Anında 200 + Asenkron İşleme) ───────

// 1. GET Doğrulama (Meta Hub Challenge)
app.get(['/webhook', '/api/webhook'], (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

    if (mode === 'subscribe' && token && token === verifyToken) {
        console.log('✅ [Webhook] Meta doğrulama isteği başarıyla onaylandı (Challenge yanıtlandı).');
        return res.status(200).send(challenge);
    } else {
        console.warn(`❌ [Webhook] Doğrulama reddedildi! Gelen Token: "${token}" | Beklenen Token: "${verifyToken}"`);
        return res.sendStatus(403);
    }
});

// 2. POST Veri Karşılama (Meta Events & Coexistence)
app.post(['/webhook', '/api/webhook'], verifyMetaWebhookSignature, (req, res) => {
    // ⚡ KRİTİK: Meta'ya anında HTTP 200 OK dön (Senkronizasyonun kopmaması için hiçbir işlem beklemeden)
    res.status(200).send('EVENT_RECEIVED');

    // ⚡ Tüm veri çözümleme ve işleme işlemlerini arka planda asenkron çalıştır
    setImmediate(async () => {
        try {
            await handleWebhookPayload(req.body);
        } catch (err) {
            console.error('❌ [Webhook Async Error] Veri işleme hatası:', err.message);
        }
    });
});

// ── Auth API'leri ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username = '', password = '' } = req.body;
        const cleanUser = String(username).toLowerCase().trim();
        if (!cleanUser || !password) {
            return res.status(400).json({ detail: 'Kullanıcı adı ve şifre gereklidir.' });
        }

        const db = await getDB();
        const user = await db.collection(COL_USERS).findOne({ username: cleanUser });
        if (!user) {
            return res.status(401).json({ detail: 'Kullanıcı adı veya şifre hatalı.' });
        }

        const isValid = verifyPassword(String(password), user.password_hash, user.salt);
        if (!isValid) {
            return res.status(401).json({ detail: 'Kullanıcı adı veya şifre hatalı.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 gün
        await saveSession(token, {
            username: user.username,
            name: user.name || user.username,
            expiresAt
        });

        res.json({
            success: true,
            token,
            user: {
                username: user.username,
                name: user.name || user.username
            }
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : (req.headers['x-auth-token'] || req.query.token || '');
    if (token) await deleteSession(token);
    res.json({ success: true, message: 'Çıkış yapıldı.' });
});

// ── Auth Middleware (Tüm /api rotalarını korur, webhook & health hariç) ────────
app.use('/api', async (req, res, next) => {
    // Giriş, sağlık kontrolü ve webhook hariç
    if (req.path === '/health' || req.path === '/ping' || req.path === '/auth/login' || req.path === '/webhook') {
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : (req.headers['x-auth-token'] || req.query.token || '');

    if (!token) {
        return res.status(401).json({ detail: 'Oturum açmanız gerekiyor.' });
    }

    let session = activeSessions.get(token);
    if (!session) {
        // Fallback DB kontrolü
        try {
            const db = await getDB();
            const doc = await db.collection(COL_SESSIONS).findOne({ token });
            if (doc && (!doc.expiresAt || doc.expiresAt > Date.now())) {
                session = {
                    username: doc.username,
                    name: doc.name,
                    expiresAt: doc.expiresAt
                };
                activeSessions.set(token, session);
            }
        } catch (e) {}
    }

    if (!session) {
        return res.status(401).json({ detail: 'Oturum açmanız gerekiyor.' });
    }

    if (session.expiresAt && Date.now() > session.expiresAt) {
        deleteSession(token);
        return res.status(401).json({ detail: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.' });
    }

    req.user = session;
    next();
});

app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user });
});

// ── Statik dosyalar ────────────────────────────────────────────────────────────
app.get('/script.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'script.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'styles.css')));

// Profil ve Excel klasöründe olmayan her şey için static middleware SONRA gelecek
// Ana sayfa
app.get('/', (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.json({ message: 'index.html bulunamadı.' });
});

// ── Profil API'leri ────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
    res.json({ profiles });
});

app.post('/api/profiles', async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const id = profileIdFromName(name);
        if (!name || !id) return res.status(400).json({ detail: 'Geçerli bir profil adı girin.' });
        if (profiles.find(p => p.id === id)) return res.status(409).json({ detail: 'Bu isimde bir profil zaten var.' });

        const profile = { id, name, directory: id };
        profiles.push(profile);
        fs.mkdirSync(getProfileDirectory(id), { recursive: true });
        await saveProfile(profile);
        res.status(201).json({ profile });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.delete('/api/profiles/:profileId', async (req, res) => {
    try {
        const p = getProfile(req.params.profileId);
        profiles = profiles.filter(x => x.id !== p.id);
        await deleteProfileFromDB(p.id);
        res.json({ status: 'deleted', id: p.id });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

// ── Excel API'leri ────────────────────────────────────────────────────────────
app.get('/api/excel-files', (req, res) => {
    try {
        const dir = getProfileDirectory(req.query.profile);
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
            .sort().reverse();
        res.json({ files });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/upload-excel', upload.array('files'), async (req, res) => {
    try {
        const profile = req.body?.profile || (req.query.profile);
        getProfile(profile);
        const dir = getProfileDirectory(profile);
        const uploaded = [];
        const errors = [];

        const allFiles = req.files || [];
        if (allFiles.length === 0) return res.status(400).json({ detail: 'Hiçbir dosya yüklenmedi.' });

        for (const file of allFiles) {
            if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
                errors.push(`${file.originalname}: Sadece .xlsx uzantılı dosyalar yüklenebilir.`);
                continue;
            }
            const safeName = path.basename(file.originalname);
            try {
                fs.writeFileSync(path.join(dir, safeName), file.buffer);
                await saveExcelFileToDB(profile, safeName, file.buffer);
                uploaded.push(safeName);
            } catch (e) {
                errors.push(`${safeName}: ${e.message}`);
            }
        }

        if (uploaded.length === 0 && errors.length > 0) {
            return res.status(400).json({ detail: errors.join('; ') });
        }
        const msg = uploaded.length > 1
            ? `${uploaded.length} dosya başarıyla yüklendi.`
            : uploaded.length === 1 ? `${uploaded[0]} başarıyla yüklendi.` : '';
        res.json({ status: 'success', uploaded, errors, message: msg });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.delete('/api/excel-files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        if (filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ detail: 'Geçersiz dosya adı.' });
        }
        const dir = getProfileDirectory(req.query.profile);
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        await deleteExcelFileFromDB(req.query.profile, filename);
        res.json({ status: 'deleted', filename, message: `${filename} silindi.` });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

// ── Sipariş API'si ─────────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
    try {
        const { profile, file = 'all' } = req.query;
        const dir = getProfileDirectory(profile);

        const processFile = async (fname) => {
            const fp = path.join(dir, fname);
            const rows = await readExcelFile(fp);
            return rows.map(r => {
                if (!r['ID']) r['ID'] = String(r['Sipariş No'] || r['Sipari No'] || '');
                r['Kaynak Dosya'] = fname;
                r['ID'] = `${profile}|${fname}|${r['ID']}`;
                return r;
            });
        };

        if (file === 'all') {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$')).sort().reverse();
            if (files.length === 0) return res.json({ orders: [], file: 'all' });
            const all = [];
            for (const f of files) {
                try { all.push(...await processFile(f)); } catch (e) { console.warn(`Excel atlandı (${f}):`, e.message); }
            }
            return res.json({ orders: all, file: 'all' });
        }

        if (file.includes('/') || file.includes('\\')) return res.status(400).json({ detail: 'Geçersiz dosya adı.' });
        const fp = path.join(dir, file);
        if (!fs.existsSync(fp)) return res.status(404).json({ detail: `Dosya bulunamadı: ${file}` });
        res.json({ orders: await processFile(file), file });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

// ── Mesaj gönderim API'si ──────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
    try {
        const { id, phone, profile, order } = req.body;
        getProfile(profile);

        if (!sendingStatus[id]) sendingStatus[id] = {};
        sendingStatus[id].status = 'queued';
        sendingStatus[id].error = '';
        if (order) sendingStatus[id].order_data = order;
        await saveStatusToDB(id);

        // Arka planda gönder (non-blocking)
        setImmediate(() => runSendingTask(id, phone, order || {}));
        res.json({ status: 'queued', id });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

// ── WhatsApp durum mock'ları (geriye uyumluluk) ────────────────────────────────
app.get('/api/whatsapp-status', async (req, res) => {
    try {
        const cfg = await getWAConfig();
        if (cfg.phone_number_id && cfg.access_token && cfg.template_name) {
            return res.json({ state: 'connected', mode: 'cloud_api' });
        }
        res.json({ state: 'not_configured', mode: 'cloud_api' });
    } catch (e) {
        res.json({ state: 'not_configured', mode: 'cloud_api' });
    }
});
app.get('/api/whatsapp-qr', (req, res) => res.json({ qr: null, state: 'cloud_api' }));
app.post('/api/whatsapp-connect', (req, res) => res.json({ success: true, state: 'cloud_api' }));
app.post('/api/whatsapp-cancel', (req, res) => res.json({ success: true, state: 'cloud_api' }));
app.post('/api/whatsapp-logout', (req, res) => res.json({ success: true, state: 'cloud_api' }));

// ── WA Config API'leri ─────────────────────────────────────────────────────────
app.get('/api/wa-config', async (req, res) => {
    try {
        const config = await getWAConfig();
        const masked = { ...config };
        const token = masked.access_token || '';
        masked.access_token_masked = token.length > 12
            ? token.slice(0, 8) + '...' + token.slice(-4)
            : '****';
        res.json(masked);
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.post('/api/wa-config', async (req, res) => {
    try {
        await saveWAConfigToDB(req.body);
        res.json({ status: 'saved' });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.post('/api/wa-config/test', async (req, res) => {
    try {
        const config = await getWAConfig();
        if (!config.phone_number_id || !config.access_token) {
            return res.json({ success: false, error: '.env dosyasında WHATSAPP_PHONE_NUMBER_ID veya WHATSAPP_ACCESS_TOKEN tanımlı değil.' });
        }
        const resp = await fetch(`${WA_API_BASE}/${config.phone_number_id}`, {
            headers: { 'Authorization': `Bearer ${config.access_token}` }
        });
        const data = await resp.json();
        if (resp.ok) return res.json({ success: true, phone_info: data });
        const err = data.error || {};
        res.json({ success: false, error: err.message || JSON.stringify(data) });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ── Durum API'leri ─────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    try {
        getProfile(req.query.profile);
        const prefix = `${req.query.profile}|`;
        const result = {};
        for (const [id, val] of Object.entries(sendingStatus)) {
            if (id.startsWith(prefix)) result[id] = val;
        }
        res.json(result);
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/mark-sent', async (req, res) => {
    try {
        const { id, profile, order } = req.body;
        getProfile(profile);
        if (!sendingStatus[id]) sendingStatus[id] = {};
        sendingStatus[id].status = 'sent';
        sendingStatus[id].error = '';
        if (order) sendingStatus[id].order_data = order;
        await saveStatusToDB(id);
        res.json({ status: 'sent', id });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/set-order-status', async (req, res) => {
    try {
        const { id, status, profile, error: errMsg = '', order } = req.body;
        getProfile(profile);
        if (status === 'pending' && !sendingStatus[id]?.hidden) {
            delete sendingStatus[id];
            await deleteStatusFromDB(id);
        } else {
            if (!sendingStatus[id]) sendingStatus[id] = {};
            sendingStatus[id].status = status;
            sendingStatus[id].error = errMsg;
            if (order) sendingStatus[id].order_data = order;
            await saveStatusToDB(id);
        }
        res.json({ status, id });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/hide-order', async (req, res) => {
    try {
        const { id, profile, order } = req.body;
        getProfile(profile);
        if (!sendingStatus[id]) sendingStatus[id] = {};
        sendingStatus[id].hidden = true;
        sendingStatus[id].hidden_at = new Date().toISOString();
        if (order) sendingStatus[id].order_data = order;
        await saveStatusToDB(id);
        res.json({ status: 'hidden', id });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/restore-order', async (req, res) => {
    try {
        const { id, profile, order } = req.body;
        getProfile(profile);
        if (sendingStatus[id]) {
            sendingStatus[id].hidden = false;
            if (order) sendingStatus[id].order_data = order;
            await saveStatusToDB(id);
        }
        res.json({ status: 'restored', id });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/restore-all-orders', async (req, res) => {
    try {
        const { file = 'all', profile } = req.body;
        getProfile(profile);
        const saves = [];
        for (const [id, val] of Object.entries(sendingStatus)) {
            if (!id.startsWith(`${profile}|`)) continue;
            if (!val.hidden) continue;
            if (file !== 'all' && !id.startsWith(`${profile}|${file}|`)) continue;
            sendingStatus[id].hidden = false;
            saves.push(saveStatusToDB(id));
        }
        await Promise.all(saves);
        res.json({ message: `Hidden orders restored for file: ${file}` });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

app.post('/api/reset-status', async (req, res) => {
    try {
        const profile = req.body?.profile || req.query.profile;
        getProfile(profile);
        const prefix = `${profile}|`;
        for (const id of Object.keys(sendingStatus)) {
            if (id.startsWith(prefix)) delete sendingStatus[id];
        }
        await resetStatusesInDB(profile);
        res.json({ status: 'reset', profile });
    } catch (e) {
        res.status(e.status || 500).json({ detail: e.message });
    }
});

// ── Self-ping (Render uyanık tutma) ───────────────────────────────────────────
function startSelfPing() {
    const appUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
    if (!appUrl) {
        console.log('[Self-Ping] RENDER_EXTERNAL_URL bulunamadı (yerel mod).');
        return;
    }
    const healthUrl = appUrl.replace(/\/$/, '') + '/api/health';
    console.log(`[Self-Ping] Başlatıldı → ${healthUrl}`);
    setInterval(async () => {
        try {
            const r = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) });
            console.log(`✓ [Self-Ping] ${r.status}`);
        } catch (e) {
            console.warn(`⚠️ [Self-Ping] ${e.message}`);
        }
    }, 120_000);
}

// ── Başlat ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('[Server] Başlatılıyor...');

    await initUsers();
    await loadSessions();
    await loadStatuses();
    await loadProfiles();
    await syncExcelFilesFromDB();

    // Site görselleri ve diğer statik dosyalar
    app.use('/site_gorselleri', express.static(path.join(PUBLIC_DIR, 'site_gorselleri')));
    // Genel public static (favicon vb.)
    app.use(express.static(PUBLIC_DIR, { index: false }));

    startSelfPing();

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Server] http://localhost:${PORT} adresinde çalışıyor`);
        // Yerel modda tarayıcıyı otomatik aç
        if (!process.env.RENDER_EXTERNAL_URL && !process.env.PORT) {
            const url = `http://127.0.0.1:${PORT}`;
            const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
            import('child_process').then(({ exec }) => setTimeout(() => exec(cmd), 1200));
        }
    });
}

main().catch(e => {
    console.error('[Server] Başlatma hatası:', e);
    process.exit(1);
});
