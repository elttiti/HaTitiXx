'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { Pool } = require('pg');
const { createAccountApi } = require('./accounts');

function loadLocalEnvFile() {
    try {
        const contents = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        for (const line of contents.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const separator = trimmed.indexOf('=');
            if (separator < 1) continue;
            const name = trimmed.slice(0, separator).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || process.env[name] !== undefined) continue;
            let value = trimmed.slice(separator + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
            process.env[name] = value;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}
loadLocalEnvFile();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const RELAY_TOKEN = String(process.env.RELAY_TOKEN || '');
const MAX_MESSAGE_BYTES = 24000;
const MAX_SIGNAL_BYTES = 18000;
const MAX_ROOMS = 500;
const MAX_PLAYERS_PER_ROOM = 32;
const MAX_TOTAL_CLIENTS = 1000;
const HOST_MIN_HOLD_MS = 15000;
const HOST_IMPROVEMENT_MS = 8;
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT debe ser un puerto válido.');
if (RELAY_TOKEN.length < 32 || RELAY_TOKEN.startsWith('REEMPLAZAR_')) throw new Error('Configurá un RELAY_TOKEN aleatorio de al menos 32 caracteres.');

const accountPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;
const accountApi = accountPool ? createAccountApi(accountPool) : null;
accountPool?.on('error', (error) => console.error('Conexión inactiva de PostgreSQL falló:', error.message));
if (accountApi) accountApi.initialize().then(() => console.log('API de cuentas conectada a PostgreSQL.')).catch((error) => console.error('No se pudo preparar la base de cuentas:', error.message));
else console.warn('DATABASE_URL no está configurada; la señalización WebRTC seguirá activa y la API de cuentas responderá temporalmente no disponible.');

const rooms = new Map();
const parties = new Map(); // partyId -> { leaderId, members: Set(playerIds) }
const safeEqual = (left, right) => {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function validRoomId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
function validPlayerId(value) {
    return Number.isInteger(value) && value >= 0 && value <= 65535;
}
function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
        if (rooms.size >= MAX_ROOMS) return null;
        room = { peers: new Map(), hostId: null, hostEpoch: 0, hostChangedAt: 0, revision: 0 };
        rooms.set(roomId, room);
    }
    return room;
}
function score(peer) {
    if (!peer.pings.length) return null;
    const sorted = [...peer.pings].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
function sortedPeers(room) {
    return [...room.peers.values()].sort((a, b) => {
        if (a.preferHost !== b.preferHost) return a.preferHost ? -1 : 1;
        const ap = score(a), bp = score(b);
        if (ap !== null && bp !== null && ap !== bp) return ap - bp;
        if (ap !== null && bp === null) return -1;
        if (ap === null && bp !== null) return 1;
        return a.joinedAt - b.joinedAt || a.playerId - b.playerId;
    });
}
function electHost(room, force = false) {
    if (!room.peers.size) { room.hostId = null; return false; }
    const best = sortedPeers(room)[0];
    const current = room.peers.get(room.hostId);
    const hasPreferredHost = [...room.peers.values()].some((peer) => peer.preferHost);
    let next = room.hostId;
    if (!current || force || (hasPreferredHost && !current.preferHost)) next = best.playerId;
    else if (best.playerId !== current.playerId) {
        const bestPing = score(best), currentPing = score(current);
        const holdPassed = Date.now() - room.hostChangedAt >= HOST_MIN_HOLD_MS;
        const currentUnknown = currentPing === null && bestPing !== null;
        const materiallyBetter = bestPing !== null && currentPing !== null && bestPing + HOST_IMPROVEMENT_MS < currentPing;
        if (currentUnknown || (holdPassed && materiallyBetter)) next = best.playerId;
    }
    if (next === room.hostId) return false;
    room.hostId = next;
    room.hostEpoch++;
    room.hostChangedAt = Date.now();
    return true;
}
function topology(room) {
    return {
        type: 'topology',
        hostId: room.hostId,
        hostEpoch: room.hostEpoch,
        revision: room.revision,
        members: sortedPeers(room).map((peer) => ({ playerId: peer.playerId, pingMs: score(peer), preferHost: peer.preferHost }))
    };
}
function broadcastTopology(room) {
    const message = topology(room);
    for (const peer of room.peers.values()) send(peer.socket, message);
}
function partySockets(party) {
    return [...wss.clients].filter((client) => client.authenticated && party.members.has(client.playerId));
}
function broadcastParty(partyId) {
    const party = parties.get(partyId); if (!party) return;
    const payload = { type: 'party-update', partyId, leaderId: party.leaderId, members: [...party.members] };
    for (const client of partySockets(party)) send(client, payload);
}
function removeClient(socket) {
    for (const [partyId, party] of parties) {
        party.members.delete(socket.playerId);
        if (party.leaderId === socket.playerId) {
            const next = party.members.values().next().value;
            if (next === undefined) parties.delete(partyId); else party.leaderId = next;
        }
        if (parties.has(partyId)) broadcastParty(partyId);
    }
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.roomId = null;
    if (!room || room.peers.get(socket.playerId)?.socket !== socket) return;
    room.peers.delete(socket.playerId);
    room.revision++;
    const hostChanged = room.hostId === socket.playerId;
    electHost(room, hostChanged);
    if (!room.peers.size) { rooms.delete(roomId); return; }
    broadcastTopology(room);
}
function validSignal(message) {
    if (!message || typeof message !== 'object' || !['description', 'candidate'].includes(message.kind)) return false;
    if (message.kind === 'description') {
        const d = message.body;
        return !!d && ['offer', 'answer'].includes(d.type) && typeof d.sdp === 'string' && d.sdp.length > 0 && d.sdp.length <= MAX_SIGNAL_BYTES;
    }
    const c = message.body;
    if (c === null) return true;
    return !!c && typeof c === 'object'
        && (c.candidate === '' || (typeof c.candidate === 'string' && c.candidate.length <= 2500))
        && (c.sdpMid === null || typeof c.sdpMid === 'string' && c.sdpMid.length <= 128)
        && (c.sdpMLineIndex === null || Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 255)
        && (c.usernameFragment === undefined || c.usernameFragment === null || typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 128);
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, service: 'hatitix-webrtc-signaling', version: 4, mediaRelay: false, accounts: !!accountApi?.isReady() }));
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        if (accountApi) return void await accountApi.handle(request, response, url);
        response.writeHead(request.method === 'OPTIONS' ? 204 : 503, {
            'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
            'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type'
        });
        response.end(request.method === 'OPTIONS' ? undefined : JSON.stringify({ ok: false, error: 'database_unavailable', message: 'La base de cuentas todavía no está configurada.' }));
        return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});

