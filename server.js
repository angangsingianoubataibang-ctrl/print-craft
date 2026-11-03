// print-agent/server.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'printcraft2026';
const SHOP_KEY = process.env.SHOP_KEY || 'shop-key-change-me';
const SESSION_HOURS = 12;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const ORDER_TTL_MS = 30 * 60 * 1000;

if (ADMIN_PASSWORD === 'printcraft2026' || SHOP_KEY === 'shop-key-change-me') {
    console.warn('\n⚠️  Using default credentials. Set ADMIN_PASSWORD and SHOP_KEY env vars for production.\n');
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const JOBS_DIR = path.join(os.tmpdir(), 'printcraft-jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

/* ═══ PERSISTENT CONFIG ═══ */
const PRICES_FILE = path.join(__dirname, 'prices.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_PRICES = {
    passport: { '35x45': 40, '2x2': 50, '35x35': 45 },
    photo: { '4x6': 25, '5x7': 45, '6x8': 60 },
    document: { bw: 2, color: 10, binding: { none: 0, staple: 20, spiral: 50, hardcover: 150 } },
    idcard: { color: 10, bw: 5 }
};

const SERVICES = ['document', 'idcard', 'photo', 'passport'];
const SERVICE_LABELS = { document: 'Xerox / Documents', idcard: 'ID card copy', photo: 'Photo prints', passport: 'Passport photos' };

const DEFAULT_PRINTER_PROFILE = {
    name: '', paper: 'auto', color: 'auto', mediaType: 'auto', orient: 'auto'
};

function newWebhookSecret() {
    return 'wh_' + crypto.randomBytes(24).toString('hex');
}

const DEFAULT_SETTINGS = {
    upiId: 'printcraft@upi',
    payeeName: 'PrintCraft',
    merchantNote: 'Print job',
    currency: 'INR',
    upiEnabled: true,
    cashEnabled: true,
    autoUpiEnabled: false,
    webhookSecret: newWebhookSecret(),
    provider: 'razorpay',

    /* ── SHOP OPEN / CLOSED STATE ──
       Change the two labels below to rename the state everywhere.
       Examples: "Thong Hange" / "Thong Hangdriko" or "Pasal Khula" / "Pasal Banda". */
    shopOpen: true,
    shopOpenLabel: 'Shop Opened',
    shopClosedLabel: 'Shop Closed',

    printers: {
        document: { ...DEFAULT_PRINTER_PROFILE, paper: 'A4', color: 'bw', mediaType: 'plain', orient: 'auto' },
        idcard: { ...DEFAULT_PRINTER_PROFILE, paper: 'A4', color: 'color', mediaType: 'plain', orient: 'auto' },
        photo: { ...DEFAULT_PRINTER_PROFILE, paper: 'auto', color: 'color', mediaType: 'photo', orient: 'auto' },
        passport: { ...DEFAULT_PRINTER_PROFILE, paper: 'auto', color: 'color', mediaType: 'photo', orient: 'auto' }
    }
};

function readJson(file, defaults) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return JSON.parse(JSON.stringify(defaults)); }
}
function mergePrices(saved) {
    return {
        passport: { ...DEFAULT_PRICES.passport, ...(saved.passport || {}) },
        photo: { ...DEFAULT_PRICES.photo, ...(saved.photo || {}) },
        document: {
            ...DEFAULT_PRICES.document, ...(saved.document || {}),
            binding: { ...DEFAULT_PRICES.document.binding, ...((saved.document || {}).binding || {}) }
        },
        idcard: { ...DEFAULT_PRICES.idcard, ...(saved.idcard || {}) }
    };
}
function mergeSettings(saved) {
    const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    if (!s.webhookSecret) s.webhookSecret = newWebhookSecret();
    if (typeof s.autoUpiEnabled !== 'boolean') s.autoUpiEnabled = false;
    if (typeof s.shopOpen !== 'boolean') s.shopOpen = true;
    if (typeof s.shopOpenLabel !== 'string' || !s.shopOpenLabel.trim()) s.shopOpenLabel = DEFAULT_SETTINGS.shopOpenLabel;
    if (typeof s.shopClosedLabel !== 'string' || !s.shopClosedLabel.trim()) s.shopClosedLabel = DEFAULT_SETTINGS.shopClosedLabel;
    const savedP = (saved && saved.printers) || {};
    s.printers = {};
    for (const svc of SERVICES) {
        s.printers[svc] = { ...DEFAULT_SETTINGS.printers[svc], ...(savedP[svc] || {}) };
    }
    return s;
}

let PRICES = mergePrices(readJson(PRICES_FILE, DEFAULT_PRICES));
let SETTINGS = mergeSettings(readJson(SETTINGS_FILE, DEFAULT_SETTINGS));

function savePrices(p) {
    try { fs.writeFileSync(PRICES_FILE, JSON.stringify(p, null, 2), 'utf8'); PRICES = p; return true; }
    catch (e) { console.error('Save prices failed:', e.message); return false; }
}
function saveSettings(s) {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8'); SETTINGS = s; return true; }
    catch (e) { console.error('Save settings failed:', e.message); return false; }
}

