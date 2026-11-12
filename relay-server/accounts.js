'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 12;

function accountTagKey(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
        .replace(/[\s_.\-·•\u200b-\u200f\u2060\ufeff]+/g, '');
}
function safeUser(row) {
    return {
        id: row.id,
        tag: `${row.display_name}#${row.tag_code}`,
        displayName: row.display_name,
        haxballName: row.haxball_name || '',
        bannerUrl: row.banner_url || '',
        bannerColor: row.banner_color || '#193b2a',
        fontStyle: row.font_style || 'system',
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
function readJson(request) {
    return new Promise((resolve, reject) => {
        let bytes = 0;
        const chunks = [];
        request.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
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

            if (request.method === 'GET' && url.pathname === '/api/me') {
                json(response, 200, { ok: true, user: safeUser(user) }); return true;
            }
            if (request.method === 'PATCH' && url.pathname === '/api/me') {
                const body = await readJson(request);
                const haxballName = String(body.haxballName ?? user.haxball_name).trim().slice(0, 25);
                const bannerUrl = String(body.bannerUrl ?? user.banner_url).trim();
                const bannerColor = String(body.bannerColor ?? user.banner_color).trim();
                const fontStyle = String(body.fontStyle ?? user.font_style).trim();
                if (bannerUrl && (!/^https:\/\//i.test(bannerUrl) || bannerUrl.length > 2000)) return json(response, 400, { ok: false, error: 'invalid_banner_url', message: 'El banner debe usar una URL HTTPS de hasta 2000 caracteres.' }), true;
                if (!/^#[0-9a-f]{6}$/i.test(bannerColor)) return json(response, 400, { ok: false, error: 'invalid_banner_color', message: 'El color del banner no es válido.' }), true;
                if (!['system', 'rounded', 'mono', 'serif'].includes(fontStyle)) return json(response, 400, { ok: false, error: 'invalid_font', message: 'La fuente elegida no es válida.' }), true;
                const updated = await pool.query(`UPDATE hatitix_accounts SET haxball_name=$2,banner_url=$3,banner_color=$4,font_style=$5 WHERE id=$1 RETURNING *`, [user.id, haxballName, bannerUrl, bannerColor, fontStyle]);
                json(response, 200, { ok: true, user: safeUser(updated.rows[0]) }); return true;
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
                json(response, 200, { ok: true, friends: rows.map(safeUser) }); return true;
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
