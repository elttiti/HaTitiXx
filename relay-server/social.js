'use strict';

/**
 * HaTitix · grupos, parties y apuestas (servidor).
 * Se enchufa en accounts.js igual que community-maps.js:
 *   handleSocial({ request, url, response, pool, user, json, readJson, areFriends, messageLimited })
 * Devuelve true si consumió la petición, false si la ruta no era suya.
 * Los errores se lanzan como ApiError (con .status) y los formatea el catch de accounts.js.
 */

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GROUP_MEMBERS = 30;
const MAX_GROUPS_OWNED = 20;
const MAX_PARTY_MEMBERS = 20;
const MAX_MESSAGE_CHARS = 500;
const BET_MAX = 1000000;
const BET_MAX_OPEN = 5;

class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const SOCIAL_SCHEMA_SQL = `
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

ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS challenger_report TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS rival_report TEXT;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE hatitix_bets ADD COLUMN IF NOT EXISTS resolution TEXT;
CREATE INDEX IF NOT EXISTS hatitix_bets_challenger_idx ON hatitix_bets(challenger_id, status);
CREATE INDEX IF NOT EXISTS hatitix_bets_rival_idx ON hatitix_bets(rival_id, status);
-- Las apuestas antiguas "contra la casa" (sin rival) creaban puntos de la nada: se cierran.
UPDATE hatitix_bets SET status = 'cancelled', resolution = 'legacy', settled_at = NOW()
    WHERE rival_id IS NULL AND status IN ('pending', 'accepted');
`;

function cleanText(value, max, fallback = '') {
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
    const members = await pool.query(`
        SELECT gm.group_id, a.id, a.display_name, a.tag_code
        FROM hatitix_group_members gm JOIN hatitix_accounts a ON a.id = gm.account_id
        WHERE gm.group_id = ANY($1::uuid[]) ORDER BY gm.joined_at`, [rows.map((row) => row.id)]);
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
            const name = cleanText(body.name, 40);
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
                await client.query('INSERT INTO hatitix_group_members(group_id, account_id) SELECT $1::uuid, UNNEST($2::uuid[])', [id, [user.id, ...memberIds]]);
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
        if (ids.length) await pool.query('INSERT INTO hatitix_group_members(group_id, account_id) SELECT $1::uuid, UNNEST($2::uuid[]) ON CONFLICT DO NOTHING', [groupId, ids]);
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
            const senderName = cleanText(user.display_name || user.displayName || 'Jugador', 50, 'Jugador');
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
        JOIN hatitix_parties p ON p.id = pm.party_id WHERE pm.account_id = $1 FOR UPDATE OF pm`, [accountId]);
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
        const name = cleanText(body.name, 40, 'Mi Party');
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
        const roomId = String(body.roomId || '');
        const link = String(body.link || '').slice(0, 300);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId) || !/^https?:\/\//i.test(link)) throw new ApiError(400, 'Sala inválida.');
        const party = await partyOf(pool, user.id);
        if (!party || !party.isLeader) return ok({ updated: false });
        const result = await pool.query(`
            UPDATE hatitix_parties SET room_id = $3, room_link = $4, room_seq = room_seq + 1
            WHERE id = $1 AND leader_id = $2 AND room_id IS DISTINCT FROM $3`, [party.id, user.id, roomId, link]);
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

// ------------------------------------------------------------------ APUESTAS
// El servidor es el árbitro: la apuesta es de suma cero entre DOS cuentas. Cada cliente descuenta su
// parte al crear/aceptar y cobra el pago que indica el servidor (nunca se crean puntos de la nada).
const BET_SELECT = `
    SELECT b.*, ca.display_name AS challenger_name, ra.display_name AS rival_name
    FROM hatitix_bets b
    JOIN hatitix_accounts ca ON ca.id = b.challenger_id
    LEFT JOIN hatitix_accounts ra ON ra.id = b.rival_id`;

async function expireBets(pool) {
    await pool.query(`UPDATE hatitix_bets SET status = 'cancelled', resolution = 'expired', settled_at = NOW()
        WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes'`);
    await pool.query(`UPDATE hatitix_bets SET status = 'cancelled', resolution = 'expired', settled_at = NOW()
        WHERE status = 'accepted' AND COALESCE(accepted_at, created_at) < NOW() - INTERVAL '6 hours'`);
}
function betView(row, userId) {
    const role = row.challenger_id === userId ? 'challenger' : 'rival';
    const myTeam = role === 'challenger' ? row.challenger_team : (row.challenger_team === 'red' ? 'blue' : 'red');
    const amount = Number(row.amount);
    // El rival solo puso su parte si llegó a aceptar; el retador la pone al crear.
    const escrowed = role === 'challenger' || !!row.accepted_at;
    let payout = 0;
    if (row.status === 'settled') {
        const iWon = (row.resolution === 'won_challenger') === (role === 'challenger');
        payout = iWon ? amount * 2 : 0;
    } else if (row.status === 'cancelled' || row.status === 'rejected') {
        payout = escrowed ? amount : 0;
    }
    return {
        id: row.id,
        roomId: row.room_id,
        role,
        myTeam,
        amount,
        status: row.status,
        resolution: row.resolution || '',
        winnerTeam: row.winner_team || '',
        opponentName: role === 'challenger' ? (row.rival_name || 'Rival') : (row.challenger_name || 'Rival'),
        myReport: (role === 'challenger' ? row.challenger_report : row.rival_report) || '',
        payout,
        createdAt: row.created_at
    };
}
async function loadBet(pool, betId, userId) {
    const { rows } = await pool.query(`${BET_SELECT} WHERE b.id = $1 AND (b.challenger_id = $2 OR b.rival_id = $2)`, [betId, userId]);
    return rows[0] ? betView(rows[0], userId) : null;
}