function shopState() {
    const open = SETTINGS.shopOpen !== false;
    return {
        shopOpen: open,
        shopLabel: open ? SETTINGS.shopOpenLabel : SETTINGS.shopClosedLabel
    };
}

/* ═══ CORS — allow any origin (public shop front-ends) ═══
   Express 5 note: app.options('*', ...) is not supported. */
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-shop-key', 'x-auth-token'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    maxAge: 86400
}));

app.use(express.json({ limit: '1mb' }));

/* ═══ HEALTH CHECK ═══
   Hit this from any device to verify the server is reachable:
   https://<your-funnel-host>/api/ping */
app.get('/api/ping', (req, res) => {
    res.json({
        ok: true,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        platform: process.platform,
        shopOpen: SETTINGS.shopOpen !== false,
        shopLabel: SETTINGS.shopOpen !== false ? SETTINGS.shopOpenLabel : SETTINGS.shopClosedLabel,
        time: new Date().toISOString()
    });
});

/* ═══ MULTER ABORT HANDLER ═══
   When mobile clients disconnect mid-upload (slow networks), multer throws
   "Request aborted". This is harmless — the client just navigated away. */
app.use((err, req, res, next) => {
    if (err && err.message === 'Request aborted') {
        console.warn(`[http] client aborted: ${req.method} ${req.url}`);
        return;
    }
    if (err) {
        console.error('[http] error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

/* ═══ SESSIONS ═══ */
const sessions = new Map();
const attempts = new Map();
const activeVisitors = new Map();
const VISITOR_TTL_MS = 90 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
    for (const [k, v] of attempts) if (now - v.firstAt > LOCKOUT_MS) attempts.delete(k);
    for (const [k, v] of activeVisitors) if (v.expires < now) activeVisitors.delete(k);
}, 10 * 60 * 1000);

function adminMW(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token || !sessions.has(token)) return res.status(401).json({ error: 'unauthorized' });
    const s = sessions.get(token);
    if (s.expires < Date.now()) { sessions.delete(token); return res.status(401).json({ error: 'expired' }); }
    req.token = token;
    next();
}
function shopMW(req, res, next) {
    if (req.headers['x-shop-key'] !== SHOP_KEY) return res.status(401).json({ error: 'invalid-shop-key' });
    next();
}
function registerVisitorSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    const now = Date.now();
    activeVisitors.set(sessionId, { expires: now + VISITOR_TTL_MS, lastSeen: now });
    return sessionId;
}
/* Blocks customer-facing operations when the shop is closed */
function shopOpenMW(req, res, next) {
    if (SETTINGS.shopOpen === false) {
        const label = SETTINGS.shopClosedLabel || 'Shop Closed';
        return res.status(503).json({ error: 'shop-closed', shopLabel: label });
    }
    next();
}

/* ═══ AUTH ═══ */
app.post('/api/login', (req, res) => {
    const ip = (req.ip || 'unknown').replace(/^::ffff:/, '');
    const now = Date.now();
    const a = attempts.get(ip);
    if (a && now - a.firstAt < LOCKOUT_MS && a.count >= MAX_ATTEMPTS) {
        const wait = Math.ceil((LOCKOUT_MS - (now - a.firstAt)) / 1000);
        return res.status(429).json({ error: 'too-many-attempts', retryAfter: wait });
    }
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'missing' });
    const aBuf = Buffer.from(password, 'utf8');
    const bBuf = Buffer.from(ADMIN_PASSWORD, 'utf8');
    const len = Math.max(aBuf.length, bBuf.length);
    const padA = Buffer.alloc(len); aBuf.copy(padA);
    const padB = Buffer.alloc(len); bBuf.copy(padB);
    const same = crypto.timingSafeEqual(padA, padB) && aBuf.length === bBuf.length;
    if (!same) {
        if (!a || now - a.firstAt > LOCKOUT_MS) attempts.set(ip, { count: 1, firstAt: now });
        else a.count++;
        return res.status(401).json({ error: 'invalid' });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expires: now + SESSION_HOURS * 3600 * 1000 });
    res.json({ token, expiresInHours: SESSION_HOURS });
});

app.post('/api/visitor/heartbeat', (req, res) => {
    const sessionId = (req.body && req.body.sessionId) || (req.headers['x-session-id'] || crypto.randomBytes(16).toString('hex'));
    const id = registerVisitorSession(String(sessionId));
    if (!id) {
        return res.status(400).json({ ok: false, error: 'invalid-session-id' });
    }
    res.json({ ok: true, sessionId: id, activeUsers: activeVisitors.size });
});

app.get('/api/visitor/count', (req, res) => {
    const count = activeVisitors.size;
    res.json({ ok: true, activeUsers: count, total: count });
});

app.post('/api/logout', adminMW, (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });
app.get('/api/auth', adminMW, (req, res) => res.json({ ok: true }));