wss.on('connection', (socket) => {
    if (wss.clients.size > MAX_TOTAL_CLIENTS) { socket.close(1013, 'server busy'); return; }
    socket.authenticated = false;
    socket.lastSignalWindow = Date.now();
    socket.signalCount = 0;
    socket.alive = true;
    const authTimer = setTimeout(() => { if (!socket.authenticated) socket.close(1008, 'authentication required'); }, 5000);
    const joinTimer = setTimeout(() => { if (!socket.roomId) socket.close(1008, 'join required'); }, 12000);
    socket.on('pong', () => { socket.alive = true; });
    socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); }
        catch { socket.close(1007, 'invalid JSON'); return; }

        if (!socket.authenticated) {
            if (message.type !== 'auth' || !safeEqual(message.token || '', RELAY_TOKEN)) {
                send(socket, { type: 'error', code: 'auth_failed' }); socket.close(1008, 'authentication failed'); return;
            }
            clearTimeout(authTimer);
            socket.authenticated = true;
            send(socket, { type: 'authenticated' });
            return;
        }

        if (message.type === 'join') {
            if (socket.roomId || !validRoomId(message.roomId) || !validPlayerId(message.playerId)) {
                send(socket, { type: 'error', code: 'invalid_join' }); socket.close(1008, 'invalid join'); return;
            }
            const room = getRoom(message.roomId);
            if (!room || (room.peers.size >= MAX_PLAYERS_PER_ROOM && !room.peers.has(message.playerId))) {
                send(socket, { type: 'error', code: 'room_full' }); socket.close(1013, 'room full'); return;
            }
            const previous = room.peers.get(message.playerId);
            const peer = { socket, playerId: message.playerId, joinedAt: Date.now(), pings: [], preferHost: message.preferHost === true };
            socket.roomId = message.roomId;
            socket.playerId = message.playerId;
            clearTimeout(joinTimer);
            room.peers.set(peer.playerId, peer);
            if (previous && previous.socket !== socket) {
                room.hostEpoch++;
                room.hostChangedAt = Date.now();
                previous.socket.close(4001, 'replaced by a newer session');
            }
            room.revision++;
            electHost(room);
            broadcastTopology(room);
            return;
        }

        const room = rooms.get(socket.roomId);
        const peer = room?.peers.get(socket.playerId);
        if (!room || !peer || peer.socket !== socket) { send(socket, { type: 'error', code: 'not_joined' }); return; }

        if (message.type === 'party-create') {
            const partyId = crypto.randomBytes(4).toString('hex');
            for (const [id, party] of parties) { party.members.delete(socket.playerId); if (!party.members.size) parties.delete(id); }
            parties.set(partyId, { leaderId: socket.playerId, members: new Set([socket.playerId]) });
            socket.partyId = partyId; socket.partyLeader = true;
            send(socket, { type: 'party-created', partyId }); broadcastParty(partyId); return;
        }
        if (message.type === 'party-join') {
            const partyId = String(message.partyId || ''); const party = parties.get(partyId);
            if (!/^[a-f0-9]{8}$/i.test(partyId) || !party) { send(socket, { type: 'error', code: 'party_not_found' }); return; }
            for (const [id, oldParty] of parties) { oldParty.members.delete(socket.playerId); if (!oldParty.members.size) parties.delete(id); }
            party.members.add(socket.playerId); socket.partyId = partyId; socket.partyLeader = false; broadcastParty(partyId); return;
        }
        if (message.type === 'party-room-change') {
            const party = parties.get(socket.partyId);
            const roomId = String(message.roomId || ''); const link = String(message.link || '').slice(0, 300);
            if (party && party.leaderId === socket.playerId && validRoomId(roomId) && /^https?:\/\//i.test(link)) {
                for (const client of partySockets(party)) if (client !== socket) send(client, { type: 'party-follow', roomId, link });
            }
            return;
        }

        if (message.type === 'host-preference') {
            if (typeof message.preferHost !== 'boolean') { send(socket, { type: 'error', code: 'invalid_host_preference' }); return; }
            if (peer.preferHost === message.preferHost) return;
            peer.preferHost = message.preferHost;
            room.revision++;
            electHost(room, true);
            broadcastTopology(room);
            return;
        }

        if (message.type === 'ping') {
            if (typeof message.nonce !== 'string' || message.nonce.length > 80) { send(socket, { type: 'error', code: 'invalid_ping' }); return; }
            send(socket, { type: 'pong', nonce: message.nonce });
            return;
        }
        if (message.type === 'gameping') {
            if (message.pingMs === null) return;
            if (!Number.isFinite(message.pingMs) || message.pingMs < 0 || message.pingMs > 60000) return;
            peer.pings.push(Math.round(message.pingMs));
            if (peer.pings.length > 5) peer.pings.shift();
            if (electHost(room)) broadcastTopology(room);
            return;
        }
        if (message.type === 'signal') {
            const now = Date.now();
            if (now - socket.lastSignalWindow >= 10000) { socket.lastSignalWindow = now; socket.signalCount = 0; }
            if (++socket.signalCount > 200) { send(socket, { type: 'error', code: 'signal_rate_limited' }); return; }
            const to = message.toPlayerId;
            const target = room.peers.get(to);
            if (!validPlayerId(to) || !target || to === socket.playerId || message.epoch !== room.hostEpoch || !validSignal(message)) {
                send(socket, { type: 'error', code: 'invalid_signal' }); return;
            }
            const fromIsHost = socket.playerId === room.hostId;
            const toIsHost = to === room.hostId;
            if (message.kind === 'description') {
                if (message.body.type === 'offer' && (!fromIsHost || toIsHost)) { send(socket, { type: 'error', code: 'offer_not_allowed' }); return; }
                if (message.body.type === 'answer' && (fromIsHost || !toIsHost)) { send(socket, { type: 'error', code: 'answer_not_allowed' }); return; }
            } else if (!fromIsHost && !toIsHost) {
                send(socket, { type: 'error', code: 'candidate_not_allowed' }); return;
            }
            send(target.socket, { type: 'signal', fromPlayerId: socket.playerId, epoch: room.hostEpoch, kind: message.kind, body: message.body });
            return;
        }
        send(socket, { type: 'error', code: 'unknown_message' });
    });
    socket.on('close', () => { clearTimeout(authTimer); clearTimeout(joinTimer); removeClient(socket); });
    socket.on('error', () => { clearTimeout(authTimer); clearTimeout(joinTimer); removeClient(socket); });
});

const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.alive) { socket.terminate(); continue; }
        socket.alive = false;
        socket.ping();
    }
}, 30000);
server.on('close', () => clearInterval(heartbeat));
server.on('close', () => accountPool?.end().catch(() => {}));
server.listen(PORT, HOST, () => console.log(`HaTitix WebRTC signaling escuchando en ${HOST}:${PORT}`));
