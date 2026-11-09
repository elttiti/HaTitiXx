// Cliente propio de Haxball (node-haxball): lobby, partida, chat y ajustes con la interfaz de haTitix.
(() => {
    const $ = (s) => document.querySelector(s);
    // Ajustes es una ventana global: fuera de #room también funciona desde SALAS/PERFILES.
    const settingsPanel = $('#settings');
    if (settingsPanel) document.body.appendChild(settingsPanel);
    const roomChatPanel = $('#chat');
    if (roomChatPanel && $('#room')) $('#room').appendChild(roomChatPanel);
    const FPS_LIMITS = [0, 30, 60, 75, 90, 120, 144, 240, 360, 500, 1000, 2000];
    const savedFpsLimit = localStorage.getItem('hatitix-fps-limit');
    let fpsLimit = savedFpsLimit === null || Number(savedFpsLimit) === 60 ? 0 : Number(savedFpsLimit);
    if (!FPS_LIMITS.includes(fpsLimit)) fpsLimit = 0;
    let rafSeq = 0;
    const rafPending = new Map();
    let lastFrameAt = 0;
    let nextFrameAt = 0;
    function requestGameFrame(callback) {
        const id = ++rafSeq;
        // requestAnimationFrame queda limitado al refresco del monitor (p. ej. 60 Hz),
        // aunque el usuario elija 120/144 FPS. Usamos el temporizador del navegador
        // y un reloj monotónico para respetar el límite solicitado sin acumular deriva.
        const interval = 1000 / (fpsLimit > 0 ? fpsLimit : 240);
        const now = performance.now();
        if (!nextFrameAt || nextFrameAt < now - interval * 2) nextFrameAt = now;
        const target = Math.max(now, nextFrameAt);
        const timer = window.setTimeout(() => {
            if (!rafPending.has(id)) return;
            const timestamp = performance.now();
            rafPending.delete(id);
            lastFrameAt = timestamp;
            nextFrameAt = target + interval;
            callback(timestamp);
        }, Math.max(0, target - now));
        rafPending.set(id, timer);
        return id;
    }
    function cancelGameFrame(id) {
        const timer = rafPending.get(id);
        if (timer !== undefined) window.clearTimeout(timer);
        rafPending.delete(id);
    }
    // En Electron las funciones del navegador deben ir "atadas" a window; el resto (red, WebRTC) usa Node.
    const API = require('node-haxball')({
        setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window),
        setInterval: setInterval.bind(window), clearInterval: clearInterval.bind(window),
        requestAnimationFrame: requestGameFrame, cancelAnimationFrame: cancelGameFrame,
        console
    });
    const { Room, Utils } = API;
    try { API.Language.current = new (require('node-haxball/examples/languages/spanishLanguage.js'))(API); } catch (_) { /* sin textos de error */ }
    const GameRenderer = require('node-haxball/examples/renderers/defaultRenderer.js');

    const FIELD_STYLES = ['field-grass', 'field-clouds', 'field-stars', 'field-cosmos', 'field-forest', 'field-urban', 'field-geometry'];
    const FIELD_STYLE_IDS = [...FIELD_STYLES, 'field-haxball'];
    const fieldArtMigration = 'hatitix-field-art-migration-v1';
    let activeField = localStorage.getItem('hatitix-active-field') || 'field-grass';
    if (!localStorage.getItem(fieldArtMigration)) {
        if (activeField === 'field-haxball') {
            activeField = 'field-grass';
            localStorage.setItem('hatitix-active-field', activeField);
        }
        localStorage.setItem(fieldArtMigration, '1');
    }
    if (!FIELD_STYLE_IDS.includes(activeField)) activeField = 'field-grass';
    const fieldArtSources = window.HATITIX_COURT_THUMBNAILS || {};
    const fieldArtImages = new Map();
    let fieldArtBounds = { width: 420, height: 200 }, fieldArtTexture = null, fieldArtTextureKey = '', fieldArtRefreshPending = false;
    function makeFieldArtTexture(fieldId = activeField) {
        const image = fieldArtImages.get(fieldId);
        if (!image?.complete || !image.naturalWidth) return null;
        const width = Math.max(120, Math.ceil(Number(fieldArtBounds.width) || 420));
        const height = Math.max(90, Math.ceil(Number(fieldArtBounds.height) || 200));
        const key = `${fieldId}:${width}:${height}`;
        if (fieldArtTextureKey === key && fieldArtTexture) return fieldArtTexture;
        const source = document.createElement('canvas'); source.width = width; source.height = height;
        const sourceCtx = source.getContext('2d', { alpha: false });
        sourceCtx.imageSmoothingEnabled = true; sourceCtx.imageSmoothingQuality = 'high';
        sourceCtx.drawImage(image, 0, 0, source.width, source.height);
        const tile = document.createElement('canvas'); tile.width = source.width; tile.height = source.height;
        const ctx = tile.getContext('2d', { alpha: false }), halfW = width / 2, halfH = height / 2, rightW = width - halfW, bottomH = height - halfH;
        // El patrón del motor se ancla en el centro del mapa: reordenar los cuatro
        // cuadrantes evita que la imagen se corte o se repita en la línea central.
        ctx.drawImage(source, 0, 0, halfW, halfH, halfW, halfH, rightW, bottomH);
        ctx.drawImage(source, halfW, 0, rightW, halfH, 0, halfH, halfW, bottomH);
        ctx.drawImage(source, 0, halfH, halfW, bottomH, halfW, 0, rightW, halfH);
        ctx.drawImage(source, halfW, halfH, rightW, bottomH, 0, 0, halfW, halfH);
        fieldArtTextureKey = key; fieldArtTexture = tile;
        return tile;
    }
    function loadFieldArtImages() {
        for (const id of FIELD_STYLES) {
            const src = fieldArtSources[id];
            if (typeof src !== 'string') continue;
            const image = new Image(); fieldArtImages.set(id, image);
            image.onload = () => {
                if (id !== activeField) return;
                fieldArtTextureKey = ''; fieldArtTexture = makeFieldArtTexture(id);
                if (renderer) applyQuality(pref.quality);
            };
            image.src = src;
        }
    }
    // Texturas propias, deterministas y ligeras: no cargan imágenes externas ni generan ruido cada vez.
    const texture = (kind, quality, classic = false) => {
        const size = quality === 'low' ? 128 : quality === 'high' ? 512 : 256;
        const c = document.createElement('canvas'); c.width = c.height = size;
        const x = c.getContext('2d', { alpha: false });
        const palettes = {
            grass: classic ? ['#73974f', '#7d9f57'] : (quality === 'low' ? ['#6f8f58', '#789862'] : quality === 'high' ? ['#688650', '#789962'] : ['#6d8c56', '#789660']),
            concrete: classic ? ['#85898b', '#898d8f'] : (quality === 'high' ? ['#526671', '#718793'] : quality === 'low' ? ['#596c76', '#627984'] : ['#536873', '#647984']),
            concrete2: classic ? ['#85898b', '#898d8f'] : (quality === 'high' ? ['#627780', '#8499a2'] : quality === 'low' ? ['#71828a', '#7b8e95'] : ['#687b84', '#7e9097']),
            galaxy: ['#10132f', '#1a1d42'], clouds: ['#3693df', '#56b1ed'], stars: ['#142554', '#1e3470'],
            cosmos: ['#090d20', '#281047'], forest: ['#0d281b', '#16472b'], urban: ['#343841', '#595b68'],
            geometry: ['#24204d', '#efbd35']
        };
        const colors = palettes[kind];
        x.fillStyle = colors[0]; x.fillRect(0, 0, size, size);
        const stripe = Math.max(4, size / (classic ? 8 : 4));
        if (kind === 'grass') for (let p = 0; p < size; p += stripe * 2) {
            x.fillStyle = colors[1]; x.fillRect(0, p, size, stripe);
        }
        if (kind === 'clouds') {
            const sky = x.createLinearGradient(0, 0, 0, size);
            sky.addColorStop(0, '#55b6ff'); sky.addColorStop(.62, '#87d0ff'); sky.addColorStop(1, '#e3f5ff');
            x.fillStyle = sky; x.fillRect(0, 0, size, size);
        } else if (kind === 'stars') {
            const night = x.createLinearGradient(0, 0, 0, size);
            night.addColorStop(0, '#263879'); night.addColorStop(.58, '#5365b2'); night.addColorStop(1, '#251b57');
            x.fillStyle = night; x.fillRect(0, 0, size, size);
            for (let i = 0; i < 6; i++) {
                const cx = (i * 91 + 28) % size, cy = size * .76 + (i % 3) * size * .04, r = size * .17;
                x.fillStyle = i % 2 ? 'rgba(195,214,255,.58)' : 'rgba(225,210,255,.6)';
                x.beginPath(); x.ellipse(cx, cy, r * 1.6, r * .55, 0, Math.PI, Math.PI * 2); x.ellipse(cx + r * .5, cy, r * .75, r * .48, 0, Math.PI, Math.PI * 2); x.fill();
            }
        } else if (kind === 'urban') {
            const asphalt = x.createLinearGradient(0, 0, 0, size);
            asphalt.addColorStop(0, '#3a3d45'); asphalt.addColorStop(.5, '#55575e'); asphalt.addColorStop(1, '#3b3e46');
            x.fillStyle = asphalt; x.fillRect(0, 0, size, size);
        }
        if (kind === 'galaxy') {
            const nebula = x.createRadialGradient(size * .32, size * .42, 1, size * .32, size * .42, size * .72);
            nebula.addColorStop(0, quality === 'high' ? 'rgba(105,58,180,.34)' : 'rgba(85,65,160,.22)');
            nebula.addColorStop(1, 'rgba(20,22,50,0)'); x.fillStyle = nebula; x.fillRect(0, 0, size, size);
            x.fillStyle = '#e8edff';
            for (let i = 0; i < (quality === 'low' ? 8 : 18); i++) {
                const px = (i * 37 + 11) % size, py = (i * 53 + 7) % size;
                x.globalAlpha = .3 + (i % 4) * .14; x.fillRect(px, py, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
            }
            x.globalAlpha = 1;
        }
        if (kind === 'clouds' || kind === 'stars' || kind === 'cosmos') {
            if (kind === 'cosmos') {
                const nebula = x.createRadialGradient(size * .62, size * .46, 2, size * .62, size * .46, size * .62);
                nebula.addColorStop(0, 'rgba(224,91,255,.35)'); nebula.addColorStop(.48, 'rgba(48,114,255,.2)'); nebula.addColorStop(1, 'rgba(10,12,32,0)');
                x.fillStyle = nebula; x.fillRect(0, 0, size, size);
            }
            if (kind === 'clouds') {
                for (let i = 0; i < 7; i++) {
                    const cx = (i * 97 + 31) % size, cy = (i * 61 + 18) % size, r = Math.max(15, size / 13);
                    const cloud = x.createRadialGradient(cx, cy, r * .12, cx, cy, r * 2.5);
                    cloud.addColorStop(0, 'rgba(255,255,255,.92)'); cloud.addColorStop(.55, 'rgba(226,246,255,.76)'); cloud.addColorStop(1, 'rgba(213,242,255,0)');
                    x.fillStyle = cloud; x.beginPath(); x.ellipse(cx + r, cy, r * 2.5, r * 1.25, -.08, 0, Math.PI * 2); x.fill();
                    x.fillStyle = 'rgba(255,255,255,.68)';
                    for (let puff = 0; puff < 4; puff++) { x.beginPath(); x.ellipse(cx + puff * r * .65, cy - (puff % 2) * r * .25, r * (.72 - puff * .07), r * (.6 - puff * .04), 0, 0, Math.PI * 2); x.fill(); }
                }
            }
            x.fillStyle = kind === 'clouds' ? 'rgba(255,255,255,.92)' : kind === 'stars' ? 'rgba(197,224,255,.78)' : '#f6f2ff';
            for (let i = 0; i < (quality === 'low' ? 18 : 52); i++) {
                const px = (i * 137 + 29) % size, py = (i * 83 + 17) % size, r = i % 11 === 0 ? 2 : 1;
                if (kind !== 'clouds' || i % 6 === 0) {
                    if (kind === 'stars' && i % 11 === 0) {
                        x.globalAlpha = .75; x.beginPath(); x.moveTo(px, py - r * 2.8); x.lineTo(px + r * .55, py - r * .55); x.lineTo(px + r * 2.8, py); x.lineTo(px + r * .55, py + r * .55); x.lineTo(px, py + r * 2.8); x.lineTo(px - r * .55, py + r * .55); x.lineTo(px - r * 2.8, py); x.lineTo(px - r * .55, py - r * .55); x.closePath(); x.fill(); x.globalAlpha = 1;
                    } else { x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill(); }
                }
            }
        }
        if (['forest', 'urban', 'geometry'].includes(kind)) {
            if (kind === 'forest') {
                const forestGlow = x.createRadialGradient(size * .52, size * .5, 2, size * .52, size * .5, size * .75);
                forestGlow.addColorStop(0, 'rgba(22,94,46,.2)'); forestGlow.addColorStop(1, 'rgba(0,0,0,.18)'); x.fillStyle = forestGlow; x.fillRect(0, 0, size, size);
                for (let i = 0; i < 12; i++) {
                    const px = (i * 79 + 17) % size, py = (i * 53 + 11) % size;
                    x.strokeStyle = i % 2 ? 'rgba(71,255,137,.42)' : 'rgba(8,37,23,.8)'; x.lineWidth = Math.max(2, size / 42);
                    x.beginPath(); x.moveTo(px, py + size * .18); x.quadraticCurveTo(px - size * .08, py, px + size * .02, py - size * .18); x.quadraticCurveTo(px + size * .12, py - size * .08, px + size * .1, py - size * .23); x.stroke();
                    x.fillStyle = 'rgba(71,255,137,.32)'; x.beginPath(); x.ellipse(px, py, size * .035, size * .018, i, 0, Math.PI * 2); x.fill();
                }
            } else if (kind === 'urban') {
                const colors = ['#ff4f7b','#f4dc42','#32d9dc','#b966ff'];
                x.fillStyle = 'rgba(225,231,238,.16)'; for (let i = 0; i < 80; i++) { const px = (i * 67 + 13) % size, py = (i * 43 + 29) % size; x.fillRect(px, py, i % 3 + 1, i % 3 + 1); }
                for (let i = 0; i < 11; i++) { const px = (i * 71 + 19) % size, py = (i * 37 + 12) % size; x.strokeStyle = colors[i % colors.length]; x.lineWidth = Math.max(2, size / 30); x.lineCap = 'round'; x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + size * .08, py - size * .11, px + size * .17, py + size * .02); x.lineTo(px + size * .22, py - size * .1); x.stroke(); x.beginPath(); x.arc(px + size * .2, py, size * .035, 0, Math.PI * 2); x.stroke(); }
            } else {
                const colors = ['#f2c438','#e64d59','#36c3dd','#a36bea'];
                for (let i = 0; i < 15; i++) { const px = (i * 71 + 14) % size, py = (i * 43 + 28) % size, w = size * (.18 + (i % 3) * .05); x.fillStyle = colors[i % colors.length]; x.globalAlpha = .88; x.beginPath(); x.moveTo(px, py); x.lineTo(px + w, py - size * .03); x.lineTo(px + w * .82, py + w * .62); x.lineTo(px + w * .28, py + w * .78); x.closePath(); x.fill(); x.strokeStyle = 'rgba(20,15,38,.42)'; x.lineWidth = 2; x.stroke(); }
                x.globalAlpha = 1;
            }
        }
        return c;
    };
    const makeImages = (quality, classic = false) => {
        if (!classic && activeField === 'field-haxball') return {
            grass: texture('grass', quality, true),
            concrete: texture('concrete', quality, true),
            concrete2: texture('concrete2', quality, true),
            typing: texture('grass', 'low', false)
        };
        const artwork = makeFieldArtTexture();
        if (artwork) return {
            grass: artwork,
            concrete: artwork,
            concrete2: texture('concrete2', quality, false),
            typing: texture('grass', 'low', false)
        };
        const base = {
            grass: texture('grass', quality, classic),
            concrete: texture('concrete', quality, classic),
            concrete2: texture('concrete2', quality, classic),
            typing: texture('grass', 'low', classic)
        };
        if (classic) return base;
        if (activeField === 'field-grass') return base;
        const textureKind = ({ 'field-clouds': 'clouds', 'field-stars': 'stars', 'field-cosmos': 'cosmos', 'field-forest': 'forest', 'field-urban': 'urban', 'field-geometry': 'geometry' })[activeField] || 'grass';
        const floor = texture(textureKind, quality, false);
        return { ...base, grass: floor, concrete: floor, concrete2: floor };
    };
    function fitFieldArtToStadium(stadium) {
        const width = Number(stadium?.bgWidth), height = Number(stadium?.bgHeight);
        if (!(width > 0 && height > 0) || (Math.abs(width - fieldArtBounds.width) < .5 && Math.abs(height - fieldArtBounds.height) < .5)) return;
        fieldArtBounds = { width, height }; fieldArtTextureKey = '';
        fieldArtTexture = makeFieldArtTexture();
        if (!room || !renderer || fieldArtRefreshPending) return;
        fieldArtRefreshPending = true;
        setTimeout(() => {
            fieldArtRefreshPending = false;
            if (room && renderer) applyQuality(pref.quality);
        }, 0);
    }
    loadFieldArtImages();
    let classicMode = localStorage.getItem('hatitix-classic') === '1';
    let images = makeImages(localStorage.getItem('hatitix-quality') || 'medium', classicMode);

    let room = null, renderer = null, poll = null, sig = '', link = '', lastKey = -1, pending = null;
    let playerMenuId = null;
    let overlay = false, joining = false, recording = false, joinTimer = null, stadiums = [];
    let wasPlaying = false, matchFullscreenRequestPending = false, restoreFullscreenAfterMatch = false, matchFullscreenDismissed = false;
    const keys = new Set();
    const DEFAULT_BINDINGS = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', kick: 'Space' };
    const savedBindings = (() => { try { return JSON.parse(localStorage.getItem('hatitix-key-bindings')) || {}; } catch { return {}; } })();
    const keyBindings = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([action, code]) => {
        const saved = savedBindings[action];
        const codes = Array.isArray(saved) ? saved : typeof saved === 'string' ? [saved] : [code];
        const valid = [...new Set(codes.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 32))].slice(0, 5);
        return [action, valid.length ? valid : [code]];
    }));
    let captureAction = null, captureIndex = 0;
    const readJSON = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } };
    const savedPromoCodes = readJSON('hatitix-promo-redeemed', []);
    const redeemedPromoCodes = new Set(Array.isArray(savedPromoCodes) ? savedPromoCodes.filter((code) => typeof code === 'string') : []);
    let hasTitipoints = redeemedPromoCodes.has('polo-dame-leche') || redeemedPromoCodes.has('gracias-por-usar-haxtitix');
    let pasitosUnlocked = redeemedPromoCodes.has('pasitos');
    let pasitosMode = pasitosUnlocked && localStorage.getItem('hatitix-pasitos-mode') === '1';
    const savedProgress = readJSON('hatitix-player-stats', {});
    const progress = {
        goals: Math.max(0, Math.floor(Number(savedProgress.goals) || 0)),
        playSeconds: Math.max(0, Math.floor(Number(savedProgress.playSeconds) || 0)),
        points: Math.max(0, Math.floor(Number(savedProgress.points ?? (Math.floor((Number(savedProgress.playSeconds) || 0) / 3600) * 10)) || 0))
    };
    const MISSIONS = [
        { id: 'goals-10', label: 'Primeros pasos', detail: 'Marcar 10 goles', target: 10, field: 'goals', reward: 5 },
        { id: 'goals-100', label: 'Delantero', detail: 'Marcar 100 goles', target: 100, field: 'goals', reward: 20 },
        { id: 'goals-1000', label: 'Leyenda goleadora', detail: 'Marcar 1.000 goles', target: 1000, field: 'goals', reward: 100 },
        { id: 'hours-1', label: 'Calentamiento', detail: 'Jugar 1 hora', target: 3600, field: 'playSeconds', reward: 10 },
        { id: 'hours-5', label: 'Constancia', detail: 'Jugar 5 horas', target: 18000, field: 'playSeconds', reward: 30 },
        { id: 'hours-25', label: 'Figura del estadio', detail: 'Jugar 25 horas', target: 90000, field: 'playSeconds', reward: 100 },
        { id: 'goals-2500', label: 'Depredador del área', detail: 'Marcar 2.500 goles', target: 2500, field: 'goals', reward: 150 },
        { id: 'goals-5000', label: 'Máquina goleadora', detail: 'Marcar 5.000 goles', target: 5000, field: 'goals', reward: 250 },
        { id: 'goals-10000', label: 'Diez mil veces leyenda', detail: 'Marcar 10.000 goles', target: 10000, field: 'goals', reward: 500 },
        { id: 'goals-25000', label: 'Dueño del marcador', detail: 'Marcar 25.000 goles', target: 25000, field: 'goals', reward: 1000 },
        { id: 'goals-50000', label: 'Inmortal del Haxball', detail: 'Marcar 50.000 goles', target: 50000, field: 'goals', reward: 2000 },
        { id: 'hours-100', label: 'Cien horas de cancha', detail: 'Jugar 100 horas', target: 360000, field: 'playSeconds', reward: 150 },
        { id: 'hours-250', label: 'Residente del estadio', detail: 'Jugar 250 horas', target: 900000, field: 'playSeconds', reward: 300 },
        { id: 'hours-500', label: 'Leyenda de la sala', detail: 'Jugar 500 horas', target: 1800000, field: 'playSeconds', reward: 600 },
        { id: 'hours-750', label: 'Eterno en la cancha', detail: 'Jugar 750 horas', target: 2700000, field: 'playSeconds', reward: 900 },
        { id: 'hours-1000', label: 'Mil horas de Haxball', detail: 'Jugar 1.000 horas', target: 3600000, field: 'playSeconds', reward: 1500 }
    ];
    const claimedMissions = new Set(readJSON('hatitix-missions-claimed', []));
    const SHOP_ITEMS = [
        { id: 'green', kind: 'theme', name: 'Neón HaTitix', price: 0, color: '#2ecc71', description: 'El estilo verde original de HaTitix.' },
        { id: 'blue', kind: 'theme', name: 'Cian galáctico', price: 12, color: '#42d9df', description: 'Un brillo frío inspirado en el espacio.' },
        { id: 'violet', kind: 'theme', name: 'Violeta cósmico', price: 24, color: '#c46cff', description: 'Un tema violeta neón para toda la app.' },
        { id: 'gold', kind: 'theme', name: 'Oro estelar', price: 40, color: '#e6bb42', description: 'Un acabado dorado para tu interfaz.' },
        { id: 'classic', kind: 'theme', name: 'Haxball clásico', price: 18, color: '#dce6ec', description: 'Interfaz neutra con detalles plateados.' },
        { id: 'field-haxball', kind: 'field', name: 'Cancha Haxball original', price: 0, color: '#789b56', description: 'Césped clásico sin líneas dibujadas en la imagen; usa las líneas y la geometría oficiales del estadio Haxball.' },
        { id: 'field-grass', kind: 'field', name: 'Heck Green Classic', price: 0, color: '#789b56', description: 'Cancha clásica renovada, con césped verde, líneas blancas y arcos estándar.' },
        { id: 'field-clouds', kind: 'field', name: 'Heavy Nubes', price: 24, color: '#74c7ff', description: 'Cielo azul luminoso con nubes suaves.' },
        { id: 'field-stars', kind: 'field', name: 'Cielos Estrellados', price: 28, color: '#9bbcff', description: 'Cielo azul nocturno con estrellas brillantes.' },
        { id: 'field-cosmos', kind: 'field', name: 'Cosmos Stadium', price: 36, color: '#b66cff', description: 'Nebulosas violetas, azules y estrellas en el espacio.' },
        { id: 'field-forest', kind: 'field', name: 'Bosque Misterio', price: 32, color: '#37e984', description: 'Césped verde profundo con destellos de bosque mágico.' },
        { id: 'field-urban', kind: 'field', name: 'Urbanos Deportes', price: 30, color: '#dd4cff', description: 'Piso urbano oscuro con grafitis de colores.' },
        { id: 'field-geometry', kind: 'field', name: 'Estadio Geométrico', price: 34, color: '#f2c438', description: 'Patrones abstractos coloridos de bloques y formas.' },
        { id: 'fx-neon', kind: 'explosion', name: 'Estallido neón', price: 8, color: '#2eff74', description: 'Una explosión de chispas verdes al marcar.' },
        { id: 'fx-rings', kind: 'explosion', name: 'Anillos de energía', price: 14, color: '#42d9df', description: 'Ondas luminosas salen desde el arco.' },
        { id: 'fx-stars', kind: 'explosion', name: 'Lluvia estelar', price: 22, color: '#ffd56a', description: 'Estrellas doradas celebran cada gol.' },
        { id: 'fx-fire', kind: 'explosion', name: 'Llamarada', price: 18, color: '#ff742e', description: 'Chispas cálidas en rojo, naranja y oro.' },
        { id: 'fx-ice', kind: 'explosion', name: 'Estallido de hielo', price: 20, color: '#86e9ff', description: 'Cristales helados salen disparados del arco.' },
        { id: 'fx-lightning', kind: 'explosion', name: 'Rayo eléctrico', price: 26, color: '#e5f45a', description: 'Una lluvia rápida de destellos eléctricos.' },
        { id: 'fx-milk', kind: 'explosion', name: 'Salpicadura de leche', price: 16, color: '#fffdf3', description: 'Una explosión blanca y divertida de gotas cremosas.' },
        { id: 'fx-lechazo', kind: 'explosion', name: 'Lechazo', price: 0, color: '#fffdf3', description: 'Explosión cremosa especial. Se desbloquea gratis con el código polo dame leche.' },
        { id: 'fx-dragon', kind: 'explosion', name: 'Dragón negro', price: 75, color: '#11151b', description: 'Un dragón oscuro sale del arco y vuela hacia medio campo al marcar.' },
        { id: 'fx-confetti', kind: 'explosion', name: 'Lluvia de confeti', price: 20, color: '#ff64a8', description: 'Decenas de papelitos de colores giran y caen desde el arco.' },
        { id: 'fx-comets', kind: 'explosion', name: 'Cometas de gol', price: 28, color: '#74eaff', description: 'Estelas luminosas cruzan el campo como meteoritos.' },
        { id: 'fx-bubbles', kind: 'explosion', name: 'Burbujas celestes', price: 18, color: '#8cecff', description: 'Burbujas transparentes flotan hacia arriba desde la red.' },
        { id: 'fx-flowers', kind: 'explosion', name: 'Pétalos de fiesta', price: 24, color: '#ff79c6', description: 'Pétalos giratorios se abren en una celebración floral.' }
    ];
    const savedThemes = readJSON('hatitix-shop-unlocked', ['green']);
    const ownedItems = new Set((Array.isArray(savedThemes) ? savedThemes : ['green']).filter((id) => SHOP_ITEMS.some((item) => item.id === id)));
    ownedItems.add('green');
    ownedItems.add('field-grass');
    ownedItems.add('field-haxball');
    if (redeemedPromoCodes.has('polo-dame-leche')) ownedItems.add('fx-lechazo');
    if (!ownedItems.has(activeField)) {
        activeField = 'field-grass';
        images = makeImages(localStorage.getItem('hatitix-quality') || 'medium', classicMode);
    }
    let activeTheme = localStorage.getItem('hatitix-theme') || 'green';
    if (!ownedItems.has(activeTheme) || SHOP_ITEMS.find((item) => item.id === activeTheme)?.kind !== 'theme') activeTheme = 'green';
    document.body.dataset.theme = activeTheme === 'green' ? '' : activeTheme;
    let activeExplosion = localStorage.getItem('hatitix-active-explosion') || '';
    if (!ownedItems.has(activeExplosion) || SHOP_ITEMS.find((item) => item.id === activeExplosion)?.kind !== 'explosion') activeExplosion = '';
    function currencyWords() {
        if (pasitosMode) return { word: 'pasitos', upper: 'PASITOS', short: 'PASITOS' };
        if (hasTitipoints) return { word: 'Titipoints', upper: 'TITIPOINTS', short: 'TITIPOINTS' };
        return { word: 'puntos', upper: 'PUNTOS', short: 'PTS' };
    }
    function updateModeLabels() {
        const currency = currencyWords();
        const labels = pasitosMode ? {
            rooms: 'SALAS DE LOS PASITOS', shop: 'TIENDA DE PASITOS', stats: 'ESTADÍSTICAS DE PASITOS',
            missions: 'RETOS DE PASITOS', replays: 'REPETICIONES DE PASITOS'
        } : { rooms: 'SALAS', shop: 'TIENDA HATITIX', stats: 'ESTADÍSTICAS', missions: 'MISIONES', replays: 'REPETICIONES' };
        $('#page-salas-title').textContent = labels.rooms;
        $('#page-tienda-title').textContent = labels.shop;
        $('#page-estadisticas-title').textContent = labels.stats;
        $('#page-misiones-title').textContent = labels.missions;
        $('#page-repeticiones-title').textContent = labels.replays;
        const navLabels = { salas: pasitosMode ? 'PASITOS' : 'SALAS', tienda: pasitosMode ? 'TIENDA PASITOS' : 'TIENDA', estadisticas: pasitosMode ? 'STATS PASITOS' : 'ESTADÍSTICAS', misiones: pasitosMode ? 'RETOS' : 'MISIONES', repeticiones: pasitosMode ? 'REP. PASITOS' : 'REPETICIONES' };
        const navTitles = { salas: labels.rooms, tienda: labels.shop, estadisticas: labels.stats, misiones: labels.missions, repeticiones: labels.replays };
        for (const [page, text] of Object.entries(navLabels)) {
            const button = document.querySelector(`.navb[data-page="${page}"]`);
            if (button) { button.textContent = text; button.title = navTitles[page]; button.setAttribute('aria-label', navTitles[page]); }
        }
        const roomLabel = document.querySelector('#lobby .rhead small'), stateBadge = $('#r-state');
        if (roomLabel && stateBadge && roomLabel.firstChild) roomLabel.firstChild.textContent = pasitosMode ? 'SALA DE LOS PASITOS ' : 'SALA ';
        const selectedRoomHeading = document.querySelector('#page-salas .side .card h3');
        if (selectedRoomHeading) selectedRoomHeading.textContent = pasitosMode ? 'SALA DE LOS PASITOS SELECCIONADA' : 'SALA SELECCIONADA';
        const replayHeader = $('#embedded-replay strong');
        if (replayHeader) replayHeader.textContent = pasitosMode ? 'PASITOS · REPETICIÓN' : 'HATITIX · REPETICIÓN';
        $('#shop-points-label').textContent = `TUS ${currency.upper}`;
        $('#stat-points-label').textContent = `${currency.upper} DISPONIBLES`;
        $('#stat-next-hour-label').textContent = `PRÓXIMOS 10 ${currency.upper}`;
        $('#shop-intro').textContent = `Desbloqueá estilos para personalizar la app. Los ${currency.word} se guardan en este dispositivo.`;
        $('#stats-intro').textContent = `Tu progreso local en HaTitix. Ganás 10 ${currency.word} por cada hora completa jugando; los goles cuentan para tus misiones.`;
        $('#missions-intro').textContent = `Completá objetivos de goles y tiempo de juego para reclamar ${currency.word}. Cada misión se puede cobrar una sola vez.`;
        $('#pasitos-mode-setting').classList.toggle('hidden', !pasitosUnlocked);
        $('#s-pasitos-mode').checked = pasitosMode;
        window.dispatchEvent(new CustomEvent('hatitix:labels-changed', { detail: { pasitos: pasitosMode } }));
    }
    function redeemPromoCode() {
        const input = $('#s-redeem-code'), status = $('#s-redeem-status');
        const promo = window.HATITIX_PROMO_CODES;
        const code = promo?.normalize(input.value), definition = promo?.codes?.[code];
        if (!definition) { status.textContent = 'Ese código no existe.'; return toast('Código no válido.'); }
        if (redeemedPromoCodes.has(definition.id)) { status.textContent = 'Ese código ya fue canjeado en este dispositivo.'; return toast('Ese código ya fue canjeado.'); }
        if (definition.reward.type === 'shop-item') {
            const item = SHOP_ITEMS.find((entry) => entry.id === definition.reward.itemId);
            if (!item) return toast('No se pudo aplicar esa recompensa.');
            ownedItems.add(item.id);
            localStorage.setItem('hatitix-shop-unlocked', JSON.stringify([...ownedItems]));
            if (definition.id === 'polo-dame-leche') {
                hasTitipoints = true;
                activeExplosion = item.id;
                localStorage.setItem('hatitix-active-explosion', activeExplosion);
            }
        } else if (definition.reward.type === 'unlock-mode' && definition.reward.modeId === 'pasitos') {
            pasitosUnlocked = true;
        } else if (definition.reward.type === 'points' && Number.isInteger(definition.reward.amount) && definition.reward.amount > 0) {
            progress.points += definition.reward.amount;
            hasTitipoints = true;
            saveProgress();
        } else return toast('La recompensa del código no está disponible.');
        redeemedPromoCodes.add(definition.id);
        localStorage.setItem('hatitix-promo-redeemed', JSON.stringify([...redeemedPromoCodes]));
        input.value = ''; status.textContent = definition.message;
        updateModeLabels(); updateProgressUI(); renderShop(); renderMissions();
        toast(definition.message, 6000);
    }
    const teamId = (p) => (p.team && p.team.id !== undefined ? p.team.id : p.team);
    const CAMERA_PRESETS = Object.freeze({
        1: 0.75, 2: 1, 3: 1.25, 4: 1.5, 5: 1.75,
        6: 2, 7: 2.25, 8: 2.5, 9: 2.75, 0: 3
    });
    let cameraPreset = Number(localStorage.getItem('hatitix-camera') || 3);
    if (!Object.prototype.hasOwnProperty.call(CAMERA_PRESETS, cameraPreset)) cameraPreset = 3;
    const pref = {
        quality: localStorage.getItem('hatitix-quality') || 'medium',
        fpsLimit,
        showFps: localStorage.getItem('hatitix-show-fps') !== '0',
        showPing: localStorage.getItem('hatitix-show-ping') !== '0',
        showChat: localStorage.getItem('hatitix-show-chat') !== '0'
    };
    let soundEnabled = localStorage.getItem('hatitix-sound') !== '0', soundContext = null;
    let chatFadeEnabled = localStorage.getItem('hatitix-chat-fade') !== '0';
    const SOUND_OPTIONS = ['off', 'soft', 'arcade', 'bass'];
    const soundPrefs = (() => {
        try {
            const saved = JSON.parse(localStorage.getItem('hatitix-sound-events') || '{}');
            return Object.fromEntries(['goal', 'hit', 'chat', 'victory'].map((event) => [event, SOUND_OPTIONS.includes(saved[event]) ? saved[event] : (event === 'hit' ? 'soft' : 'arcade')]));
        } catch { return { goal: 'arcade', hit: 'soft', chat: 'arcade', victory: 'arcade' }; }
    })();
    const SOUND_EVENTS = ['goal', 'hit', 'chat', 'victory'];
    const customSoundUrls = new Map();
    let soundDbPromise;
    function openSoundDb() {
        if (!window.indexedDB) return Promise.reject(new Error('El almacenamiento de audio no está disponible.'));
        soundDbPromise ||= new Promise((resolve, reject) => {
            const request = indexedDB.open('hatitix-custom-audio', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('sounds');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento de audio.'));
        });
        return soundDbPromise;
    }
    async function saveCustomSound(event, file) {
        const db = await openSoundDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('sounds', 'readwrite');
            tx.objectStore('sounds').put(file, event);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('No se pudo guardar el audio.'));
            tx.onabort = () => reject(tx.error || new Error('No se pudo guardar el audio.'));
        });
        const oldUrl = customSoundUrls.get(event);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        customSoundUrls.delete(event);
        localStorage.setItem(`hatitix-sound-name-${event}`, file.name);
    }
    async function getCustomSoundUrl(event) {
        if (customSoundUrls.has(event)) return customSoundUrls.get(event);
        const db = await openSoundDb();
        const blob = await new Promise((resolve, reject) => {
            const request = db.transaction('sounds', 'readonly').objectStore('sounds').get(event);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('No se pudo cargar el audio.'));
        });
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        customSoundUrls.set(event, url);
        return url;
    }
    async function playCustomSound(event) {
        const url = await getCustomSoundUrl(event);
        if (!url) return false;
        const audio = new Audio(url);
        audio.volume = 0.8;
        await audio.play();
        return true;
    }
    let lastHitSoundAt = 0;
    function playGameSound(event) {
        if (!soundEnabled) return;
        if (event === 'hit' && performance.now() - lastHitSoundAt < 65) return;
        if (event === 'hit') lastHitSoundAt = performance.now();
        if (SOUND_EVENTS.includes(event) && localStorage.getItem(`hatitix-sound-name-${event}`)) {
            playCustomSound(event).catch(() => {});
            return;
        }
        const style = soundPrefs[event];
        if (!style || style === 'off') return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            soundContext ||= new AudioCtx();
            if (soundContext.state === 'suspended') soundContext.resume().catch(() => {});
            const now = soundContext.currentTime;
            const notesByStyle = {
                soft: { goal: [{ f: 520, d: .11 }], hit: [{ f: 190, d: .055 }], chat: [{ f: 720, d: .07 }], victory: [{ f: 600, d: .1 }, { f: 760, d: .14 }] },
                arcade: { goal: [{ f: 520, d: .11 }, { f: 780, d: .16 }], hit: [{ f: 230, d: .045 }, { f: 150, d: .04 }], chat: [{ f: 850, d: .045 }, { f: 1120, d: .055 }], victory: [{ f: 523, d: .11 }, { f: 659, d: .11 }, { f: 784, d: .2 }] },
                bass: { goal: [{ f: 110, d: .22 }, { f: 220, d: .16 }], hit: [{ f: 105, d: .085 }], chat: [{ f: 460, d: .08 }], victory: [{ f: 146, d: .15 }, { f: 220, d: .16 }, { f: 293, d: .25 }] }
            };
            const notes = (notesByStyle[style] || notesByStyle.arcade)[event] || notesByStyle.arcade.goal;
            let offset = 0;
            for (const note of notes) {
                const oscillator = soundContext.createOscillator(), gain = soundContext.createGain();
                oscillator.type = style === 'arcade' ? 'triangle' : style === 'bass' ? 'sine' : 'sine';
                oscillator.frequency.setValueAtTime(note.f, now + offset);
                if (event === 'hit') oscillator.frequency.exponentialRampToValueAtTime(Math.max(45, note.f * .42), now + offset + note.d);
                gain.gain.setValueAtTime(.0001, now + offset);
                gain.gain.exponentialRampToValueAtTime(event === 'hit' ? .025 : .04, now + offset + .008);
                gain.gain.exponentialRampToValueAtTime(.0001, now + offset + note.d);
                oscillator.connect(gain); gain.connect(soundContext.destination);
                oscillator.start(now + offset); oscillator.stop(now + offset + note.d + .01);
                offset += note.d * .72;
            }
        } catch (_) { /* el sonido no debe interferir con la partida */ }
    }
    const custom = {
        ball: localStorage.getItem('hatitix-custom-ball') || '',
        me: localStorage.getItem('hatitix-custom-me') || '',
        other: localStorage.getItem('hatitix-custom-other') || '',
        otherTeam: localStorage.getItem('hatitix-custom-other-team') || 'none',
        vision: localStorage.getItem('hatitix-vision') || 'normal'
    };
    const imageCache = new Map();
    const remotePlayerSkins = new Map();
    const relayImageCache = new Map();
    const MAX_RELAY_IMAGE_CHARS = 2600;
    const getCustomImage = (src) => {
        if (!src) return null;
        if (!imageCache.has(src)) { const image = new Image(); image.src = src; imageCache.set(src, image); }
        const image = imageCache.get(src);
        return image.complete && image.naturalWidth ? image : null;
    };
    const validRelayImage = (value) => typeof value === 'string' && value.length <= MAX_RELAY_IMAGE_CHARS
        && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
    let lastBallScreenPosition = null;
    const chatBubbles = new Map();
    function drawChatBubbles(gameState) {
        if (!renderer || !chatBubbles.size || !gameState?.players?.length) return;
        const now = performance.now(), canvas = $('#cv'), ctx = canvas.getContext('2d');
        for (const [id, bubble] of chatBubbles) if (bubble.until <= now) chatBubbles.delete(id);
        if (!chatBubbles.size) return;
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = 'bold 12px Segoe UI, sans-serif'; ctx.textBaseline = 'middle';
        for (const player of gameState.players) {
            const bubble = chatBubbles.get(player.id);
            if (!bubble || !player.disc) continue;
            const point = renderer.transformMapCoordToPixelCoord(player.disc.pos.x, player.disc.pos.y);
            const radius = renderer.transformMapDistanceToPixelDistance(player.disc.radius);
            const text = bubble.text.length > 46 ? `${bubble.text.slice(0, 45)}…` : bubble.text;
            const lines = text.length > 25 ? [text.slice(0, 25), text.slice(25)] : [text];
            const width = Math.min(220, Math.max(76, ...lines.map((line) => ctx.measureText(line).width + 20)));
            const height = lines.length === 2 ? 38 : 26;
            const x = Math.max(width / 2 + 4, Math.min(canvas.width - width / 2 - 4, point.x));
            const y = Math.max(height / 2 + 4, point.y - radius - height / 2 - 10);
            const left = x - width / 2, top = y - height / 2;
            ctx.beginPath(); ctx.roundRect(left, top, width, height, 7);
            ctx.fillStyle = 'rgba(5,8,10,.92)'; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = '#d7f4dd'; ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x - 5, top + height - 1); ctx.lineTo(x, top + height + 6); ctx.lineTo(x + 5, top + height - 1); ctx.closePath();
            ctx.fillStyle = 'rgba(5,8,10,.92)'; ctx.fill();
            ctx.fillStyle = '#fff';
            lines.forEach((line, index) => ctx.fillText(line, x - ctx.measureText(line).width / 2, top + 13 + index * 13));
        }
        ctx.restore();
    }
    const recentRoomChats = new Map();
    const pendingSelfChatEchoes = [];
    function handleIncomingRoomChat(id, message, sourceRoom = room) {
        const text = String(message ?? '').trim();
        if (!text) return;
        const now = performance.now(), key = `${id}:${text}`, last = recentRoomChats.get(key) || 0;
        for (let index = pendingSelfChatEchoes.length - 1; index >= 0; index--) {
            if (now - pendingSelfChatEchoes[index].at > 10000) pendingSelfChatEchoes.splice(index, 1);
        }
        const selfEcho = Number(id) === Number(sourceRoom?.currentPlayerId)
            ? pendingSelfChatEchoes.findIndex((entry) => entry.text === text) : -1;
        if (selfEcho >= 0) {
            pendingSelfChatEchoes.splice(selfEcho, 1);
            recentRoomChats.set(key, now);
            chatBubbles.set(id, { text, until: now + 5000 });
            return;
        }
        if (now - last < 80) return;
        recentRoomChats.set(key, now);
        if (recentRoomChats.size > 100) {
            for (const [entry, time] of recentRoomChats) if (now - time > 2000) recentRoomChats.delete(entry);
        }
        const player = sourceRoom?.getPlayer(id);
        addChat((player && player.name) || 'Jugador', text);
        playGameSound('chat');
        chatBubbles.set(id, { text, until: now + 5000 });
    }
    function handleChatIndicator(id, isTyping) {
        if (isTyping) {
            const current = chatBubbles.get(id);
            if (!current || current.text === 'Escribiendo…') chatBubbles.set(id, { text: 'Escribiendo…', until: performance.now() + 4000 });
        } else if (chatBubbles.get(id)?.text === 'Escribiendo…') chatBubbles.delete(id);
    }
    function drawCustomization(gameState) {
        fitFieldArtToStadium(gameState?.gameState?.stadium);
        const ballDisc = gameState?.gameState?.physicsState?.discs?.[0];
        if (activeExplosion && renderer && ballDisc?.pos) {
            const pos = renderer.transformMapCoordToPixelCoord(ballDisc.pos.x, ballDisc.pos.y);
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) lastBallScreenPosition = { x: pos.x, y: pos.y, at: performance.now() };
        }
        drawChatBubbles(gameState);
        if (classicMode || !renderer || (!custom.ball && !custom.me && !custom.other && !remotePlayerSkins.size) || !gameState?.gameState) return;
        const ctx = $('#cv').getContext('2d');
        const draw = (image, disc) => {
            if (!image || !disc) return;
            const pos = renderer.transformMapCoordToPixelCoord(disc.pos.x, disc.pos.y);
            const radius = renderer.transformMapDistanceToPixelDistance(disc.radius);
            ctx.save();
            ctx.beginPath(); ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2); ctx.clip();
            ctx.drawImage(image, pos.x - radius, pos.y - radius, radius * 2, radius * 2);
            ctx.restore();
        };
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = pref.quality !== 'low';
        const discs = gameState.gameState.physicsState.discs;
        draw(getCustomImage(custom.ball), discs[0]);
        gameState.players?.forEach((player) => {
            const mine = player.id === room.currentPlayerId;
            const team = teamId(player);
            const teamPhotoApplies = (setting) => setting === 'all'
                || (setting === 'red' && team === API.Impl.Core.Team.red.id)
                || (setting === 'blue' && team === API.Impl.Core.Team.blue.id);
            const localOtherAllowed = teamPhotoApplies(custom.otherTeam);
            let source = '';
            if (mine) {
                source = localOtherAllowed && custom.other ? custom.other : custom.me;
            } else {
                const shared = remotePlayerSkins.get(player.id);
                if (shared) source = teamPhotoApplies(shared.team) && shared.teamPhoto ? shared.teamPhoto : shared.me;
                if (!source && localOtherAllowed) source = custom.other;
            }
            draw(getCustomImage(source), player.disc);
        });
        ctx.restore();
    }

    let skinP2P = null, skinRelayPublishTimer = null, skinProfileRevision = 0;
    function setSkinRelayStatus(text) {
        const status = $('#s-skin-relay-status');
        if (status) status.textContent = text;
    }
    function getSkinRelayRoomId() {
        const candidate = room?.id ?? pending?.id;
        if (candidate !== null && candidate !== undefined && /^[A-Za-z0-9_-]{1,80}$/.test(String(candidate))) return String(candidate);
        const match = String(link || '').match(/[?&]c=([A-Za-z0-9_-]{1,80})/);
        return match ? match[1] : '';
    }
    function setRemotePlayerSkin(id, profile) {
        const playerId = Number(id);
        if (!Number.isInteger(playerId) || playerId < 0 || playerId > 65535 || playerId === Number(room?.currentPlayerId)) return;
        const me = validRelayImage(profile.me) ? profile.me : '';
        const teamPhoto = validRelayImage(profile.teamPhoto) ? profile.teamPhoto : '';
        const team = ['none', 'red', 'blue', 'all'].includes(profile.team) ? profile.team : 'none';
        remotePlayerSkins.set(playerId, { me, teamPhoto, team });
    }
    function disconnectSkinRelay(clearProfiles = true) {
        clearTimeout(skinRelayPublishTimer); skinRelayPublishTimer = null;
        const sync = skinP2P; skinP2P = null;
        if (sync) sync.disconnect();
        if (clearProfiles) remotePlayerSkins.clear();
    }
    function connectSkinRelay() {
        const endpoint = String(localStorage.getItem('hatitix-skin-relay-url') || '').trim();
        const token = String(localStorage.getItem('hatitix-skin-relay-token') || '').trim();
        const roomId = getSkinRelayRoomId();
        if (!room || !endpoint || !token) {
            setSkinRelayStatus(endpoint || token ? 'Falta la URL, la clave o entrar a una sala.' : 'Señalización sin configurar. No se mandan fotos por el chat de Haxball.');
            return;
        }
        if (!roomId || room.currentPlayerId === null || room.currentPlayerId === undefined) {
            setSkinRelayStatus('Esperando el identificador de la sala para conectar…');
            return;
        }
        if (typeof RTCPeerConnection !== 'function' || !window.HatitixSkinWebRTC) {
            setSkinRelayStatus('Este equipo no ofrece WebRTC; actualizá HaTitix o Chromium.');
            return;
        }
        disconnectSkinRelay(true);
        try {
            skinP2P = new window.HatitixSkinWebRTC({
                url: endpoint,
                token,
                roomId,
                playerId: Number(room.currentPlayerId),
                preferHost: localStorage.getItem('hatitix-skin-prefer-host') === '1',
                getGamePing: () => {
                    const me = (room?.players || []).find((player) => player.id === room?.currentPlayerId);
                    if (!me || me.ping === null || me.ping === undefined || me.ping === '') return null;
                    const ping = Number(me.ping);
                    return Number.isFinite(ping) && ping >= 0 ? ping : null;
                },
                onRemoteProfile: (id, profile) => setRemotePlayerSkin(id, profile),
                onRemoteLeave: (id) => remotePlayerSkins.delete(Number(id)),
                onClear: () => remotePlayerSkins.clear(),
                onStatus: (status) => setSkinRelayStatus(status)
            });
            skinP2P.connect();
            scheduleSkinProfilePublish(250);
        } catch (error) {
            skinP2P = null;
            setSkinRelayStatus('No se pudo iniciar WebRTC: ' + errText(error));
        }
    }
    function disconnectSkinRelayAndClear() {
        disconnectSkinRelay(true);
        setSkinRelayStatus('Señalización desconectada.');
    }
    async function compressSkinForRelay(src) {
        if (!src) return '';
        let image = imageCache.get(src);
        if (!image) { getCustomImage(src); image = imageCache.get(src); }
        if (!image) return '';
        if (!image.complete || !image.naturalWidth) {
            await new Promise((resolve) => {
                let done = false;
                const finish = () => { if (done) return; done = true; clearTimeout(timeout); image.removeEventListener('load', finish); image.removeEventListener('error', finish); resolve(); };
                const timeout = setTimeout(finish, 2500);
                image.addEventListener('load', finish, { once: true }); image.addEventListener('error', finish, { once: true });
            });
        }
        if (!image.naturalWidth || !image.naturalHeight) return '';
        for (const maxSide of [64, 48, 32]) {
            const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            for (const quality of [.52, .42, .32]) {
                const result = canvas.toDataURL('image/webp', quality);
                if (result.length <= MAX_RELAY_IMAGE_CHARS) return result;
            }
        }
        return '';
    }
    function relayImageFor(src) {
        if (!src) return Promise.resolve('');
        if (!relayImageCache.has(src)) relayImageCache.set(src, compressSkinForRelay(src));
        return relayImageCache.get(src);
    }
    function scheduleSkinProfilePublish(delay = 0) {
        clearTimeout(skinRelayPublishTimer);
        const revision = ++skinProfileRevision;
        skinRelayPublishTimer = setTimeout(() => publishSkinProfile(revision).catch(() => {}), delay);
    }
    async function publishSkinProfile(revision = skinProfileRevision) {
        const sync = skinP2P;
        if (!sync || !room) return;
        const team = ['none', 'red', 'blue', 'all'].includes(custom.otherTeam) ? custom.otherTeam : 'none';
        const meSource = custom.me, teamSource = team === 'none' ? '' : custom.other;
        const [me, teamPhoto] = await Promise.all([relayImageFor(meSource), relayImageFor(teamSource)]);
        if (revision !== skinProfileRevision || sync !== skinP2P || !room) return;
        sync.publishProfile({ me, teamPhoto, team });
    }
    let goalParticles = [], goalFxAnimating = false, goalFxTimer = null;
    function resizeGoalFx() {
        // El efecto es pequeño y breve: 1x evita limpiar/dibujar millones de
        // píxeles en pantallas HiDPI cuando la app corre sin límite de FPS.
        const canvas = $('#goal-fx'), ratio = 1;
        const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
        }
        const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    function paintGoalFx() {
        goalFxAnimating = false;
        const canvas = $('#goal-fx'), ctx = canvas.getContext('2d'), width = canvas.clientWidth, height = canvas.clientHeight, now = performance.now();
        // El canvas de efectos trabaja a escala 1x y solo se repinta mientras
        // hay partículas; limpiar todo evita restos de estelas al desaparecer.
        ctx.clearRect(0, 0, width, height);
        goalParticles = goalParticles.filter((p) => now - p.started < p.duration);
        for (const p of goalParticles) {
            if (now < p.started) continue;
            const progress = Math.min(1, (now - p.started) / p.duration), fade = 1 - progress;
            ctx.save(); ctx.globalAlpha = fade;
            if (p.kind === 'ring') {
                ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + progress * Math.min(width, height) * .12, 0, Math.PI * 2);
                ctx.strokeStyle = p.color; ctx.lineWidth = 2.5 * fade + .4; ctx.shadowBlur = 0; ctx.stroke();
            } else if (p.kind === 'dragon') {
                const travel = Math.min(width * .43, 420), direction = p.direction;
                const x = p.x + direction * travel * progress, y = p.y + Math.sin(progress * Math.PI * 3) * 10;
                const flap = Math.sin(progress * Math.PI * 10) * 8;
                ctx.translate(x, y); ctx.scale(direction, 1); ctx.fillStyle = '#090b10'; ctx.strokeStyle = '#414956'; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
                // Cola larga y curvada, con punta de flecha.
                ctx.beginPath(); ctx.moveTo(-27, 0); ctx.quadraticCurveTo(-48, -4, -67, -20); ctx.quadraticCurveTo(-57, -2, -70, 6); ctx.quadraticCurveTo(-48, 10, -28, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
                // Alas membranosas; las puntas baten suavemente mientras vuela.
                ctx.beginPath(); ctx.moveTo(-15, -5); ctx.lineTo(-34, -25-flap); ctx.lineTo(-22, -20-flap); ctx.lineTo(-28, -43-flap); ctx.lineTo(-5, -29-flap); ctx.lineTo(2, -11); ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(-12, 5); ctx.lineTo(-31, 24+flap); ctx.lineTo(-21, 19+flap); ctx.lineTo(-26, 40+flap); ctx.lineTo(-3, 27+flap); ctx.lineTo(4, 11); ctx.closePath(); ctx.fill(); ctx.stroke();
                // Cuerpo central con cuello curvo y pecho para evitar aspecto de simple chispa.
                ctx.beginPath(); ctx.ellipse(-2, 1, 31, 13, -.04, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(17, -6); ctx.quadraticCurveTo(24, -18, 32, -19); ctx.lineTo(39, -16); ctx.lineTo(31, -9); ctx.lineTo(23, 1); ctx.closePath(); ctx.fill(); ctx.stroke();
                // Cabeza, hocico, cuernos y ojo brillante.
                ctx.beginPath(); ctx.ellipse(38, -18, 11, 7, -.12, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(44, -18); ctx.lineTo(55, -15); ctx.lineTo(44, -12); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(31, -22); ctx.lineTo(27, -31); ctx.lineTo(37, -24); ctx.moveTo(39, -23); ctx.lineTo(41, -32); ctx.lineTo(45, -22); ctx.stroke();
                // Cuatro patas articuladas visibles bajo el torso.
                ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-18, 8); ctx.lineTo(-22, 19); ctx.lineTo(-29, 22); ctx.moveTo(-5, 10); ctx.lineTo(-3, 21); ctx.lineTo(4, 23); ctx.moveTo(13, 8); ctx.lineTo(13, 18); ctx.lineTo(20, 21); ctx.moveTo(24, 2); ctx.lineTo(24, 12); ctx.lineTo(31, 14); ctx.stroke();
                // Placas dorsales y ojo para definir mejor la silueta.
                ctx.lineWidth = 1.5; ctx.beginPath(); for (let i=0;i<6;i++){const sx=-20+i*8;ctx.moveTo(sx,-10);ctx.lineTo(sx+4,-16-(i%2)*2);} ctx.stroke();
                ctx.fillStyle = '#ff3348'; ctx.beginPath(); ctx.arc(41, -20, 1.8, 0, Math.PI*2); ctx.fill();
            } else if (p.kind === 'milk') {
                const x = p.x + p.vx * progress * 50, y = p.y + p.vy * progress * 50 + progress * progress * 32;
                const size = p.size * (.65 + fade * .6);
                ctx.translate(x, y); ctx.rotate(p.rotation + progress * p.spin); ctx.fillStyle = p.color; ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.ellipse(0, 0, size * 1.4, size * .8, 0, 0, Math.PI * 2);
                ctx.ellipse(-size * 1.1, -size * .1, size * .55, size * .55, 0, 0, Math.PI * 2);
                ctx.ellipse(size * 1.1, size * .15, size * .5, size * .7, 0, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.kind === 'confetti') {
                const size = p.size * (.7 + fade * .45);
                const x = p.x + p.vx * progress * 76 + Math.sin(progress * 9 + p.phase) * 8;
                const y = p.y + p.vy * progress * 76 + progress * progress * 52;
                ctx.translate(x, y); ctx.rotate(p.rotation + progress * p.spin * 3);
                ctx.fillStyle = p.color; ctx.fillRect(-size * .55, -size * .3, size * 1.1, size * .6);
            } else if (p.kind === 'comet') {
                const x = p.x + p.vx * progress * 112, y = p.y + p.vy * progress * 112;
                ctx.strokeStyle = p.color; ctx.lineWidth = 2 + fade * 1.6; ctx.shadowColor = p.color; ctx.shadowBlur = 12;
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - p.vx * 19, y - p.vy * 19); ctx.stroke();
                ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2 + fade * 2, 0, Math.PI * 2); ctx.fill();
            } else if (p.kind === 'bubble') {
                const size = p.size * (.7 + fade * .45);
                const x = p.x + p.vx * progress * 44 + Math.sin(progress * 8 + p.phase) * 9;
                const y = p.y + p.vy * progress * 86, radius = size * (.65 + fade * .5);
                ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.shadowColor = p.color; ctx.shadowBlur = 7;
                ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
                ctx.fillStyle = `rgba(255,255,255,${.1 + fade * .12})`; ctx.beginPath(); ctx.arc(x - radius * .3, y - radius * .3, Math.max(1, radius * .18), 0, Math.PI * 2); ctx.fill();
            } else if (p.kind === 'petal') {
                const size = p.size * (.7 + fade * .45);
                const x = p.x + p.vx * progress * 58 + Math.sin(progress * 9 + p.phase) * 8;
                const y = p.y + p.vy * progress * 58 + progress * progress * 28;
                ctx.translate(x, y); ctx.rotate(p.rotation + progress * p.spin * 2); ctx.fillStyle = p.color;
                for (let petal = 0; petal < 3; petal++) { ctx.rotate(Math.PI * 2 / 3); ctx.beginPath(); ctx.ellipse(0, -size * .62, size * .38, size * .72, 0, 0, Math.PI * 2); ctx.fill(); }
            } else {
                const x = p.x + p.vx * progress * 42, y = p.y + p.vy * progress * 42 + progress * progress * 34;
                const size = p.size * (.7 + fade * .45);
                ctx.translate(x, y); ctx.rotate(p.rotation + progress * p.spin); ctx.fillStyle = p.color; ctx.shadowBlur = 0;
                if (p.kind === 'star') {
                    ctx.beginPath();
                    for (let i = 0; i < 8; i++) { const angle = i * Math.PI / 4 - Math.PI / 2, radius = i % 2 ? size * .38 : size; ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius); }
                    ctx.closePath(); ctx.fill();
                } else { ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); }
            }
            ctx.restore();
        }
        if (goalParticles.length) { goalFxAnimating = true; goalFxTimer = setTimeout(paintGoalFx, 33); }
    }
    function spawnGoalExplosion(team) {
        if (!activeExplosion) return;
        resizeGoalFx();
        const canvas = $('#goal-fx'), width = canvas.clientWidth, height = canvas.clientHeight;
        // Team azul anota a la izquierda y rojo a la derecha. El canvas de FX está
        // por encima del renderer, por eso el estallido no queda detrás de la red.
        const now = performance.now(), blueScored = team === API.Impl.Core.Team.blue.id;
        const ballIsAtScoringGoal = lastBallScreenPosition && now - lastBallScreenPosition.at < 250
            && (blueScored ? lastBallScreenPosition.x < width * .35 : lastBallScreenPosition.x > width * .65);
        // Usar la última posición física pintada (el balón justo cruzando la
        // línea, como en la referencia); el fallback queda apenas dentro del arco.
        const insideNetOffset = Math.min(22, width * .025);
        const projectedX = ballIsAtScoringGoal ? lastBallScreenPosition.x + (blueScored ? -insideNetOffset : insideNetOffset) : (blueScored ? width * .055 : width * .945);
        const x = Math.max(width * .01, Math.min(width * .99, projectedX));
        const y = ballIsAtScoringGoal ? lastBallScreenPosition.y : height * .5;
        const palettes = {
            'fx-rings': ['#42d9df', '#c8fbff'], 'fx-stars': ['#ffd56a', '#fff3c4', '#ffffff'],
            'fx-fire': ['#ff422e', '#ff8b28', '#ffe06a'], 'fx-ice': ['#65c9ff', '#b7f4ff', '#ffffff'],
            'fx-lightning': ['#e5f45a', '#ffffff', '#8bf4ff'], 'fx-milk': ['#fffdf3', '#ffffff', '#e9f4ff'], 'fx-lechazo': ['#fffdf3', '#ffffff', '#e9f4ff'],
            'fx-neon': ['#2eff74', '#a7ffbf', '#ffffff'], 'fx-dragon': ['#11151b'],
            'fx-confetti': ['#ff64a8', '#ffd166', '#5ed8ff', '#77f29a', '#b986ff'],
            'fx-comets': ['#74eaff', '#ffffff', '#ffcf70'],
            'fx-bubbles': ['#8cecff', '#ffffff', '#a6bcff'],
            'fx-flowers': ['#ff79c6', '#ffd6e8', '#ffe27a', '#c49aff']
        };
        const palette = palettes[activeExplosion] || palettes['fx-neon'];
        if (activeExplosion === 'fx-dragon') {
            const direction = blueScored ? 1 : -1;
            const startX = blueScored ? Math.min(width * .1, x) : Math.max(width * .9, x);
            goalParticles.push({ kind: 'dragon', x: startX, y, direction, color: '#11151b', started: now, duration: 1600 });
        } else if (activeExplosion === 'fx-rings') {
            for (let i = 0; i < 2; i++) goalParticles.push({ kind: 'ring', x, y, radius: 7 + i * 11, color: palette[i % palette.length], started: now + i * 65, duration: 620 });
        } else if (activeExplosion === 'fx-confetti') {
            for (let i = 0; i < 44; i++) goalParticles.push({ kind: 'confetti', x, y, vx: (Math.random() - .5) * 2.8, vy: -1.5 - Math.random() * 1.5, size: 5 + Math.random() * 5, phase: Math.random() * 6, rotation: Math.random() * Math.PI, spin: (Math.random() - .5) * 4, color: palette[i % palette.length], started: now, duration: 1050 + Math.random() * 500 });
        } else if (activeExplosion === 'fx-comets') {
            for (let i = 0; i < 12; i++) {
                const angle = Math.PI * 2 * i / 12 + (Math.random() - .5) * .5;
                goalParticles.push({ kind: 'comet', x, y, vx: Math.cos(angle) * (1 + Math.random() * .65), vy: Math.sin(angle) * (1 + Math.random() * .65), color: palette[i % palette.length], started: now + i * 18, duration: 820 + Math.random() * 360 });
            }
        } else if (activeExplosion === 'fx-bubbles') {
            for (let i = 0; i < 26; i++) goalParticles.push({ kind: 'bubble', x: x + (Math.random() - .5) * 20, y, vx: (Math.random() - .5) * .9, vy: -.55 - Math.random() * .8, size: 4 + Math.random() * 8, phase: Math.random() * 6, color: palette[i % palette.length], started: now + i * 22, duration: 1300 + Math.random() * 700 });
        } else if (activeExplosion === 'fx-flowers') {
            for (let i = 0; i < 20; i++) {
                const angle = Math.PI * 2 * i / 20 + (Math.random() - .5) * .2;
                goalParticles.push({ kind: 'petal', x, y, vx: Math.cos(angle) * (.55 + Math.random() * .75), vy: Math.sin(angle) * (.55 + Math.random() * .75), size: 4 + Math.random() * 5, phase: Math.random() * 6, rotation: Math.random() * Math.PI, spin: (Math.random() - .5) * 3, color: palette[i % palette.length], started: now, duration: 1000 + Math.random() * 500 });
            }
        } else {
            const isMilkBurst = activeExplosion === 'fx-milk' || activeExplosion === 'fx-lechazo';
            const count = isMilkBurst ? 18 : activeExplosion === 'fx-stars' || activeExplosion === 'fx-ice' ? 22 : 26;
            for (let i = 0; i < count; i++) {
                const angle = Math.PI * 2 * i / count + (Math.random() - .5) * .3, speed = .45 + Math.random() * 1.05;
                const kind = isMilkBurst ? 'milk' : ['fx-stars', 'fx-ice', 'fx-lightning'].includes(activeExplosion) ? 'star' : 'spark';
                goalParticles.push({ kind, x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: isMilkBurst ? 3 + Math.random() * 4 : 2.5 + Math.random() * 3.5, rotation: Math.random() * Math.PI, spin: (Math.random() - .5) * 3, glow: 0, color: palette[i % palette.length], started: now, duration: 480 + Math.random() * 220 });
            }
        }
        if (!goalFxAnimating) { goalFxAnimating = true; goalFxTimer = setTimeout(paintGoalFx, 0); }
    }
    function showMatchFx(kind, title, subtitle) {
        const fx = $('#match-fx');
        $('#fx-title').innerHTML = `${title}<span class="fx-sub">${subtitle}</span>`;
        fx.className = `show ${kind}`;
        clearTimeout(showMatchFx.timer);
        showMatchFx.timer = setTimeout(() => { fx.className = ''; }, 1100);
    }

    function toast(t, ms) {
        const el = $('#toast'); el.textContent = t; el.classList.remove('hidden');
        clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms || 4000);
    }
    function saveProgress() { localStorage.setItem('hatitix-player-stats', JSON.stringify(progress)); updateProgressUI(); }
    function renderMissions() {
        const grid = $('#missions-grid');
        if (!grid) return;
        grid.replaceChildren(...MISSIONS.map((mission) => {
            const current = Math.max(0, Number(progress[mission.field]) || 0), done = current >= mission.target, claimed = claimedMissions.has(mission.id);
            const card = document.createElement('article'); card.className = 'shop-item mission-card';
            const title = document.createElement('h3'); title.textContent = mission.label;
            const detail = document.createElement('p'); detail.textContent = mission.detail;
            const progressText = document.createElement('div'); progressText.className = 'mission-progress-text';
            progressText.textContent = mission.field === 'playSeconds' ? `${Math.min(current / 3600, mission.target / 3600).toFixed(1)} / ${(mission.target / 3600).toFixed(0)} horas` : `${Math.min(current, mission.target).toLocaleString('es')} / ${mission.target.toLocaleString('es')} goles`;
            const bar = document.createElement('progress'); bar.className = 'mission-bar'; bar.max = mission.target; bar.value = Math.min(current, mission.target);
            const reward = document.createElement('div'); reward.className = 'shop-price'; reward.textContent = `RECOMPENSA · ${mission.reward} ${currencyWords().upper}`;
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.dataset.claimMission = mission.id;
            button.textContent = claimed ? 'RECLAMADA' : done ? 'RECLAMAR' : 'EN PROGRESO'; button.disabled = claimed || !done;
            card.append(title, detail, progressText, bar, reward, button); return card;
        }));
    }
    function claimMission(id) {
        const mission = MISSIONS.find((entry) => entry.id === id);
        if (!mission || claimedMissions.has(id) || Number(progress[mission.field]) < mission.target) return;
        claimedMissions.add(id); localStorage.setItem('hatitix-missions-claimed', JSON.stringify([...claimedMissions]));
        progress.points += mission.reward; saveProgress(); renderShop(); renderMissions(); toast(`Misión completada: +${mission.reward} ${currencyWords().word}.`);
    }
    function updateProgressUI() {
        const hours = progress.playSeconds / 3600;
        const nextSeconds = 3600 - (progress.playSeconds % 3600);
        const nextHours = Math.floor(nextSeconds / 3600), nextMinutes = Math.floor((nextSeconds % 3600) / 60), nextRemainder = nextSeconds % 60;
        $('#stat-points').textContent = String(progress.points);
        $('#stat-goals').textContent = String(progress.goals);
        $('#stat-hours').textContent = hours.toFixed(1);
        $('#stat-next-hour').textContent = `${nextHours ? `${nextHours} h ` : ''}${nextMinutes} min ${nextRemainder} s`;
        $('#shop-points').textContent = String(progress.points);
        const goalsStat = $('#stat-goals'); if (goalsStat) goalsStat.textContent = String(progress.goals);
    }
    function applyTheme(id) {
        activeTheme = ownedItems.has(id) && SHOP_ITEMS.find((item) => item.id === id)?.kind === 'theme' ? id : 'green';
        localStorage.setItem('hatitix-theme', activeTheme);
        document.body.dataset.theme = activeTheme === 'green' ? '' : activeTheme;
    }
    const isEquipped = (item) => item.kind === 'theme' ? activeTheme === item.id
        : item.kind === 'field' ? activeField === item.id : activeExplosion === item.id;
    function applyField(id) {
        const item = SHOP_ITEMS.find((candidate) => candidate.id === id && candidate.kind === 'field');
        if (!item || !ownedItems.has(id)) return;
        activeField = id;
        fieldArtTextureKey = ''; fieldArtTexture = makeFieldArtTexture(id);
        localStorage.setItem('hatitix-active-field', activeField);
        applyQuality(pref.quality);
        toast(`Cancha ${item.name} activada.`);
    }
    const shopPreviewCache = new Map();
    function createShopPreview(item) {
        const fieldThumbnails = window.HATITIX_COURT_THUMBNAILS || {
            'field-grass': 'assets/courts/heck-green-classic.webp',
            'field-clouds': 'assets/courts/heavy-nubes.webp',
            'field-stars': 'assets/courts/cielos-estrellados.webp',
            'field-cosmos': 'assets/courts/cosmos-stadium.webp',
            'field-forest': 'assets/courts/bosque-misterio.webp',
            'field-urban': 'assets/courts/urbanos-deportes.webp',
            'field-geometry': 'assets/courts/estadio-geometrico.webp'
        };
        if (item.id === 'field-haxball') {
            const preview = document.createElement('canvas'); preview.width = 220; preview.height = 156;
            preview.className = 'shop-preview field-preview'; preview.setAttribute('aria-label', 'Vista previa de la cancha Haxball original');
            const ctx = preview.getContext('2d');
            ctx.fillStyle = ctx.createPattern(texture('grass', 'low', true), 'repeat'); ctx.fillRect(0, 0, preview.width, preview.height);
            ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2;
            ctx.strokeRect(7, 7, 206, 142); ctx.beginPath(); ctx.moveTo(110, 7); ctx.lineTo(110, 149); ctx.stroke();
            ctx.beginPath(); ctx.arc(110, 78, 27, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeRect(7, 45, 27, 66); ctx.strokeRect(186, 45, 27, 66);
            return preview;
        }
        if (item.kind === 'field' && fieldThumbnails[item.id]) {
            const image = document.createElement('img');
            image.className = 'shop-preview field-preview';
            const thumbnail = fieldThumbnails[item.id];
            image.src = thumbnail.startsWith('data:') ? thumbnail : new URL(thumbnail, document.baseURI).href;
            image.alt = `Vista previa de la cancha ${item.name}`; image.loading = 'eager'; image.decoding = 'async';
            image.addEventListener('error', () => {
                const fallback = document.createElement('canvas'); fallback.width = 220; fallback.height = 156;
                fallback.className = 'shop-preview field-preview'; fallback.setAttribute('aria-label', `Vista previa generada: ${item.name}`);
                const ctx = fallback.getContext('2d');
                const kind = ({ 'field-clouds': 'clouds', 'field-stars': 'stars', 'field-cosmos': 'cosmos', 'field-forest': 'forest', 'field-urban': 'urban', 'field-geometry': 'geometry' })[item.id] || 'grass';
                ctx.fillStyle = ctx.createPattern(texture(kind, 'low', false), 'repeat'); ctx.fillRect(0, 0, fallback.width, fallback.height);
                ctx.strokeStyle = 'rgba(240,255,235,.78)'; ctx.lineWidth = 1.5;
                ctx.strokeRect(6, 7, 208, 142); ctx.beginPath(); ctx.moveTo(110, 7); ctx.lineTo(110, 149); ctx.stroke();
                ctx.beginPath(); ctx.arc(110, 78, 27, 0, Math.PI * 2); ctx.stroke();
                ctx.strokeRect(6, 45, 27, 66); ctx.strokeRect(187, 45, 27, 66);
                image.replaceWith(fallback);
            }, { once: true });
            return image;
        }
        let source = shopPreviewCache.get(item.id);
        if (!source) {
            source = document.createElement('canvas'); source.width = 220; source.height = 72;
            const ctx = source.getContext('2d');
            if (item.kind === 'field') {
                const previewKind = ({ 'field-clouds': 'clouds', 'field-stars': 'stars', 'field-cosmos': 'cosmos', 'field-forest': 'forest', 'field-urban': 'urban', 'field-geometry': 'geometry' })[item.id] || 'grass';
                const tile = texture(previewKind, 'low', false);
                ctx.fillStyle = ctx.createPattern(tile, 'repeat'); ctx.fillRect(0, 0, source.width, source.height);
                ctx.strokeStyle = 'rgba(240,255,235,.72)'; ctx.lineWidth = 1.5;
                ctx.strokeRect(5, 5, 210, 62); ctx.beginPath(); ctx.moveTo(110, 5); ctx.lineTo(110, 67); ctx.stroke();
                ctx.beginPath(); ctx.arc(110, 36, 15, 0, Math.PI * 2); ctx.stroke();
                ctx.strokeRect(5, 22, 22, 28); ctx.strokeRect(193, 22, 22, 28);
            } else {
                ctx.fillStyle = '#080c12'; ctx.fillRect(0, 0, source.width, source.height);
                ctx.strokeStyle = 'rgba(235,245,235,.7)'; ctx.lineWidth = 2;
                ctx.strokeRect(4, 15, 18, 42); ctx.beginPath(); ctx.moveTo(22, 15); ctx.lineTo(22, 57); ctx.stroke();
                const cx = 34, cy = 36, color = item.color;
                if (item.id === 'fx-dragon') {
                    ctx.fillStyle = '#080b10'; ctx.strokeStyle = '#434b58'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.ellipse(36, 36, 27, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(55, 34); ctx.lineTo(70, 28); ctx.lineTo(65, 36); ctx.lineTo(71, 42); ctx.closePath(); ctx.fill();
                    ctx.beginPath(); ctx.moveTo(30, 34); ctx.lineTo(14, 13); ctx.lineTo(20, 36); ctx.lineTo(9, 26); ctx.lineTo(18, 44); ctx.closePath(); ctx.fill(); ctx.stroke();
                    ctx.fillStyle = '#ff293f'; ctx.beginPath(); ctx.arc(66, 33, 2, 0, Math.PI * 2); ctx.fill();
                } else if (item.id === 'fx-rings') {
                    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(cx, cy, 7 + i * 7, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); }
                } else if (['fx-milk', 'fx-lechazo'].includes(item.id)) {
                    ctx.fillStyle = '#fffdf3';
                    for (let i = 0; i < 11; i++) { const a = i * Math.PI * 2 / 11, r = 7 + (i % 3) * 5; ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2 + i % 3, 2 + i % 2, a, 0, Math.PI * 2); ctx.fill(); }
                    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
                } else if (item.id === 'fx-confetti') {
                    const colors = ['#ff64a8', '#ffd166', '#5ed8ff', '#77f29a', '#b986ff'];
                    for (let i = 0; i < 27; i++) { ctx.save(); ctx.translate(cx + ((i * 29) % 56) - 24, cy + ((i * 17) % 48) - 21); ctx.rotate(i * .73); ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(-2, -4, 4, 8); ctx.restore(); }
                } else if (item.id === 'fx-comets') {
                    for (let i = 0; i < 6; i++) { const x = 16 + i * 8, y = 16 + (i % 3) * 13; ctx.strokeStyle = i % 2 ? '#fff' : color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 12, y - 8); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); }
                } else if (item.id === 'fx-bubbles') {
                    for (let i = 0; i < 9; i++) { const x = 15 + i * 5.4, y = 52 - (i * 13 % 38), r = 3 + i % 4; ctx.strokeStyle = i % 2 ? '#fff' : color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
                } else if (item.id === 'fx-flowers') {
                    ctx.fillStyle = color; for (let flower = 0; flower < 3; flower++) { const x = 19 + flower * 15, y = 27 + (flower % 2) * 15; for (let petal = 0; petal < 5; petal++) { const a = petal * Math.PI * 2 / 5; ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 6, y + Math.sin(a) * 6, 3, 5, a, 0, Math.PI * 2); ctx.fill(); } ctx.fillStyle = '#ffe27a'; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = color; }
                } else {
                    for (let i = 0; i < 14; i++) {
                        const a = Math.PI * 2 * i / 14, r1 = 5 + i % 3, r2 = 13 + i % 5 * 3;
                        ctx.strokeStyle = i % 2 ? color : '#fff'; ctx.lineWidth = item.id === 'fx-stars' || item.id === 'fx-ice' ? 2 : 1.5;
                        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); ctx.stroke();
                    }
                    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
                }
            }
            shopPreviewCache.set(item.id, source);
        }
        const preview = document.createElement('canvas'); preview.width = 220; preview.height = 72; preview.className = 'shop-preview';
        preview.getContext('2d').drawImage(source, 0, 0);
        preview.setAttribute('aria-label', `Vista previa: ${item.name}`);
        return preview;
    }
    function renderShop() {
        const grid = $('#shop-grid');
        if (!grid) return;
        updateProgressUI();
        const visibleItems = SHOP_ITEMS.filter((item) => item.id !== 'fx-lechazo' || ownedItems.has(item.id));
        grid.replaceChildren(...visibleItems.map((item) => {
            const card = document.createElement('article'); card.className = 'shop-item';
            const swatch = document.createElement('div'); swatch.className = 'shop-swatch'; swatch.style.background = `linear-gradient(110deg, ${item.color}, #080c08)`;
            const heading = document.createElement('h3'); heading.textContent = item.name;
            const description = document.createElement('p'); description.textContent = item.description;
            const price = document.createElement('div'); price.className = 'shop-price'; price.textContent = item.price ? `${item.price} ${currencyWords().upper}` : 'GRATIS';
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.dataset.shopItem = item.id;
            const owned = ownedItems.has(item.id);
            const equipped = isEquipped(item);
            button.textContent = owned ? (equipped ? 'ACTIVO' : 'ACTIVAR EN PERSONALIZACIÓN') : `DESBLOQUEAR · ${item.price} ${currencyWords().short}`;
            button.disabled = !owned && progress.points < item.price;
            if (item.kind === 'field') card.append(createShopPreview(item), swatch);
            else { card.append(swatch); if (item.kind === 'explosion') card.append(createShopPreview(item)); }
            card.append(heading, description, price, button);
            return card;
        }));
        renderOwnedItems();
    }
    function renderOwnedItems() {
        const grid = $('#custom-store-items');
        if (!grid) return;
        const items = SHOP_ITEMS.filter((item) => ownedItems.has(item.id));
        if (!items.length) {
            const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Todavía no desbloqueaste artículos de la tienda.';
            grid.replaceChildren(empty); return;
        }
        grid.replaceChildren(...items.map((item) => {
            const card = document.createElement('article'); card.className = 'shop-item owned-item';
            const swatch = document.createElement('div'); swatch.className = 'shop-swatch'; swatch.style.background = `linear-gradient(110deg, ${item.color}, #080c08)`;
            const heading = document.createElement('h3'); heading.textContent = item.name;
            const description = document.createElement('p'); description.textContent = item.id === 'fx-lechazo' ? 'Recompensa gratis del código polo dame leche.' : item.kind === 'explosion' ? `Efecto de gol comprado. Activarlo cuesta 0 ${currencyWords().word}.` : item.kind === 'field' ? `Cancha comprada. Activarla cuesta 0 ${currencyWords().word}.` : `Tema comprado. Activarlo cuesta 0 ${currencyWords().word}.`;
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.dataset.ownedItem = item.id;
            const equipped = isEquipped(item);
            button.textContent = equipped ? (item.kind === 'explosion' ? 'DESACTIVAR' : 'ACTIVO') : 'ACTIVAR';
            button.disabled = equipped && item.kind !== 'explosion';
            if (item.kind === 'field') card.append(createShopPreview(item), swatch);
            else { card.append(swatch); if (item.kind === 'explosion') card.append(createShopPreview(item)); }
            card.append(heading, description, button);
            return card;
        }));
    }
    function refreshPointsFromStorage() {
        const saved = readJSON('hatitix-player-stats', {});
        if (Number.isFinite(Number(saved.points))) progress.points = Math.max(0, Math.floor(Number(saved.points)));
        updateProgressUI(); renderShop();
    }
    function formatBinding(code) {
        return ({ Space: 'ESPACIO', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'ESC' })[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
    }
    function renderBindings() {
        document.querySelectorAll('[data-bind-list]').forEach((container) => {
            const action = container.dataset.bindList;
            const codes = keyBindings[action] || [];
            container.replaceChildren(...codes.map((code, index) => {
                const slot = document.createElement('span'); slot.className = 'binding-slot';
                const assign = document.createElement('button'); assign.type = 'button'; assign.className = 'btn binding-key';
                assign.dataset.bind = action; assign.dataset.bindIndex = String(index);
                assign.textContent = captureAction === action && captureIndex === index ? 'PRESIONÁ…' : formatBinding(code);
                assign.classList.toggle('listening', captureAction === action && captureIndex === index);
                slot.append(assign);
                if (codes.length > 1) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn binding-remove'; remove.dataset.removeBind = action; remove.dataset.bindIndex = String(index); remove.title = 'Quitar tecla'; remove.textContent = '×'; slot.append(remove); }
                return slot;
            }));
            const add = document.createElement('button'); add.type = 'button'; add.className = 'btn binding-add'; add.dataset.addBind = action;
            add.disabled = codes.length >= 5; add.textContent = codes.length >= 5 ? 'MÁX. 5' : '+ Añadir tecla';
            container.append(add);
        });
    }
    function loadOverlayPosition(id) {
        const position = readJSON(`hatitix-position-${id}`, null);
        const element = $('#' + id);
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
            element.style.left = `${Math.max(0, Math.min(1, position.x)) * 100}%`;
            element.style.top = `${Math.max(0, Math.min(1, position.y)) * 100}%`;
            element.style.right = 'auto'; element.style.bottom = 'auto';
        }
    }
    function enableOverlayDrag(id) {
        const element = $('#' + id), game = $('#game');
        element.addEventListener('pointerdown', (event) => {
            if (event.target.closest('input,button,select') || event.button !== 0) return;
            const gameRect = game.getBoundingClientRect(), rect = element.getBoundingClientRect();
            const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
            element.setPointerCapture(event.pointerId);
            const move = (e) => {
                const maxX = Math.max(0, game.clientWidth - element.offsetWidth), maxY = Math.max(0, game.clientHeight - element.offsetHeight);
                const x = Math.max(0, Math.min(maxX, e.clientX - gameRect.left - offsetX));
                const y = Math.max(0, Math.min(maxY, e.clientY - gameRect.top - offsetY));
                element.style.left = `${x}px`; element.style.top = `${y}px`; element.style.right = 'auto'; element.style.bottom = 'auto';
            };
            const finish = () => {
                element.removeEventListener('pointermove', move);
                element.removeEventListener('pointerup', finish);
                element.removeEventListener('pointercancel', finish);
                const bounds = game.getBoundingClientRect(), box = element.getBoundingClientRect();
                localStorage.setItem(`hatitix-position-${id}`, JSON.stringify({ x: bounds.width ? Math.min(1, Math.max(0, (box.left - bounds.left) / Math.max(1, bounds.width - box.width))) : 0, y: bounds.height ? Math.min(1, Math.max(0, (box.top - bounds.top) / Math.max(1, bounds.height - box.height))) : 0 }));
            };
            element.addEventListener('pointermove', move); element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish);
        });
    }
    const errText = (e) => { try { return e && e.toString ? e.toString() : String(e); } catch { return 'error'; } };
    const guard = (fn) => { try { return fn(); } catch (e) { toast('Error: ' + errText(e), 6000); } };
    // Si algo falla por dentro (conexión, renderer, etc.) lo mostramos en vez de quedarse "cargando" en silencio
    window.addEventListener('error', (e) => { if (room || joining) toast('Error: ' + (e.message || 'desconocido'), 7000); });
    window.addEventListener('unhandledrejection', (e) => { if (room || joining) toast('Error: ' + errText(e.reason), 7000); });
    const isPaused = () => { try { return !!(room && room.isGamePaused && room.isGamePaused()); } catch { return false; } };
    const amAdmin = () => { const me = room.players.find((p) => p.id === room.currentPlayerId); return !!(me && me.isAdmin) || !!room.isHost; };
    function moveMe(t) { if (room) guard(() => room.setPlayerTeam(room.currentPlayerId, t)); }
    function setOverlay(v) { overlay = v; sig = ''; update(); }

    async function profile() {
        try { const d = await hatitix.loadProfiles(); return d.profiles.find((p) => p.id === d.activeId) || null; } catch { return null; }
    }
    async function saveProfileExtrapolation(value) {
        try {
            const data = await hatitix.loadProfiles();
            const profiles = data.profiles.map((p) => p.id === data.activeId ? { ...p, extrapolation: value } : p);
            if (profiles.some((p) => p.id === data.activeId)) await hatitix.saveProfiles({ profiles, activeId: data.activeId });
        } catch (_) { /* el valor ya quedó aplicado en esta partida */ }
    }
    async function saveProfileAvatar(value) {
        try {
            const data = await hatitix.loadProfiles();
            const profiles = data.profiles.map((p) => p.id === data.activeId ? { ...p, avatar: value } : p);
            if (profiles.some((p) => p.id === data.activeId)) await hatitix.saveProfiles({ profiles, activeId: data.activeId });
        } catch (_) { /* el avatar ya quedó aplicado en esta partida */ }
    }
    let fullscreenRenderResolution = null;
    let selectedRenderResolution = readJSON('hatitix-selected-resolution', null);
    if (!selectedRenderResolution || !Number.isInteger(selectedRenderResolution.width) || !Number.isInteger(selectedRenderResolution.height)) selectedRenderResolution = null;
    function applyStageResolution() {
        const game = $('#game');
        if (!game) return;
        if (!isFullscreen || !selectedRenderResolution) {
            game.style.removeProperty('width'); game.style.removeProperty('height');
            game.style.removeProperty('left'); game.style.removeProperty('top'); game.style.removeProperty('right'); game.style.removeProperty('bottom'); game.style.removeProperty('transform'); game.style.removeProperty('transform-origin');
            return;
        }
        const parent = game.parentElement, maxWidth = Math.max(1, parent.clientWidth), maxHeight = Math.max(1, parent.clientHeight);
        if (stretchFullscreen) {
            // Renderizar primero en la resolución/proporción elegida y deformar
            // el escenario completo (como el escalado de pantalla de Windows).
            const scaleX = maxWidth / selectedRenderResolution.width;
            const scaleY = maxHeight / selectedRenderResolution.height;
            game.style.width = `${selectedRenderResolution.width}px`;
            game.style.height = `${selectedRenderResolution.height}px`;
            game.style.left = '50%'; game.style.top = '50%'; game.style.right = 'auto'; game.style.bottom = 'auto';
            game.style.transformOrigin = 'center center';
            game.style.transform = `translate(-50%, -50%) scale(${scaleX}, ${scaleY})`;
            return;
        }
        const fit = Math.min(maxWidth / selectedRenderResolution.width, maxHeight / selectedRenderResolution.height);
        game.style.width = `${Math.round(selectedRenderResolution.width * fit)}px`;
        game.style.height = `${Math.round(selectedRenderResolution.height * fit)}px`;
        game.style.left = '50%'; game.style.top = '50%'; game.style.right = 'auto'; game.style.bottom = 'auto'; game.style.transformOrigin = 'center center'; game.style.transform = 'translate(-50%, -50%)';
    }
    function syncRenderResolution() {
        if (!renderer) return;
        if (!fullscreenRenderResolution) {
            renderer.resolutionScale = ({ low: 0.8, medium: 1, high: 1.25 })[pref.quality] || 1;
            applyStageResolution();
            return;
        }
        applyStageResolution();
        const rect = $('#cv').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        if (rect.width <= 0 || rect.height <= 0) return;
        // The upstream renderer resizes its backing store from CSS dimensions
        // every frame, so control its scale rather than assigning canvas.width.
        const scaleX = fullscreenRenderResolution.width / (rect.width * dpr);
        const scaleY = fullscreenRenderResolution.height / (rect.height * dpr);
        renderer.resolutionScale = Math.max(0.1, Math.min(scaleX, scaleY));
    }
    function sizeCanvas() {
        const cv = $('#cv'), r = cv.parentElement.getBoundingClientRect();
        if (renderer) { syncRenderResolution(); return; }
        if (r.width > 0) {
            const width = fullscreenRenderResolution ? fullscreenRenderResolution.width : (r.width | 0);
            const height = fullscreenRenderResolution ? fullscreenRenderResolution.height : (r.height | 0);
            if (cv.width !== width) cv.width = width;
            if (cv.height !== height) cv.height = height;
        }
    }
    function setCameraPreset(number) {
        const zoom = CAMERA_PRESETS[number];
        if (!renderer || zoom === undefined) return;
        cameraPreset = number;
        renderer.zoomCoeff = zoom;
        localStorage.setItem('hatitix-camera', String(number));
        $('#h-cam').textContent = `CAM ${number} · 1–0`;
        $('#s-zoom').value = zoom;
    }
    function setChatVisible(value) {
        pref.showChat = !!value;
        localStorage.setItem('hatitix-show-chat', pref.showChat ? '1' : '0');
        $('#chat').classList.toggle('chat-hidden', !pref.showChat);
        $('#s-chat').checked = pref.showChat;
        $('#g-chat').setAttribute('aria-pressed', String(pref.showChat));
        $('#g-chat').title = pref.showChat ? 'Ocultar chat' : 'Mostrar chat';
    }
    let isFullscreen = false, isMatchFullscreen = false, resolutionResizeInProgress = false;
    let stretchFullscreen = localStorage.getItem('hatitix-fullscreen-stretch') === '1';
    function applyChatSize() {
        const size = Math.max(11, Math.min(22, Number(localStorage.getItem('hatitix-chat-size')) || 13));
        const maxHeight = Math.max(90, Math.min(420, Number(localStorage.getItem('hatitix-chat-height')) || 210));
        document.documentElement.style.setProperty('--chat-font-size', `${size}px`);
        document.documentElement.style.setProperty('--chat-max-height', `${maxHeight}px`);
        const sizeInput = $('#s-chat-size'), heightInput = $('#s-chat-height');
        if (sizeInput) sizeInput.value = String(size);
        if (heightInput) heightInput.value = String(maxHeight);
    }
    function applyChatFade() {
        const messages = [...$('#chat-log').children];
        messages.forEach((message, index) => {
            if (chatFadeEnabled) message.dataset.old = String(Math.min(5, Math.floor((messages.length - 1 - index) / 3)));
            else delete message.dataset.old;
        });
        const checkbox = $('#s-chat-fade');
        if (checkbox) checkbox.checked = chatFadeEnabled;
    }
    function updateFullscreenUI(enabled) {
        if (!enabled && resolutionResizeInProgress) return;
        isFullscreen = !!enabled;
        if (!isFullscreen) { isMatchFullscreen = false; fullscreenRenderResolution = null; }
        else if (!fullscreenRenderResolution && selectedRenderResolution) fullscreenRenderResolution = { ...selectedRenderResolution };
        document.body.classList.toggle('app-fullscreen', isFullscreen);
        document.body.classList.toggle('match-fullscreen', isFullscreen && isMatchFullscreen);
        $('#s-fullscreen').checked = isFullscreen;
        const windowMode = $('#s-window-mode'); if (windowMode) windowMode.value = isFullscreen ? 'borderless' : 'windowed';
        $('#s-stretch').checked = stretchFullscreen;
        $('#g-fullscreen').setAttribute('aria-pressed', String(isFullscreen));
        $('#g-fullscreen').title = isFullscreen ? 'Salir de pantalla completa (mantiene navegación)' : 'Pantalla completa de app (mantiene navegación)';
        $('#g-fullscreen').textContent = isFullscreen ? '⛶' : '⛶';
        $('#g-match-fullscreen').setAttribute('aria-pressed', String(isMatchFullscreen));
        $('#g-match-fullscreen').title = isMatchFullscreen ? 'Salir de pantalla completa de partido' : 'Pantalla completa de partido (oculta navegación)';
        applyStageResolution();
        requestAnimationFrame(() => { sizeCanvas(); resizeGoalFx(); });
    }
    async function setFullscreen(enabled) {
        if (!enabled) restoreFullscreenAfterMatch = false;
        try { updateFullscreenUI(await hatitix.setFullscreen(!!enabled)); }
        catch (error) { toast('No se pudo cambiar pantalla completa: ' + errText(error), 7000); }
    }
    async function setMatchFullscreen(enabled) {
        if (!enabled) {
            const keepFullscreen = restoreFullscreenAfterMatch;
            restoreFullscreenAfterMatch = false;
            isMatchFullscreen = false; updateFullscreenUI(isFullscreen);
            if (!keepFullscreen) await setFullscreen(false);
            return;
        }
        if (!isMatchFullscreen) restoreFullscreenAfterMatch = isFullscreen;
        try {
            const actual = isFullscreen ? true : await hatitix.setFullscreen(true);
            isMatchFullscreen = !!actual;
            updateFullscreenUI(actual);
        } catch (error) { toast('No se pudo abrir la pantalla completa de partido: ' + errText(error), 7000); }
    }
    function applyQuality(value) {
        pref.quality = ['low', 'medium', 'high'].includes(value) ? value : 'medium';
        localStorage.setItem('hatitix-quality', pref.quality);
        images = makeImages(pref.quality, classicMode);
        const initialContext = $('#cv').getContext('2d');
        if (initialContext) initialContext.imageSmoothingQuality = pref.quality === 'high' ? 'high' : 'medium';
        if (!renderer) { $('#s-quality').value = pref.quality; return; }
        const quality = {
            low: { resolutionScale: 0.8, drawBackground: true, showAvatars: false, showChatIndicators: false, lowLatency: true },
            medium: { resolutionScale: 1, drawBackground: true, showAvatars: true, showChatIndicators: true, lowLatency: true },
            high: { resolutionScale: 1.25, drawBackground: true, showAvatars: true, showChatIndicators: true, lowLatency: true }
        }[pref.quality];
        if (!room) { Object.assign(renderer, quality); $('#s-quality').value = pref.quality; return; }
        // setRenderer reinicia solo el renderer, no la conexión ni la partida.
        const nextRenderer = new GameRenderer(API, { canvas: $('#cv'), images, paintGame: true, onRequestAnimationFrame: drawCustomization });
        bindRendererEvents(nextRenderer);
        Object.assign(nextRenderer, quality, { extrapolation: renderer.extrapolation, zoomCoeff: renderer.zoomCoeff });
        try { room ? room.setRenderer(nextRenderer) : null; } catch (_) { /* se aplicará al volver a entrar */ }
        renderer = nextRenderer;
        syncRenderResolution();
        $('#s-quality').value = pref.quality;
    }
    function setFpsLimit(value) {
        const next = Number(value);
        fpsLimit = FPS_LIMITS.includes(next) ? next : 0;
        pref.fpsLimit = fpsLimit;
        lastFrameAt = 0; nextFrameAt = 0;
        localStorage.setItem('hatitix-fps-limit', String(fpsLimit));
        $('#s-fps-limit').value = String(fpsLimit);
    }
    const fpsSamples = [];
    function updateStats() {
        if (!room || !renderer) return;
        const me = room.getPlayer(room.currentPlayerId);
        let fps = 0;
        try { const value = renderer.fps(); fps = Number.isFinite(value) ? value : 0; } catch (_) { /* todavía no hay frame */ }
        const now = performance.now();
        if (fps > 0) fpsSamples.push([now, fps]);
        while (fpsSamples.length && now - fpsSamples[0][0] > 1100) fpsSamples.shift();
        fps = fpsSamples.length ? Math.round(fpsSamples.reduce((sum, sample) => sum + sample[1], 0) / fpsSamples.length) : 0;
        if (fpsLimit > 0) fps = Math.min(fps, fpsLimit);
        const ping = Number.isFinite(me?.ping) ? Math.round(me.ping) : 0;
        $('#h-fps').textContent = fps > 0 ? String(fps) : '—';
        $('#h-ping').textContent = ping > 0 ? `${ping} ms` : '0 ms';
        $('#stat-fps').classList.toggle('hidden', !pref.showFps);
        $('#stat-ping').classList.toggle('hidden', !pref.showPing);
        $('#stats').classList.toggle('hidden', !pref.showFps && !pref.showPing);
    }
    function bindIncomingChatEvents(activeRoom) {
        if (!activeRoom) return;
        activeRoom.onPlayerChat = (id, message) => handleIncomingRoomChat(id, message, activeRoom);
        activeRoom.onAfterPlayerChat = (id, message) => handleIncomingRoomChat(id, message, activeRoom);
        activeRoom.onPlayerChatIndicatorChange = handleChatIndicator;
        activeRoom.onAfterPlayerChatIndicatorChange = handleChatIndicator;
    }
    function common(prof, authKey) {
        sizeCanvas();
        renderer = new GameRenderer(API, { canvas: $('#cv'), images, paintGame: true, onRequestAnimationFrame: drawCustomization });
        bindRendererEvents(renderer);
        renderer.extrapolation = prof && prof.extrapolation !== null ? prof.extrapolation : 0;
        $('#s-ex').value = renderer.extrapolation;
        setCameraPreset(cameraPreset);
        applyQuality(pref.quality);
        syncRenderResolution();
        const storage = { player_name: (prof && prof.name) || 'Jugador', player_auth_key: authKey };
        if (prof && prof.avatar) storage.avatar = prof.avatar;
        if (prof && prof.flag) storage.geo = { lat: 0, lon: 0, flag: prof.flag };
        const displayRoomChat = (id, message) => handleIncomingRoomChat(id, message, room);
        const config = {
            onPlayerChat: displayRoomChat,
            onAfterPlayerChat: displayRoomChat,
            onPlayerChatIndicatorChange: handleChatIndicator,
            onAfterPlayerChatIndicatorChange: handleChatIndicator,
            onAfterPlayerBallKick: () => playGameSound('hit'),
            onAfterTeamGoal: () => playGameSound('goal'),
            onAfterGameEnd: () => playGameSound('victory')
        };
        return {
            storage, config, plugins: [], renderer, preInit: bindIncomingChatEvents,
            onOpen, onClose: (m) => closeRoom(m)
        };
    }
    function bindRendererEvents(target) {
        target.onTeamGoal = (team, ...args) => {
            progress.goals += 1; saveProgress();
            spawnGoalExplosion(team);
            const blue = team === API.Impl.Core.Team.blue.id;
            showMatchFx(blue ? 'goal-blue' : 'goal-red', blue ? 'Gol azul' : 'Gol rojo', 'HA TITI X');
        };
        target.onGameEnd = (winner, ...args) => {
            const blue = winner === API.Impl.Core.Team.blue.id;
            showMatchFx('victory', blue ? 'Ganó azul' : winner === API.Impl.Core.Team.red.id ? 'Ganó rojo' : 'Partida terminada', 'RESULTADO FINAL');
        };
    }

    let lastPlaytimeCheck = Date.now(), lastProgressSave = 0;
    setInterval(() => {
        const now = Date.now(), elapsed = Math.max(0, Math.min(60, Math.floor((now - lastPlaytimeCheck) / 1000)));
        lastPlaytimeCheck = now;
        if (!room || !room.gameState || isPaused() || !elapsed) return;
        const oldHours = Math.floor(progress.playSeconds / 3600);
        progress.playSeconds += elapsed;
        const earnedHours = Math.floor(progress.playSeconds / 3600) - oldHours;
        if (earnedHours > 0) progress.points += earnedHours * 10;
        updateProgressUI();
        if (earnedHours || Math.floor(progress.playSeconds / 60) !== lastProgressSave) {
            lastProgressSave = Math.floor(progress.playSeconds / 60); saveProgress(); renderShop(); renderMissions();
        }
    }, 5000);
    window.addEventListener('beforeunload', saveProgress);

    async function joinRoom(r, password) {
        if (room || joining) return toast('Ya se está conectando a una sala...');
        toast('Entrando a ' + r.name + '...', 30000);
        pending = r; joining = true;
        clearTimeout(joinTimer);
        joinTimer = setTimeout(() => { if (!room && joining) { joining = false; toast('La sala no responde (tiempo agotado). Probá de nuevo.', 8000); } }, 30000);
        try {
            const prof = await profile();
            const [authKey, authObj] = await Utils.generateAuth();
            Room.join({ id: r.id, password, authObj }, common(prof, authKey));
        } catch (e) { joining = false; toast('No se pudo entrar: ' + errText(e), 7000); }
    }

    async function createRoom(o) {
        if (room || joining) return;
        toast('Creando sala...', 30000); joining = true;
        pending = { id: null, name: o.name };
        try {
            const prof = await profile();
            const [authKey] = await Utils.generateAuth();
            Room.create({ name: o.name, password: o.password || undefined, showInRoomList: o.show, maxPlayerCount: o.max, token: o.token, noPlayer: false }, common(prof, authKey));
        } catch (e) { joining = false; toast('No se pudo crear: ' + errText(e), 7000); }
    }

    function onOpen(r) {
        joining = false; clearTimeout(joinTimer); overlay = false; recording = false;
        fpsSamples.length = 0;
        room = r; sig = ''; link = pending && pending.id ? 'https://www.haxball.com/play?c=' + pending.id : '';
        setChatVisible(true);
        $('#chat').classList.remove('hidden');
        applyPreferredSide(r);
        r.onAfterRoomLink = (l) => { link = l; if (!skinP2P) connectSkinRelay(); };
        recentRoomChats.clear(); pendingSelfChatEchoes.length = 0; chatBubbles.clear();
        bindIncomingChatEvents(r);
        connectSkinRelay();
        $('#chat-log').replaceChildren();
        $('#room').classList.remove('hidden');
        $('#toast').classList.add('hidden');
        // El HUD y la lista de jugadores no necesitan 10 refrescos por segundo;
        // 5 Hz mantiene el marcador responsivo y reduce trabajo del hilo de UI.
        poll = setInterval(() => guard(update), 200);
        guard(update);
    }

    function applyPreferredSide(activeRoom = room) {
        if (!activeRoom || activeRoom.currentPlayerId === null || activeRoom.currentPlayerId === undefined) return;
        const preference = localStorage.getItem('hatitix-auto-side') || 'off';
        if (preference === 'off') return;
        const players = activeRoom.players || [];
        let team;
        if (preference === 'red') team = API.Impl.Core.Team.red.id;
        else if (preference === 'blue') team = API.Impl.Core.Team.blue.id;
        else if (preference === 'spec') team = 0;
        else if (preference === 'auto') {
            const red = players.filter((p) => teamId(p) === API.Impl.Core.Team.red.id).length;
            const blue = players.filter((p) => teamId(p) === API.Impl.Core.Team.blue.id).length;
            team = red === blue ? (Math.random() < .5 ? API.Impl.Core.Team.red.id : API.Impl.Core.Team.blue.id)
                : red < blue ? API.Impl.Core.Team.red.id : API.Impl.Core.Team.blue.id;
        } else return;
        const current = activeRoom.getPlayer(activeRoom.currentPlayerId);
        if (current && teamId(current) !== team) {
            try { activeRoom.setPlayerTeam(current.id, team); }
            catch (error) { toast('No se pudo elegir el equipo automáticamente: ' + errText(error), 6000); }
        }
    }

    function closeRoom(msg) {
        joining = false; clearTimeout(joinTimer);
        if (!room && !poll) { toast('No se pudo conectar' + (msg ? ': ' + errText(msg) : ''), 8000); return; }
        wasPlaying = false;
        if (isMatchFullscreen) setMatchFullscreen(false);
        disconnectSkinRelayAndClear();
        clearInterval(poll); poll = null; room = null; keys.clear(); lastKickDown = false; fpsSamples.length = 0; chatBubbles.clear(); recentRoomChats.clear(); pendingSelfChatEchoes.length = 0; lastKey = -1; overlay = false; recording = false; closePlayerMenu();
        $('#room').classList.add('hidden'); $('#room').classList.remove('ov'); $('#chat').classList.add('hidden'); $('#m-stadium').classList.add('hidden'); $('#settings').classList.add('hidden');
        toast(msg ? 'Saliste de la sala: ' + errText(msg) : 'Saliste de la sala');
    }
    function leave() { try { room && room.leave(); } catch (_) { /* ya cerrada */ } closeRoom(''); }

    function addChat(name, msg) {
        const log = $('#chat-log'), d = document.createElement('div');
        d.className = 'chat-message'; d.textContent = `${name}: ${String(msg ?? '')}`;
        log.append(d);
        while (log.children.length > 20) log.firstChild.remove();
        applyChatFade();
        log.scrollTop = log.scrollHeight;
    }
    const CHAT_COMMANDS = [
        '/help', '/chat on', '/chat off', '/fps on', '/fps off', '/ping on', '/ping off',
        '/quality low', '/quality medium', '/quality high', '/extrapolation 100', '/avatar 😀',
        '/start', '/pause', '/resume', '/stop', '/auto', '/rand', '/lock', '/reset', '/store'
    ];
    let visibleCommandSuggestions = [], commandSuggestionIndex = 0;
    $('#chat-in').addEventListener('input', updateCommandSuggestions);
    $('#chat-in').addEventListener('focus', updateCommandSuggestions);
    $('#chat-in').addEventListener('blur', () => setTimeout(() => {
        if (document.activeElement !== $('#chat-in')) { $('#chat-suggestions').replaceChildren(); visibleCommandSuggestions = []; }
    }, 120));
    function updateCommandSuggestions() {
        const input = $('#chat-in'), panel = $('#chat-suggestions'), query = input.value.trimStart().toLowerCase();
        const allowed = room && amAdmin() ? CHAT_COMMANDS : CHAT_COMMANDS.filter((command) => !/^\/(start|pause|resume|stop|auto|rand|lock|reset)(?:\s|$)/.test(command));
        visibleCommandSuggestions = query.startsWith('/') ? allowed.filter((command) => command.startsWith(query)).slice(0, 8) : [];
        commandSuggestionIndex = 0;
        panel.replaceChildren(...visibleCommandSuggestions.map((command, index) => {
            const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', index === 0 ? 'true' : 'false'); option.textContent = command; option.dataset.command = command;
            option.onmousedown = (event) => event.preventDefault();
            option.onclick = () => { input.value = command + ' '; panel.replaceChildren(); visibleCommandSuggestions = []; input.focus(); };
            return option;
        }));
    }
    function selectCommandSuggestion() {
        if (!visibleCommandSuggestions.length) return false;
        const input = $('#chat-in');
        const selected = visibleCommandSuggestions[Math.min(commandSuggestionIndex, visibleCommandSuggestions.length - 1)];
        input.value = selected + ' ';
        $('#chat-suggestions').replaceChildren(); visibleCommandSuggestions = []; commandSuggestionIndex = 0;
        return true;
    }
    function localCommand(raw) {
        const parts = raw.trim().split(/\s+/), command = (parts.shift() || '').toLowerCase();
        if (!command) return true;
        if (command === 'help') {
            addChat('haTitix', '/chat on|off · /fps on|off · /ping on|off · /quality low|medium|high');
            addChat('haTitix', '/extrapolation número · ejemplo: /extrapolation 100');
            addChat('haTitix', '/avatar emoji · cambia tu avatar (ejemplo: /avatar ⚽)');
            addChat('haTitix', '/start · /pause · /stop · /auto · /rand · /lock · /reset (admin)');
            addChat('haTitix', '/store · guardar la cancha actual en Mis estadios');
            return true;
        }
        const on = parts[0] !== 'off' && parts[0] !== '0';
        if (command === 'chat') { setChatVisible(on); return true; }
        if (command === 'fps') { pref.showFps = on; localStorage.setItem('hatitix-show-fps', on ? '1' : '0'); updateStats(); return true; }
        if (command === 'ping') { pref.showPing = on; localStorage.setItem('hatitix-show-ping', on ? '1' : '0'); updateStats(); return true; }
        if (command === 'quality') { applyQuality(parts[0] || 'medium'); return true; }
        if (command === 'extrapolation') {
            const value = Number(parts[0]);
            if (!Number.isFinite(value)) { addChat('haTitix', 'Uso: /extrapolation número (sin límite fijo)'); return true; }
            const next = Math.round(value);
            if (renderer) { renderer.extrapolation = next; $('#s-ex').value = next; }
            saveProfileExtrapolation(next);
            addChat('haTitix', `Extrapolation aplicada y guardada: ${next}`);
            return true;
        }
        if (command === 'avatar') {
            const avatar = parts.join(' ').trim();
            const symbols = [...avatar];
            if (!avatar || symbols.length > 2 || /[\u0000-\u001f<>]/.test(avatar)) {
                addChat('haTitix', 'Uso: /avatar emoji (por ejemplo: /avatar ⚽)'); return true;
            }
            try {
                room.setAvatar(avatar);
                saveProfileAvatar(avatar);
                addChat('haTitix', `Avatar cambiado a ${avatar}.`);
            } catch (error) { addChat('haTitix', 'No se pudo cambiar el avatar: ' + errText(error)); }
            return true;
        }
        if (command === 'store') { saveCurrentStadiumToStore().catch((error) => toast('No se pudo guardar el mapa: ' + errText(error), 7000)); return true; }
        if (!amAdmin()) return false;
        const actions = { start: () => room.startGame(), pause: () => room.pauseGame(), resume: () => room.pauseGame(), stop: () => room.stopGame(), auto: () => room.autoTeams(), rand: () => room.randTeams(), lock: () => room.lockTeams(), reset: () => room.resetTeams() };
        if (actions[command]) { guard(actions[command]); return true; }
        return false;
    }
    function sendChatText(value) {
        const text = value.trim();
        if (!text) return;
        // Los comandos ! del bot/host deben salir sin transformaciones.
        if (text.startsWith('/') && localCommand(text.slice(1))) {
            $('#chat-suggestions').replaceChildren(); visibleCommandSuggestions = []; return;
        }
        if (room && room.currentPlayerId != null) {
            const me = room.players.find((player) => player.id === room.currentPlayerId);
            pendingSelfChatEchoes.push({ text, at: performance.now() });
            if (me) addChat(me.name || 'Tú', text);
        }
        room.sendChat(text, null);
        $('#chat-suggestions').replaceChildren(); visibleCommandSuggestions = [];
    }

    function closePlayerMenu() {
        const menu = $('#player-menu');
        if (!menu) return;
        menu.classList.add('hidden');
        menu.setAttribute('aria-hidden', 'true');
        playerMenuId = null;
    }

    function openPlayerMenu(player, x, y) {
        const menu = $('#player-menu');
        playerMenuId = player.id;
        $('#player-menu-heading').textContent = player.name;
        $('#player-admin-action').textContent = player.isAdmin ? 'Quitar administrador' : 'Dar administrador';
        menu.classList.remove('hidden');
        menu.setAttribute('aria-hidden', 'false');
        menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    }

    function moderatePlayer(action) {
        const id = playerMenuId;
        closePlayerMenu();
        if (id === null || !room || !amAdmin()) return toast('Solo un administrador de la sala puede moderar jugadores.');
        const target = room.getPlayer(id);
        if (!target) return toast('Ese jugador ya no está en la sala.');
        if (target.id === room.currentPlayerId) return toast('No podés aplicar esta acción sobre tu propio jugador.');

        if (action === 'admin') {
            const grant = !target.isAdmin;
            try {
                room.setPlayerAdmin(target.id, grant);
                toast(`${grant ? 'Se otorgó' : 'Se quitó'} el admin a ${target.name}.`);
                sig = ''; update();
            } catch (e) { toast('No se pudo cambiar el admin: ' + errText(e), 7000); }
            return;
        }

        if (action !== 'kick' && action !== 'ban') return;
        const banning = action === 'ban';
        const verb = banning ? 'banear' : 'expulsar';
        if (!window.confirm(`¿Confirmás ${verb} a ${target.name}?`)) return;
        try {
            room.kickPlayer(target.id, banning ? 'Baneado por el administrador' : 'Expulsado por el administrador', banning);
            toast(`${target.name} fue ${banning ? 'baneado' : 'expulsado'}.`);
        } catch (e) { toast(`No se pudo ${verb} a ${target.name}: ` + errText(e), 7000); }
    }

    function openSettings() {
        closePlayerMenu();
        $('#settings').classList.remove('hidden');
    }

    function playerRow(p, admin) {
        const d = document.createElement('div'); d.className = 'pr';
        const canDrag = admin || p.id === room.currentPlayerId;
        d.draggable = canDrag;
        if (canDrag) {
            d.title = admin && p.id !== room.currentPlayerId ? 'Arrastrá para moverlo de equipo · clic derecho para moderar' : 'Arrastrá para cambiarte de equipo';
            d.ondragstart = (e) => { e.dataTransfer.setData('text/plain', String(p.id)); e.dataTransfer.setData('text/player-id', String(p.id)); e.dataTransfer.effectAllowed = 'move'; d.classList.add('dragging'); };
            d.ondragend = () => d.classList.remove('dragging');
        }
        const av = Object.assign(document.createElement('div'), { className: 'av', textContent: p.avatar || '' });
        d.append(av);
        if (p.flag) d.append(Object.assign(document.createElement('img'), { src: `https://flagcdn.com/w40/${p.flag}.png`, alt: p.flag }));
        d.append(Object.assign(document.createElement('span'), { textContent: p.name }));
        const ping = Number(p.ping);
        if (Number.isFinite(ping) && ping >= 0) d.append(Object.assign(document.createElement('small'), { className: 'player-ping', textContent: `${Math.round(ping)} ms`, title: 'Ping del jugador' }));
        if (p.isAdmin) d.append(Object.assign(document.createElement('span'), { textContent: '★', style: 'color:var(--warn)' }));
        if (p.id === room.currentPlayerId) d.append(Object.assign(document.createElement('span'), { className: 'vos', textContent: 'VOS' }));
        if (admin) d.onclick = () => room.setPlayerTeam(p.id, (teamId(p) + 1) % 3);
        d.oncontextmenu = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!amAdmin()) return toast('Solo un administrador de la sala puede moderar jugadores.');
            if (p.id === room.currentPlayerId) return toast('No podés moderarte a vos mismo.');
            openPlayerMenu(p, e.clientX, e.clientY);
        };
        return d;
    }

    function fillSelect(sel, max, fmt) {
        if (sel.options.length) return;
        for (let i = 0; i <= max; i++) sel.add(new Option(i === 0 ? '∞' : fmt(i), i));
    }

    function update() {
        if (!room) return;
        const playing = !!room.gameState, players = room.players;
        $('#room').classList.toggle('playing', playing);
        if (playing !== wasPlaying) {
            wasPlaying = playing;
            if (playing) {
                matchFullscreenRequestPending = true;
                setMatchFullscreen(true).finally(() => { matchFullscreenRequestPending = false; });
                matchFullscreenDismissed = false;
            } else if (isMatchFullscreen) {
                matchFullscreenDismissed = false;
                matchFullscreenRequestPending = true;
                setMatchFullscreen(false).finally(() => { matchFullscreenRequestPending = false; });
            } else {
                matchFullscreenDismissed = false;
            }
        } else if (playing && !isMatchFullscreen && !matchFullscreenRequestPending && !matchFullscreenDismissed) {
            // Mantenerlo activo en los partidos aunque se cierre accidentalmente.
            matchFullscreenRequestPending = true;
            setMatchFullscreen(true).finally(() => { matchFullscreenRequestPending = false; });
        }
        if (playerMenuId !== null && !players.some((p) => p.id === playerMenuId)) closePlayerMenu();
        if (!playing) overlay = false;
        $('#lobby').classList.toggle('hidden', playing && !overlay);
        $('#room').classList.toggle('ov', playing && overlay);
        $('#game').classList.toggle('hidden', !playing);
        if (playing) {
            const t = Math.floor(room.timeElapsed || 0);
            $('#h-red').textContent = room.redScore ?? 0;
            $('#h-blue').textContent = room.blueScore ?? 0;
            $('#h-time').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
        }
        updateStats();
        const me = players.find((p) => p.id === room.currentPlayerId);
        const admin = !!(me && me.isAdmin) || !!room.isHost;
        const paused = playing && isPaused(), locked = !!room.teamsLocked, myTeam = me ? teamId(me) : 0;
        const s = JSON.stringify([room.name, admin, room.scoreLimit, room.timeLimit, playing, paused, locked, recording, overlay, myTeam,
            playing ? [room.redScore, room.blueScore] : 0,
            players.map((p) => [p.id, p.name, teamId(p), p.avatar, p.flag, p.isAdmin, p.ping])]);
        if (s === sig) return;
        sig = s;
        $('#r-name').textContent = room.name;
        const st = $('#r-state');
        st.textContent = paused ? 'PAUSADO' : playing ? 'EN JUEGO' : 'EN ESPERA';
        st.className = 'chip' + (paused ? ' pause' : playing ? ' live' : '');
        const cols = { 1: [], 0: [], 2: [] };
        players.forEach((p) => (cols[teamId(p)] || cols[0]).push(playerRow(p, admin)));
        $('#l-red').replaceChildren(...cols[1]); $('#l-spec').replaceChildren(...cols[0]); $('#l-blue').replaceChildren(...cols[2]);
        $('#n-red').textContent = playing ? (room.redScore ?? 0) : cols[1].length;
        $('#n-blue').textContent = playing ? (room.blueScore ?? 0) : cols[2].length;
        $('#n-spec').textContent = cols[0].length;
        $('#th-red').classList.toggle('mine', myTeam === 1); $('#th-blue').classList.toggle('mine', myTeam === 2); $('#th-spec').classList.toggle('mine', myTeam === 0);
        const canMove = admin || !locked;
        $('#a-red').disabled = $('#a-blue').disabled = !canMove;
        fillSelect($('#r-score'), 15, (i) => i); fillSelect($('#r-time'), 15, (i) => i + ' min');
        $('#r-score').value = room.scoreLimit; $('#r-time').value = room.timeLimit;
        for (const id of ['#r-score', '#r-time', '#r-auto', '#r-rand', '#r-lock', '#r-reset', '#r-pick', '#r-start', '#r-stop', '#g-stop']) $(id).disabled = !admin;
        $('#r-stop').disabled = !admin || !playing; $('#r-close').style.display = playing ? '' : 'none';
        $('#r-start').textContent = !playing ? 'INICIAR JUEGO' : paused ? 'REANUDAR' : 'PAUSAR';
        $('#r-lock').textContent = locked ? 'Desbloquear' : 'Bloquear';
        $('#r-rec').textContent = recording ? '■ Parar grab.' : '● Grabar'; $('#r-rec').classList.toggle('on', recording);
        $('#r-stadium').textContent = (room.stadium && room.stadium.name) || '';
        $('#r-hint').textContent = !canMove ? 'Los equipos están bloqueados por el admin.'
            : 'Click en ROJO / AZUL / ESPECTADORES para cambiarte de lado' + (admin ? '; clic en un jugador para moverlo (espectador → rojo → azul) o clic derecho para dar/quitar admin, expulsar o banear.' : '.');
    }

    // ----- Controles remapeables y cámara rápida con 1–0 -----
    const LEGACY_BINDING_ALIASES = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], kick: ['KeyX', 'Space'] };
    const actionCodes = (action) => [...keyBindings[action], ...(keyBindings[action].includes(DEFAULT_BINDINGS[action]) ? LEGACY_BINDING_ALIASES[action] : [])];
    const actionPressed = (action) => actionCodes(action).some((code) => keys.has(code));
    let lastKickDown = false;
    function sendKeys() {
        if (!room) return;
        const kickDown = actionPressed('kick');
        lastKickDown = kickDown;
        const x = (actionPressed('right') ? 1 : 0) - (actionPressed('left') ? 1 : 0);
        const y = (actionPressed('down') ? 1 : 0) - (actionPressed('up') ? 1 : 0);
        const k = Utils.keyState(x, y, kickDown);
        if (k !== lastKey) { lastKey = k; try { room.setKeyState(k); } catch (_) { /* ignorar */ } }
    }
    window.addEventListener('keydown', (e) => {
        if (e.code === 'F11' && room) {
            e.preventDefault();
            if (room.gameState) {
                if (isFullscreen) {
                    matchFullscreenDismissed = true;
                    restoreFullscreenAfterMatch = false;
                    isMatchFullscreen = false;
                    setFullscreen(false);
                } else {
                    matchFullscreenDismissed = false;
                    setMatchFullscreen(true);
                }
            } else setFullscreen(!isFullscreen);
            return;
        }
        if (captureAction) {
            e.preventDefault(); e.stopPropagation();
            if (e.code === 'Escape') { if (keyBindings[captureAction]?.[captureIndex] === '') keyBindings[captureAction].splice(captureIndex, 1); captureAction = null; renderBindings(); return; }
            if (['Tab', 'Enter'].includes(e.code)) return;
            if (Object.keys(keyBindings).some((action) => actionCodes(action).includes(e.code) && !(action === captureAction && keyBindings[action][captureIndex] === e.code))) { toast('Esa tecla ya está asignada a otro control.'); return; }
            if (keyBindings[captureAction].includes(e.code) && keyBindings[captureAction][captureIndex] !== e.code) { toast('Esa tecla ya figura en esta acción.'); return; }
            keyBindings[captureAction][captureIndex] = e.code;
            localStorage.setItem('hatitix-key-bindings', JSON.stringify(keyBindings));
            captureAction = null; renderBindings(); keys.clear(); sendKeys();
            return;
        }
        if (!room) return;
        const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
        if (e.code === 'Escape') {
            if (!$('#player-menu').classList.contains('hidden')) { closePlayerMenu(); return; }
            if (!$('#settings').classList.contains('hidden')) $('#settings').classList.add('hidden');
            else if (room.gameState) setOverlay(!overlay);
            else $('#settings').classList.remove('hidden');
            return;
        }
        if (e.code === 'Tab') {
            e.preventDefault();
            if (e.target.id === 'chat-in' && selectCommandSuggestion()) return;
            setChatVisible(true); $('#chat-in').focus(); updateCommandSuggestions(); return;
        }
        if (typing) {
            if (e.code === 'Enter' && e.target.id === 'chat-in') {
                sendChatText(e.target.value);
                e.target.value = ''; e.target.blur();
            }
            return;
        }
        if (e.code === 'Enter') { setChatVisible(true); $('#chat-in').focus(); e.preventDefault(); return; }
        if (e.code === 'KeyP' && room.gameState && amAdmin()) { guard(() => room.pauseGame()); return; }
        const cameraKey = e.code.match(/^(?:Digit|Numpad)([0-9])$/);
        if (Object.keys(keyBindings).some((action) => actionCodes(action).includes(e.code))) { keys.add(e.code); e.preventDefault(); sendKeys(); return; }
        if (room.gameState && cameraKey) { setCameraPreset(Number(cameraKey[1])); e.preventDefault(); return; }
    });
    window.addEventListener('keyup', (e) => { keys.delete(e.code); sendKeys(); });
    window.addEventListener('blur', () => { keys.clear(); sendKeys(); });
    window.addEventListener('resize', () => { if (room) sizeCanvas(); resizeGoalFx(); closePlayerMenu(); });

    // ----- Botones -----
    $('#r-start').onclick = () => guard(() => (room.gameState ? room.pauseGame() : room.startGame()));
    $('#g-stop').onclick = $('#r-stop').onclick = () => { guard(() => room.stopGame()); overlay = false; };
    $('#g-teams').onclick = () => setOverlay(true);
    $('#g-chat').onclick = () => setChatVisible(!pref.showChat);
    $('#r-close').onclick = () => setOverlay(false);
    $('#r-set').onclick = openSettings;
    $('#th-red').onclick = () => moveMe(1); $('#th-blue').onclick = () => moveMe(2); $('#th-spec').onclick = () => moveMe(0);
    $('#a-red').onclick = $('#a-blue').onclick = () => moveMe(0);
    function dropPlayer(team, event) {
        event.preventDefault();
        event.stopPropagation();
        const rawId = event.dataTransfer.getData('text/player-id') || event.dataTransfer.getData('text/plain');
        const id = Number(rawId);
        const player = room?.getPlayer(id);
        const me = room?.getPlayer(room.currentPlayerId);
        if (!player || !me || (id !== me.id && !amAdmin())) return;
        guard(() => room.setPlayerTeam(id, team));
    }
    [['#l-red', 1], ['#l-spec', 0], ['#l-blue', 2], ['.team.red', 1], ['.team:not(.red):not(.blue)', 0], ['.team.blue', 2]].forEach(([selector, team]) => {
        const target = $(selector);
        target.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
        target.ondrop = (e) => dropPlayer(team, e);
    });
    $('#r-auto').onclick = () => guard(() => room.autoTeams());
    $('#r-rand').onclick = () => guard(() => room.randTeams());
    $('#r-lock').onclick = () => guard(() => room.lockTeams());
    $('#r-reset').onclick = () => guard(() => room.resetTeams());
    $('#r-rec').onclick = async () => {
        try {
            if (!recording) {
                if (room.startRecording() === false) return toast('No se pudo iniciar la grabación.');
                recording = true; toast('Grabando repetición...');
            } else {
                const data = room.stopRecording(); recording = false;
                if (data) {
                    await hatitix.saveReplay(data, { name: room?.name || 'Partida' });
                    toast('Repetición guardada en la pestaña REPETICIONES.');
                } else toast('No se recibieron datos de la grabación.');
            }
        } catch (error) { recording = false; toast('No se pudo guardar la repetición: ' + errText(error), 7000); }
        sig = ''; update();
    };
    let savedMaps = [];
    async function saveCurrentStadiumToStore() {
        const current = room?.stadium;
        if (!current) throw new Error('No hay una cancha cargada en esta sala.');
        let serialized;
        try {
            // El exportador de node-haxball convierte el objeto interno del estadio
            // a JSON oficial y evita perder sus propiedades al cruzar IPC.
            serialized = Utils.exportStadium(current);
        } catch (_) {
            serialized = JSON.stringify(current);
        }
        if (typeof serialized !== 'string' || !serialized.trim()) throw new Error('El motor no pudo exportar el estadio actual.');
        const saved = await hatitix.saveMap(serialized, { name: current.name || 'Mapa guardado' });
        toast(saved.duplicate ? `Ese mapa ya estaba guardado: ${saved.name}` : `Mapa guardado en Mis estadios: ${saved.name}`);
        await openStadiumPicker(saved.id);
    }
    async function openStadiumPicker(preselectId = '') {
        if (!room) return;
        try { savedMaps = await hatitix.listMaps(); } catch (_) { savedMaps = []; }
        const personal = savedMaps.map((entry) => ({ ...entry.stadium, name: entry.name, __savedId: entry.id }));
        let defaults = [];
        try {
            const builtIns = Utils.getDefaultStadiums();
            if (Array.isArray(builtIns)) {
                const preferred = ['Classic', 'Easy', 'Small', 'Big', 'Rounded', 'Hockey', 'Big Hockey', 'Big Easy', 'Big Rounded', 'Huge'];
                const byName = new Map(builtIns.map((stadium) => [stadium.name, stadium]));
                defaults = [...preferred.filter((name) => byName.has(name)).map((name) => byName.get(name)), ...builtIns.filter((stadium) => !preferred.includes(stadium.name))]
                    .map((stadium) => ({ ...stadium, __savedId: '' }));
            }
        } catch (error) { console.error('No se pudieron cargar los estadios predeterminados de Haxball:', error); }
        stadiums = [...personal, ...defaults];
        const personalGroup = document.createElement('optgroup'); personalGroup.label = `MIS ESTADIOS (${personal.length})`;
        const defaultGroup = document.createElement('optgroup'); defaultGroup.label = `PREDETERMINADOS DE HAXBALL (${defaults.length})`;
        personal.forEach((stadium, i) => personalGroup.append(new Option(`★ ${stadium.name || `Estadio ${i + 1}`}`, i)));
        defaults.forEach((stadium, i) => defaultGroup.append(new Option(stadium.name || `Cancha ${i + 1}`, personal.length + i)));
        $('#st-list').replaceChildren(personalGroup, defaultGroup);
        const selected = preselectId ? stadiums.findIndex((stadium) => stadium.__savedId === preselectId) : stadiums.findIndex((stadium) => stadium.name === room.stadium?.name);
        $('#st-list').selectedIndex = selected >= 0 ? selected : 0;
        $('#st-status').textContent = `${savedMaps.length} mapa(s) guardado(s). /store guarda una copia local de la cancha actual; elegí una cancha para aplicarla a la sala.`;
        $('#st-delete').disabled = true;
        $('#m-stadium').classList.remove('hidden');
    }
    $('#r-pick').onclick = () => guard(() => openStadiumPicker());
    $('#st-save-current').onclick = async () => {
        try { await saveCurrentStadiumToStore(); } catch (error) { toast('No se pudo guardar el mapa: ' + errText(error), 7000); }
    };
    $('#st-list').onchange = () => { const selected = stadiums[Number($('#st-list').value)]; $('#st-delete').disabled = !selected?.__savedId; };
    $('#st-file').onchange = async (event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        try {
            const saved = await hatitix.saveMap(await file.text(), { name: file.name.replace(/\.(hbs|json)$/i, '') });
            toast(saved.duplicate ? `Ese mapa ya estaba guardado: ${saved.name}` : `Mapa guardado: ${saved.name}`); await openStadiumPicker();
            const index = stadiums.findIndex((stadium) => stadium.__savedId === saved.id); if (index >= 0) $('#st-list').selectedIndex = index;
            $('#st-list').dispatchEvent(new Event('change'));
        } catch (error) { toast('No se pudo guardar el mapa: ' + errText(error), 7000); }
    };
    $('#st-delete').onclick = async () => {
        const selected = stadiums[Number($('#st-list').value)]; if (!selected?.__savedId) return;
        if (!confirm(`¿Eliminar el mapa “${selected.name}”?`)) return;
        try { await hatitix.deleteMap(selected.__savedId); toast('Mapa eliminado.'); await openStadiumPicker(); } catch (error) { toast('No se pudo eliminar: ' + errText(error), 7000); }
    };
    $('#st-cancel').onclick = () => $('#m-stadium').classList.add('hidden');
    $('#st-ok').onclick = () => {
        const selected = stadiums[Number($('#st-list').value)];
        if (!selected) return toast('Elegí un mapa antes de cargarlo.');
        try {
            let stadium = selected;
            if (selected.__savedId) {
                const { __savedId, ...mapData } = selected;
                stadium = Utils.parseStadium(JSON.stringify(mapData));
                if (!stadium) throw new Error('Haxball no pudo interpretar este archivo de mapa.');
            }
            room.setCurrentStadium(stadium);
            $('#m-stadium').classList.add('hidden');
            toast(`Mapa cargado: ${selected.name || 'Estadio'}`);
        } catch (error) {
            console.error('Error al cargar estadio:', error);
            toast('No se pudo cargar el mapa: ' + errText(error), 7000);
        }
    };
    $('#r-leave').onclick = leave; $('#g-leave').onclick = leave;
    $('#r-score').onchange = (e) => room.setScoreLimit(+e.target.value);
    $('#r-time').onchange = (e) => room.setTimeLimit(+e.target.value);
    $('#r-link').onclick = () => {
        if (!link) return toast('Todavía no hay link de la sala');
        navigator.clipboard.writeText(link); toast('Link copiado');
    };
    $('#g-set').onclick = openSettings;
    $('#b-settings').onclick = openSettings;
    $('#g-fullscreen').onclick = () => setFullscreen(!isFullscreen);
    $('#g-match-fullscreen').onclick = () => {
        if (room && room.gameState) {
            if (!isMatchFullscreen) { matchFullscreenDismissed = false; setMatchFullscreen(true); }
            else toast('El fullscreen especial se mantiene activo durante los partidos.');
            return;
        }
        setMatchFullscreen(!isMatchFullscreen);
    };
    $('#s-fullscreen').onchange = (event) => setFullscreen(event.target.checked);
    $('#s-window-mode').value = isFullscreen ? 'borderless' : 'windowed';
    $('#s-window-mode').onchange = (event) => setFullscreen(event.target.value === 'borderless');
    $('#s-stretch').checked = stretchFullscreen;
    $('#s-stretch').onchange = (event) => {
        stretchFullscreen = event.target.checked;
        localStorage.setItem('hatitix-fullscreen-stretch', stretchFullscreen ? '1' : '0');
        applyStageResolution();
        updateFullscreenUI(isFullscreen);
    };
    hatitix.getFullscreen().then(updateFullscreenUI).catch(() => updateFullscreenUI(false));
    hatitix.onFullscreenChanged(updateFullscreenUI);
    const savedAutoSide = localStorage.getItem('hatitix-auto-side') || 'off';
    $('#s-auto-side').value = ['off', 'auto', 'red', 'blue', 'spec'].includes(savedAutoSide) ? savedAutoSide : 'off';
    $('#s-auto-side').onchange = (event) => {
        const value = ['off', 'auto', 'red', 'blue', 'spec'].includes(event.target.value) ? event.target.value : 'off';
        localStorage.setItem('hatitix-auto-side', value);
        toast(value === 'off' ? 'Selección automática de equipo desactivada.' : 'El equipo elegido se aplicará al entrar a la próxima sala.');
    };
    document.querySelector('.navb[data-page="misiones"]')?.addEventListener('click', () => renderMissions());
    $('#missions-grid').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-claim-mission]');
        if (button) claimMission(button.dataset.claimMission);
    });
    $('#shop-grid').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-shop-item]');
        if (!button) return;
        const item = SHOP_ITEMS.find((candidate) => candidate.id === button.dataset.shopItem);
        if (!item) return;
        if (!ownedItems.has(item.id)) {
            if (progress.points < item.price) return toast(`Todavía no tenés ${currencyWords().word} suficientes.`);
            progress.points -= item.price; ownedItems.add(item.id);
            localStorage.setItem('hatitix-shop-unlocked', JSON.stringify([...ownedItems]));
            saveProgress(); toast(`Desbloqueaste ${item.name}. Ya aparece en Ajustes → Personalización.`);
        }
        if (item.kind === 'theme') applyTheme(item.id);
        else if (item.kind === 'field') applyField(item.id);
        renderShop();
        if (item.kind === 'explosion') toast(`Abrí Ajustes → Personalización para activar ${item.name}.`);
    });
    $('#custom-store-items').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-owned-item]');
        if (!button) return;
        const item = SHOP_ITEMS.find((candidate) => candidate.id === button.dataset.ownedItem);
        if (!item || !ownedItems.has(item.id)) return;
        if (item.kind === 'theme') applyTheme(item.id);
        else if (item.kind === 'field') applyField(item.id);
        else {
            activeExplosion = activeExplosion === item.id ? '' : item.id;
            localStorage.setItem('hatitix-active-explosion', activeExplosion);
        }
        renderShop();
        if (item.kind === 'theme') toast(`Tema ${item.name} activado.`);
        else if (item.kind === 'explosion') toast(activeExplosion ? `${item.name} se mostrará cuando marques.` : 'Explosión de gol desactivada.');
    });
    window.addEventListener('hatitix:points-changed', refreshPointsFromStorage);
    $('#s-redeem').addEventListener('click', redeemPromoCode);
    $('#s-redeem-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); redeemPromoCode(); } });
    $('#s-pasitos-mode').addEventListener('change', (event) => {
        if (!pasitosUnlocked) { event.target.checked = false; return; }
        pasitosMode = event.target.checked;
        localStorage.setItem('hatitix-pasitos-mode', pasitosMode ? '1' : '0');
        updateModeLabels(); updateProgressUI(); renderShop(); renderMissions();
        toast(pasitosMode ? 'Modo Pasitos activado.' : 'Modo Pasitos desactivado.');
    });
    $('#settings').addEventListener('click', (event) => {
        const assign = event.target.closest('button[data-bind]');
        const add = event.target.closest('button[data-add-bind]');
        const remove = event.target.closest('button[data-remove-bind]');
        if (assign) { captureAction = assign.dataset.bind; captureIndex = Number(assign.dataset.bindIndex) || 0; renderBindings(); toast('Presioná la nueva tecla. Escape cancela.'); return; }
        if (add) {
            const action = add.dataset.addBind;
            if (keyBindings[action]?.length >= 5) return;
            keyBindings[action].push(''); captureAction = action; captureIndex = keyBindings[action].length - 1; renderBindings(); toast('Presioná la nueva tecla. Escape cancela.'); return;
        }
        if (remove) {
            const action = remove.dataset.removeBind, index = Number(remove.dataset.bindIndex);
            if (!Array.isArray(keyBindings[action]) || keyBindings[action].length <= 1) return;
            keyBindings[action].splice(index, 1); localStorage.setItem('hatitix-key-bindings', JSON.stringify(keyBindings));
            captureAction = null; keys.clear(); renderBindings(); sendKeys();
        }
    });
    $('#s-controls-reset').onclick = () => {
        Object.assign(keyBindings, Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([action, code]) => [action, [code]])));
        localStorage.setItem('hatitix-key-bindings', JSON.stringify(keyBindings));
        captureAction = null; keys.clear(); renderBindings(); sendKeys(); toast('Controles restablecidos a WASD y espacio.');
    };
    $('#s-classic').checked = classicMode;
    document.body.classList.toggle('classic-haxball', classicMode);
    $('#s-classic').onchange = (event) => setClassicMode(event.target.checked);
    function showCustomResolution(show) {
        ['#s-width', '#s-height', '#s-res-x'].forEach((selector) => $(selector).classList.toggle('hidden', !show));
    }
    function applySelectedAspect() {
        const width = Number($('#s-width').value);
        const aspect = $('#s-aspect')?.value || 'original';
        if (!Number.isInteger(width) || aspect === 'original') return;
        const [numerator, denominator] = aspect.split(':').map(Number);
        let height = Math.round(width * denominator / numerator);
        if (height < 500) { height = 500; $('#s-width').value = String(Math.round(height * numerator / denominator)); }
        if (height > 2160) { height = 2160; $('#s-width').value = String(Math.round(height * numerator / denominator)); }
        $('#s-height').value = String(height);
    }
    $('#s-resolution').onchange = (event) => {
        const value = event.target.value;
        const customSize = value === 'custom';
        showCustomResolution(customSize);
        if (!customSize) {
            const [width, height] = value.split('x').map(Number);
            $('#s-width').value = width; $('#s-height').value = height;
        }
        applySelectedAspect();
    };
    $('#s-aspect').value = localStorage.getItem('hatitix-resolution-aspect') || 'original';
    if ($('#s-aspect').value === '4:3') {
        stretchFullscreen = true;
        localStorage.setItem('hatitix-fullscreen-stretch', '1');
        $('#s-stretch').checked = true;
    }
    $('#s-aspect').onchange = () => {
        const aspect = $('#s-aspect').value;
        localStorage.setItem('hatitix-resolution-aspect', aspect);
        applySelectedAspect();
        if (aspect !== 'original') {
            $('#s-resolution').value = 'custom';
            showCustomResolution(true);
        }
        if (aspect === '4:3') {
            // 4:3 en pantalla completa se estira al monitor de forma inmediata.
            stretchFullscreen = true;
            localStorage.setItem('hatitix-fullscreen-stretch', '1');
            $('#s-stretch').checked = true;
        }
        $('#s-res-apply').click();
    };
    $('#s-width').addEventListener('input', applySelectedAspect);
    $('#s-res-apply').onclick = async () => {
        applySelectedAspect();
        const width = Number($('#s-width').value), height = Number($('#s-height').value);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 600 || width > 3840 || height < 500 || height > 2160) return toast('Resolución permitida: ancho 600–3840 y alto 500–2160.');
        resolutionResizeInProgress = true;
        try {
            const result = await hatitix.resizeWindow({ width, height });
            $('#s-width').value = result[0]; $('#s-height').value = result[1];
            selectedRenderResolution = { width: result[0], height: result[1] };
            localStorage.setItem('hatitix-selected-resolution', JSON.stringify(selectedRenderResolution));
            const remainsFullscreen = typeof result[2] === 'boolean' ? result[2] : isFullscreen;
            fullscreenRenderResolution = remainsFullscreen ? { width: result[0], height: result[1] } : null;
            sizeCanvas();
            const preset = `${result[0]}x${result[1]}`;
            $('#s-resolution').value = [...$('#s-resolution').options].some((option) => option.value === preset) ? preset : 'custom';
            showCustomResolution($('#s-resolution').value === 'custom');
            toast(remainsFullscreen
                ? `Ventana ajustada a ${result[0]} × ${result[1]} y pantalla completa conservada.`
                : `Ventana ajustada a ${result[0]} × ${result[1]} píxeles.`);
        } catch (error) { toast('No se pudo cambiar la resolución: ' + errText(error), 7000); }
        finally { setTimeout(() => { resolutionResizeInProgress = false; }, 900); }
    };
    hatitix.getWindowSize().then(([width, height, fullscreen]) => {
        if (fullscreen && !selectedRenderResolution) selectedRenderResolution = { width, height };
        if (!selectedRenderResolution) selectedRenderResolution = { width, height };
        if (fullscreen) fullscreenRenderResolution = { ...selectedRenderResolution };
        $('#s-width').value = selectedRenderResolution.width; $('#s-height').value = selectedRenderResolution.height;
        applySelectedAspect();
        const preset = `${selectedRenderResolution.width}x${selectedRenderResolution.height}`;
        $('#s-resolution').value = [...$('#s-resolution').options].some((option) => option.value === preset) ? preset : 'custom';
        showCustomResolution($('#s-resolution').value === 'custom');
        sizeCanvas();
    }).catch(() => {});
    $('#s-layout-reset').onclick = () => {
        ['hud', 'chat'].forEach((id) => {
            localStorage.removeItem(`hatitix-position-${id}`);
            const element = $('#' + id);
            element.style.removeProperty('left'); element.style.removeProperty('top'); element.style.removeProperty('right'); element.style.removeProperty('bottom');
        });
        toast('Posiciones del chat y marcador restablecidas.');
    };
    ['hud', 'chat'].forEach((id) => { loadOverlayPosition(id); enableOverlayDrag(id); });
    renderBindings(); updateModeLabels(); renderShop(); updateProgressUI(); renderMissions();
    $('#player-menu').addEventListener('click', (e) => {
        const button = e.target.closest('button[data-action]');
        if (button) moderatePlayer(button.dataset.action);
    });
    document.addEventListener('pointerdown', (e) => {
        const menu = $('#player-menu');
        if (!menu.classList.contains('hidden') && !menu.contains(e.target)) closePlayerMenu();
    });
    window.addEventListener('resize', closePlayerMenu);
    document.querySelectorAll('.settings-nav button').forEach((button) => button.onclick = () => {
        const section = button.dataset.settings;
        document.querySelectorAll('.settings-nav button').forEach((b) => b.classList.toggle('on', b === button));
        document.querySelectorAll('.settings-group').forEach((group) => { const active = group.dataset.section === section; group.classList.toggle('active', active); group.open = active; });
    });
    $('#s-close').onclick = () => $('#settings').classList.add('hidden');
    $('#s-ex').oninput = (e) => {
        const value = Number(e.target.value);
        if (renderer && e.target.value !== '' && Number.isFinite(value)) renderer.extrapolation = value;
    };
    $('#s-ex').onchange = (e) => {
        if (e.target.value === '' || !Number.isFinite(Number(e.target.value))) return;
        const value = Math.round(Number(e.target.value));
        e.target.value = String(value); if (renderer) renderer.extrapolation = value; saveProfileExtrapolation(value);
    };
    $('#s-zoom').oninput = (e) => {
        if (!renderer) return;
        renderer.zoomCoeff = +e.target.value;
        $('#h-cam').textContent = 'CAM LIBRE · 1–0';
    };
    $('#s-quality').onchange = (e) => applyQuality(e.target.value);
    $('#s-fps-limit').onchange = (e) => setFpsLimit(e.target.value);
    $('#s-fps').onchange = (e) => { pref.showFps = e.target.checked; localStorage.setItem('hatitix-show-fps', pref.showFps ? '1' : '0'); updateStats(); };
    $('#s-ping').onchange = (e) => { pref.showPing = e.target.checked; localStorage.setItem('hatitix-show-ping', pref.showPing ? '1' : '0'); updateStats(); };
    $('#s-acceleration').value = localStorage.getItem('hatitix-acceleration') || 'hardware';
    $('#s-acceleration-apply').onclick = async () => {
        const mode = $('#s-acceleration').value === 'software' ? 'software' : 'hardware';
        localStorage.setItem('hatitix-acceleration', mode);
        toast(`Cambiando a aceleración ${mode === 'hardware' ? 'de hardware' : 'por software'} y reiniciando...`);
        try { await hatitix.setAcceleration(mode); } catch (error) { toast('No se pudo cambiar la aceleración: ' + errText(error), 7000); }
    };
    $('#s-chat').onchange = (e) => setChatVisible(e.target.checked);
    function setClassicMode(enabled) {
        classicMode = !!enabled;
        localStorage.setItem('hatitix-classic', classicMode ? '1' : '0');
        $('#s-classic').checked = classicMode;
        document.body.classList.toggle('classic-haxball', classicMode);
        applyQuality(pref.quality);
        applyVision(custom.vision);
        toast(classicMode ? 'Estilo Haxball clásico activado: cancha e interfaz transformadas.' : 'Estilo HaTitix restaurado.');
    }
    function applyVision(value) {
        custom.vision = ['normal', 'contrast', 'simple'].includes(value) ? value : 'normal';
        localStorage.setItem('hatitix-vision', custom.vision);
        $('#cv').classList.remove('vision-contrast', 'vision-simple');
        if (!classicMode && custom.vision !== 'normal') $('#cv').classList.add('vision-' + custom.vision);
        $('#s-vision').value = custom.vision;
    }
    function setPreview(name, src) {
        const preview = $('#preview-' + name);
        preview.src = src || ''; preview.classList.toggle('hidden', !src);
    }
    function saveImageAsset(name, file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const max = 96, scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
                const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                const src = canvas.toDataURL('image/webp', .72); custom[name] = src; localStorage.setItem('hatitix-custom-' + name, src); imageCache.delete(src); relayImageCache.clear(); setPreview(name, src); scheduleSkinProfilePublish(0); toast('Imagen guardada y optimizada');
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    }
    ['ball', 'me', 'other'].forEach((name) => {
        $('#s-' + name + '-img').onchange = (e) => saveImageAsset(name, e.target.files[0]);
        $('#clear-' + name + '-img').onclick = () => { custom[name] = ''; localStorage.removeItem('hatitix-custom-' + name); relayImageCache.clear(); setPreview(name, ''); $('#s-' + name + '-img').value = ''; scheduleSkinProfilePublish(0); };
        setPreview(name, custom[name]);
    });
    $('#s-other-team').value = custom.otherTeam;
    $('#s-other-team').onchange = (e) => { custom.otherTeam = ['none', 'red', 'blue', 'all'].includes(e.target.value) ? e.target.value : 'none'; localStorage.setItem('hatitix-custom-other-team', custom.otherTeam); scheduleSkinProfilePublish(0); };
    $('#s-skin-relay-url').value = localStorage.getItem('hatitix-skin-relay-url') || '';
    $('#s-skin-relay-token').value = localStorage.getItem('hatitix-skin-relay-token') || '';
    $('#s-skin-relay-save').onclick = () => {
        const urlInput = $('#s-skin-relay-url'), tokenInput = $('#s-skin-relay-token');
        const rawUrl = urlInput.value.trim(), token = tokenInput.value.trim();
        if (!rawUrl && !token) {
            localStorage.removeItem('hatitix-skin-relay-url'); localStorage.removeItem('hatitix-skin-relay-token');
            disconnectSkinRelayAndClear(); toast('Señalización desactivada.'); return;
        }
        if (!rawUrl || !token) { toast('Ingresá tanto la URL de señalización como la clave compartida.', 6000); return; }
        let parsed;
        try { parsed = new URL(rawUrl); } catch (_) { toast('La URL de señalización no es válida.', 6000); return; }
        if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) { toast('Usá una URL ws:// o wss:// válida, sin usuario ni contraseña.', 6000); return; }
        const localRelayHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if (parsed.protocol === 'ws:' && !localRelayHost) { toast('Para un servidor público usá wss://; ws:// solo se permite en localhost.', 7000); return; }
        if (parsed.pathname === '/' || !parsed.pathname) parsed.pathname = '/ws';
        if (parsed.pathname !== '/ws' || parsed.search) { toast('La URL debe apuntar a la ruta /ws y no llevar parámetros.', 6000); return; }
        parsed.hash = '';
        const endpoint = parsed.toString();
        localStorage.setItem('hatitix-skin-relay-url', endpoint);
        localStorage.setItem('hatitix-skin-relay-token', token);
        urlInput.value = endpoint;
        disconnectSkinRelay(true);
        if (room) connectSkinRelay();
        else setSkinRelayStatus('Señalización guardada. Se conectará al entrar a una sala.');
        toast('Configuración de señalización guardada.');
    };
    const skinHostPreference = $('#s-skin-host-prefer');
    skinHostPreference.checked = localStorage.getItem('hatitix-skin-prefer-host') === '1';
    skinHostPreference.onchange = () => {
        const preferHost = skinHostPreference.checked;
        localStorage.setItem('hatitix-skin-prefer-host', preferHost ? '1' : '0');
        if (skinP2P) skinP2P.setPreferHost(preferHost);
        else if (room) connectSkinRelay();
        toast(preferHost ? 'Esta instancia tendrá prioridad para alojar las skins mientras esté conectada.' : 'Se usará la elección automática de anfitrión por ping.');
    };
    setSkinRelayStatus(localStorage.getItem('hatitix-skin-relay-url') ? 'Señalización configurada. Se conectará al entrar a una sala.' : 'Señalización sin configurar. Las fotos no se envían por el chat ni al servidor.');
    $('#s-vision').onchange = (e) => applyVision(e.target.value);
    applyVision(custom.vision);
    $('#s-quality').value = pref.quality;
    $('#s-fps-limit').value = String(pref.fpsLimit);
    $('#s-sound').checked = soundEnabled;
    $('#s-sound').onchange = (event) => {
        soundEnabled = !!event.target.checked;
        localStorage.setItem('hatitix-sound', soundEnabled ? '1' : '0');
    };
    for (const event of ['goal', 'hit', 'chat', 'victory']) {
        const input = $(`#s-sound-${event}`);
        input.value = soundPrefs[event];
        input.onchange = () => {
            soundPrefs[event] = SOUND_OPTIONS.includes(input.value) ? input.value : 'off';
            localStorage.setItem('hatitix-sound-events', JSON.stringify(soundPrefs));
            if (soundEnabled && soundPrefs[event] !== 'off') playGameSound(event);
        };
        const fileInput = $(`#s-sound-file-${event}`);
        const nameLabel = $(`#s-sound-name-${event}`);
        const savedName = localStorage.getItem(`hatitix-sound-name-${event}`);
        if (savedName) nameLabel.textContent = savedName;
        fileInput.onchange = async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            if (file.type && !file.type.startsWith('audio/')) {
                toast('Elegí un archivo de audio válido.'); fileInput.value = ''; return;
            }
            try {
                await saveCustomSound(event, file);
                nameLabel.textContent = file.name;
                toast('Audio personalizado guardado.');
                await playCustomSound(event);
            } catch (error) {
                toast(error.message || 'No se pudo guardar o reproducir el audio.');
            }
        };
        $(`[data-sound-test="${event}"]`).onclick = async () => {
            try {
                const played = await playCustomSound(event);
                if (!played) {
                    const wasEnabled = soundEnabled;
                    soundEnabled = true;
                    playGameSound(event);
                    soundEnabled = wasEnabled;
                }
            } catch (_) { toast('No se pudo reproducir este audio.'); }
        };
        $(`[data-sound-clear="${event}"]`).onclick = async () => {
            try {
                const db = await openSoundDb();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('sounds', 'readwrite');
                    tx.objectStore('sounds').delete(event);
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error || new Error('No se pudo borrar el audio.'));
                });
                const url = customSoundUrls.get(event);
                if (url) URL.revokeObjectURL(url);
                customSoundUrls.delete(event);
                localStorage.removeItem(`hatitix-sound-name-${event}`);
                nameLabel.textContent = 'Usar sonido elegido arriba';
                fileInput.value = '';
                toast('Audio personalizado eliminado.');
            } catch (error) { toast(error.message || 'No se pudo eliminar el audio.'); }
        };
    }
    $('#s-chat-size').oninput = () => {
        localStorage.setItem('hatitix-chat-size', $('#s-chat-size').value);
        applyChatSize();
    };
    $('#s-chat-height').oninput = () => {
        localStorage.setItem('hatitix-chat-height', $('#s-chat-height').value);
        applyChatSize();
    };
    $('#s-chat-fade').checked = chatFadeEnabled;
    $('#s-chat-fade').onchange = () => {
        chatFadeEnabled = $('#s-chat-fade').checked;
        localStorage.setItem('hatitix-chat-fade', chatFadeEnabled ? '1' : '0');
        applyChatFade();
    };
    applyChatSize();
    $('#s-fps').checked = pref.showFps;
    $('#s-ping').checked = pref.showPing;
    $('#s-chat').checked = pref.showChat;
    setChatVisible(pref.showChat);

    // ----- Crear sala y clave -----
    const show = (id, v) => $(id).classList.toggle('hidden', !v);
    $('#c-max').oninput = (e) => { $('#c-maxv').textContent = e.target.value; };
    $('#c-close').onclick = () => show('#m-create', false);
    $('#c-ok').onclick = async () => {
        show('#m-create', false);
        toast('Resolvé el captcha de Haxball para crear la sala...');
        const token = await hatitix.getToken();
        if (!token) return toast('Creación cancelada');
        createRoom({ name: $('#c-name').value.trim() || 'Sala HaTitiX', password: $('#c-pass').value, max: +$('#c-max').value, show: $('#c-show').checked, token });
    };
    $('#pw-cancel').onclick = () => show('#m-pw', false);
    const submitRoomPassword = () => {
        if (!pending) return;
        const target = pending;
        const password = $('#pw-in').value;
        show('#m-pw', false);
        joinRoom(target, password);
    };
    $('#pw-ok').onclick = submitRoomPassword;
    $('#pw-in').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitRoomPassword(); });
    let replayReader = null, replayCanvasRenderer = null, replayRendererReady = false;
    let replayDuration = 0, replayEnded = false, replayUiAt = 0;
    function replayTimeText(ms) {
        const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function updateReplayControls(force = false) {
        if (!replayReader) return;
        const now = performance.now();
        if (!force && now - replayUiAt < 130) return;
        replayUiAt = now;
        $('#embedded-replay-seek').value = String(Math.max(0, replayReader.getCurrentFrameNo()));
        $('#embedded-replay-time').textContent = `${replayTimeText(replayReader.getTime())} / ${replayTimeText(replayDuration)}`;
    }
    function drawReplayFrame() {
        if (!replayReader) return;
        try {
            if (!replayCanvasRenderer) {
                replayCanvasRenderer = new GameRenderer(API, {
                    canvas: $('#embedded-replay-canvas'), images, paintGame: true,
                    onRequestAnimationFrame: () => {}
                });
                replayCanvasRenderer.room = replayReader;
                replayCanvasRenderer.resolutionScale = ({ low: 0.8, medium: 1, high: 1.25 })[pref.quality] || 1;
                replayCanvasRenderer.initialize();
                replayRendererReady = true;
            }
            replayCanvasRenderer.room = replayReader;
            replayCanvasRenderer.render();
            $('#embedded-replay-message').classList.add('hidden');
            updateReplayControls();
        } catch (error) {
            $('#embedded-replay-error').textContent = `No se pudo dibujar la repetición: ${errText(error)}`;
            replayReader.setSpeed(0);
        }
    }
    function closeReplay() {
        try { replayReader?.setSpeed(0); replayReader?.destroy(); } catch (_) { /* repetición ya terminada */ }
        try { if (replayRendererReady) replayCanvasRenderer?.finalize(); } catch (_) { /* limpiar renderer */ }
        replayReader = null; replayCanvasRenderer = null; replayRendererReady = false; replayEnded = false; replayDuration = 0;
        $('#embedded-replay').classList.add('hidden');
    }
    async function playReplay(id, name = 'Partida') {
        closeReplay();
        const overlay = $('#embedded-replay'), message = $('#embedded-replay-message');
        overlay.classList.remove('hidden');
        $('#embedded-replay-title').textContent = name || 'Partida';
        $('#embedded-replay-error').textContent = '';
        message.textContent = 'Cargando repetición…'; message.classList.remove('hidden');
        try {
            const raw = await hatitix.readReplay(id);
            const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            replayReader = API.Replay.read(bytes, {
                render: drawReplayFrame,
                onGameTick: () => updateReplayControls(),
                onDestinationTimeReached: () => updateReplayControls(true),
                onEnd: () => {
                    replayEnded = true; replayReader?.setSpeed(0);
                    message.textContent = 'Fin de la repetición'; message.classList.remove('hidden'); updateReplayControls(true);
                }
            }, { requestAnimationFrame: requestGameFrame, cancelAnimationFrame: cancelGameFrame });
            replayDuration = replayReader.length();
            $('#embedded-replay-seek').max = String(Math.max(1, replayReader.maxFrameNo));
            $('#embedded-replay-seek').value = '0';
            replayReader.setSpeed(Number($('#embedded-replay-speed').value) || 1);
            updateReplayControls(true);
        } catch (error) {
            message.textContent = 'No se pudo abrir esta repetición.'; message.classList.remove('hidden');
            $('#embedded-replay-error').textContent = errText(error);
        }
    }
    $('#embedded-replay-close').onclick = closeReplay;
    $('#embedded-replay-play').onclick = () => {
        if (!replayReader) return;
        if (replayEnded) { replayEnded = false; replayReader.setCurrentFrameNo(0); }
        replayReader.setSpeed(Number($('#embedded-replay-speed').value) || 1);
        $('#embedded-replay-message').classList.add('hidden');
    };
    $('#embedded-replay-pause').onclick = () => replayReader?.setSpeed(0);
    $('#embedded-replay-speed').onchange = () => {
        if (replayReader && replayReader.getSpeed() > 0) replayReader.setSpeed(Number($('#embedded-replay-speed').value) || 1);
    };
    $('#embedded-replay-seek').oninput = () => {
        if (!replayReader) return;
        replayEnded = false; replayReader.setSpeed(0);
        replayReader.setCurrentFrameNo(Number($('#embedded-replay-seek').value));
        $('#embedded-replay-message').classList.add('hidden'); updateReplayControls(true);
    };
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !$('#embedded-replay').classList.contains('hidden')) closeReplay();
    });
    window.HX = {
        join: (r) => {
            // Siempre permitir ingresar clave: links directos y algunas listas no
            // informan de forma fiable si la sala está protegida.
            pending = r;
            $('#pw-in').value = '';
            $('#pw-in').placeholder = r.hasPassword ? 'Contraseña de la sala' : 'Sin contraseña, dejá este campo vacío';
            show('#m-pw', true);
            $('#pw-in').focus();
        },
        openCreate: async () => {
            const p = await profile();
            $('#c-name').value = ((p && p.name) || 'Mi') + "'s room";
            show('#m-create', true);
        },
        playReplay
    };
})();