/* ═══ STATUS ═══ */
app.get('/api/status', (req, res) => {
    const shop = shopState();
    const activeUsers = activeVisitors.size;
    if (process.platform !== 'win32') {
        return res.json({
            online: true,
            shopOpen: shop.shopOpen,
            shopLabel: shop.shopLabel,
            activeUsers,
            printers: [],
            platform: process.platform,
            uptime: Math.round(process.uptime())
        });
    }
    execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Printer | Select-Object -ExpandProperty Name'
    ], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        const printers = err ? [] : stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        res.json({
            online: true,
            shopOpen: shop.shopOpen,
            shopLabel: shop.shopLabel,
            activeUsers,
            printers,
            platform: 'win32',
            sumatra: !!findSumatra(),
            uptime: Math.round(process.uptime())
        });
    });
});

/* ═══ SHOP OPEN / CLOSED ═══ */
app.get('/api/shop', (req, res) => res.json(shopState()));

app.post('/api/shop/toggle', adminMW, (req, res) => {
    const next = { ...SETTINGS, shopOpen: !SETTINGS.shopOpen };
    if (!saveSettings(next)) return res.status(500).json({ error: 'save-failed' });
    const shop = shopState();
    console.log(`[shop] ${shop.shopOpen ? 'OPENED' : 'CLOSED'} (label: "${shop.shopLabel}")`);
    res.json({ ok: true, ...shop });
});

app.post('/api/shop/state', adminMW, (req, res) => {
    const b = req.body || {};
    const next = { ...SETTINGS };
    if (typeof b.shopOpen === 'boolean') next.shopOpen = b.shopOpen;
    if (typeof b.shopOpenLabel === 'string' && b.shopOpenLabel.trim()) next.shopOpenLabel = b.shopOpenLabel.trim().slice(0, 40);
    if (typeof b.shopClosedLabel === 'string' && b.shopClosedLabel.trim()) next.shopClosedLabel = b.shopClosedLabel.trim().slice(0, 40);
    if (!saveSettings(next)) return res.status(500).json({ error: 'save-failed' });
    const shop = shopState();
    console.log(`[shop] state updated → ${shop.shopOpen ? 'OPENED' : 'CLOSED'} ("${shop.shopLabel}")`);
    res.json({ ok: true, ...shop });
});

/* ═══ PRICES ═══ */
app.get('/api/prices', (req, res) => res.json(PRICES));

app.post('/api/prices', adminMW, (req, res) => {
    const b = req.body || {};
    const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fb; };
    const c = PRICES;
    const next = {
        passport: {
            '35x45': num(b.passport?.['35x45'], c.passport['35x45']),
            '2x2': num(b.passport?.['2x2'], c.passport['2x2']),
            '35x35': num(b.passport?.['35x35'], c.passport['35x35'])
        },
        photo: {
            '4x6': num(b.photo?.['4x6'], c.photo['4x6']),
            '5x7': num(b.photo?.['5x7'], c.photo['5x7']),
            '6x8': num(b.photo?.['6x8'], c.photo['6x8'])
        },
        document: {
            bw: num(b.document?.bw, c.document.bw),
            color: num(b.document?.color, c.document.color),
            binding: {
                none: num(b.document?.binding?.none, c.document.binding.none),
                staple: num(b.document?.binding?.staple, c.document.binding.staple),
                spiral: num(b.document?.binding?.spiral, c.document.binding.spiral),
                hardcover: num(b.document?.binding?.hardcover, c.document.binding.hardcover)
            }
        },
        idcard: {
            color: num(b.idcard?.color, c.idcard.color),
            bw: num(b.idcard?.bw, c.idcard.bw)
        }
    };
    if (!savePrices(next)) return res.status(500).json({ error: 'save-failed' });
    console.log('[prices] updated');
    res.json({ ok: true, prices: next });
});

/* ═══ SETTINGS (UPI + PRINTER ROUTING + SHOP STATE) ═══ */
app.get('/api/settings', (req, res) => {
    const safe = { ...SETTINGS, ...shopState() };
    res.json(safe);
});

app.get('/api/settings/admin', adminMW, (req, res) => res.json(SETTINGS));

function parsePrinter(incoming, current) {
    const str = (v, fb, max = 80) => typeof v === 'string' ? v.trim().slice(0, max) : fb;
    const enumv = (v, allowed, fb) => allowed.includes(v) ? v : fb;
    const inc = incoming || {};
    return {
        name: str(inc.name, current.name, 80),
        paper: enumv(inc.paper, ['auto', 'A4', '4x6', '5x7', '6x8', '10x15', 'A5', 'Letter'], current.paper),
        color: enumv(inc.color, ['auto', 'color', 'bw'], current.color),
        mediaType: enumv(inc.mediaType, ['auto', 'plain', 'photo', 'glossy', 'matte', 'satin'], current.mediaType),
        orient: enumv(inc.orient, ['auto', 'portrait', 'landscape'], current.orient)
    };
}

