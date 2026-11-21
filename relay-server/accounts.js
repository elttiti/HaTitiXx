'use strict';

const { handleCommunityMaps } = require('./community-maps');

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
const MAX_GROUP_MEMBERS = 30;
const MAX_GROUPS_OWNED = 10;
const MAX_PARTY_MEMBERS = 8;
class ApiError extends Error {
    constructor(status, message) { super(message); this.name = 'ApiError'; this.status = status; }
}

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
    }),
    '04a3d3c7794f380848a024838b40b52596717170ab8e6eada048a6b45ca55645': Object.freeze({
        grant: 'titi-id', points: 0,
        fixedTag: Object.freeze({ displayName: 'Titi', tagCode: '0000' }),
        message: 'Código aceptado: tu identificador de jugador ahora es Titi#0000.'
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
    const grants = Array.isArray(row.grants) ? row.grants : parsePins(row.grants || '[]');
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
        createdAt: row.created_at,
        // Total acumulado de puntos que el dueño le sumó/restó a esta cuenta (ver /api/admin/points).
        // El cliente compara este número con el último que vio y aplica solo la diferencia, una vez.
        adminPointsTotal: Number(row.admin_points_total) || 0
    };
}
function isOwnerEmail(user) {
    const ownerEmail = String(process.env.OWNER_ACCOUNT_EMAIL || '').trim().toLowerCase();
    return !!ownerEmail && String(user?.email || '').trim().toLowerCase() === ownerEmail;
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

const SOCIAL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS hatitix_groups (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hatitix_group_members (
    group_id UUID NOT NULL REFERENCES hatitix_groups(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, account_id)
);
CREATE INDEX IF NOT EXISTS hatitix_group_members_account_idx ON hatitix_group_members(account_id);
CREATE TABLE IF NOT EXISTS hatitix_group_messages (
    id BIGSERIAL PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES hatitix_groups(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES hatitix_accounts(id) ON DELETE SET NULL,
    sender_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hatitix_group_messages_group_idx ON hatitix_group_messages(group_id, id);

CREATE TABLE IF NOT EXISTS hatitix_parties (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    leader_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    room_id TEXT,
    room_link TEXT,
    room_seq INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hatitix_party_members (
    party_id UUID NOT NULL REFERENCES hatitix_parties(id) ON DELETE CASCADE,
    account_id UUID PRIMARY KEY REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hatitix_party_members_party_idx ON hatitix_party_members(party_id);
CREATE TABLE IF NOT EXISTS hatitix_party_invites (
    id UUID PRIMARY KEY,
    party_id UUID NOT NULL REFERENCES hatitix_parties(id) ON DELETE CASCADE,
    from_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (party_id, to_id)
);
CREATE INDEX IF NOT EXISTS hatitix_party_invites_to_idx ON hatitix_party_invites(to_id);

`;

function socialCleanText(value, max, fallback = '') {
    const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    return text || fallback;
}
function uniqueIds(list, max) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        const id = String(item || '').toLowerCase();
        if (UUID_RE.test(id) && !out.includes(id)) out.push(id);
        if (out.length >= max) break;
    }
    return out;
}
async function withTx(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ya cerrada */ }
        throw error;
    } finally { client.release(); }
}

// ------------------------------------------------------------------ GRUPOS
async function listGroups(pool, userId, groupId = null) {
    const params = [userId];
    let extra = '';
    if (groupId) { params.push(groupId); extra = 'AND g.id = $2'; }
    const { rows } = await pool.query(`
        SELECT g.id, g.name, g.owner_id, g.created_at,
               COALESCE((SELECT MAX(m.id) FROM hatitix_group_messages m WHERE m.group_id = g.id), 0) AS last_message_id
        FROM hatitix_groups g
        JOIN hatitix_group_members me ON me.group_id = g.id AND me.account_id = $1
        WHERE TRUE ${extra}
        ORDER BY g.created_at DESC`, params);
    if (!rows.length) return [];
    const groupIds = rows.map((row) => row.id);
    const members = await pool.query(`
        SELECT gm.group_id, a.id, a.display_name, a.tag_code
        FROM hatitix_group_members gm JOIN hatitix_accounts a ON a.id = gm.account_id
        WHERE gm.group_id IN (${groupIds.map((_, index) => `$${index + 1}`).join(', ')}) ORDER BY gm.joined_at`, groupIds);
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        owner: row.owner_id === userId,
        ownerId: row.owner_id,
        createdAt: row.created_at,
        lastMessageId: Number(row.last_message_id || 0),
        members: members.rows.filter((m) => m.group_id === row.id)
            .map((m) => ({ id: m.id, displayName: m.display_name, tag: `${m.display_name}#${m.tag_code}` }))
    }));
}
async function memberOf(pool, groupId, userId) {
    const { rowCount } = await pool.query('SELECT 1 FROM hatitix_group_members WHERE group_id = $1 AND account_id = $2', [groupId, userId]);
    return rowCount > 0;
}

async function groupsRoutes(ctx) {
    const { request, url, pool, user, readJson, areFriends, messageLimited, ok } = ctx;
    const method = request.method;
    if (url.pathname === '/api/groups') {
        if (method === 'GET') return ok({ groups: await listGroups(pool, user.id) });
        if (method === 'POST') {
            const body = await readJson(request);
            const name = socialCleanText(body.name, 40);
            if (!name) throw new ApiError(400, 'Escribí un nombre para el grupo.');
            const memberIds = uniqueIds(body.memberIds, MAX_GROUP_MEMBERS).filter((id) => id !== user.id);
            if (!memberIds.length) throw new ApiError(400, 'Elegí al menos un amigo.');
            for (const id of memberIds) {
                if (!(await areFriends(user.id, id))) throw new ApiError(403, 'Solo podés agregar a tus amigos al grupo.');
            }
            const owned = await pool.query('SELECT COUNT(*)::int AS n FROM hatitix_groups WHERE owner_id = $1', [user.id]);
            if (owned.rows[0].n >= MAX_GROUPS_OWNED) throw new ApiError(400, `Podés tener hasta ${MAX_GROUPS_OWNED} grupos propios. Eliminá alguno.`);
            const id = crypto.randomUUID();
            await withTx(pool, async (client) => {
                await client.query('INSERT INTO hatitix_groups(id, name, owner_id) VALUES($1, $2, $3)', [id, name, user.id]);
                for (const accountId of [user.id, ...memberIds]) {
                    await client.query('INSERT INTO hatitix_group_members(group_id, account_id) VALUES($1, $2)', [id, accountId]);
                }
            });
            const [group] = await listGroups(pool, user.id, id);
            return ok({ group }, 201);
        }
        return false;
    }
    const match = url.pathname.match(/^\/api\/groups\/([0-9a-f-]{36})(?:\/(leave|members|messages))?$/i);
    if (!match || !UUID_RE.test(match[1])) return false;
    const groupId = match[1].toLowerCase(), sub = (match[2] || '').toLowerCase();

    if (!sub && method === 'GET') {
        const [group] = await listGroups(pool, user.id, groupId);
        if (!group) throw new ApiError(404, 'Grupo no encontrado.');
        return ok({ group });
    }
    if (!sub && method === 'DELETE') {
        const result = await pool.query('DELETE FROM hatitix_groups WHERE id = $1 AND owner_id = $2', [groupId, user.id]);
        if (result.rowCount) return ok({});
        if (await memberOf(pool, groupId, user.id)) throw new ApiError(403, 'Solo el dueño puede eliminar el grupo. Podés salirte.');
        throw new ApiError(404, 'Grupo no encontrado.');
    }
    if (sub === 'leave' && method === 'POST') {
        const group = await pool.query('SELECT owner_id FROM hatitix_groups WHERE id = $1', [groupId]);
        if (!group.rows[0] || !(await memberOf(pool, groupId, user.id))) throw new ApiError(404, 'Grupo no encontrado.');
        if (group.rows[0].owner_id === user.id) throw new ApiError(400, 'Sos el dueño: eliminá el grupo en lugar de salirte.');
        await pool.query('DELETE FROM hatitix_group_members WHERE group_id = $1 AND account_id = $2', [groupId, user.id]);
        return ok({});
    }
    if (sub === 'members' && method === 'POST') {
        const group = await pool.query('SELECT owner_id FROM hatitix_groups WHERE id = $1', [groupId]);
        if (!group.rows[0]) throw new ApiError(404, 'Grupo no encontrado.');
        if (group.rows[0].owner_id !== user.id) throw new ApiError(403, 'Solo el dueño puede agregar integrantes.');
        const body = await readJson(request);
        const ids = uniqueIds(body.memberIds, MAX_GROUP_MEMBERS);
        for (const id of ids) if (!(await areFriends(user.id, id))) throw new ApiError(403, 'Solo podés agregar a tus amigos al grupo.');
        const count = await pool.query('SELECT COUNT(*)::int AS n FROM hatitix_group_members WHERE group_id = $1', [groupId]);
        if (count.rows[0].n + ids.length > MAX_GROUP_MEMBERS) throw new ApiError(400, `El grupo admite hasta ${MAX_GROUP_MEMBERS} integrantes.`);
        for (const accountId of ids) {
            await pool.query('INSERT INTO hatitix_group_members(group_id, account_id) VALUES($1, $2) ON CONFLICT DO NOTHING', [groupId, accountId]);
        }
        const [updated] = await listGroups(pool, user.id, groupId);
        return ok({ group: updated });
    }
    if (sub === 'messages') {
        if (!(await memberOf(pool, groupId, user.id))) throw new ApiError(404, 'Grupo no encontrado.');
        if (method === 'GET') {
            const after = Math.max(0, Number.parseInt(url.searchParams.get('after') || '0', 10) || 0);
            const { rows } = await pool.query(`
                SELECT * FROM (
                    SELECT id, sender_id, sender_name, body, created_at FROM hatitix_group_messages
                    WHERE group_id = $1 AND id > $2 ORDER BY id DESC LIMIT 100
                ) m ORDER BY id ASC`, [groupId, after]);
            return ok({ messages: rows.map((m) => ({ id: Number(m.id), mine: m.sender_id === user.id, senderName: m.sender_name, body: m.body, createdAt: m.created_at })) });
        }
        if (method === 'POST') {
            if (messageLimited(user.id)) throw new ApiError(429, 'Vas muy rápido. Esperá unos segundos.');
            const body = await readJson(request);
            const text = String(body.body || '').replace(/\u0000/g, '').trim();
            if (!text || text.length > MAX_MESSAGE_CHARS) throw new ApiError(400, `El mensaje debe tener entre 1 y ${MAX_MESSAGE_CHARS} caracteres.`);
            const senderName = socialCleanText(user.display_name || user.displayName || 'Jugador', 50, 'Jugador');
            const inserted = await pool.query('INSERT INTO hatitix_group_messages(group_id, sender_id, sender_name, body) VALUES($1, $2, $3, $4) RETURNING id, created_at', [groupId, user.id, senderName, text]);
            return ok({ message: { id: Number(inserted.rows[0].id), mine: true, senderName, body: text, createdAt: inserted.rows[0].created_at } }, 201);
        }
    }
    return false;
}

// ------------------------------------------------------------------ PARTIES
async function partyOf(pool, accountId) {
    const found = await pool.query(`
        SELECT p.* FROM hatitix_party_members pm JOIN hatitix_parties p ON p.id = pm.party_id
        WHERE pm.account_id = $1`, [accountId]);
    const party = found.rows[0];
    if (!party) return null;
    const members = await pool.query(`
        SELECT a.id, a.display_name, a.tag_code FROM hatitix_party_members pm
        JOIN hatitix_accounts a ON a.id = pm.account_id WHERE pm.party_id = $1 ORDER BY pm.joined_at`, [party.id]);
    return {
        id: party.id,
        name: party.name,
        leaderId: party.leader_id,
        isLeader: party.leader_id === accountId,
        roomId: party.room_id || '',
        roomLink: party.room_link || '',
        roomSeq: Number(party.room_seq || 0),
        members: members.rows.map((m) => ({ id: m.id, displayName: m.display_name, tag: `${m.display_name}#${m.tag_code}` }))
    };
}
async function leavePartyTx(client, accountId) {
    const current = await client.query(`
        SELECT pm.party_id, p.leader_id FROM hatitix_party_members pm
        JOIN hatitix_parties p ON p.id = pm.party_id WHERE pm.account_id = $1`, [accountId]);
    if (!current.rows[0]) return;
    const { party_id: partyId, leader_id: leaderId } = current.rows[0];
    await client.query('DELETE FROM hatitix_party_members WHERE account_id = $1', [accountId]);
    const rest = await client.query('SELECT account_id FROM hatitix_party_members WHERE party_id = $1 ORDER BY joined_at LIMIT 1', [partyId]);
    if (!rest.rows[0]) await client.query('DELETE FROM hatitix_parties WHERE id = $1', [partyId]);
    else if (leaderId === accountId) await client.query('UPDATE hatitix_parties SET leader_id = $2 WHERE id = $1', [partyId, rest.rows[0].account_id]);
}

async function partiesRoutes(ctx) {
    const { request, url, pool, user, readJson, areFriends, ok } = ctx;
    const method = request.method, path = url.pathname;

    if (method === 'GET' && path === '/api/parties/me') {
        const party = await partyOf(pool, user.id);
        const invites = await pool.query(`
            SELECT i.id, i.party_id, p.name AS party_name, a.display_name AS from_name, i.created_at
            FROM hatitix_party_invites i
            JOIN hatitix_parties p ON p.id = i.party_id
            JOIN hatitix_accounts a ON a.id = i.from_id
            WHERE i.to_id = $1 AND i.created_at > NOW() - INTERVAL '1 day'
            ORDER BY i.created_at DESC LIMIT 20`, [user.id]);
        return ok({ party, invites: invites.rows.map((i) => ({ id: i.id, partyId: i.party_id, partyName: i.party_name, fromName: i.from_name, createdAt: i.created_at })) });
    }
    if (method === 'POST' && path === '/api/parties') {
        const body = await readJson(request);
        const name = socialCleanText(body.name, 40, 'Mi Party');
        const id = crypto.randomUUID();
        await withTx(pool, async (client) => {
            await leavePartyTx(client, user.id);
            await client.query('INSERT INTO hatitix_parties(id, name, leader_id) VALUES($1, $2, $3)', [id, name, user.id]);
            await client.query('INSERT INTO hatitix_party_members(party_id, account_id) VALUES($1, $2)', [id, user.id]);
        });
        return ok({ party: await partyOf(pool, user.id) }, 201);
    }
    if (method === 'POST' && path === '/api/parties/leave') {
        await withTx(pool, (client) => leavePartyTx(client, user.id));
        return ok({});
    }
    if (method === 'POST' && path === '/api/parties/end') {
        const party = await partyOf(pool, user.id);
        if (!party) throw new ApiError(404, 'No estás en ningún party.');
        if (!party.isLeader) throw new ApiError(403, 'Solo el líder puede finalizar el party.');
        await pool.query('DELETE FROM hatitix_parties WHERE id = $1 AND leader_id = $2', [party.id, user.id]);
        return ok({});
    }
    if (method === 'POST' && path === '/api/parties/invite') {
        const body = await readJson(request);
        const toId = String(body.accountId || '').toLowerCase();
        if (!UUID_RE.test(toId) || toId === user.id) throw new ApiError(400, 'Amigo inválido.');
        const party = await partyOf(pool, user.id);
        if (!party) throw new ApiError(400, 'Primero creá un Party.');
        if (!(await areFriends(user.id, toId))) throw new ApiError(403, 'Solo podés invitar a tus amigos.');
        if (party.members.some((m) => m.id === toId)) throw new ApiError(409, 'Ya está en el party.');
        if (party.members.length >= MAX_PARTY_MEMBERS) throw new ApiError(400, `El party admite hasta ${MAX_PARTY_MEMBERS} jugadores.`);
        await pool.query(`
            INSERT INTO hatitix_party_invites(id, party_id, from_id, to_id) VALUES($1, $2, $3, $4)
            ON CONFLICT (party_id, to_id) DO UPDATE SET from_id = EXCLUDED.from_id, created_at = NOW()`,
        [crypto.randomUUID(), party.id, user.id, toId]);
        return ok({});
    }
    if (method === 'POST' && path === '/api/parties/room') {
        const body = await readJson(request);
        if (body.clear === true) {
            // El líder salió de su sala: se borra la sala del party para que los miembros salgan también.
            const current = await partyOf(pool, user.id);
            if (!current || !current.isLeader) return ok({ updated: false });
            const cleared = await pool.query('UPDATE hatitix_parties SET room_id = NULL, room_link = NULL, room_seq = room_seq + 1 WHERE id = $1 AND leader_id = $2 AND room_id IS NOT NULL', [current.id, user.id]);
            return ok({ updated: cleared.rowCount > 0 });
        }
        const roomId = String(body.roomId || '');
        const link = String(body.link || '').slice(0, 300);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId) || !/^https?:\/\//i.test(link)) throw new ApiError(400, 'Sala inválida.');
        const party = await partyOf(pool, user.id);
        if (!party || !party.isLeader) return ok({ updated: false });
        const result = await pool.query(`
            UPDATE hatitix_parties SET room_id = $3, room_link = $4, room_seq = room_seq + 1
            WHERE id = $1 AND leader_id = $2 AND (room_id IS NULL OR room_id <> $3)`, [party.id, user.id, roomId, link]);
        return ok({ updated: result.rowCount > 0 });
    }
    const invite = path.match(/^\/api\/parties\/invites\/([0-9a-f-]{36})\/(accept|decline)$/i);
    if (method === 'POST' && invite && UUID_RE.test(invite[1])) {
        const inviteId = invite[1].toLowerCase(), action = invite[2].toLowerCase();
        await withTx(pool, async (client) => {
            const found = await client.query('SELECT * FROM hatitix_party_invites WHERE id = $1 AND to_id = $2 FOR UPDATE', [inviteId, user.id]);
            const row = found.rows[0];
            if (!row) throw new ApiError(404, 'La invitación ya no existe (el party pudo haber finalizado).');
            if (action === 'decline') { await client.query('DELETE FROM hatitix_party_invites WHERE id = $1', [inviteId]); return; }
            const count = await client.query('SELECT COUNT(*)::int AS n FROM hatitix_party_members WHERE party_id = $1', [row.party_id]);
            const already = await client.query('SELECT 1 FROM hatitix_party_members WHERE party_id = $1 AND account_id = $2', [row.party_id, user.id]);
            if (!already.rowCount) {
                if (count.rows[0].n >= MAX_PARTY_MEMBERS) throw new ApiError(400, 'El party está lleno.');
                await leavePartyTx(client, user.id);
                await client.query('INSERT INTO hatitix_party_members(party_id, account_id) VALUES($1, $2)', [row.party_id, user.id]);
            }
            await client.query('DELETE FROM hatitix_party_invites WHERE id = $1', [inviteId]);
        });
        return ok({ party: await partyOf(pool, user.id) });
    }
    return false;
}


async function handleSocialRoutes(ctx) {
    const path = ctx.url.pathname;
    const reply = (payload, status = 200) => { ctx.json(ctx.response, status, { ok: true, ...payload }); return true; };
    const full = { ...ctx, ok: reply };
    if (path === '/api/groups' || path.startsWith('/api/groups/')) return (await groupsRoutes(full)) === true;
    if (path === '/api/parties' || path.startsWith('/api/parties/')) return (await partiesRoutes(full)) === true;
    return false;
}

// ------------------------------------------------------------------ APUESTAS 1v1
// Flujo: desafío (pending) → el rival acepta → el retador crea una sala privada (clave) y sube el enlace →
// se invita a amigos conectados a mirar → los espectadores apuestan rojo/azul antes del saque →
// ambos jugadores informan el ganador; si coinciden se liquida, si no se anula (nadie gana ni pierde).
const BET_TABLES_SQL = `
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS room_link TEXT NOT NULL DEFAULT '';
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS room_password TEXT NOT NULL DEFAULT '';
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS rival_player_name TEXT NOT NULL DEFAULT '';
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS started_at TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS report_challenger TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS report_rival TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS winner_team TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS settled_at TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS forfeit_at TEXT;
CREATE TABLE IF NOT EXISTS hatitix_bet_wagers (
    id UUID PRIMARY KEY,
    bet_id UUID NOT NULL REFERENCES hatitix_bets(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'spectator',
    team TEXT NOT NULL CHECK (team IN ('red', 'blue')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    claimed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bet_id, account_id)
);
CREATE INDEX IF NOT EXISTS hatitix_bet_wagers_account_idx ON hatitix_bet_wagers(account_id);
CREATE TABLE IF NOT EXISTS hatitix_bet_spectators (
    bet_id UUID NOT NULL REFERENCES hatitix_bets(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'invited',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bet_id, account_id)
);
CREATE INDEX IF NOT EXISTS hatitix_bet_spectators_account_idx ON hatitix_bet_spectators(account_id);
`;
const BET_WITH_NAMES_SQL = `
    SELECT b.*, c.display_name AS c_name, c.tag_code AS c_code, r.display_name AS r_name, r.tag_code AS r_code
    FROM hatitix_bets b
    JOIN hatitix_accounts c ON c.id = b.challenger_id
    JOIN hatitix_accounts r ON r.id = b.rival_id`;

async function handleBetRoutes(ctx) {
    const { request, url, response, pool, user, json, readJson, areFriends, presenceOf } = ctx;
    const method = request.method, path = url.pathname;
    if (path !== '/api/bet/create' && !path.startsWith('/api/bets/')) return false;
    const reply = (payload, status = 200) => { json(response, status, { ok: true, ...payload }); return true; };
    const betPoints = (value, label = 'El monto') => {
        const amount = Number(value);
        if (!Number.isSafeInteger(amount) || amount < 1) throw new ApiError(400, `${label} debe ser un número entero mayor a 0.`);
        return amount;
    };
    const loadBet = async (id) => (await pool.query(`${BET_WITH_NAMES_SQL} WHERE b.id = $1`, [id])).rows[0] || null;
    const tag = (name, code) => `${name}#${code}`;

    if (method === 'POST' && path === '/api/bet/create') {
        const body = await readJson(request);
        const amount = betPoints(body.amount);
        const rivalId = String(body.rivalId || '').trim().toLowerCase();
        if (!UUID_RE.test(rivalId) || rivalId === user.id) throw new ApiError(400, 'Elegí a un amigo como rival.');
        if (!(await areFriends(user.id, rivalId))) throw new ApiError(403, 'Solo podés desafiar a tus amigos.');
        const busy = await pool.query(`
            SELECT 1 FROM hatitix_bets
            WHERE status IN ('pending', 'accepted') AND created_at > datetime('now', '-4 hours')
              AND (challenger_id IN ($1, $2) OR rival_id IN ($1, $2)) LIMIT 1`, [user.id, rivalId]);
        if (busy.rowCount) throw new ApiError(409, 'Tú o tu rival ya tienen una apuesta en curso. Esperen a que termine.');
        const id = crypto.randomUUID();
        await withTx(pool, async (client) => {
            await client.query('INSERT INTO hatitix_bets(id, room_id, challenger_id, rival_id, amount, team) VALUES($1, $2, $3, $4, $5, $6)', [id, '', user.id, rivalId, amount, 'red']);
            await client.query("INSERT INTO hatitix_bet_wagers(id, bet_id, account_id, role, team, amount) VALUES($1, $2, $3, 'player', 'red', $4)", [crypto.randomUUID(), id, user.id, amount]);
            await client.query("INSERT INTO hatitix_bet_wagers(id, bet_id, account_id, role, team, amount) VALUES($1, $2, $3, 'player', 'blue', $4)", [crypto.randomUUID(), id, rivalId, amount]);
        });
        return reply({ message: 'Desafío enviado. Esperando que tu rival acepte.', bet: { id, status: 'pending', amount } }, 201);
    }

    if (method === 'GET' && path === '/api/bets/mine') {
        await pool.query("UPDATE hatitix_bets SET status = 'cancelled' WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')");
        await pool.query("UPDATE hatitix_bets SET status = 'cancelled' WHERE status = 'accepted' AND created_at < datetime('now', '-4 hours')");
        // Abandono: si uno informó que el rival se fue y el rival no contestó en 90 s, gana quien informó.
        await pool.query(`UPDATE hatitix_bets SET status = 'settled', winner_team = COALESCE(report_challenger, report_rival), settled_at = CURRENT_TIMESTAMP
            WHERE status = 'accepted' AND started_at IS NOT NULL AND forfeit_at IS NOT NULL AND forfeit_at < datetime('now', '-90 seconds')
              AND ((report_challenger IS NULL AND report_rival IS NOT NULL) OR (report_challenger IS NOT NULL AND report_rival IS NULL))`);
        const mine = await pool.query(`${BET_WITH_NAMES_SQL}
            WHERE (b.challenger_id = $1 OR b.rival_id = $1) AND b.status IN ('pending', 'accepted')
            ORDER BY b.created_at DESC LIMIT 10`, [user.id]);
        const incoming = [], outgoing = [], active = [];
        for (const row of mine.rows) {
            const iAmChallenger = row.challenger_id === user.id;
            const base = { id: row.id, amount: Number(row.amount), createdAt: row.created_at };
            if (row.status === 'pending') {
                if (iAmChallenger) outgoing.push({ ...base, toName: row.r_name, toTag: tag(row.r_name, row.r_code) });
                else incoming.push({ ...base, fromName: row.c_name, fromTag: tag(row.c_name, row.c_code) });
                continue;
            }
            active.push({
                ...base, role: iAmChallenger ? 'challenger' : 'rival', side: iAmChallenger ? 'red' : 'blue',
                opponentName: iAmChallenger ? row.r_name : row.c_name, opponentId: iAmChallenger ? row.rival_id : row.challenger_id,
                redName: row.c_name, blueName: row.r_name,
                roomId: row.room_id || '', roomLink: row.room_link || '', roomPassword: row.room_password || '',
                rivalPlayerName: row.rival_player_name || '', started: !!row.started_at,
                reported: !!(iAmChallenger ? row.report_challenger : row.report_rival)
            });
        }
        const watch = await pool.query(`${BET_WITH_NAMES_SQL}
            JOIN hatitix_bet_spectators s ON s.bet_id = b.id AND s.account_id = $1
            WHERE s.status IN ('invited', 'joined') AND b.status = 'accepted' AND b.room_link <> ''
            ORDER BY b.created_at DESC LIMIT 10`, [user.id]);
        const wagers = watch.rows.length
            ? await pool.query(`SELECT bet_id, team, amount FROM hatitix_bet_wagers WHERE account_id = $1 AND bet_id IN (${watch.rows.map((_, i) => `$${i + 2}`).join(', ')})`, [user.id, ...watch.rows.map((row) => row.id)])
            : { rows: [] };
        const statusOf = await pool.query("SELECT bet_id, status FROM hatitix_bet_spectators WHERE account_id = $1", [user.id]);
        const spectatorStatus = new Map(statusOf.rows.map((row) => [row.bet_id, row.status]));
        const invites = [], spectating = [];
        for (const row of watch.rows) {
            const info = { id: row.id, amount: Number(row.amount), redName: row.c_name, blueName: row.r_name, started: !!row.started_at };
            if (spectatorStatus.get(row.id) === 'invited') invites.push(info);
            else {
                const wager = wagers.rows.find((entry) => entry.bet_id === row.id);
                spectating.push({ ...info, roomId: row.room_id || '', roomLink: row.room_link, roomPassword: row.room_password, myWager: wager ? { team: wager.team, amount: Number(wager.amount) } : null });
            }
        }
        const results = await pool.query(`
            SELECT w.bet_id, w.role, w.team, w.amount, b.winner_team, c.display_name AS c_name, r.display_name AS r_name
            FROM hatitix_bet_wagers w
            JOIN hatitix_bets b ON b.id = w.bet_id
            JOIN hatitix_accounts c ON c.id = b.challenger_id
            JOIN hatitix_accounts r ON r.id = b.rival_id
            WHERE w.account_id = $1 AND w.claimed = 0 AND b.status = 'settled' LIMIT 20`, [user.id]);
        return reply({
            incoming, outgoing, active, invites, spectating,
            results: results.rows.map((row) => ({ betId: row.bet_id, role: row.role, team: row.team, amount: Number(row.amount), winnerTeam: row.winner_team, won: row.team === row.winner_team, redName: row.c_name, blueName: row.r_name }))
        });
    }

    if (method === 'POST' && path === '/api/bets/claim') {
        const body = await readJson(request);
        const betId = String(body.betId || '').toLowerCase();
        if (!UUID_RE.test(betId)) throw new ApiError(400, 'Apuesta inválida.');
        const found = await pool.query(`
            SELECT w.team, w.amount, b.winner_team FROM hatitix_bet_wagers w JOIN hatitix_bets b ON b.id = w.bet_id
            WHERE w.bet_id = $1 AND w.account_id = $2 AND b.status = 'settled'`, [betId, user.id]);
        if (!found.rows[0]) throw new ApiError(404, 'No hay nada para cobrar en esa apuesta.');
        const marked = await pool.query('UPDATE hatitix_bet_wagers SET claimed = 1 WHERE bet_id = $1 AND account_id = $2 AND claimed = 0', [betId, user.id]);
        if (!marked.rowCount) return reply({ claimed: false });
        const won = found.rows[0].team === found.rows[0].winner_team, amount = Number(found.rows[0].amount);
        return reply({ claimed: true, won, amount, delta: won ? amount : -amount });
    }

    const action = path.match(/^\/api\/bets\/([0-9a-f-]{36})\/(accept|reject|room|ready|start|settle|spectate|wager)$/i);
    if (method !== 'POST' || !action || !UUID_RE.test(action[1])) return false;
    const betId = action[1].toLowerCase(), what = action[2].toLowerCase();
    const bet = await loadBet(betId);
    if (!bet) throw new ApiError(404, 'La apuesta ya no existe.');
    const isChallenger = bet.challenger_id === user.id, isRival = bet.rival_id === user.id;

    if (what === 'accept') {
        if (!isRival) throw new ApiError(403, 'Solo el rival puede aceptar esta apuesta.');
        if (bet.status !== 'pending') throw new ApiError(409, 'Esta apuesta ya fue respondida o venció.');
        await pool.query("UPDATE hatitix_bets SET status = 'accepted' WHERE id = $1 AND status = 'pending'", [betId]);
        return reply({ status: 'accepted', amount: Number(bet.amount), message: 'Apuesta aceptada. El retador va a crear la sala 1v1.' });
    }
    if (what === 'reject') {
        if (!isRival && !isChallenger) throw new ApiError(403, 'No participás en esta apuesta.');
        if (!['pending', 'accepted'].includes(bet.status)) return reply({ status: bet.status, message: 'La apuesta ya estaba cerrada.' });
        // Antes de que empiece el partido cualquiera de los dos puede cancelar. Si ya empezó y pasaron 6 minutos
        // (un partido dura 3 como máximo), se considera trabada y también se puede cancelar: nadie gana ni pierde.
        const done = await pool.query("UPDATE hatitix_bets SET status = 'rejected' WHERE id = $1 AND status IN ('pending', 'accepted') AND (started_at IS NULL OR started_at < datetime('now', '-6 minutes'))", [betId]);
        if (!done.rowCount) throw new ApiError(409, 'El partido ya empezó y no se puede cancelar todavía. Si quedó trabado, probá de nuevo pasados 6 minutos desde que empezó.');
        return reply({ status: 'rejected', message: 'Apuesta cancelada.' });
    }
    if (what === 'room') {
        if (!isChallenger) throw new ApiError(403, 'Solo el retador crea la sala.');
        if (bet.status !== 'accepted') throw new ApiError(409, 'La apuesta todavía no fue aceptada.');
        const body = await readJson(request);
        const roomId = String(body.roomId || ''), link = String(body.link || '').slice(0, 300), password = String(body.password || '');
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId) || !/^https?:\/\//i.test(link)) throw new ApiError(400, 'Sala inválida.');
        if (!/^[A-Za-z0-9_-]{4,40}$/.test(password)) throw new ApiError(400, 'La clave de la sala no es válida.');
        const first = !bet.room_link;
        await pool.query('UPDATE hatitix_bets SET room_id = $2, room_link = $3, room_password = $4 WHERE id = $1', [betId, roomId, link, password]);
        let invited = 0;
        if (first) {
            // "Quiero spectear": se invita a los amigos conectados de ambos jugadores que no participan.
            const seen = new Set([bet.challenger_id, bet.rival_id]);
            for (const owner of [bet.challenger_id, bet.rival_id]) {
                const friends = await pool.query(`
                    SELECT a.* FROM hatitix_friendships f
                    JOIN hatitix_accounts a ON a.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
                    WHERE f.user_low = $1 OR f.user_high = $1`, [owner]);
                for (const friend of friends.rows) {
                    if (seen.has(friend.id) || !presenceOf(friend).online || invited >= 40) continue;
                    seen.add(friend.id);
                    await pool.query('INSERT INTO hatitix_bet_spectators(bet_id, account_id) VALUES($1, $2) ON CONFLICT DO NOTHING', [betId, friend.id]);
                    invited++;
                }
            }
        }
        return reply({ invited });
    }
    if (what === 'ready') {
        if (!isRival) throw new ApiError(403, 'Solo el rival puede avisar que entró.');
        const body = await readJson(request);
        const name = socialCleanText(body.playerName, 40);
        if (!name) throw new ApiError(400, 'Falta el nombre del jugador en la sala.');
        await pool.query('UPDATE hatitix_bets SET rival_player_name = $2 WHERE id = $1', [betId, name]);
        return reply({});
    }
    if (what === 'start') {
        if (!isChallenger) throw new ApiError(403, 'Solo el anfitrión inicia el partido.');
        if (bet.status !== 'accepted') throw new ApiError(409, 'La apuesta no está activa.');
        await pool.query('UPDATE hatitix_bets SET started_at = CURRENT_TIMESTAMP WHERE id = $1 AND started_at IS NULL', [betId]);
        return reply({});
    }
    if (what === 'settle') {
        if (!isChallenger && !isRival) throw new ApiError(403, 'No participás en esta apuesta.');
        // Si el que se fue ya reconoció la derrota, la apuesta está liquidada: al otro jugador se le responde que sí, sin error.
        if (bet.status === 'settled') return reply({ state: 'settled', winnerTeam: bet.winner_team, message: 'Apuesta liquidada.' });
        if (bet.status !== 'accepted') throw new ApiError(409, 'La apuesta no está activa.');
        if (!bet.started_at) throw new ApiError(409, 'El partido todavía no empezó.');
        const body = await readJson(request);
        const winnerTeam = body.winnerTeam === 'blue' ? 'blue' : body.winnerTeam === 'red' ? 'red' : '';
        if (!winnerTeam) throw new ApiError(400, 'Resultado inválido.');
        if (body.forfeit === true) {
            const mySide = isChallenger ? 'red' : 'blue';
            if (winnerTeam !== mySide) {
                // El que abandona reconoce la derrota: se liquida ya, sin esperar al otro.
                await pool.query(`UPDATE hatitix_bets SET ${isChallenger ? 'report_challenger' : 'report_rival'} = $2, status = 'settled', winner_team = $2, settled_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'accepted'`, [betId, winnerTeam]);
                return reply({ state: 'settled', winnerTeam, message: 'Abandonaste el 1v1: perdiste la apuesta.' });
            }
            // El otro se fue: se anota y, si el rival no contesta en 90 s, se liquida a favor de quien informó (ver /api/bets/mine).
            await pool.query(`UPDATE hatitix_bets SET ${isChallenger ? 'report_challenger' : 'report_rival'} = $2, forfeit_at = CURRENT_TIMESTAMP WHERE id = $1`, [betId, winnerTeam]);
            const check = await loadBet(betId);
            if (!check.report_challenger || !check.report_rival) return reply({ state: 'waiting', message: 'Tu rival abandonó. Si no responde en 90 segundos, ganás la apuesta.' });
            if (check.report_challenger === check.report_rival) {
                await pool.query("UPDATE hatitix_bets SET status = 'settled', winner_team = $2, settled_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'accepted'", [betId, winnerTeam]);
                return reply({ state: 'settled', winnerTeam, message: 'Apuesta liquidada.' });
            }
            await pool.query("UPDATE hatitix_bets SET status = 'cancelled' WHERE id = $1 AND status = 'accepted'", [betId]);
            return reply({ state: 'cancelled', message: 'Los dos resultados no coinciden: la apuesta se anuló y nadie pierde puntos.' });
        }
        await pool.query(`UPDATE hatitix_bets SET ${isChallenger ? 'report_challenger' : 'report_rival'} = $2 WHERE id = $1`, [betId, winnerTeam]);
        const fresh = await loadBet(betId);
        if (!fresh.report_challenger || !fresh.report_rival) return reply({ state: 'waiting', message: 'Resultado enviado. Esperando que tu rival lo confirme.' });
        if (fresh.report_challenger === fresh.report_rival) {
            await pool.query("UPDATE hatitix_bets SET status = 'settled', winner_team = $2, settled_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'accepted'", [betId, winnerTeam]);
            return reply({ state: 'settled', winnerTeam, message: 'Apuesta liquidada.' });
        }
        await pool.query("UPDATE hatitix_bets SET status = 'cancelled' WHERE id = $1 AND status = 'accepted'", [betId]);
        return reply({ state: 'cancelled', message: 'Los dos resultados no coinciden: la apuesta se anuló y nadie pierde puntos.' });
    }
    if (what === 'spectate') {
        const body = await readJson(request);
        const spectator = await pool.query('SELECT status FROM hatitix_bet_spectators WHERE bet_id = $1 AND account_id = $2', [betId, user.id]);
        if (!spectator.rows[0]) throw new ApiError(403, 'No fuiste invitado a mirar esta apuesta.');
        if (body.accept !== true) {
            await pool.query("UPDATE hatitix_bet_spectators SET status = 'declined' WHERE bet_id = $1 AND account_id = $2", [betId, user.id]);
            return reply({ joined: false });
        }
        if (bet.status !== 'accepted' || !bet.room_link) throw new ApiError(409, 'La apuesta ya terminó.');
        await pool.query("UPDATE hatitix_bet_spectators SET status = 'joined' WHERE bet_id = $1 AND account_id = $2", [betId, user.id]);
        return reply({ joined: true, roomId: bet.room_id, roomLink: bet.room_link, roomPassword: bet.room_password, started: !!bet.started_at, redName: bet.c_name, blueName: bet.r_name, amount: Number(bet.amount) });
    }
    if (what === 'wager') {
        const spectator = await pool.query("SELECT 1 FROM hatitix_bet_spectators WHERE bet_id = $1 AND account_id = $2 AND status = 'joined'", [betId, user.id]);
        if (!spectator.rowCount) throw new ApiError(403, 'Primero aceptá mirar la apuesta.');
        if (bet.status !== 'accepted') throw new ApiError(409, 'La apuesta ya terminó.');
        if (bet.started_at) throw new ApiError(409, 'El partido ya empezó: las apuestas están cerradas.');
        const body = await readJson(request);
        const team = body.team === 'blue' ? 'blue' : body.team === 'red' ? 'red' : '';
        if (!team) throw new ApiError(400, 'Elegí rojo o azul.');
        const amount = betPoints(body.amount, 'Tu apuesta');
        const inserted = await pool.query("INSERT INTO hatitix_bet_wagers(id, bet_id, account_id, role, team, amount) VALUES($1, $2, $3, 'spectator', $4, $5) ON CONFLICT (bet_id, account_id) DO NOTHING", [crypto.randomUUID(), betId, user.id, team, amount]);
        if (!inserted.rowCount) throw new ApiError(409, 'Ya apostaste en este partido.');
        return reply({ team, amount, message: `Apostaste ${amount} puntos al ${team === 'red' ? 'rojo' : 'azul'}.` }, 201);
    }
    return false;
}