async function betsRoutes(ctx) {
    const { request, url, pool, user, readJson, ok } = ctx;
    const method = request.method, path = url.pathname;

    if (method === 'GET' && path === '/api/bet/mine') {
        await expireBets(pool);
        const { rows } = await pool.query(`${BET_SELECT}
            WHERE (b.challenger_id = $1 OR b.rival_id = $1) AND b.rival_id IS NOT NULL
              AND (b.status IN ('pending', 'accepted') OR COALESCE(b.settled_at, b.created_at) > NOW() - INTERVAL '7 days')
            ORDER BY b.created_at DESC LIMIT 60`, [user.id]);
        return ok({ bets: rows.map((row) => betView(row, user.id)) });
    }
    if (method === 'POST' && path === '/api/bet/create') {
        const body = await readJson(request);
        const amount = Number(body.amount);
        const team = String(body.team || '').toLowerCase();
        const roomId = String(body.roomId || '').trim();
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > BET_MAX) throw new ApiError(400, `El monto debe ser un entero entre 1 y ${BET_MAX.toLocaleString('es-AR')}.`);
        if (!['red', 'blue'].includes(team)) throw new ApiError(400, 'Elegí el equipo rojo o azul.');
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) throw new ApiError(400, 'Entrá a una sala para apostar.');
        await expireBets(pool);
        let rival;
        const rivalId = String(body.rivalId || '').toLowerCase();
        const rivalName = cleanText(body.rivalName, 60);
        if (UUID_RE.test(rivalId)) {
            rival = (await pool.query('SELECT id, display_name FROM hatitix_accounts WHERE id = $1', [rivalId])).rows[0];
        } else if (rivalName) {
            const found = await pool.query('SELECT id, display_name FROM hatitix_accounts WHERE LOWER(haxball_name) = LOWER($1) AND id <> $2 LIMIT 2', [rivalName, user.id]);
            if (found.rows.length > 1) throw new ApiError(409, 'Hay más de una cuenta HaTitix con ese nombre de Haxball.');
            rival = found.rows[0];
        }
        if (!rival) throw new ApiError(404, 'Ese jugador no tiene una cuenta HaTitix con su nombre de Haxball configurado.');
        if (rival.id === user.id) throw new ApiError(400, 'No podés apostar contra vos mismo.');
        const open = await pool.query(`SELECT COUNT(*)::int AS n FROM hatitix_bets WHERE challenger_id = $1 AND status IN ('pending', 'accepted')`, [user.id]);
        if (open.rows[0].n >= BET_MAX_OPEN) throw new ApiError(429, `Ya tenés ${BET_MAX_OPEN} apuestas abiertas. Esperá a que terminen.`);
        const dup = await pool.query(`SELECT 1 FROM hatitix_bets WHERE challenger_id = $1 AND rival_id = $2 AND status = 'pending'`, [user.id, rival.id]);
        if (dup.rowCount) throw new ApiError(409, 'Ya le enviaste un desafío a ese jugador. Esperá su respuesta.');
        const id = crypto.randomUUID();
        await pool.query('INSERT INTO hatitix_bets(id, room_id, challenger_id, rival_id, amount, challenger_team) VALUES($1, $2, $3, $4, $5, $6)', [id, roomId, user.id, rival.id, amount, team]);
        const bet = await loadBet(pool, id, user.id);
        return ok({ bet, message: `Desafío enviado a ${rival.display_name}: ${amount} puntos.` }, 201);
    }
    const action = path.match(/^\/api\/bet\/([0-9a-f-]{36})\/(accept|reject|cancel)$/i);
    if (method === 'POST' && action && UUID_RE.test(action[1])) {
        const betId = action[1].toLowerCase(), verb = action[2].toLowerCase();
        await expireBets(pool);
        await withTx(pool, async (client) => {
            const found = await client.query('SELECT * FROM hatitix_bets WHERE id = $1 FOR UPDATE', [betId]);
            const bet = found.rows[0];
            if (!bet || (verb === 'cancel' ? bet.challenger_id !== user.id : bet.rival_id !== user.id)) throw new ApiError(404, 'Apuesta no encontrada.');
            if (bet.status !== 'pending') throw new ApiError(409, 'Esta apuesta ya no está disponible (venció o ya se respondió).');
            if (verb === 'accept') await client.query(`UPDATE hatitix_bets SET status = 'accepted', accepted_at = NOW() WHERE id = $1`, [betId]);
            else await client.query(`UPDATE hatitix_bets SET status = $2, resolution = $3, settled_at = NOW() WHERE id = $1`,
                [betId, verb === 'reject' ? 'rejected' : 'cancelled', verb === 'reject' ? 'rejected' : 'cancelled_by_challenger']);
        });
        return ok({ bet: await loadBet(pool, betId, user.id) });
    }
    if (method === 'POST' && path === '/api/bet/settle') {
        const body = await readJson(request);
        const betId = String(body.betId || '').toLowerCase();
        const winnerTeam = String(body.winnerTeam || '').toLowerCase();
        if (!UUID_RE.test(betId) || !['red', 'blue'].includes(winnerTeam)) throw new ApiError(400, 'Apuesta o equipo ganador inválido.');
        await expireBets(pool);
        await withTx(pool, async (client) => {
            const found = await client.query('SELECT * FROM hatitix_bets WHERE id = $1 FOR UPDATE', [betId]);
            const bet = found.rows[0];
            if (!bet || (bet.challenger_id !== user.id && bet.rival_id !== user.id)) throw new ApiError(404, 'Apuesta no encontrada.');
            if (bet.status !== 'accepted') return; // ya resuelta (idempotente) o todavía sin aceptar
            const column = bet.challenger_id === user.id ? 'challenger_report' : 'rival_report';
            await client.query(`UPDATE hatitix_bets SET ${column} = $2 WHERE id = $1`, [betId, winnerTeam]);
            const reports = { challenger: bet.challenger_id === user.id ? winnerTeam : bet.challenger_report, rival: bet.rival_id === user.id ? winnerTeam : bet.rival_report };
            if (!reports.challenger || !reports.rival) return; // falta el reporte del otro jugador
            if (reports.challenger === reports.rival) {
                await client.query(`UPDATE hatitix_bets SET status = 'settled', winner_team = $2, resolution = $3, settled_at = NOW() WHERE id = $1`,
                    [betId, winnerTeam, bet.challenger_team === winnerTeam ? 'won_challenger' : 'won_rival']);
            } else {
                await client.query(`UPDATE hatitix_bets SET status = 'cancelled', resolution = 'disputed', settled_at = NOW() WHERE id = $1`, [betId]);
            }
        });
        const bet = await loadBet(pool, betId, user.id);
        return ok({ bet, message: bet && bet.status === 'accepted' ? 'Resultado enviado. Esperando que tu rival confirme.' : 'Apuesta actualizada.' });
    }
    return false;
}

async function handleSocial(ctx) {
    const path = ctx.url.pathname;
    const reply = (payload, status = 200) => { ctx.json(ctx.response, status, { ok: true, ...payload }); return true; };
    const full = { ...ctx, ok: reply };
    if (path === '/api/groups' || path.startsWith('/api/groups/')) return (await groupsRoutes(full)) === true;
    if (path === '/api/parties' || path.startsWith('/api/parties/')) return (await partiesRoutes(full)) === true;
    if (path.startsWith('/api/bet/')) return (await betsRoutes(full)) === true;
    return false;
}

module.exports = { handleSocial, SOCIAL_SCHEMA_SQL, ApiError };