app.post('/api/settings', adminMW, (req, res) => {
    const b = req.body || {};
    const str = (v, fb, max = 80) => typeof v === 'string' ? v.trim().slice(0, max) : fb;
    const bool = (v, fb) => typeof v === 'boolean' ? v : fb;

    const curP = SETTINGS.printers || DEFAULT_SETTINGS.printers;
    const nextP = {};
    for (const svc of SERVICES) {
        nextP[svc] = parsePrinter((b.printers || {})[svc], curP[svc]);
    }

    const next = {
        upiId: str(b.upiId, SETTINGS.upiId, 80) || DEFAULT_SETTINGS.upiId,
        payeeName: str(b.payeeName, SETTINGS.payeeName, 80) || DEFAULT_SETTINGS.payeeName,
        merchantNote: str(b.merchantNote, SETTINGS.merchantNote, 80),
        currency: str(b.currency, SETTINGS.currency, 8) || 'INR',
        upiEnabled: bool(b.upiEnabled, SETTINGS.upiEnabled),
        cashEnabled: bool(b.cashEnabled, SETTINGS.cashEnabled),
        autoUpiEnabled: bool(b.autoUpiEnabled, SETTINGS.autoUpiEnabled),
        provider: str(b.provider, SETTINGS.provider, 40) || 'razorpay',
        webhookSecret: SETTINGS.webhookSecret, /* never overwrite via API */

        /* shop state — optional overrides */
        shopOpen: bool(b.shopOpen, SETTINGS.shopOpen),
        shopOpenLabel: str(b.shopOpenLabel, SETTINGS.shopOpenLabel, 40) || SETTINGS.shopOpenLabel,
        shopClosedLabel: str(b.shopClosedLabel, SETTINGS.shopClosedLabel, 40) || SETTINGS.shopClosedLabel,

        printers: nextP
    };
    if (!saveSettings(next)) return res.status(500).json({ error: 'save-failed' });
    console.log('[settings] updated');
    res.json({ ok: true, settings: next });
});

app.post('/api/settings/rotate-webhook', adminMW, (req, res) => {
    const next = { ...SETTINGS, webhookSecret: newWebhookSecret() };
    if (!saveSettings(next)) return res.status(500).json({ error: 'save-failed' });
    console.log('[settings] webhook secret rotated');
    res.json({ ok: true, webhookSecret: next.webhookSecret });
});

/* ═══ AUTO PAYMENT ═══ */
const pendingOrders = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [id, o] of pendingOrders) if (now - o.createdAt > ORDER_TTL_MS) pendingOrders.delete(id);
}, 5 * 60 * 1000);

app.post('/api/payment/order', shopMW, shopOpenMW, (req, res) => {
    const { amount, jobId, service } = req.body || {};
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'invalid-amount' });
    const orderId = 'ORD-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6).toUpperCase();
    pendingOrders.set(orderId, {
        amount: amt,
        jobId: String(jobId || '').slice(0, 40),
        service: String(service || '').slice(0, 20),
        createdAt: Date.now(),
        paid: false,
        paymentRef: null,
        paidAt: null
    });
    console.log(`[payment] order created: ${orderId} ₹${amt.toFixed(2)} (${service})`);
    res.json({
        ok: true,
        orderId, amount: amt,
        upiId: SETTINGS.upiId,
        payeeName: SETTINGS.payeeName,
        note: SETTINGS.merchantNote,
        autoVerify: SETTINGS.autoUpiEnabled === true
    });
});

app.get('/api/payment/status/:orderId', shopMW, (req, res) => {
    const o = pendingOrders.get(req.params.orderId);
    if (!o) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, paid: !!o.paid, amount: o.amount, paymentRef: o.paymentRef, paidAt: o.paidAt });
});

app.post('/api/payment/webhook/:secret', (req, res) => {
    if (!SETTINGS.webhookSecret || req.params.secret !== SETTINGS.webhookSecret) {
        return res.status(401).json({ error: 'invalid-secret' });
    }
    const b = req.body || {};
    const rawAmount = b.amount ?? b.paid_amount ?? b.payment_amount ?? b.transaction_amount
        ?? b.data?.amount ?? b.payload?.payment?.entity?.amount ?? 0;
    const amountInPaise = b.amount_in_paise === true
        || (b.currency === 'INR' && Number(rawAmount) > 1000)
        || b.data?.amount !== undefined;
    const amount = Number(rawAmount) / (amountInPaise ? 100 : 1);
    const orderId = String(
        b.order_id || b.merchant_order_id || b.orderId || b.reference ||
        b.remarks?.orderId || b.data?.order_id || b.payload?.payment?.entity?.notes?.orderId || ''
    ).trim();
    const paymentRef = String(
        b.payment_id || b.txn_id || b.transaction_id || b.upi_transaction_id ||
        b.razorpay_payment_id || b.data?.payment_id || b.payload?.payment?.entity?.id || ''
    ).trim();

    console.log(`[payment] webhook: orderId='${orderId}' amount=${amount} ref='${paymentRef}'`);

    let match = null;
    if (orderId && pendingOrders.has(orderId)) {
        match = { id: orderId, o: pendingOrders.get(orderId) };
    } else {
        const tol = 0.5;
        for (const [id, o] of pendingOrders) {
            if (o.paid) continue;
            if (Math.abs(o.amount - amount) <= tol) { match = { id, o }; break; }
        }
    }
    if (!match) {
        console.warn('[payment] webhook: no matching order');
        return res.json({ ok: true, matched: false });
    }
    match.o.paid = true;
    match.o.paymentRef = paymentRef || 'webhook';
    match.o.paidAt = Date.now();
    console.log(`[payment] ${match.id} marked PAID`);
    res.json({ ok: true, matched: true, orderId: match.id });
});