function createAccountApi(pool) {
    const authAttempts = new Map();
    const messageBuckets = new Map();
    const redeemBuckets = new Map();
    // IPs baneadas: viven en la base (para que persistan si Render reinicia el servicio) y en memoria
    // (para no consultar la base en cada request/conexión). loadBannedIps() las carga al arrancar.
    const bannedIps = new Set();
    async function loadBannedIps() {
        try {
            const { rows } = await pool.query('SELECT ip FROM hatitix_banned_ips');
            bannedIps.clear();
            for (const row of rows) bannedIps.add(row.ip);
        } catch (error) { console.error('No se pudieron cargar las IPs baneadas:', error.message); }
    }
    const lastSeen = new Map();      // id -> última actividad (ms) en memoria
    const lastPersisted = new Map(); // id -> última vez que se guardó last_seen en la base
    function touch(user, ip) {
        const now = Date.now();
        lastSeen.set(user.id, now);
        if (now - (lastPersisted.get(user.id) || 0) > 60000) {
            lastPersisted.set(user.id, now);
            pool.query('UPDATE hatitix_accounts SET last_seen=NOW(), last_ip=$2 WHERE id=$1', [user.id, String(ip || '').slice(0, 80)]).catch(() => {});
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
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS admin_points_total BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE hatitix_accounts ADD COLUMN IF NOT EXISTS last_ip TEXT NOT NULL DEFAULT '';
            CREATE TABLE IF NOT EXISTS hatitix_banned_ips (
                ip TEXT PRIMARY KEY,
                reason TEXT NOT NULL DEFAULT '',
                banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
            ALTER TABLE hatitix_account_stats ADD COLUMN IF NOT EXISTS assists BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE hatitix_account_stats ADD COLUMN IF NOT EXISTS matches BIGINT NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS hatitix_maps (
                id UUID PRIMARY KEY, name TEXT NOT NULL, author_id UUID REFERENCES hatitix_accounts(id) ON DELETE SET NULL,
                author_name TEXT NOT NULL, data TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                likes INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL DEFAULT 'comunidad'
            );
            ALTER TABLE hatitix_maps ADD COLUMN IF NOT EXISTS likes INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE hatitix_maps ADD COLUMN IF NOT EXISTS downloads INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE hatitix_maps ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'comunidad';
            CREATE TABLE IF NOT EXISTS hatitix_bets (
                id UUID PRIMARY KEY,
                room_id TEXT NOT NULL,
                challenger_id UUID NOT NULL REFERENCES hatitix_accounts(id) ON DELETE CASCADE,
                rival_id UUID REFERENCES hatitix_accounts(id) ON DELETE SET NULL,
                amount INTEGER NOT NULL CHECK (amount > 0),
                team TEXT NOT NULL DEFAULT 'red' CHECK (team IN ('red', 'blue')),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'settled', 'cancelled')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS team TEXT NOT NULL DEFAULT 'red';
            CREATE INDEX IF NOT EXISTS hatitix_bets_room_idx ON hatitix_bets(room_id, created_at DESC);
        `);
        schemaReady = true;
        await loadBannedIps();
        try { await pool.query(BET_TABLES_SQL); }
        catch (error) { console.error('No se pudieron crear las tablas de apuestas:', error.message); }
        try {
            // Cuentas creadas antes de este arreglo: se agregan al ranking con valores en 0.
            await pool.query('INSERT INTO hatitix_account_stats(account_id) SELECT id FROM hatitix_accounts WHERE id NOT IN (SELECT account_id FROM hatitix_account_stats)');
        } catch (error) { console.error('No se pudo completar el ranking de cuentas existentes:', error.message); }
        try { await pool.query(SOCIAL_TABLES_SQL); }
        catch (error) { console.error('No se pudieron crear las tablas de grupos/Parties:', error.message); }
        const cleanupDays = Number(process.env.TURSO_CLEANUP_DAYS || 180);
        if (Number.isInteger(cleanupDays) && cleanupDays >= 30) {
            const cutoff = `-${cleanupDays} days`;
            try {
                await pool.query("DELETE FROM hatitix_messages WHERE created_at < datetime('now', $1)", [cutoff]);
                await pool.query("DELETE FROM hatitix_group_messages WHERE created_at < datetime('now', $1)", [cutoff]);
                await pool.query("DELETE FROM hatitix_party_invites WHERE created_at < datetime('now', '-2 days')");
                await pool.query("DELETE FROM hatitix_sessions WHERE expires_at < CURRENT_TIMESTAMP");
                await pool.query("DELETE FROM hatitix_bets WHERE status IN ('settled', 'cancelled', 'rejected') AND created_at < datetime('now', $1)", [cutoff]);
            } catch (error) { console.error('No se pudo ejecutar la limpieza de datos antiguos:', error.message); }
        }
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
            "INSERT INTO hatitix_sessions(token_hash, account_id, expires_at) VALUES($1, $2, datetime('now', '+' || $3 || ' days'))",
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
                        const text = `${error.code || ''} ${error.message || ''}`;
                        const unique = error.code === '23505' || /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(text);
                        if (unique && /hatitix_accounts\.email|\bemail\b/i.test(text)) {
                            return json(response, 409, { ok: false, error: 'email_taken', message: 'Ya existe una cuenta con ese correo.' }), true;
                        }
                        if (unique && attempt < 11) continue;
                        throw error;
                    }
                }
                if (!account) return json(response, 503, { ok: false, error: 'tag_unavailable', message: 'No se pudo asignar un identificador. Vuelve a intentarlo.' }), true;
                // Toda cuenta nueva aparece en el ranking desde el primer momento (0 goles, 0 horas).
                await pool.query('INSERT INTO hatitix_account_stats(account_id) VALUES($1) ON CONFLICT DO NOTHING', [account.id]).catch((error) => console.error('No se pudo crear la fila de ranking:', error.message));
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
            touch(user, ipKey(request));
            if (await handleCommunityMaps({ request, url, response, pool, user, json, readJson })) return true;
            if (await handleSocialRoutes({ request, url, response, pool, user, json, readJson, areFriends, messageLimited })) return true;
            if (request.method === 'GET' && url.pathname === '/api/news') {
                json(response, 200, { ok: true, news: [
                    { id: 1, title: '¡Bienvenidos a HaTitix!', date: '2026-11-14', content: 'Ya está disponible la Workshop de mapas comunitarios.' },
                    { id: 2, title: 'Torneo de fin de semana', date: '2026-11-14', content: 'Prepárate para los próximos partidos de Futsal.' }
                ] }); return true;
            }
            if (await handleBetRoutes({ request, url, response, pool, user, json, readJson, areFriends, presenceOf })) return true;
            if (request.method === 'GET' && url.pathname === '/api/me') {
                const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
                if (bearer) await pool.query("UPDATE hatitix_sessions SET expires_at = datetime('now', '+' || $2 || ' days') WHERE token_hash = $1", [hashToken(bearer), SESSION_DAYS]).catch(() => {});
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
                const assists = Math.max(0, Math.min(1000000000, Math.floor(Number(body.assists) || 0)));
                const matches = Math.max(0, Math.min(1000000000, Math.floor(Number(body.matches) || 0)));
                await pool.query(`
                    INSERT INTO hatitix_account_stats(account_id,goals,hours,assists,matches) VALUES($1,$2,$3,$4,$5)
                    ON CONFLICT (account_id) DO UPDATE SET
                        goals=MAX(hatitix_account_stats.goals, EXCLUDED.goals),
                        hours=MAX(hatitix_account_stats.hours, EXCLUDED.hours),
                        assists=MAX(hatitix_account_stats.assists, EXCLUDED.assists),
                        matches=MAX(hatitix_account_stats.matches, EXCLUDED.matches),
                        updated_at=NOW()
                `, [user.id, goals, hours, assists, matches]);
                json(response, 200, { ok: true }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/ranking/friends') {
                const { rows } = await pool.query(`
                    SELECT a.id, a.display_name, a.tag_code, COALESCE(s.goals,0)::bigint AS goals,
                           COALESCE(s.hours,0)::double precision AS hours,
                           COALESCE(s.assists,0)::bigint AS assists, COALESCE(s.matches,0)::bigint AS matches
                    FROM hatitix_accounts a
                    LEFT JOIN hatitix_account_stats s ON s.account_id=a.id
                    WHERE a.id=$1 OR a.id IN (
                        SELECT CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END
                        FROM hatitix_friendships f WHERE f.user_low=$1 OR f.user_high=$1
                    )
                    ORDER BY goals DESC, hours DESC, a.display_name ASC LIMIT 100
                `, [user.id]);
                json(response, 200, { ok: true, entries: rows.map((row) => ({ id: row.id, name: row.display_name, tag: `${row.display_name}#${row.tag_code}`, goals: Number(row.goals) || 0, hours: Number(row.hours) || 0, assists: Number(row.assists) || 0, matches: Number(row.matches) || 0 })) }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/ranking/global') {
                const { rows } = await pool.query(`
                    SELECT a.id, a.display_name, a.tag_code, COALESCE(s.goals,0)::bigint AS goals,
                           COALESCE(s.hours,0)::double precision AS hours,
                           COALESCE(s.assists,0)::bigint AS assists, COALESCE(s.matches,0)::bigint AS matches
                    FROM hatitix_accounts a
                    LEFT JOIN hatitix_account_stats s ON s.account_id=a.id
                    ORDER BY goals DESC, hours DESC, a.display_name ASC LIMIT 100
                `);
                json(response, 200, { ok: true, entries: rows.map((row) => ({ id: row.id, name: row.display_name, tag: `${row.display_name}#${row.tag_code}`, goals: Number(row.goals) || 0, hours: Number(row.hours) || 0, assists: Number(row.assists) || 0, matches: Number(row.matches) || 0 })) }); return true;
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
                // El pin OWNER solo lo puede canjear la cuenta configurada en OWNER_ACCOUNT_EMAIL (variable de entorno en Render).
                if (reward.grant === 'owner' && !isOwnerEmail(user)) {
                    return json(response, 403, { ok: false, error: 'not_allowed', message: 'Ese código solo lo puede usar la cuenta del dueño.' }), true;
                }
                // Turso guarda los grants como JSON en una columna TEXT.
                const current = await pool.query('SELECT * FROM hatitix_accounts WHERE id=$1', [user.id]);
                if (!current.rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'Cuenta no encontrada.' }), true;
                const grants = Array.isArray(current.rows[0].grants) ? current.rows[0].grants.slice() : parsePins(current.rows[0].grants || '[]');
                const grantIds = grants.map((item) => typeof item === 'string' ? item : item?.grant).filter(Boolean);
                if (grantIds.includes(reward.grant)) return json(response, 409, { ok: false, error: 'already_redeemed', message: 'Esta cuenta ya canjeó ese código.' }), true;
                if (reward.fixedTag) {
                    const taken = await pool.query('SELECT id FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2 AND id<>$3', [accountTagKey(reward.fixedTag.displayName), reward.fixedTag.tagCode, user.id]);
                    if (taken.rows[0]) return json(response, 409, { ok: false, error: 'tag_taken', message: 'El identificador Titi#0000 ya está ocupado.' }), true;
                }
                grants.push(reward.grant);
                const result = reward.fixedTag
                    ? await pool.query('UPDATE hatitix_accounts SET display_name=$2,name_key=$3,tag_code=$4,grants=$5 WHERE id=$1 RETURNING *', [user.id, reward.fixedTag.displayName, accountTagKey(reward.fixedTag.displayName), reward.fixedTag.tagCode, JSON.stringify(grants)])
                    : await pool.query('UPDATE hatitix_accounts SET grants=$2 WHERE id=$1 RETURNING *', [user.id, JSON.stringify(grants)]);
                json(response, 200, { ok: true, points: reward.points, grant: reward.grant, message: reward.message, user: safeUser(result.rows[0]) }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/ban-ip') {
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const body = await readJson(request);
                const ip = String(body.ip || '').trim().slice(0, 80);
                if (!ip) return json(response, 400, { ok: false, error: 'invalid_ip', message: 'Falta la IP.' }), true;
                const reason = String(body.reason || '').trim().slice(0, 200);
                await pool.query('INSERT INTO hatitix_banned_ips(ip, reason) VALUES($1,$2) ON CONFLICT (ip) DO UPDATE SET reason=EXCLUDED.reason', [ip, reason]);
                bannedIps.add(ip);
                json(response, 200, { ok: true, ip, reason }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/unban-ip') {
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const body = await readJson(request);
                const ip = String(body.ip || '').trim().slice(0, 80);
                if (!ip) return json(response, 400, { ok: false, error: 'invalid_ip', message: 'Falta la IP.' }), true;
                await pool.query('DELETE FROM hatitix_banned_ips WHERE ip=$1', [ip]);
                bannedIps.delete(ip);
                json(response, 200, { ok: true, ip }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/ban-player') {
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const body = await readJson(request);
                const tag = String(body.tag || '').trim();
                const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                const found = await pool.query('SELECT * FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                if (!found.rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                const ip = String(found.rows[0].last_ip || '').trim();
                if (!ip) return json(response, 409, { ok: false, error: 'no_ip_known', message: 'Todavía no tenemos registrada ninguna IP para esa cuenta (necesita iniciar sesión al menos una vez después de esta actualización). Probá de nuevo más tarde.' }), true;
                const reason = String(body.reason || '').trim().slice(0, 200);
                await pool.query('INSERT INTO hatitix_banned_ips(ip, reason) VALUES($1,$2) ON CONFLICT (ip) DO UPDATE SET reason=EXCLUDED.reason', [ip, reason ? `${reason} (${tag})` : `Baneado por nombre: ${tag}`]);
                bannedIps.add(ip);
                json(response, 200, { ok: true, tag, ip, reason }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/unban-player') {
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const body = await readJson(request);
                const tag = String(body.tag || '').trim();
                const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                const found = await pool.query('SELECT * FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                if (!found.rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                const ip = String(found.rows[0].last_ip || '').trim();
                if (ip) { await pool.query('DELETE FROM hatitix_banned_ips WHERE ip=$1', [ip]); bannedIps.delete(ip); }
                json(response, 200, { ok: true, tag, ip }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/admin/banned-ips') {
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const { rows } = await pool.query('SELECT ip, reason, banned_at FROM hatitix_banned_ips ORDER BY banned_at DESC');
                json(response, 200, { ok: true, banned: rows }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/reset-codes') {
                // Borra grants (OWNER/BETATESTER) de una cuenta para que pueda volver a canjear el código.
                // Sin "tag" en el body, se aplica a tu propia cuenta. Con "tag", a la cuenta de ese Nombre#1234.
                // Sin "grant" en el body, borra TODOS los grants de esa cuenta; con "grant", borra solo ese.
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const body = await readJson(request).catch(() => ({}));
                const tag = String(body.tag || '').trim();
                const grant = body.grant === undefined || body.grant === null ? null : String(body.grant).trim();
                if (grant !== null && grant !== 'owner' && grant !== 'betatester') {
                    return json(response, 400, { ok: false, error: 'invalid_grant', message: 'grant debe ser "owner" o "betatester" (o no enviarlo, para borrar todos).' }), true;
                }
                let targetId = user.id;
                if (tag) {
                    const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                    if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                    const found = await pool.query('SELECT id FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                    if (!found.rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                    targetId = found.rows[0].id;
                }
                let result;
                if (grant === null) {
                    result = await pool.query("UPDATE hatitix_accounts SET grants='[]' WHERE id=$1 RETURNING *", [targetId]);
                } else {
                    const current = await pool.query('SELECT * FROM hatitix_accounts WHERE id=$1', [targetId]);
                    if (!current.rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                    const grants = (Array.isArray(current.rows[0].grants) ? current.rows[0].grants : parsePins(current.rows[0].grants || '[]'))
                        .filter((item) => (typeof item === 'string' ? item : item?.grant) !== grant);
                    result = await pool.query('UPDATE hatitix_accounts SET grants=$2 WHERE id=$1 RETURNING *', [targetId, JSON.stringify(grants)]);
                }
                json(response, 200, { ok: true, user: safeUser(result.rows[0]) }); return true;
            }
            if (request.method === 'GET' && url.pathname === '/api/users/search') {
                const tag = String(url.searchParams.get('tag') || '').trim();
                const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                const { rows } = await pool.query('SELECT * FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                if (!rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                json(response, 200, { ok: true, user: safeUser(rows[0]) }); return true;
            }
            if (request.method === 'POST' && url.pathname === '/api/admin/points') {
                if (!isOwnerEmail(user)) return json(response, 403, { ok: false, error: 'not_allowed', message: 'Solo el dueño puede usar esto.' }), true;
                const body = await readJson(request);
                const tag = String(body.tag || '').trim();
                const match = tag.match(/^(.{2,24})#(\d{4})$/u);
                if (!match) return json(response, 400, { ok: false, error: 'invalid_tag', message: 'Usa el formato Nombre#1234.' }), true;
                const delta = Math.trunc(Number(body.delta));
                if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000000) {
                    return json(response, 400, { ok: false, error: 'invalid_delta', message: 'La cantidad debe ser un número entero distinto de 0 (máx. 1.000.000).' }), true;
                }
                const found = await pool.query('SELECT * FROM hatitix_accounts WHERE name_key=$1 AND tag_code=$2', [accountTagKey(match[1]), match[2]]);
                if (!found.rows[0]) return json(response, 404, { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' }), true;
                const updated = await pool.query('UPDATE hatitix_accounts SET admin_points_total = admin_points_total + $2 WHERE id=$1 RETURNING *', [found.rows[0].id, delta]);
                const target = safeUser(updated.rows[0]);
                json(response, 200, { ok: true, user: target, delta, newTotal: target.adminPointsTotal }); return true;
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
                // Invitaciones a sala recientes sin leer: el cliente las muestra en pantalla sin marcarlas como leídas.
                const pending = await pool.query(`
                    SELECT m.id, m.body, a.display_name AS from_name FROM hatitix_messages m
                    JOIN hatitix_accounts a ON a.id = m.sender_id
                    WHERE m.receiver_id = $1 AND m.read_at IS NULL AND m.body LIKE '%sala de HaTitix: http%' AND m.created_at > datetime('now', '-15 minutes')
                    ORDER BY m.id DESC LIMIT 5`, [user.id]);
                const roomInvites = pending.rows.map((row) => ({ id: Number(row.id), fromName: row.from_name, link: (String(row.body).match(/https?:\/\/\S+/) || [''])[0] }));
                json(response, 200, { ok: true, counts, roomInvites }); return true;
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
            if (!(Number(error.status) >= 400 && Number(error.status) < 500)) console.error('Error en API de cuentas:', error.stack || error.message);
            json(response, Number(error.status) || 500, { ok: false, error: Number(error.status) === 413 ? 'payload_too_large' : 'server_error', message: Number(error.status) ? error.message : `Error interno del servidor: ${String(error.message || error).slice(0, 160)}` });
            return true;
        }
    }

    return { initialize, handle, isReady: () => schemaReady, isBannedIp: (ip) => bannedIps.has(ip) };
}

module.exports = { createAccountApi, ipKey };
