'use strict';

const crypto = require('node:crypto');
const MAX_MAP_BYTES = 2 * 1024 * 1024;
const MAP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeJson = (response, status, body, json) => json(response, status, body);

function cleanName(value) {
    return String(value || 'Mapa').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'Mapa';
}
function normalizeMapData(value) {
    let source;
    try {
        source = typeof value === 'string' ? value : JSON.stringify(value);
        if (typeof source !== 'string' || !source.trim()) throw new Error('Faltan los datos del mapa.');
        if (Buffer.byteLength(source, 'utf8') > MAX_MAP_BYTES) throw new Error('El mapa supera el máximo de 2 MB.');
        const map = JSON.parse(source);
        if (!map || typeof map !== 'object' || Array.isArray(map) || !Array.isArray(map.vertexes) || !Array.isArray(map.segments)) {
            throw new Error('El archivo no contiene un estadio Haxball válido.');
        }
        if (map.vertexes.length > 10000 || map.segments.length > 25000) throw new Error('El mapa contiene demasiados elementos.');
        return JSON.stringify(map);
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error('El mapa no contiene JSON válido.');
        throw error;
    }
}
function paginationNumber(value, fallback, maximum) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) return fallback;
    return Math.min(number, maximum);
}

/**
 * Adaptador para el router HTTP existente del relay.
 * Devuelve true si consumió la petición; false si la ruta no era de mapas.
 * Requiere las utilidades `json` y `readJson` ya usadas por el relay.
 */
async function handleCommunityMaps({ request, url, response, pool, user, json, readJson }) {
    const method = String(request.method || '').toUpperCase();
    const pathname = url.pathname;

    if (method === 'POST' && pathname === '/api/maps/upload') {
        if (!user || !user.id || !MAP_UUID_RE.test(String(user.id))) {
            safeJson(response, 401, { ok: false, message: 'Inicia sesión para subir mapas.' }, json);
            return true;
        }
        let body;
        try { body = await readJson(request); }
        catch (error) {
            safeJson(response, 400, { ok: false, message: error?.message || 'No se pudo leer el mapa.' }, json);
            return true;
        }
        let data;
        try { data = normalizeMapData(body?.data); }
        catch (error) {
            safeJson(response, 400, { ok: false, message: error.message || 'Mapa inválido.' }, json);
            return true;
        }
        const name = cleanName(body?.name);
        const authorName = cleanName(user.display_name || user.displayName || user.name || 'Jugador');
        const id = crypto.randomUUID();
        try {
            await pool.query(
                'INSERT INTO hatitix_maps (id, name, author_id, author_name, data) VALUES ($1, $2, $3, $4, $5)',
                [id, name, user.id, authorName, data]
            );
        } catch (error) {
            console.error('[community-maps] No se pudo guardar:', error?.message || error);
            safeJson(response, 500, { ok: false, message: 'No se pudo guardar el mapa en el servidor.' }, json);
            return true;
        }
        safeJson(response, 201, { ok: true, id, name }, json);
        return true;
    }

    if (method === 'GET' && pathname === '/api/maps/list') {
        const requestedLimit = paginationNumber(url.searchParams?.get('limit'), 200, 200);
        const limit = Math.max(1, requestedLimit);
        const offset = paginationNumber(url.searchParams?.get('offset'), 0, 1000000000);
        try {
            const [countResult, mapResult] = await Promise.all([
                pool.query('SELECT COUNT(*) AS total FROM hatitix_maps'),
                pool.query(
                    'SELECT id, name, author_name, created_at FROM hatitix_maps ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
                    [limit, offset]
                )
            ]);
            const total = Number(countResult.rows?.[0]?.total || 0);
            const maps = mapResult.rows || [];
            safeJson(response, 200, { ok: true, maps, total, limit, offset, hasMore: offset + maps.length < total }, json);
        } catch (error) {
            console.error('[community-maps] No se pudo listar:', error?.message || error);
            safeJson(response, 500, { ok: false, message: 'No se pudieron cargar los mapas.' }, json);
        }
        return true;
    }

    if (method === 'GET' && pathname.startsWith('/api/maps/download/')) {
        let id = '';
        try { id = decodeURIComponent(pathname.slice('/api/maps/download/'.length)); } catch (_) { /* ID incorrecto */ }
        if (!MAP_UUID_RE.test(id)) {
            safeJson(response, 400, { ok: false, message: 'ID de mapa inválido.' }, json);
            return true;
        }
        try {
            const result = await pool.query('SELECT data FROM hatitix_maps WHERE id = $1', [id]);
            if (!result.rows?.[0]) {
                safeJson(response, 404, { ok: false, message: 'Mapa no encontrado.' }, json);
                return true;
            }
            safeJson(response, 200, { ok: true, data: result.rows[0].data }, json);
        } catch (error) {
            console.error('[community-maps] No se pudo descargar:', error?.message || error);
            safeJson(response, 500, { ok: false, message: 'No se pudo descargar el mapa.' }, json);
        }
        return true;
    }
    return false;
}

module.exports = { handleCommunityMaps, normalizeMapData, MAX_MAP_BYTES };