app.post('/api/payment/mark-paid', adminMW, (req, res) => {
    const { orderId, paymentRef } = req.body || {};
    const o = pendingOrders.get(orderId);
    if (!o) return res.status(404).json({ error: 'not-found' });
    o.paid = true;
    o.paymentRef = paymentRef || 'manual';
    o.paidAt = Date.now();
    console.log(`[payment] ${orderId} marked PAID manually`);
    res.json({ ok: true, orderId, paid: true });
});

app.post('/api/payment/cancel', adminMW, (req, res) => {
    const { orderId } = req.body || {};
    if (!pendingOrders.has(orderId)) return res.status(404).json({ error: 'not-found' });
    pendingOrders.delete(orderId);
    res.json({ ok: true });
});

app.get('/api/payment/pending', adminMW, (req, res) => {
    const list = [...pendingOrders].map(([id, o]) => ({ orderId: id, ...o }))
        .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
});

/* ═══ PRINT ═══ */
const upload = multer({ dest: JOBS_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

function resolveJobSettings(service, clientBody) {
    const profile = (SETTINGS.printers && SETTINGS.printers[service]) || DEFAULT_PRINTER_PROFILE;
    const pick = (adminVal, clientVal, fallback) => {
        if (adminVal && adminVal !== 'auto') return adminVal;
        if (clientVal && clientVal !== 'auto') return clientVal;
        return fallback;
    };
    return {
        printer: profile.name || clientBody.printer || '',
        paper: pick(profile.paper, clientBody.paper, 'A4'),
        color: pick(profile.color, clientBody.color, 'color'),
        mediaType: pick(profile.mediaType, clientBody.mediaType, ''),
        orient: pick(profile.orient, clientBody.orient, 'auto')
    };
}

/* ═══ Borderless rule ═══
   Borderless ONLY for the full-photo print service at 4×6, 5×7 or 6×8.
   Not for passport (tiled), not for idcard, not for document, not for A4.
   Change this single function if the rule ever needs to be different. */
function isBorderlessJob(service, paper) {
    return service === 'photo' && (paper === '4x6' || paper === '5x7' || paper === '6x8');
}

app.post('/api/print', shopMW, shopOpenMW, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'no-file' });
    const service = (req.body.service || '').trim();
    const resolved = resolveJobSettings(service, req.body);

    const copies = Math.min(Math.max(parseInt(req.body.copies) || 1, 1), 20);
    const jobId = (req.body.jobId || 'job').replace(/[^\w-]/g, '') || 'job';

    const origExt = path.extname(req.file.originalname || '').toLowerCase();
    const ext = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(origExt) ? origExt : '.png';
    const finalPath = req.file.path + ext;
    fs.renameSync(req.file.path, finalPath);

    const borderless = isBorderlessJob(service, resolved.paper);

    console.log(`[print] ${jobId} svc=${service || '?'} → ${ext} → ${resolved.printer || 'default'} × ${copies} | paper=${resolved.paper} color=${resolved.color} orient=${resolved.orient} media=${resolved.mediaType || 'default'} borderless=${borderless}`);

    // Respond immediately so the client (and any tunnel in between) doesn't time out.
    res.json({
        success: true, jobId, copies, service,
        printer: resolved.printer || 'default',
        paper: resolved.paper, color: resolved.color,
        orient: resolved.orient, mediaType: resolved.mediaType,
        borderless
    });

    // Print in the background. Errors are logged but won't reach the client.
    (async () => {
        try {
            for (let i = 0; i < copies; i++) {
                await printOnce(finalPath, resolved.printer, jobId, i + 1, copies, resolved.paper, resolved.color, resolved.orient, resolved.mediaType, borderless);
            }
            setTimeout(() => fs.unlink(finalPath, () => { }), 60 * 1000);
            console.log(`[print] ${jobId} done`);
        } catch (err) {
            console.error(`[print] ${jobId} FAILED:`, err.message);
        }
    })();
});

async function printOnce(filePath, printer, jobId, copyNum, total, paper, color, orient, mediaType, borderless) {
    const isPdf = filePath.toLowerCase().endsWith('.pdf');
    console.log(`[print] ${jobId} copy ${copyNum}/${total} → ${isPdf ? 'PDF' : 'image'} | ${paper} ${orient} ${color} ${mediaType || ''} ${borderless ? 'BORDERLESS' : ''}`);
    if (isPdf) return printPdf(filePath, printer, paper, color, orient);
    return printImage(filePath, printer, paper, color, orient, mediaType, borderless);
}

