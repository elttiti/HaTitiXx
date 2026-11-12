'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROFILE_BODY_BYTES = 4800 * 1024;
const MAX_BANNER_CHARS = 4200000;
const MAX_AVATAR_CHARS = 150000;
const MAX_MESSAGE_CHARS = 500;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 12;

function accountTagKey(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
        .replace(/[\s_.\-·•\u200b-\u200f\u2060\ufeff]+/g, '');
}
const FONT_STYLES = ['system', 'rounded', 'mono', 'serif', 'display', 'script', 'comic', 'tech'];
const ONLINE_WINDOW_MS = 75 * 1000;
const MAX_PINS = 5;
const HEX_RE = /^#[0-9a-f]{6}$/i;
// Códigos especiales. Se guardan como SHA-256 del texto normalizado (minúsculas, sin tildes) para que no queden a la vista.
const SPECIAL_CODES = Object.freeze({
    '3baa98c0c93d5dcbdb763722e7806228e1ece61550e3e9af9c1c7014232b2ed8': Object.freeze({
        grant: 'betatester', points: 500,
        message: '¡Gracias por probar HaTitix! Recibiste 500 puntos y el pin BETATESTER.'
    }),
    '014c98a46aaa02817caf27690482bfe60a63f7d39ebaba334c97cc9c3ffcbeda': Object.freeze({
        grant: 'owner', points: 0,
        message: 'Código de dueño aceptado: desbloqueaste la corona 👑 y el pin OWNER.'
    })
});
// Pines que solo se obtienen con un código (el servidor fija su aspecto; el cliente no puede inventarlos).
const SPECIAL_PINS = Object.freeze({
    'pin-betatester': Object.freeze({ grant: 'betatester', label: 'BETATESTER', emoji: '🧪', color: '#39ff14', style: 'neon' }),
    'pin-owner': Object.freeze({ grant: 'owner', label: 'OWNER', emoji: '👑', color: '#ff0000', style: 'rgb' })
});
const RESERVED_LABELS = new Set(['owner', 'betatester', 'admin', 'staff', 'moderador', 'mod', 'dueno', 'creador', 'hatitix']);
// Detecta el nombre reservado aunque lo disfracen (0wner, ow ner, OWNER123…). Debe coincidir con pins.js del cliente.
function isReservedLabel(text) {
    const k = String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
        .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
    return !!k && [...RESERVED_LABELS].some((word) => k === word || (word.length >= 5 && k.includes(word)));
}
function normalizeCode(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function parsePins(raw) {
    try {
        const list = JSON.parse(raw || '[]');
        return Array.isArray(list) ? list.slice(0, MAX_PINS) : [];
    } catch (_) { return []; }
}
function cleanText(value, max) {
    return Array.from(String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').trim()).slice(0, max).join('');
}
// Devuelve la lista de pines validada o un texto con el motivo del rechazo.
function validatePins(input, grants) {
    if (!Array.isArray(input)) return { error: 'Los pines deben ser una lista.' };
    if (input.length > MAX_PINS) return { error: `Puedes llevar hasta ${MAX_PINS} pines.` };
    const out = [], seen = new Set();
    for (const entry of input) {
        const id = String(entry?.id ?? '').trim();
        if (!/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(id) || seen.has(id)) return { error: 'Alguno de los pines no es válido.' };
        seen.add(id);
        const special = SPECIAL_PINS[id];
        if (special) {
            if (!grants.includes(special.grant)) return { error: 'Ese pin solo se desbloquea con su código.' };
            out.push({ id, label: special.label, emoji: special.emoji, color: special.color, style: special.style });
            continue;
        }
        const label = cleanText(entry.label, 14), emoji = cleanText(entry.emoji, 4), color = String(entry.color || '#2ecc71');
        if (!label && !emoji) return { error: 'Cada pin necesita un texto o un emoji.' };
        if (!HEX_RE.test(color)) return { error: 'El color de un pin no es válido.' };
        if (isReservedLabel(label) || isReservedLabel(label + emoji)) return { error: `No puedes crear un pin con "${label}": ese nombre está reservado.` };
        out.push({ id, label, emoji, color: color.toLowerCase(), style: 'solid' });
    }
    return { pins: out };
}
function safeUser(row) {
    const grants = Array.isArray(row.grants) ? row.grants : [];
    const crownOn = row.crown_on !== false;
    return {
        id: row.id,
        tag: `${row.display_name}#${row.tag_code}`,
        displayName: row.display_name,
        haxballName: row.haxball_name || '',
        bannerUrl: row.banner_url || '',
        avatarUrl: row.avatar_url || '',
        bannerColor: row.banner_color || '#193b2a',
        fontStyle: row.font_style || 'system',
        pins: parsePins(row.pins),
        grants: grants.filter((g) => g === 'owner' || g === 'betatester'),
        crownOn,
        crown: grants.includes('owner') && crownOn,
        createdAt: row.created_at
    };
}
function json(response, status, payload) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type'
    });
    response.end(JSON.stringify(payload));
}
function readJson(request, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let bytes = 0;
        const chunks = [];
        request.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > limit) {
                reject(Object.assign(new Error('El contenido es demasiado grande.'), { status: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
        });
        request.on('error', reject);
    });
}
function normalizedEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function validDisplayName(value) {
    const name = String(value || '').normalize('NFC').trim();
    return name.length >= 2 && name.length <= 24 && accountTagKey(name).length >= 2 && !/[#\u0000-\u001f]/.test(name) ? name : '';
}
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
function ipKey(request) {
    // No confiar en X-Forwarded-For salvo que Render haya configurado el proxy delante del proceso.
    return String(request.socket?.remoteAddress || 'unknown').slice(0, 80);
}

function createAccountApi(pool) {
    const authAttempts = new Map();
    const messageBuckets = new Map();
    const redeemBuckets = new Map();
    const lastSeen = new Map();      // id -> última actividad (ms) en memoria
    const lastPersisted = new Map(); // id -> última vez que se guardó last_seen en la base
    function touch(user) {
        const now = Date.now();
        lastSeen.set(user.id, now);
        if (now - (lastPersisted.get(user.id) || 0) > 60000) {
            lastPersisted.set(user.id, now);
            pool.query('UPDATE hatitix_accounts SET last_seen=NOW() WHERE id=$1', [user.id]).catch(() => {});
        }
        if (lastSeen.size > 20000) for (const [k, v] of lastSeen) if (now - v > 3600000) { lastSeen.delete(k); lastPersisted.delete(k); }
    }
    function presenceOf(row) {
        const dbSeen = row.last_seen ? Date.parse(row.last_seen) || 0 : 0;
        const seen = Math.max(lastSeen.get(row.id) || 0, dbSeen);
        return { online: seen > 0 && Date.now() - seen < ONLINE_WINDOW_MS, lastSeen: seen ? new Date(seen).toISOString() : null };
    }
    function redeemLimited(userId) {
        const now = Date.now(); let b = redeemBuckets.get(userId);
        if (!b || now - b.start > 10 * 60 * 1000) b = { start: now, count: 0 };
        b.count++; redeemBuckets.set(userId, b);
        if (redeemBuckets.size > 5000) for (const [k, v] of redeemBuckets) if (now - v.start > 10 * 60 * 1000) redeemBuckets.delete(k);
        return b.count > 10;
    }
    const BANNER_DATA_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    async function areFriends(a, b) {
        const low = [a, b].sort()[0], high = [a, b].sort()[1];
        const { rowCount } = await pool.query('SELECT 1 FROM hatitix_friendships WHERE user_low=$1 AND user_high=$2', [low, high]);
        return rowCount > 0;
    }
    function messageLimited(userId) {
        const now = Date.now(); let b = messageBuckets.get(userId);
        if (!b || now - b.start > 30000) b = { start: now, count: 0 };
        b.count++; messageBuckets.set(userId, b);
        if (messageBuckets.size > 5000) for (const [k, v] of messageBuckets) if (now - v.start > 30000) messageBuckets.delete(k);
        return b.count > 20;
    }
    let schemaReady = false;

    async function initialize() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS hatitix_accounts (
                id UUID PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                name_key TEXT NOT NULL,
                tag_code CHAR(4) NOT NULL,
                haxball_name TEXT NOT NULL DEFAULT '',
                banner_url TEXT NOT NULL DEFAULT '',
                banner_color TEXT NOT NULL DEFAULT '#193b2a',
                font_style TEXT NOT NULL DEFAULT 'system',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (name_key, tag_code)
            );
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS pins TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS grants TEXT[] NOT NULL DEFAULT '{}';
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS crown_on BOOLEAN NOT NULL DEFAULT TRUE;
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
            CREATE TABLE IF NOT EXISTS hatitix_sessions (
                token_hash CHAR(64) PRIMARY KEY,
                account_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS hatitix_sessions_account_idx ON hatitix_sessions(account_id);
            CREATE TABLE IF NOT EXISTS hatitix_friend_requests (
                id UUID PRIMARY KEY,
                sender_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                receiver_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (sender_id <> receiver_id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS hatitix_friend_pending_pair_idx
                ON hatitix_friend_requests(sender_id, receiver_id) WHERE status = 'pending';
            CREATE TABLE IF NOT EXISTS hatitix_friendships (
                user_low UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                user_high UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_low, user_high),
                CHECK (user_low < user_high)
            );
            CREATE TABLE IF NOT EXISTS hatitix_messages (
                id BIGSERIAL PRIMARY KEY,
                sender_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                receiver_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                body TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                read_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS hatitix_messages_pair_idx ON hatitix_messages(sender_id, receiver_id, id);
            CREATE INDEX IF NOT EXISTS hatitix_messages_unread_idx ON hatitix_messages(receiver_id) WHERE read_at IS NULL;
            CREATE TABLE IF NOT EXISTS hatitix_account_stats (
                account_id UUID PRIMARY KEY REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                goals BIGINT NOT NULL DEFAULT 0,
                hours DOUBLE PRECISION NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        schemaReady = true;
    }

    function limited(request, response) {
        const key = ipKey(request), now = Date.now();
        let entry = authAttempts.get(key);
        if (!entry || now - entry.startedAt >= RATE_WINDOW_MS) entry = { startedAt: now, count: 0 };
        entry.count++;
        authAttempts.set(key, entry);
        if (authAttempts.size > 5000) {
            for (const [ip, bucket] of authAttempts) if (now - bucket.startedAt > RATE_WINDOW_MS) authAttempts.delete(ip);
        }
        if (entry.count > RATE_LIMIT) {
            json(response, 429, { ok: false, error: 'rate_limited', message: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' });
            return true;
        }
        return false;
    }

    async function sessionUser(request) {
        const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
        const { rows } = await pool.query(`
            SELECT a.* FROM hatitix_sessions s
            JOIN hatitix_accounts a ON a.id = s.account_id
            WHERE s.token_hash = $1 AND s.expires_at > NOW()
        `, [hashToken(token)]);
        return rows[0] || null;
    }

    async function createSession(accountId) {
        const token = crypto.randomBytes(36).toString('base64url');
        await pool.query(
            'INSERT INTO hatitix_sessions(token_hash, account_id, expires_at) VALUES($1, $2, NOW() + ($3 * INTERVAL \'1 day\'))',
            [hashToken(token), accountId, SESSION_DAYS]
        );
        return token;
    }

    async function passwordDigest(password) {
        const salt = crypto.randomBytes(16);
        const derived = await scrypt(password, salt, 64);
        return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
    }
    async function checkPassword(password, encoded) {
        const [algorithm, saltText, digestText] = String(encoded || '').split('$');
        if (algorithm !== 'scrypt' || !saltText || !digestText) return false;
        const expected = Buffer.from(digestText, 'base64url');
        const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length));
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    async function publicUserById(id) {
        const { rows } = await pool.query('SELECT * FROM hatitix_accounts WHERE id = $1', [id]);
        return rows[0] ? safeUser(rows[0]) : null;
    }

    async function handle(request, response, url) {
        if (!url.pathname.startsWith('/api/')) return false;
        if (request.method === 'OPTIONS') {
            response.writeHead(204, {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
                'access-control-allow-headers': 'authorization, content-type',
                'cache-control': 'no-store'
            });
            response.end(); return true;
        }
        if (!schemaReady) {
            json(response, 503, { ok: false, error: 'database_unavailable', message: 'La base de cuentas todavía no está lista.' });
            return true;
        }
        try {
            if (request.method === 'POST' && url.pathname === '/api/auth/register') {
                if (limited(request, response)) return true;
                const body = await readJson(request);
                const email = normalizedEmail(body.email), displayName = validDisplayName(body.displayName);
                const password = String(body.password || ''), haxballName = String(body.haxballName || '').trim().slice(0, 25);
                if (!email) return json(response, 400, { ok: false, error: 'invalid_email', message: 'Escribe un correo válido.' }), true;
                if (!displayName) return json(response, 400, { ok: false, error: 'invalid_name', message: 'El nombre de cuenta debe tener entre 2 y 24 caracteres y no incluir #.' }), true;
                if (password.length < 10 || password.length > 128) return json(response, 400, { ok: false, error: 'invalid_password', message: 'La contraseña debe tener entre 10 y 128 caracteres.' }), true;
                const passwordHash = await passwordDigest(password), nameKey = accountTagKey(displayName);
                let account;
                for (let attempt = 0; attempt < 12; attempt++) {
                    const tagCode = String(crypto.randomInt(0, 10000)).padStart(4, '0');
                    try {
                        const result = await pool.query(`
                            INSERT INTO hatitix_accounts(id,email,password_hash,display_name,name_key,tag_code,haxball_name)
                            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *
                        `, [crypto.randomUUID(), email, passwordHash, displayName, nameKey, tagCode, haxballName]);
                        account = result.rows[0]; break;
                    } catch (error) {
                        if (error.code === '23505' && error.constraint === 'hatitix_accounts_email_key') {
                            return json(response, 409, { ok: false, error: 'email_taken', message: 'Ya existe una cuenta con ese correo.' }), true;
                        }
                        if (error.code === '23505' && attempt < 11) continue;
                        throw error;
                    }
                }
                if (!account) return json(response, 503, { ok: false, error: 'tag_unavailable', message: 'No se pudo asignar un identificador. Vuelve a intentarlo.' }), true;
                const token = await createSession(account.id);
                json(response, 201, { ok: true, token, user: safeUser(account), emailVerified: false });
                return true;
            }

            if (request.method === 'POST' && url.pathname === '/api/auth/login') {
                if (limited(request, response)) return true;
                const body = await readJson(request), email = normalizedEmail(body.email), password = String(body.password || '');
                if (!email || !password || password.length > 128) return json(response, 400, { ok: false, error: 'invalid_credentials', message: 'Correo o contraseña incorrectos.' }), true;
                const { rows } = await pool.query('SELECT * FROM hatitix_accounts WHERE email = $1', [email]);
                if (!rows[0] || !(await checkPassword(password, rows[0].password_hash))) return json(response, 401, { ok: false, error: 'invalid_credentials', message: 'Correo o contraseña incorrectos.' }), true;
                const token = await createSession(rows[0].id);
                json(response, 200, { ok: true, token, user: safeUser(rows[0]), emailVerified: false });
                return true;
            }

            if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
                const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
                if (token) await pool.query('DELETE FROM hatitix_sessions WHERE token_hash = $1', [hashToken(token)]);
                json(response, 200, { ok: true }); return true;
            }

            const user = await sessionUser(request);
            if (!user) { json(response, 401, { ok: false, error: 'unauthorized', message: 'Inicia sesión para continuar.' }); return true; }
            touch(user);

            if (request.method === 'GET' && url.pathname === '/api/me') {
                json(response, 200, { ok: true, user: safeUser(user) }); return true;
            }
            if (request.method === 'PATCH' && url.pathname === '/api/me') {
                const body = await readJson(request, MAX_PROFILE_BODY_BYTES);
                const haxballName = String(body.haxballName ?? user.haxball_name).trim().slice(0, 25);
                const bannerUrl = String(body.bannerUrl ?? user.banner_url).trim();
                const bannerColor = String(body.bannerColor ?? user.banner_color).trim();
                const fontStyle = String(body.fontStyle ?? user.font_style).trim();
                const avatarUrl = String(body.avatarUrl ?? user.avatar_url ?? '').trim();
                const avatarOk = !avatarUrl || (BANNER_DATA_RE.test(avatarUrl) && avatarUrl.length <= MAX_AVATAR_CHARS) || (/^https:\/\//i.test(avatarUrl) && avatarUrl.length <= 2000);
                if (!avatarOk) return json(response, 400, { ok: false, error: 'invalid_avatar', message: 'La foto de perfil no es válida o pesa demasiado.' }), true;
                const bannerIsUrl = /^https:\/\//i.test(bannerUrl) && bannerUrl.length <= 2000;
                const bannerIsData = BANNER_DATA_RE.test(bannerUrl) && bannerUrl.length <= MAX_BANNER_CHARS;
                if (bannerUrl && !bannerIsUrl && !bannerIsData) return json(response, 400, { ok: false, error: 'invalid_banner_url', message: 'El banner debe ser una URL HTTPS o una imagen subida (GIF de hasta ~3 MB).' }), true;
                if (!/^#[0-9a-f]{6}$/i.test(bannerColor)) return json(response, 400, { ok: false, error: 'invalid_banner_color', message: 'El color del banner no es válido.' }), true;
                if (!FONT_STYLES.includes(fontStyle)) return json(response, 400, { ok: false, error: 'invalid_font', message: 'La fuente elegida no es válida.' }), true;
                const grants = Array.isArray(user.grants) ? user.grants : [];
                let pinsJson = user.pins || '[]';
                if (body.pins !== undefined) {
                    const checked = validatePins(body.pins, grants);
                    if (checked.error) return json(response, 400, { ok: false, error: 'invalid_pins', message: checked.error }), true;
                    pinsJson = JSON.stringify(checked.pins);
                }
                const crownOn = body.crownOn === undefined ? user.crown_on !== false : body.crownOn === true;
                const updated = await pool.query(`UPDATE hatitix_accounts SET haxball_name=$2,banner_url=$3,banner_color=$4,font_style=$5,avatar_url=$6,pins=$7,crown_on=$8 WHERE id=$1 RETURNING *`, [user.id, haxballName, bannerUrl, bannerColor, fontStyle, avatarUrl, pinsJson, crownOn]);
                json(response, 200, { ok: true, user: safeUser(updated.rows[0]) }); return true;
            }
            if (request.method === 'PUT' && url.pathname === '/api/ranking/me') {
                const body = await readJson(request);
                const goals = Math.max(0, Math.min(1000000000, Math.floor(Number(body.goals) || 0)));
                const hours = Math.max(0, Math.min(100000000, Number(body.hours) || 0));
                await pool.query(`
                    INSERT INTO hatitix_account_stats(account_id,goals,hours) VALUES($1,$2,$3)
                    ON CONFLICT (account_id) DO UPDATE SET
                        goals=GREATEST(hatitix_account_stats.goals, EXCLUDED.goals),
                        hours=GREATEST(hatitix_account_stats.hours, EXCLUDED.hours),
                        updated_at=NOW()
                `, [user.id, goals, hours]);
                json(response, 200, { ok: true }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/ranking/friends') {
                const { rows } = await pool.query(`
                    SELECT a.id, a.display_name, a.tag_code, COALESCE(s.goals,0)::bigint AS goals,
                           COALESCE(s.hours,0)::double precision AS hours
                    FROM hatitix_accounts a
                    LEFT JOIN hatitix_account_stats s ON s.account_id=a.id
                    WHERE a.id=$1 OR a.id IN (
                        SELECT CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END
                        FROM hatitix_friendships f WHERE f.user_low=$1 OR f.user_high=$1
                    )
                    ORDER BY goals DESC, hours DESC, a.display_name ASC LIMIT 100
                `, [user.id]);
                json(response, 200, { ok: true, entries: rows.map((row) => ({ id: row.id, name: row.display_name, tag: `${row.display_name}#${row.tag_code}`, goals: Number(row.goals) || 0, hours: Number(row.hours) || 0 })) }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/presence') {
                json(response, 200, { ok: true }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/redeem') {
                if (redeemLimited(user.id)) return json(response, 429, { ok: false, error: 'rate_limited', message: 'Demasiados intentos. Espera unos minutos.' }), true;
                const body = await readJson(request);
                const hash = crypto.createHash('sha256').update(normalizeCode(body.code)).digest('hex');
                const reward = SPECIAL_CODES[hash];
                if (!reward) return json(response, 404, { ok: false, error: 'invalid_code', message: 'Ese código no existe.' }), true;
                // Canje atómico: solo se concede si la cuenta aún no tiene esta recompensa.
                const result = await pool.query('UPDATE hatitix_accounts SET grants = array_append(grants, $2::text) WHERE id=$1 AND NOT ($2::text = ANY(grants)) RETURNING *', [user.id, reward.grant]);
                if (!result.rowCount) return json(response, 409, { ok: false, error: 'already_redeemed', message: 'Esta cuenta ya canjeó ese código.' }), true;
                json(response, 200, { ok: true, points: reward.points, grant: reward.grant, message: reward.message, user: safeUser(result.rows[0]) }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/users/search') {
                const tag = String(url.searchParams.get('tag') || '').trim();
                const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                const { rows } = await pool.query('SELECT * FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                if (!rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                json(response, 200, { ok: true, user: safeUser(rows[0]) }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/friends') {
                const { rows } = await pool.query(`
                    SELECT a.* FROM hatitix_friendships f
                    JOIN hatitix_accounts a ON a.id = CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END
                    WHERE f.user_low=$1 OR f.user_high=$1 ORDER BY a.display_name
                `, [user.id]);
                json(response, 200, { ok: true, friends: rows.map((row) => ({ ...safeUser(row), ...presenceOf(row) })) }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/friends/requests') {
                const { rows } = await pool.query(`
                    SELECT r.id,r.status,r.created_at,r.sender_id,r.receiver_id,
                           s.display_name AS s_name,s.tag_code AS s_code,s.haxball_name AS s_hax,s.banner_url AS s_banner,s.banner_color AS s_color,s.font_style AS s_font,s.created_at AS s_created,
                           v.display_name AS v_name,v.tag_code AS v_code,v.haxball_name AS v_hax,v.banner_url AS v_banner,v.banner_color AS v_color,v.font_style AS v_font,v.created_at AS v_created
                    FROM hatitix_friend_requests r
                    JOIN hatitix_accounts s ON s.id=r.sender_id JOIN hatitix_accounts v ON v.id=r.receiver_id
                    WHERE r.status='pending' AND (r.sender_id=$1 OR r.receiver_id=$1)
                    ORDER BY r.created_at DESC LIMIT 100
                `, [user.id]);
                const incoming = [], outgoing = [];
                for (const row of rows) {
                    const other = row.sender_id === user.id
                        ? { id: row.receiver_id, display_name: row.v_name, tag_code: row.v_code, haxball_name: row.v_hax, banner_url: row.v_banner, banner_color: row.v_color, font_style: row.v_font, created_at: row.v_created }
                        : { id: row.sender_id, display_name: row.s_name, tag_code: row.s_code, haxball_name: row.s_hax, banner_url: row.s_banner, banner_color: row.s_color, font_style: row.s_font, created_at: row.s_created };
                    (row.receiver_id === user.id ? incoming : outgoing).push({ id: row.id, user: safeUser(other), createdAt: row.created_at });
                }
                json(response, 200, { ok: true, incoming, outgoing }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/friends/requests') {
                const body = await readJson(request), tag = String(body.tag || '').trim();
                const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                const targetResult = await pool.query('SELECT id FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                const targetId = targetResult.rows[0]?.id;
                if (!targetId) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                if (targetId === user.id) return json(response, 400, { ok: false, error: 'self_request', message: 'No puedes enviarte una solicitud a ti mismo.' }), true;
                const low = [user.id, targetId].sort()[0], high = [user.id, targetId].sort()[1];
                const existingFriend = await pool.query('SELECT 1 FROM hatitix_friendships WHERE user_low=$1 AND user_high=$2', [low, high]);
                if (existingFriend.rowCount) return json(response, 409, { ok: false, error: 'already_friends', message: 'Ya son amigos.' }), true;
                const reverse = await pool.query("SELECT id FROM hatitix_friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'", [targetId, user.id]);
                if (reverse.rowCount) return json(response, 409, { ok: false, error: 'incoming_request', message: 'Esa cuenta ya te envió una solicitud. Puedes aceptarla en Solicitudes recibidas.' }), true;
                try {
                    const inserted = await pool.query("INSERT INTO hatitix_friend_requests(id,sender_id,receiver_id) VALUES($1,$2,$3) RETURNING id,created_at", [crypto.randomUUID(), user.id, targetId]);
                    json(response, 201, { ok: true, request: { id: inserted.rows[0].id, createdAt: inserted.rows[0].created_at } }); return true;
                } catch (error) {
                    if (error.code === '23505') return json(response, 409, { ok: false, error: 'request_exists', message: 'Ya hay una solicitud pendiente.' }), true;
                    throw error;
                }
            }
            const requestAction = url.pathname.match(/^\/api\/friends\/requests\/([0-9a-f-]{36})\/(accept|reject)$/i);
            if (request.method === 'POST' && requestAction && UUID_RE.test(requestAction[1])) {
                const id = requestAction[1], action = requestAction[2];
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const result = await client.query("SELECT * FROM hatitix_friend_requests WHERE id=$1 AND receiver_id=$2 AND status='pending' FOR UPDATE", [id, user.id]);
                    if (!result.rows[0]) {
                        await client.query('ROLLBACK');
                        json(response, 404, { ok: false, error: 'request_not_found', message: 'La solicitud ya no está pendiente.' }); return true;
                    }
                    const friendRequest = result.rows[0];
                    if (action === 'accept') {
                        const low = [friendRequest.sender_id, friendRequest.receiver_id].sort()[0], high = [friendRequest.sender_id, friendRequest.receiver_id].sort()[1];
                        await client.query('INSERT INTO hatitix_friendships(user_low,user_high) VALUES($1,$2) ON CONFLICT DO NOTHING', [low, high]);
                        await client.query("UPDATE hatitix_friend_requests SET status='accepted',updated_at=NOW() WHERE id=$1", [id]);
                    } else {
                        await client.query("UPDATE hatitix_friend_requests SET status='rejected',updated_at=NOW() WHERE id=$1", [id]);
                    }
                    await client.query('COMMIT');
                    json(response, 200, { ok: true, status: action === 'accept' ? 'accepted' : 'rejected' }); return true;
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => {}); throw error;
                } finally { client.release(); }
            }
            const unfriend = url.pathname.match(/^\/api\/friends\/([0-9a-f-]{36})$/i);
            if (request.method === 'DELETE' && unfriend && UUID_RE.test(unfriend[1])) {
                const otherId = unfriend[1];
                const low = [user.id, otherId].sort()[0], high = [user.id, otherId].sort()[1];
                await pool.query('DELETE FROM hatitix_friendships WHERE user_low=$1 AND user_high=$2', [low, high]);
                json(response, 200, { ok: true }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/messages/unread') {
                const { rows } = await pool.query('SELECT sender_id, COUNT(*)::int AS n FROM hatitix_messages WHERE receiver_id=$1 AND read_at IS NULL GROUP BY sender_id', [user.id]);
                const counts = {}; for (const row of rows) counts[row.sender_id] = row.n;
                json(response, 200, { ok: true, counts }); return true;
            }
            const messageRoute = url.pathname.match(/^\/api\/messages\/([0-9a-f-]{36})$/i);
            if (messageRoute && UUID_RE.test(messageRoute[1])) {
                const otherId = messageRoute[1];
                if (!(await areFriends(user.id, otherId))) return json(response, 403, { ok: false, error: 'not_friends', message: 'Solo puedes chatear con tus amigos.' }), true;
                if (request.method === 'GET') {
                    const after = Math.max(0, Number.parseInt(url.searchParams.get('after') || '0', 10) || 0);
                    const { rows } = await pool.query(`
                        SELECT * FROM (
                            SELECT id, sender_id, body, created_at FROM hatitix_messages
                            WHERE id > $3 AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))
                            ORDER BY id DESC LIMIT 100
                        ) m ORDER BY id ASC`, [user.id, otherId, after]);
                    await pool.query('UPDATE hatitix_messages SET read_at=NOW() WHERE sender_id=$1 AND receiver_id=$2 AND read_at IS NULL', [otherId, user.id]);
                    json(response, 200, { ok: true, messages: rows.map((m) => ({ id: Number(m.id), mine: m.sender_id === user.id, body: m.body, createdAt: m.created_at })) }); return true;
                }
                if (request.method === 'POST') {
                    if (messageLimited(user.id)) return json(response, 429, { ok: false, error: 'rate_limited', message: 'Vas muy rápido. Espera unos segundos.' }), true;
                    const body = await readJson(request);
                    const text = String(body.body || '').replace(/\u0000/g, '').trim();
                    if (!text || text.length > MAX_MESSAGE_CHARS) return json(response, 400, { ok: false, error: 'invalid_message', message: `El mensaje debe tener entre 1 y ${MAX_MESSAGE_CHARS} caracteres.` }), true;
                    const inserted = await pool.query('INSERT INTO hatitix_messages(sender_id, receiver_id, body) VALUES($1,$2,$3) RETURNING id, created_at', [user.id, otherId, text]);
                    json(response, 201, { ok: true, message: { id: Number(inserted.rows[0].id), mine: true, body: text, createdAt: inserted.rows[0].created_at } }); return true;
                }
            }
            json(response, 404, { ok: false, error: 'not_found', message: 'Ruta de API no encontrada.' });
            return true;
        } catch (error) {
            console.error('Error en API de cuentas:', error.message);
            json(response, Number(error.status) || 500, { ok: false, error: Number(error.status) === 413 ? 'payload_too_large' : 'server_error', message: Number(error.status) ? error.message : 'Error interno del servidor.' });
            return true;
        }
    }

    return { initialize, handle, isReady: () => schemaReady };
}

module.exports = { createAccountApi };