/* ═══ PDF VIA SUMATRA ═══ */
function findSumatra() {
    const candidates = [
        path.join(__dirname, 'SumatraPDF.exe'),
        'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
        'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
        path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe')
    ];
    for (const p of candidates) if (p && fs.existsSync(p)) return p;
    return null;
}

function printPdf(filePath, printer, paper, color, orient) {
    return new Promise((resolve, reject) => {
        const sumatra = findSumatra();
        if (!sumatra) return reject(new Error('SumatraPDF.exe not found.'));

        const settings = [];
        if (paper === '4x6') settings.push('paper=4x6');
        else if (paper === 'A4') settings.push('paper=A4');
        if (color === 'color') settings.push('color');
        else if (color === 'bw') settings.push('monochrome');

        // Only force orientation when explicitly requested.
        // 'auto' (or empty) lets SumatraPDF use the PDF's own page orientation.
        if (orient === 'portrait' || orient === 'landscape') {
            settings.push('orientation=' + orient);
        }

        const args = printer ? ['-print-to', printer] : ['-print-to-default'];
        if (settings.length) {
            args.push('-print-settings', settings.join(','));
        }
        args.push('-silent', '-exit-when-done', filePath);

        console.log(`[sumatra] ${sumatra}`, JSON.stringify(args));

        execFile(sumatra, args, { windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
            if (err) {
                const code = err.code !== undefined ? err.code : 'n/a';
                const signal = err.signal || 'n/a';
                const errMsg = (stderr || '').toString().trim();
                const outMsg = (stdout || '').toString().trim();
                console.error(`[sumatra] exit=${code} signal=${signal}`);
                if (errMsg) console.error(`[sumatra] stderr: ${errMsg.slice(0, 500)}`);
                if (outMsg) console.error(`[sumatra] stdout: ${outMsg.slice(0, 500)}`);
                return reject(new Error(`SumatraPDF: exit ${code}${errMsg ? ' · ' + errMsg.slice(0, 300) : ' (no stderr)'}`));
            }
            if (stdout && stdout.toString().trim()) {
                console.log(`[sumatra] ${stdout.toString().trim()}`);
            }
            resolve();
        });
    });
}

/* ═══ IMAGE PRINT — per-job ticket, no admin required ═══
   borderless is passed in by the caller and honoured ONLY when true. */
function printImage(imagePath, printerName, paper, color, orient, mediaType, borderless) {
    return new Promise((resolve, reject) => {
        const escPath = imagePath.replace(/'/g, "''");
        const escPrinter = (printerName || '').replace(/'/g, "''");
        const wantLandscape = orient === 'landscape';
        const forceColor = color !== 'bw';
        const wantPhoto = mediaType === 'photo' || mediaType === 'glossy' || mediaType === 'satin';
        const wantBorderless = borderless === true;

        let targetW, targetH, paperNameHint;
        if (paper === '4x6') { targetW = 400; targetH = 600; paperNameHint = '4x6 / 10x15cm / Postcard'; }
        else if (paper === '5x7') { targetW = 500; targetH = 700; paperNameHint = '5x7 in'; }
        else if (paper === '6x8') { targetW = 600; targetH = 800; paperNameHint = '6x8 in'; }
        else if (paper === '10x15') { targetW = 394; targetH = 591; paperNameHint = '10x15 cm'; }
        else { targetW = 827; targetH = 1169; paperNameHint = 'A4'; }

        const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Printing -ErrorAction SilentlyContinue

$wantLandscape = ${wantLandscape ? '$true' : '$false'}
$wantColor = ${forceColor ? '$true' : '$false'}
$wantPhoto = ${wantPhoto ? '$true' : '$false'}
$wantBorderless = ${wantBorderless ? '$true' : '$false'}
$paperKey = '${paper}'

$queueName = ${escPrinter ? `'${escPrinter}'` : '$null'}

$srv = New-Object System.Printing.LocalPrintServer
$queue = $null
if ($queueName) {
    try { $queue = $srv.GetPrintQueue($queueName) } catch { $queue = $null }
}
if (-not $queue) { $queue = $srv.DefaultPrintQueue }
if (-not $queue) { throw "No usable print queue found" }
Write-Host ("Using queue: " + $queue.FullName)

$baseTicket = $queue.DefaultPrintTicket
if (-not $baseTicket) { $baseTicket = New-Object System.Printing.PrintTicket }
$ticket = $baseTicket.Clone()

if ($wantPhoto) { $ticket.PageMediaType = [System.Printing.PageMediaType]::PhotographicGlossy }
else { $ticket.PageMediaType = [System.Printing.PageMediaType]::Plain }

if ($wantColor) { $ticket.OutputColor = [System.Printing.OutputColor]::Color }
else { $ticket.OutputColor = [System.Printing.OutputColor]::Monochrome }

if ($wantLandscape) { $ticket.PageOrientation = [System.Printing.PageOrientation]::Landscape }
else { $ticket.PageOrientation = [System.Printing.PageOrientation]::Portrait }

$sizeMap = @{
  '4x6'    = @([System.Printing.PageMediaSizeName]::NorthAmerica4x6, [System.Printing.PageMediaSizeName]::Photo4x6)
  '5x7'    = @([System.Printing.PageMediaSizeName]::NorthAmerica5x7)
  '10x15'  = @([System.Printing.PageMediaSizeName]::Photo10x15)
  'A4'     = @([System.Printing.PageMediaSizeName]::ISOA4)
  'A5'     = @([System.Printing.PageMediaSizeName]::ISOA5)
  'Letter' = @([System.Printing.PageMediaSizeName]::NorthAmericaLetter)
}
try {
    $caps = $queue.GetPrintCapabilities()
    $wantedNames = $sizeMap[$paperKey]
    if ($wantedNames -and $wantedNames.Count -gt 0) {
        foreach ($sz in $caps.PageMediaSizeCapability) {
            if ($wantedNames -contains $sz.PageMediaSizeName) {
                $ticket.PageMediaSize = $sz
                Write-Host ("Ticket paper: " + $sz.PageMediaSizeName)
                break
            }
        }
    }
    # Borderless — ONLY when explicitly requested by the caller.
    # The caller enables this only for the full-photo service at 4x6 / 5x7 / 6x8.
    if ($wantBorderless) {
        foreach ($b in $caps.PageBorderlessCapability) {
            if ($b -eq [System.Printing.PageBorderless]::Borderless) {
                $ticket.PageBorderless = [System.Printing.PageBorderless]::Borderless
                Write-Host "Borderless: enabled on ticket"
                break
            }
        }
    } else {
        Write-Host "Borderless: NOT requested - keeping driver default"
    }
} catch { Write-Host ("Capability query failed: " + $_) }

try {
    $queue.CurrentJobSettings.CurrentPrintTicket = $ticket
    Write-Host "Ticket attached to next job (no queue commit)"
} catch {
    Write-Host ("Could not attach per-job ticket, using driver defaults: " + $_)
}

$img = [System.Drawing.Image]::FromFile('${escPath}')

try {
    $doc = New-Object System.Drawing.Printing.PrintDocument
    if ($queueName) { $doc.PrinterSettings.PrinterName = $queueName }
    if (-not $doc.PrinterSettings.IsValid) { throw "Printer is not valid or not ready" }

    $matched = $null
    $allSizes = @()
    foreach ($ps in $doc.PrinterSettings.PaperSizes) {
        $name = $ps.PaperName
        $allSizes += ($name + ' (' + $ps.Width + 'x' + $ps.Height + ')')
        if ($paperKey -eq '4x6') {
            if ($name -match '10x15|4x6|4R|Postcard' -and $name -notmatch 'A6') { $matched = $ps; break }
        } elseif ($paperKey -eq 'A4') {
            if ($name -match '\\bA4\\b') { $matched = $ps; break }
        } elseif ($paperKey -eq '5x7') {
            if ($name -match '5x7|13x18') { $matched = $ps; break }
        }
    }
    if (-not $matched) {
        foreach ($ps in $doc.PrinterSettings.PaperSizes) {
            $wD = [Math]::Abs($ps.Width - $targetW)
            $hD = [Math]::Abs($ps.Height - $targetH)
            $wS = [Math]::Abs($ps.Width - $targetH)
            $hS = [Math]::Abs($ps.Height - $targetW)
            if (($wD -lt 12 -and $hD -lt 12) -or ($wS -lt 12 -and $hS -lt 12)) { $matched = $ps; break }
        }
    }
    if (-not $matched) { throw "No paper size close to ${paperNameHint}. Supported: " + ($allSizes -join ', ') }

    $doc.DefaultPageSettings.PaperSize = $matched
    $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    $doc.DefaultPageSettings.Landscape = $wantLandscape
    $doc.DefaultPageSettings.Color = $wantColor
    $doc.OriginAtMargins = $false

    $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

    $doc.add_PrintPage({
        param($sender, $e)
        $g = $e.Graphics
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

        $bounds = $e.PageBounds
        $pageIsLandscape = $bounds.Width -gt $bounds.Height
        Write-Host ("PageBounds=" + $bounds.Width + "x" + $bounds.Height)

        if ($wantLandscape -ne $pageIsLandscape) {
            $g.TranslateTransform($bounds.Width, 0)
            $g.RotateTransform(90)
            $g.DrawImage($img, 0, 0, $bounds.Height, $bounds.Width)
        } else {
            $g.DrawImage($img, $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
        }
    })

    $doc.Print()
} finally {
    $img.Dispose()
}
`;

        const scriptPath = path.join(JOBS_DIR, `print-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ps1`);
        fs.writeFileSync(scriptPath, psScript, 'utf8');
        console.log(`[print] Image: paper=${paper} orient=${orient} color=${color} media=${mediaType || 'default'} borderless=${wantBorderless}`);
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath
        ], { windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
            fs.unlink(scriptPath, () => { });
            if (err) {
                const msg = (stderr || err.message).toString().trim().slice(0, 500);
                return reject(new Error(`Print image failed: ${msg}`));
            }
            if (stdout) console.log(`[print] ${stdout.toString().trim()}`);
            resolve();
        });
    });
}

/* ═══ STARTUP PRINTER REPORT ═══ */
function querySystemDefault() {
    if (process.platform !== 'win32') return null;
    try {
        const script = `
$ErrorActionPreference = 'SilentlyContinue'
$printers = Get-CimInstance -ClassName Win32_Printer
$default = $printers | Where-Object { $_.Default -eq $true } | Select-Object -First 1
if (-not $default) { return }
$name = $default.Name
$paper = '?'; $media = '?'; $col = '?'
try {
    Add-Type -AssemblyName System.Printing
    $srv = New-Object System.Printing.LocalPrintServer
    $q = $srv.GetPrintQueue($name)
    $t = $q.DefaultPrintTicket
    $paper = $t.PageMediaSize.PageMediaSizeName
    $media = $t.PageMediaType
    $col   = $t.OutputColor
} catch {}
[PSCustomObject]@{ Name=$name; Paper=$paper; Media=$media; Color=$col } | ConvertTo-Json -Compress
`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, timeout: 5000, encoding: 'utf8'
        }).trim();
        if (!out) return null;
        return JSON.parse(out);
    } catch { return null; }
}

function reportPrinterConfig(printers) {
    const sys = querySystemDefault();
    console.log('\n── System default printer ──');
    if (sys) {
        console.log(`  ${sys.Name}`);
        console.log(`    Paper size : ${sys.Paper}`);
        console.log(`    Media type : ${sys.Media}`);
        console.log(`    Colour     : ${sys.Color}`);
    } else {
        console.log('  (none detected)');
    }

    console.log('\n── Per-service printer routing ──');
    console.log('  Service        Printer                        Paper   Colour  Media           Orient');
    console.log('  ─────────────  ─────────────────────────────  ──────  ──────  ──────────────  ──────────');
    for (const svc of SERVICES) {
        const p = SETTINGS.printers[svc];
        const label = SERVICE_LABELS[svc].padEnd(14).slice(0, 14);
        const name = (p.name || '(system default)').padEnd(29).slice(0, 29);
        const paper = (p.paper || 'auto').padEnd(6).slice(0, 6);
        const colour = (p.color || 'auto').padEnd(6).slice(0, 6);
        const media = (p.mediaType || 'auto').padEnd(14).slice(0, 14);
        const orient = p.orient || 'auto';
        console.log(`  ${label}  ${name}  ${paper}  ${colour}  ${media}  ${orient}`);
    }
    if (Array.isArray(printers) && printers.length) {
        console.log('\n  Detected printers: ' + printers.join(', '));
    }
    console.log('  ───────────────────────────────────────────────────────────────────────────────────');
    console.log('  Borderless rule: photo service at 4×6, 5×7 or 6×8 only.');
    console.log('  ───────────────────────────────────────────────────────────────────────────────────\n');
}

/* ═══ SERVE PAGES ═══ */
function serveHtml(filename, res) {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(500).send(`<h1>Missing public/${filename}</h1><p>Save at: ${filePath}</p>`);
    }
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.replace('__SHOP_KEY__', SHOP_KEY);
    res.type('html').send(html);
}

app.get('/', (req, res) => serveHtml('index.html', res));
app.get('/admin', (req, res) => serveHtml('admin.html', res));
app.get('/admin/', (req, res) => serveHtml('admin.html', res));

/* ═══ BIND TO ALL INTERFACES ═══
   Binding to 0.0.0.0 (instead of the default 127.0.0.1) ensures Tailscale
   Funnel and any other tunnel/service can reach the server. */
app.listen(PORT, '0.0.0.0', () => {
    const sumatra = findSumatra();
    const shop = shopState();
    console.log(`\n✓ PrintCraft agent running on http://localhost:${PORT}`);
    console.log(`  Customer shop:   http://localhost:${PORT}/`);
    console.log(`  Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`  Health check:    http://localhost:${PORT}/api/ping`);
    console.log(`  Serving from:    ${PUBLIC_DIR}`);
    console.log(`  Admin password:  ${ADMIN_PASSWORD === 'printcraft2026' ? '(default — change it!)' : '(set)'}`);
    console.log(`  SumatraPDF:      ${sumatra || 'NOT FOUND — PDF printing will fail'}`);
    console.log(`  Platform:        ${process.platform}`);
    console.log(`  Shop state:      ${shop.shopLabel} (${shop.shopOpen ? 'open' : 'closed'})`);
    console.log(`  UPI ID:          ${SETTINGS.upiId}`);
    console.log(`  Auto UPI:        ${SETTINGS.autoUpiEnabled ? 'enabled (' + SETTINGS.provider + ')' : 'disabled'}`);
    console.log(`  Webhook URL:     http://localhost:${PORT}/api/payment/webhook/${SETTINGS.webhookSecret}`);
    console.log(`  Prices file:     ${PRICES_FILE}`);
    console.log(`  Settings file:   ${SETTINGS_FILE}`);

    if (process.platform === 'win32') {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
            { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                const printers = err ? [] : stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                reportPrinterConfig(printers);
            });
    } else {
        reportPrinterConfig([]);
    }
});