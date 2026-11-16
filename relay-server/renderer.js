const $ = (s) => document.querySelector(s);
const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => localStorage.setItem(k, JSON.stringify(v))
};
const state = { rooms: [], tab: 'all', sel: null, favs: new Set(store.get('favs', [])), seen: store.get('seen', []) };
const regions = new Intl.DisplayNames(['es'], { type: 'region' });
const countryName = (c) => { try { return regions.of(c.toUpperCase()); } catch { return c.toUpperCase(); } };

// Servidores: se detectan por el nombre de la sala (editá las expresiones a gusto)
const SERVERS = {
    sang: /sanguch|sandwich|🥪|🍞|🧀/i,
    aha: /\baha\b/i,
    haxarg: /hax\s?arg/i
};
const plain = (n) => n.normalize('NFKD');

function setView(v) {
    // ya no hay vista de Haxball oficial
}

function join(room) {
    state.seen = [room.name, ...state.seen.filter((n) => n !== room.name)].slice(0, 30);
    store.set('seen', state.seen);
    HX.join(room);
}

function visible() {
    const q = $('#q').value.trim().toLowerCase();
    const country = $('#country').value;
    return state.rooms
        .filter((r) => {
            if (state.tab === 'favs' && !state.favs.has(r.name)) return false;
            if (SERVERS[state.tab] && !SERVERS[state.tab].test(plain(r.name))) return false;
            if (state.tab === 'seen' && !state.seen.includes(r.name)) return false;
            if (q && !r.name.toLowerCase().includes(q)) return false;
            if (!$('#f-pw').checked && r.hasPassword) return false;
            if (!$('#f-full').checked && r.players >= r.maxPlayers) return false;
            if (!$('#f-empty').checked && r.players === 0) return false;
            return !country || r.flag === country;
        })
        .sort((a, b) => b.players - a.players);
}

function row(r) {
    const d = document.createElement('div');
    d.className = 'row' + (r.hasPassword ? ' pw' : '') + (r.players >= r.maxPlayers ? ' full' : '') +
        (r.players === 0 ? ' empty' : '') + (state.sel?.id === r.id ? ' sel' : '');
    const star = document.createElement('button');
    star.className = 'star' + (state.favs.has(r.name) ? ' on' : '');
    star.textContent = '★';
    star.onclick = (e) => {
        e.stopPropagation();
        state.favs.has(r.name) ? state.favs.delete(r.name) : state.favs.add(r.name);
        store.set('favs', [...state.favs]);
        render();
    };
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    const jug = document.createElement('span');
    jug.className = 'jug';
    jug.innerHTML = '<div class="bar"><i></i></div><span class="cnt"></span>';
    jug.querySelector('i').style.width = Math.min(100, (r.players / (r.maxPlayers || 1)) * 100) + '%';
    jug.querySelector('.cnt').textContent = `${r.players}/${r.maxPlayers}`;
    const lock = document.createElement('span');
    lock.textContent = r.hasPassword ? '🔒' : '';
    const flag = document.createElement('img');
    flag.alt = r.flag.toUpperCase();
    flag.src = `https://flagcdn.com/w40/${r.flag}.png`;
    d.append(star, name, jug, lock, flag);
    d.onclick = () => { state.sel = r; render(); };
    d.ondblclick = () => join(r);
    return d;
}

function render() {
    const rows = visible();
    $('#list').replaceChildren(...rows.map(row));
    if (!rows.length) {
        const m = document.createElement('div');
        m.className = 'msg';
        m.textContent = state.rooms.length ? 'No hay salas con esos filtros.' : 'Cargando salas...';
        $('#list').append(m);
    }
    $('#c-all').textContent = state.rooms.length;
    $('#c-favs').textContent = state.rooms.filter((r) => state.favs.has(r.name)).length;
    $('#c-seen').textContent = state.rooms.filter((r) => state.seen.includes(r.name)).length;
    for (const k in SERVERS) $('#c-' + k).textContent = state.rooms.filter((r) => SERVERS[k].test(plain(r.name))).length;
    const players = state.rooms.reduce((n, r) => n + r.players, 0);
    $('#total').textContent = state.rooms.length ? `${players} jugadores en ${state.rooms.length} salas` : '';
    const s = state.sel;
    $('#selname').textContent = s ? s.name : 'Elegí una sala de la lista.';
    $('#selinfo').textContent = s ? `${s.players}/${s.maxPlayers} jugadores · ${countryName(s.flag)}${s.hasPassword ? ' · con clave' : ''}` : '';
    $('#b-join').style.display = s ? 'block' : 'none';
}

function fillCountries() {
    const sel = $('#country'), cur = sel.value;
    const codes = [...new Set(state.rooms.map((r) => r.flag))].sort((a, b) => countryName(a).localeCompare(countryName(b)));
    sel.replaceChildren(new Option('Todos los países', ''), ...codes.map((c) => new Option(countryName(c), c)));
    sel.value = cur;
}

async function refresh() {
    try {
        state.rooms = await hatitix.rooms();
        fillCountries();
    } catch (err) {
        state.rooms = [];
        $('#list').replaceChildren();
        const m = document.createElement('div');
        m.className = 'msg';
        m.textContent = 'Error al cargar la lista: ' + err.message;
        $('#list').append(m);
        return;
    }
    render();
}

document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    state.tab = t.dataset.tab;
    render();
});
['#q', '#f-pw', '#f-full', '#f-empty', '#country'].forEach((s) => $(s).addEventListener('input', render));
$('#b-refresh').onclick = refresh;
$('#b-create').onclick = () => HX.openCreate();
$('#b-create-rs').onclick = () => HX.openCreate('rs');
$('#b-quit').onclick = () => hatitix.quit();
$('#b-discord').onclick = () => hatitix.discord();
$('#b-join').onclick = () => state.sel && join(state.sel);
$('#b-link').onclick = () => {
    const v = $('#link').value.trim();
    const id = (v.match(/[?&]c=([\w-]+)/) || [])[1] || (/^[\w-]{4,32}$/.test(v) ? v : null);
    if (id) { HX.join({ id, name: id, hasPassword: false }); $('#link').value = ''; }
};
$('#link').addEventListener('keydown', (e) => e.key === 'Enter' && $('#b-link').click());
document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#q').focus(); }
});

// ---------- Páginas ----------
function showPage(p) {
    document.querySelectorAll('.navb[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === p));
    $('#page-salas').classList.toggle('hidden', p !== 'salas');
    $('#page-perfiles').classList.toggle('hidden', p !== 'perfiles');
    $('#page-tienda').classList.toggle('hidden', p !== 'tienda');
    $('#page-casino').classList.toggle('hidden', p !== 'casino');
    $('#page-estadisticas').classList.toggle('hidden', p !== 'estadisticas');
    $('#page-trofeos').classList.toggle('hidden', p !== 'trofeos');
    $('#page-misiones').classList.toggle('hidden', p !== 'misiones');
    $('#page-repeticiones').classList.toggle('hidden', p !== 'repeticiones');
    $('#page-amigos').classList.toggle('hidden', p !== 'amigos');
    $('#page-mensajes').classList.toggle('hidden', p !== 'mensajes');
    if (p === 'amigos') renderFriends();
    if (p === 'mensajes') window.dispatchEvent(new Event('hatitix:messages-page'));
    if (p === 'estadisticas') renderRanking();
    if (p === 'trofeos') renderTrophies();
    if (p === 'repeticiones') renderReplays();
    if (p === 'casino') renderCasino();
    setView('lobby');
}
document.querySelectorAll('.navb[data-page]').forEach((b) => b.onclick = () => showPage(b.dataset.page));
let casinoBusy = false;
let casinoAudio;
function casinoSound(kind = 'tick') {
    if (localStorage.getItem('hatitix-sound') === '0' || Number(localStorage.getItem('hatitix-sound-volume') || .8) <= 0) return;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
        casinoAudio ||= new Ctx(); if (casinoAudio.state === 'suspended') casinoAudio.resume().catch(() => {});
        const now = casinoAudio.currentTime, tones = { tick: [260, .045], win: [880, .22], lose: [120, .18], card: [520, .08] }, [freq, duration] = tones[kind] || tones.tick;
        const o = casinoAudio.createOscillator(), g = casinoAudio.createGain(); o.type = kind === 'lose' ? 'sawtooth' : 'triangle'; o.frequency.value = freq; g.gain.setValueAtTime(.0001, now); g.gain.exponentialRampToValueAtTime(.12, now + .01); g.gain.exponentialRampToValueAtTime(.0001, now + duration); o.connect(g).connect(casinoAudio.destination); o.start(now); o.stop(now + duration + .02);
    } catch (_) {}
}
function renderCasino() { const balance = document.getElementById('casino-balance'); if (balance) balance.textContent = String(window.HatitixCasino?.balance?.() || 0); }
function casinoAmount(id) { return document.getElementById(id)?.value; }
function casinoMessage(text, tone = '') { const el = document.getElementById('casino-result'); if (!el) return; el.textContent = text; el.className = `casino-result ${tone}`; }
const casinoFormatCard = (card) => card === 1 ? 'A' : card === 11 ? 'J' : card === 12 ? 'Q' : card === 13 ? 'K' : String(card);
const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '7️⃣', '🍇', '💎'];
function setCasinoButtons(disabled) { document.querySelectorAll('.casino-play').forEach((button) => { button.disabled = disabled; }); }
function finishCasino(play, game) {
    const result = window.HatitixCasino?.settle?.(play.id); if (!result?.ok) { casinoBusy = false; setCasinoButtons(false); return; }
    const delta = result.delta, won = delta > 0, push = delta === 0;
    let detail = '';
    if (game === 'roulette') detail = `Salió ${play.number} · ${play.color}. ` + play.parts.map((part) => `${part.type} ${part.pick} ${part.hit ? '✔' : '✘'}`).join(' · ') + '. ';
    casinoMessage(push ? `${detail}Empate: no ganás ni perdés. Saldo: ${result.balance}.` : won ? `${detail}¡Ganaste +${delta} Titipoints! Saldo: ${result.balance}.` : `${detail}Perdiste ${Math.abs(delta)} Titipoints. Saldo: ${result.balance}.`, won ? 'win' : push ? '' : 'lose');
    casinoSound(won ? 'win' : push ? 'card' : 'lose'); renderCasino(); casinoBusy = false; setCasinoButtons(false);
}
// Ruleta: el número del centro va cambiando mientras gira y frena en el resultado.
function spinRoulette(play) {
    const wheel = document.getElementById('roulette-wheel'), label = wheel.querySelector('span');
    wheel.classList.remove('spinning'); void wheel.offsetWidth; wheel.classList.add('spinning');
    const flicker = setInterval(() => { label.textContent = String(Math.floor(Math.random() * 37)); }, 70);
    const ticks = setInterval(() => casinoSound('tick'), 170);
    setTimeout(() => { clearInterval(flicker); clearInterval(ticks); wheel.classList.remove('spinning'); label.textContent = String(play.number); finishCasino(play, 'roulette'); }, 1750);
}
// Máquinas: los emojis pasan y cambian como si giraran; cada rodillo frena por separado.
function spinSlots(play) {
    const reels = document.getElementById('slot-reels'), nodes = [...reels.children], stopAt = [900, 1500, 2100], stopped = [false, false, false], started = performance.now();
    reels.classList.add('spinning');
    nodes.forEach((node) => { node.classList.remove('stopped'); node.classList.add('rolling'); });
    const ticks = setInterval(() => casinoSound('tick'), 130);
    const timer = setInterval(() => {
        const elapsed = performance.now() - started;
        nodes.forEach((node, index) => {
            if (stopped[index]) return;
            if (elapsed >= stopAt[index]) { stopped[index] = true; node.textContent = play.reels[index]; node.classList.remove('rolling'); node.classList.add('stopped'); casinoSound('card'); }
            else node.textContent = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
        });
        if (stopped.every(Boolean)) { clearInterval(timer); clearInterval(ticks); reels.classList.remove('spinning'); setTimeout(() => finishCasino(play, 'slots'), 350); }
    }, 70);
}
function startCasinoGame(game) {
    if (casinoBusy) return;
    let play;
    if (game === 'roulette') play = window.HatitixCasino?.roulette?.(casinoAmount('roulette-amount'), { color: document.getElementById('roulette-color')?.value || '', number: document.getElementById('roulette-number')?.value ?? '' });
    if (game === 'slots') play = window.HatitixCasino?.slots?.(casinoAmount('slots-amount'));
    if (!play?.ok) return casinoMessage(play?.message || 'El casino no está disponible.', 'lose');
    casinoBusy = true; setCasinoButtons(true);
    casinoMessage(game === 'roulette' ? 'La ruleta está girando…' : 'Las máquinas están rodando…');
    if (game === 'roulette') spinRoulette(play);
    if (game === 'slots') spinSlots(play);
}
document.querySelectorAll('.casino-play').forEach((button) => button.addEventListener('click', () => startCasinoGame(button.dataset.casinoGame)));

// Blackjack: Iniciar → Pedir carta / Quedarse / Duplicar.
function renderBlackjack(state) {
    const dealer = document.getElementById('blackjack-dealer'), player = document.getElementById('blackjack-player');
    if (!state) { dealer.textContent = 'Banca: —'; player.textContent = 'Vos: —'; }
    else {
        dealer.textContent = `Banca: ${state.dealer.map(casinoFormatCard).join(' · ')}${state.dealerHidden ? ' · 🂠' : ''} (${state.dealerTotal}${state.dealerHidden ? ' + ?' : ''})`;
        player.textContent = `Vos: ${state.player.map(casinoFormatCard).join(' · ')} (${state.playerTotal})${state.doubled ? ' · duplicada' : ''}`;
    }
    const playing = !!state && !state.finished;
    document.getElementById('bj-start').disabled = playing;
    document.getElementById('bj-hit').disabled = !playing;
    document.getElementById('bj-stand').disabled = !playing;
    document.getElementById('bj-double').disabled = !playing || !state.canDouble;
    document.getElementById('blackjack-amount').disabled = playing;
}
function blackjackStep(state) {
    if (!state?.ok) return casinoMessage(state?.message || 'El casino no está disponible.', 'lose');
    renderBlackjack(state); casinoSound('card'); renderCasino();
    if (!state.finished) return casinoMessage('Tu turno: pedí carta, quedate o duplicá.');
    const delta = state.delta, text = {
        blackjack: `¡Blackjack! Ganaste +${delta} Titipoints.`, win: `¡Ganaste +${delta} Titipoints!`,
        push: 'Empate: te devuelven la apuesta.', lose: `Perdiste ${state.stake} Titipoints.`
    }[state.outcome] || 'Mano terminada.';
    casinoMessage(`${text} Saldo: ${state.balance}.`, delta > 0 ? 'win' : delta === 0 ? '' : 'lose');
    casinoSound(delta > 0 ? 'win' : delta === 0 ? 'card' : 'lose');
}
document.getElementById('bj-start')?.addEventListener('click', () => blackjackStep(window.HatitixCasino?.blackjack?.start(casinoAmount('blackjack-amount'))));
document.getElementById('bj-hit')?.addEventListener('click', () => blackjackStep(window.HatitixCasino?.blackjack?.hit()));
document.getElementById('bj-stand')?.addEventListener('click', () => blackjackStep(window.HatitixCasino?.blackjack?.stand()));
document.getElementById('bj-double')?.addEventListener('click', () => blackjackStep(window.HatitixCasino?.blackjack?.double()));
renderBlackjack(null);
renderCasino();
window.addEventListener('hatitix:stats-updated', renderCasino);
document.getElementById('messages-open-inbox')?.addEventListener('click', () => document.getElementById('r-msgs')?.click());
document.getElementById('messages-create-group')?.addEventListener('click', () => document.getElementById('r-create-group')?.click());
document.getElementById('messages-create-party')?.addEventListener('click', () => document.getElementById('r-party')?.click());
document.getElementById('messages-invite-party')?.addEventListener('click', () => document.getElementById('g-party-invite')?.click());
const TROPHIES = [
    { name: 'Primer Gol', desc: 'Marca tu primer gol.', icon: '⚽', unlocked: (p) => p.goals >= 1 },
    { name: 'Hat-Trick', desc: 'Alcanza 3 goles.', icon: '🎩', unlocked: (p) => p.goals >= 3 },
    { name: 'Goleador', desc: 'Alcanza 100 goles.', icon: '🔥', unlocked: (p) => p.goals >= 100 },
    { name: 'Veterano', desc: 'Juega al menos 10 horas.', icon: '⏱️', unlocked: (p) => p.playSeconds >= 36000 },
    { name: 'Punto de Oro', desc: 'Llega a 1.000 puntos.', icon: '💎', unlocked: (p) => p.points >= 1000 },
    { name: 'Millonario', desc: 'Acumula 10.000 puntos.', icon: '💰', unlocked: (p) => p.points >= 10000 }
];
function renderTrophies() {
    const grid = $('#trophies-grid'); if (!grid) return;
    let progress = {}; try { progress = JSON.parse(localStorage.getItem('hatitix-player-stats') || '{}') || {}; } catch (_) {}
    grid.replaceChildren(...TROPHIES.map((trophy) => {
        const unlocked = !!trophy.unlocked(progress), card = document.createElement('article');
        card.className = 'shop-item'; card.style.opacity = unlocked ? '1' : '.4'; card.style.filter = unlocked ? 'none' : 'grayscale(1)';
        const icon = document.createElement('div'); icon.style.cssText = 'font-size:50px;text-align:center;margin-bottom:10px'; icon.textContent = unlocked ? trophy.icon : '🔒';
        const title = document.createElement('h3'); title.textContent = trophy.name; title.style.textAlign = 'center';
        const desc = document.createElement('p'); desc.textContent = trophy.desc; desc.style.textAlign = 'center';
        const status = document.createElement('div'); status.className = 'shop-price'; status.style.cssText = `text-align:center;color:${unlocked ? 'var(--accent)' : 'var(--muted)'}`; status.textContent = unlocked ? '¡DESBLOQUEADO!' : 'BLOQUEADO';
        card.append(icon, title, desc, status); return card;
    }));
}

async function renderReplays() {
    const list = $('#replay-list'), status = $('#replay-status');
    const pasitos = localStorage.getItem('hatitix-pasitos-mode') === '1';
    const replayNoun = pasitos ? 'repeticiones de pasitos' : 'repeticiones';
    list.replaceChildren();
    try {
        const replays = await hatitix.listReplays();
        if (!replays.length) {
            status.textContent = `0 ${replayNoun}`;
            const empty = document.createElement('p'); empty.className = 'muted';
            empty.textContent = `Todavía no hay ${replayNoun} guardadas. Graba una partida o importa un archivo .hbr2.`;
            list.append(empty); return;
        }
        for (const replay of replays) {
            const card = document.createElement('article'); card.className = 'replay-card';
            const title = document.createElement('h3'); title.textContent = replay.name || 'Partida';
            const details = document.createElement('small');
            const date = new Date(replay.createdAt).toLocaleString('es-AR');
            const size = Math.max(1, Math.round((replay.size || 0) / 1024));
            details.textContent = `${date} · ${size >= 1024 ? `${(size / 1024).toFixed(1)} MB` : `${size} KB`}`;
            const actions = document.createElement('div'); actions.className = 'replay-actions';
            const play = Object.assign(document.createElement('button'), { className: 'btn main', textContent: '▶ Reproducir' });
            play.onclick = () => {
                if (window.HX?.playReplay) window.HX.playReplay(replay.id, replay.name || 'Partida');
                else status.textContent = 'El reproductor no está disponible. Reinicia HaTitiX y vuelve a intentarlo.';
            };
            const exportButton = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Exportar .hbr2' });
            exportButton.onclick = async () => {
                try {
                    const bytes = await hatitix.readReplay(replay.id), url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
                    const a = document.createElement('a'); a.href = url; a.download = `${replay.name || 'haTitix'}.hbr2`; a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                } catch (error) { status.textContent = error.message; }
            };
            const remove = Object.assign(document.createElement('button'), { className: 'btn danger', textContent: 'Eliminar' });
            remove.onclick = async () => {
                if (!confirm(`¿Eliminar la repetición “${replay.name || 'Partida'}”?`)) return;
                try { await hatitix.deleteReplay(replay.id); await renderReplays(); }
                catch (error) { status.textContent = error.message; }
            };
            actions.append(play, exportButton, remove); card.append(title, details, actions); list.append(card);
        }
        status.textContent = `${replays.length} ${pasitos ? `${replays.length === 1 ? 'repetición' : 'repeticiones'} de pasitos` : `repetición${replays.length === 1 ? '' : 'es'}`}`;
    } catch (error) { status.textContent = error.message || 'No se pudo leer la biblioteca.'; }
}
window.addEventListener('hatitix:labels-changed', () => {
    if (!$('#page-repeticiones').classList.contains('hidden')) renderReplays();
});

$('#replay-refresh').onclick = renderReplays;
$('#replay-import-file').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const status = $('#replay-status');
    try {
        await hatitix.saveReplay(new Uint8Array(await file.arrayBuffer()), { name: file.name.replace(/\.hbr2$/i, '') });
        status.textContent = 'Repetición importada.';
        await renderReplays();
    } catch (error) { status.textContent = error.message || 'No se pudo importar el archivo.'; }
    event.target.value = '';
};


// Amigos globales de HaTitix: se buscan por ID único y la amistad requiere aceptación.
async function renderFriends() {
    const list = $('#friends-list'), requestsBox = $('#friend-requests'), status = $('#friends-status');
    if (!list || !requestsBox || !status) return;
    const accounts = window.HatitixAccounts;
    list.replaceChildren(); requestsBox.replaceChildren();
    if (!accounts?.getUser()) {
        status.textContent = 'Inicia sesión en tu cuenta HaTitix para gestionar amistades.';
        return;
    }
    status.textContent = 'Cargando amigos y solicitudes…';
    try {
        const [friendsResult, requestResult] = await Promise.all([
            accounts.api('/api/friends'), accounts.api('/api/friends/requests')
        ]);
        const section = (title) => {
            const wrap = document.createElement('div'); wrap.className = 'friend-requests';
            const heading = document.createElement('h3'); heading.textContent = title; wrap.append(heading);
            return wrap;
        };
        const incomingBox = section('Solicitudes recibidas');
        for (const request of requestResult.incoming) {
            const row = document.createElement('div'); row.className = 'prow';
            const label = Object.assign(document.createElement('b'), { textContent: `${request.user.tag} quiere ser tu amigo` });
            const accept = Object.assign(document.createElement('button'), { className: 'btn main', textContent: 'Aceptar' });
            accept.onclick = async () => { try { await accounts.api(`/api/friends/requests/${request.id}/accept`, { method: 'POST', body: '{}' }); await renderFriends(); } catch (e) { status.textContent = e.message; } };
            const reject = Object.assign(document.createElement('button'), { className: 'btn danger', textContent: 'Rechazar' });
            reject.onclick = async () => { try { await accounts.api(`/api/friends/requests/${request.id}/reject`, { method: 'POST', body: '{}' }); await renderFriends(); } catch (e) { status.textContent = e.message; } };
            row.append(label, accept, reject); incomingBox.append(row);
        }
        if (!requestResult.incoming.length) incomingBox.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No tienes solicitudes recibidas.' }));
        const outgoingBox = section('Solicitudes enviadas');
        for (const request of requestResult.outgoing) {
            const row = document.createElement('div'); row.className = 'prow';
            row.append(Object.assign(document.createElement('span'), { textContent: `${request.user.tag} · pendiente de respuesta` }));
            outgoingBox.append(row);
        }
        if (!requestResult.outgoing.length) outgoingBox.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No tienes solicitudes pendientes.' }));
        requestsBox.append(incomingBox, outgoingBox);

        for (const friend of friendsResult.friends) {
            const card = document.createElement('article'); card.className = 'friend-card friend-card-click'; card.title = 'Ver perfil'; accounts.cosmetics?.apply(card, friend, .6);
            card.onclick = () => window.HatitixSocial?.openProfile(friend);
            const heading = document.createElement('b'); heading.textContent = `${friend.crown ? '👑' : '👽'} ${friend.displayName}`;
            const presence = window.HatitixPins ? window.HatitixPins.presenceNode(friend) : document.createTextNode('');
            const pins = Object.assign(document.createElement('div'), { className: 'hx-pins' }); window.HatitixPins?.fillPins(pins, friend.pins);
            const tag = document.createElement('div'); tag.className = 'friend-account-tag'; tag.textContent = `${friend.tag}${friend.haxballName ? ` · Haxball: ${friend.haxballName}` : ''}`;
            const actions = document.createElement('div'); actions.className = 'bottom';
            const invite = Object.assign(document.createElement('button'), { className: 'btn main', textContent: '🔗 Compartir enlace de sala' });
            invite.onclick = async (ev) => {
                ev.stopPropagation();
                const link = HX.shareCurrentRoom?.();
                if (!link) { status.textContent = 'Primero crea o entra a una sala.'; return; }
                try { await navigator.clipboard.writeText(link); status.textContent = `Enlace copiado. Envíalo a ${friend.tag}.`; }
                catch (_) { status.textContent = link; }
            };
            const remove = Object.assign(document.createElement('button'), { className: 'btn danger', textContent: 'Quitar amigo' });
            remove.onclick = async (ev) => {
                ev.stopPropagation();
                if (!confirm(`¿Quitar a ${friend.tag} de tus amigos?`)) return;
                try { await accounts.api(`/api/friends/${friend.id}`, { method: 'DELETE' }); await renderFriends(); }
                catch (e) { status.textContent = e.message; }
            };
            const message = Object.assign(document.createElement('button'), { className: 'btn', textContent: '💬 Mensaje' });
            message.onclick = (ev) => { ev.stopPropagation(); window.HatitixSocial?.openChat(friend); };
            const unread = window.HatitixSocial?.unreadFor(friend.id) || 0;
            if (unread) message.textContent = `💬 Mensaje (${unread})`;
            actions.append(message, invite, remove); card.append(heading, presence, tag, pins, actions); list.append(card);
        }
        if (!friendsResult.friends.length) list.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Todavía no tienes amigos aceptados.' }));
        status.textContent = `Amigos: ${friendsResult.friends.length} · ID de tu cuenta: ${accounts.getUser().tag}`;
    } catch (error) { status.textContent = error.message || 'No se pudo conectar con el servicio de cuentas.'; }
}
$('#friend-add').onclick = async () => {
    const accounts = window.HatitixAccounts, status = $('#friends-status'), tag = $('#friend-name').value.trim();
    if (!accounts?.requireAccount()) return;
    if (!tag) { status.textContent = 'Escribe el ID completo, por ejemplo Nombre#1234.'; return; }
    try {
        await accounts.api('/api/friends/requests', { method: 'POST', body: JSON.stringify({ tag }) });
        $('#friend-name').value = ''; status.textContent = `Solicitud enviada a ${tag}. Cuando la acepte aparecerá en tu lista de amigos.`; await renderFriends();
    } catch (error) { status.textContent = error.message; }
};
$('#friend-name').addEventListener('keydown', (e) => e.key === 'Enter' && $('#friend-add').click());
$('#friend-invite-current').onclick = async () => { const url = HX.shareCurrentRoom?.(); if (!url) { $('#friends-status').textContent = 'Primero crea o entra a una sala.'; return; } try { await navigator.clipboard.writeText(url); $('#friends-status').textContent = 'Enlace de sala copiado. Compártelo con tus amigos.'; } catch { $('#friends-status').textContent = url; } };
window.addEventListener('hatitix:account-changed', () => { if (!$('#page-amigos').classList.contains('hidden')) renderFriends(); });
// Ranking de amigos sincronizado; si el servidor aún no tiene la ruta, conserva el ranking local.
let remoteRanking = null;
let rankingError = '';
let rankingMode = 'public';
function rankingEntries() {
    const saved = store.get('hatitix-ranking-v1', {}), current = P.activeId || 'guest';
    const names = new Map(P.profiles.map((profile) => [profile.id, profile.name]));
    const entries = Object.entries(saved).map(([id, value]) => ({ id, name: names.get(id) || value.name || 'Perfil alien', goals: Number(value.goals) || 0, hours: Number(value.hours) || 0 }));
    // Mostrar también perfiles que todavía no tienen partidas registradas, en vez de
    // quedarnos únicamente con el primer perfil que inició sesión.
    for (const profile of P.profiles) {
        if (!entries.some((entry) => entry.id === profile.id)) entries.push({ id: profile.id, name: profile.name || 'Perfil alien', goals: 0, hours: 0 });
    }
    if (!entries.some((entry) => entry.id === current)) {
        const progress = store.get('hatitix-player-stats', {});
        entries.push({ id: current, name: names.get(current) || 'Mi alien', goals: Number(progress.goals) || 0, hours: (Number(progress.playSeconds) || 0) / 3600 });
    }
    return entries;
}
function renderRanking() {
    const accountId = window.HatitixAccounts?.getUser?.()?.id;
    const isMe = (entry) => remoteRanking !== null ? (!!accountId && entry.id === accountId) : entry.id === P.activeId;
    const render = (target, entries, field, format) => {
        if (!target) return;
        // Se muestran TODOS los registrados (hasta 100); a igualdad de valor se ordena por nombre.
        const sorted = [...entries].sort((a, b) => (b[field] - a[field]) || String(a.name).localeCompare(String(b.name), 'es')).slice(0, 100);
        target.replaceChildren(...(sorted.length ? sorted : [{ id: '', name: 'Todavía no hay datos', [field]: 0 }]).map((entry, index) => {
            const row = document.createElement('div'); row.className = 'ranking-row' + (isMe(entry) ? ' me' : '');
            const rank = Object.assign(document.createElement('span'), { className: 'rank', textContent: String(index + 1) });
            const name = Object.assign(document.createElement('span'), { textContent: `${isMe(entry) ? '👽 ' : ''}${entry.name}` });
            const value = Object.assign(document.createElement('span'), { className: 'value', textContent: format(entry[field]) });
            row.append(rank, name, value);
            return row;
        }));
    };
    const entries = remoteRanking !== null ? remoteRanking : rankingEntries();
    render($('#ranking-goals'), entries, 'goals', (v) => `${Math.round(v).toLocaleString('es-AR')} ⚽`);
    render($('#ranking-hours'), entries, 'hours', (v) => `${Number(v).toFixed(1)} h 🚀`);
    const status = $('#ranking-status');
    if (status) status.textContent = rankingError ? rankingError : remoteRanking !== null ? `${remoteRanking.length} jugador(es) ${rankingMode === 'friends' ? 'entre tú y tus amigos' : 'registrados en HaTitix'}.` : '';
}
async function refreshRemoteRanking() {
    const accounts = window.HatitixAccounts;
    if (!accounts?.getUser?.()) { remoteRanking = null; rankingError = ''; renderRanking(); return; }
    const endpoint = rankingMode === 'friends' ? '/api/ranking/friends' : '/api/ranking/global';
    try {
        const result = await accounts.api(endpoint);
        remoteRanking = (result.entries || []).map((entry) => ({
            id: entry.id, name: entry.name || entry.tag || 'Jugador',
            goals: Number(entry.goals) || 0, hours: Number(entry.hours) || 0
        }));
        rankingError = '';
        renderRanking();
    } catch (error) { remoteRanking = null; rankingError = 'No se pudo cargar el ranking del servidor; se muestran los datos de este dispositivo.'; renderRanking(); }
}
setInterval(() => { if (!document.getElementById('page-estadisticas')?.classList.contains('hidden')) refreshRemoteRanking(); }, 20000);
function setRankingMode(mode) {
    rankingMode = mode;
    $('#btn-rank-public')?.classList.toggle('main', mode === 'public');
    $('#btn-rank-friends')?.classList.toggle('main', mode === 'friends');
    remoteRanking = null;
    renderRanking();
    refreshRemoteRanking();
}
$('#btn-rank-public')?.addEventListener('click', () => setRankingMode('public'));
$('#btn-rank-friends')?.addEventListener('click', () => setRankingMode('friends'));
$('.navb[data-page="estadisticas"]')?.addEventListener('click', refreshRemoteRanking);
window.addEventListener('hatitix:stats-updated', () => { renderRanking(); if (P.draft) previewCosmetics(P.draft.id); });
window.addEventListener('hatitix:account-changed', () => refreshRemoteRanking());

// ---------- Perfiles ----------
const FLAGS = ('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gt gu gw gy hk hn hr ht hu id ie il im in iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg si sk sl sm sn so sr ss st sv sx sy sz tc td tg th tj tk tl tm tn to tr tt tv tw tz ua ug us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw gb-eng gb-sct gb-wls').split(' ');
const P = { profiles: [], activeId: null, draft: null };
const newDraft = () => ({ id: Math.random().toString(36).slice(2, 10), name: '', avatar: '', flag: '', extrapolation: null });
const flagImg = (value) => {
    const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const image = document.createElement('img');
    image.alt = code;
    image.loading = 'lazy';
    image.decoding = 'async';
    if (!/^[a-z]{2}(?:-[a-z]{3})?$/.test(code)) return image;
    image.src = `https://flagcdn.com/w40/${encodeURIComponent(code)}.png`;
    image.onerror = () => { image.removeAttribute('src'); image.hidden = true; };
    return image;
};

// El banner, color y tipografía viven en la CUENTA HaTitix (se editan en CUENTA y los ven tus amigos).
const getCosmetics = () => { const u = window.HatitixAccounts?.getUser?.(); return { color: u?.bannerColor || '#193b2a', font: u?.fontStyle || 'system', banner: u?.bannerUrl || '' }; };
const AVATAR_GIF_KEY = 'hatitix-avatar-gif';
const hasShopItem = (itemId) => store.get('hatitix-shop-unlocked', []).includes(itemId);
// El avatar GIF es único y pertenece al perfil activo; se gestiona en Ajustes → Personalización.
const avatarGifFor = (profileId) => (hasShopItem('unlock-avatar-gif') && profileId && profileId === P.activeId) ? (localStorage.getItem(AVATAR_GIF_KEY) || '') : '';
function previewCosmetics() {
    const hero = $('#p-profile-hero'), heroAvatar = $('#p-profile-hero-avatar'), heroName = $('#p-profile-hero-name'), heroLabel = $('#p-profile-hero-banner-label');
    if (!hero || !P.draft) return;
    const account = window.HatitixAccounts?.getUser?.();
    if (account && window.HatitixAccounts.cosmetics) window.HatitixAccounts.cosmetics.apply(hero, account, .52);
    else { hero.style.backgroundColor = '#193b2a'; hero.style.backgroundImage = 'linear-gradient(120deg,#193b2a,#0c1110)'; hero.style.fontFamily = ''; }
    heroName.style.fontFamily = heroLabel.style.fontFamily = heroAvatar.style.fontFamily = hero.style.fontFamily;
    const progress = store.get('hatitix-player-stats', {}), banner = account?.bannerUrl || '';
    heroName.textContent = P.draft.name || 'Mi alien';
    heroLabel.textContent = `${Number(progress.points) || 0} 👽 Titipoints · ${banner ? (banner.startsWith('data:image/gif') || /\.gif(\?|$)/i.test(banner) ? '🎞️ Banner GIF' : '🖼️ Banner personalizado') : (account ? 'Cambia tu banner en CUENTA' : 'Inicia sesión para personalizar')}`;
    heroAvatar.replaceChildren();
    const heroGif = avatarGifFor(P.draft.id);
    if (heroGif) { const image = Object.assign(document.createElement('img'), { src: heroGif, alt: 'GIF de avatar' }); heroAvatar.append(image); }
    else {
        const characterPhoto = localStorage.getItem('hatitix-custom-me') || '';
        if (characterPhoto) { const image = Object.assign(document.createElement('img'), { src: characterPhoto, alt: 'Foto del personaje' }); heroAvatar.append(image); }
        else heroAvatar.textContent = P.draft.avatar || '👽';
    }
}
window.addEventListener('hatitix:account-changed', () => { if (P.draft) previewCosmetics(); });
function pmsg(t) { $('#p-msg').textContent = t; }

function renderProfiles() {
    const d = P.draft;
    $('#plist').replaceChildren(...P.profiles.map((p) => {
        const c = document.createElement('div');
        c.className = 'pcard' + (p.id === d.id ? ' sel' : '');
        const av = Object.assign(document.createElement('div'), { className: 'av', textContent: p.avatar });
        const cardGif = avatarGifFor(p.id);
        if (cardGif) { const avatarImg = Object.assign(document.createElement('img'), { src: cardGif, alt: 'GIF de avatar' }); avatarImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%'; av.textContent=''; av.append(avatarImg); }
        const info = document.createElement('div');
        const b = Object.assign(document.createElement('b'), { textContent: p.name });
        info.append(b);
        if (p.flag) info.append(flagImg(p.flag));
        c.append(av, info);
        if (p.id === P.activeId) c.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: '● ACTIVO' }));
        c.onclick = () => { P.draft = { ...p }; pmsg(''); renderProfiles(); previewCosmetics(p.id); };
        return c;
    }));
    const saved = P.profiles.some((p) => p.id === d.id);
    $('#p-title').textContent = saved ? d.name : 'Nuevo perfil';
    $('#p-name').value = d.name;
    $('#p-avatar').value = d.avatar;
    $('#p-extra').value = d.extrapolation ?? '';
    $('#p-delete').style.display = saved ? '' : 'none';
    document.querySelectorAll('#flags button').forEach((b) => b.classList.toggle('on', b.dataset.flag === d.flag));
    previewCosmetics(d.id);
}

function buildFlags() {
    const mk = (code, content) => {
        const b = document.createElement('button');
        b.dataset.flag = code;
        b.title = code ? countryName(code.slice(0, 2)) : 'Automática';
        b.append(content);
        b.onclick = () => { P.draft.flag = code; renderProfiles(); };
        return b;
    };
    $('#flags').replaceChildren(mk('', 'AUTO'), ...FLAGS.map((c) => mk(c, flagImg(c))));
}

async function persist(activate) {
    const d = P.draft;
    d.name = $('#p-name').value.trim();
    d.avatar = $('#p-avatar').value;
    const ex = $('#p-extra').value;
    d.extrapolation = ex === '' ? null : Number(ex);
    if (!d.name) return pmsg('Poné un nombre.');
    // Nombre único: lo reserva el relay para este dispositivo (sin distinguir mayúsculas).
    const previousName = (P.profiles.find((p) => p.id === d.id) || {}).name;
    pmsg('Verificando nombre…');
    const claim = await window.HatitixNames.claim(d.name);
    if (claim.status === 409 || claim.error === 'name_taken') return pmsg(`El nombre “${d.name}” ya está en uso. Elegí otro.`);
    if (claim.status === 400 || claim.error === 'invalid') return pmsg('Nombre inválido: usá entre 1 y 24 caracteres, sin < ni >.');
    const unverified = !claim.ok;
    if (claim.ok) {
        d.name = claim.name || d.name;
        const stillUsed = P.profiles.some((p) => p.id !== d.id && (p.name || '').trim().toLowerCase() === (previousName || '').trim().toLowerCase());
        if (previousName && previousName.trim().toLowerCase() !== d.name.toLowerCase() && !stillUsed) window.HatitixNames.release(previousName);
    }
    const profiles = [...P.profiles];
    const i = profiles.findIndex((p) => p.id === d.id);
    i < 0 ? profiles.push(d) : (profiles[i] = d);
    const res = await hatitix.saveProfiles({ profiles, activeId: activate || !P.activeId ? d.id : P.activeId });
    Object.assign(P, res);
    P.draft = { ...(P.profiles.find((p) => p.id === d.id) || newDraft()) };
    localStorage.setItem('hatitix-active-profile', JSON.stringify({ id: P.activeId, name: P.draft.name }));
    pmsg((activate ? 'Guardado y activado ✓' : 'Guardado ✓') + (unverified ? ' (no se pudo verificar que el nombre sea único: el servidor no respondió)' : ''));
    renderProfiles();
    window.dispatchEvent(new Event('hatitix:active-profile-changed'));
}

$('#p-new').onclick = () => { P.draft = newDraft(); pmsg(''); renderProfiles(); previewCosmetics(P.draft.id); };
$('#p-save').onclick = () => persist(false);
$('#p-activate').onclick = () => persist(true);
$('#p-delete').onclick = async () => {
    const removed = P.profiles.find((p) => p.id === P.draft.id);
    if (removed && !P.profiles.some((p) => p.id !== removed.id && (p.name || '').toLowerCase() === (removed.name || '').toLowerCase())) window.HatitixNames.release(removed.name);
    const res = await hatitix.saveProfiles({ profiles: P.profiles.filter((p) => p.id !== P.draft.id), activeId: P.activeId });
    Object.assign(P, res);
    P.draft = P.profiles[0] ? { ...P.profiles[0] } : newDraft();
    renderProfiles();
};

// ---------- Avatar GIF (Ajustes → Personalización) ----------
function refreshAvatarGifSetting() {
    const unlocked = hasShopItem('unlock-avatar-gif');
    $('#avatar-gif-setting').classList.toggle('hidden', !unlocked);
    const gif = unlocked ? (localStorage.getItem(AVATAR_GIF_KEY) || '') : '';
    const preview = $('#preview-avatar-gif');
    if (gif) preview.src = gif; else preview.removeAttribute('src');
    preview.classList.toggle('hidden', !gif);
}
$('#s-avatar-gif').addEventListener('change', (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (!hasShopItem('unlock-avatar-gif')) return;
    if (file.type !== 'image/gif' || file.size > 1024 * 1024) { alert('El avatar debe ser un .gif de hasta 1 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
        try { localStorage.setItem(AVATAR_GIF_KEY, String(reader.result)); }
        catch (_) { alert('No hay espacio para guardar ese GIF. Probá con uno más liviano.'); return; }
        refreshAvatarGifSetting(); renderProfiles(); window.dispatchEvent(new Event('hatitix:character-photo-changed'));
    };
    reader.readAsDataURL(file);
});
$('#clear-avatar-gif').addEventListener('click', () => { localStorage.removeItem(AVATAR_GIF_KEY); refreshAvatarGifSetting(); renderProfiles(); window.dispatchEvent(new Event('hatitix:character-photo-changed')); });
refreshAvatarGifSetting();
window.addEventListener('hatitix:profile-unlocks-changed', refreshAvatarGifSetting);

P.draft = newDraft();
buildFlags();
hatitix.loadProfiles().then((d) => {
    Object.assign(P, d);
    P.draft = P.profiles.find((p) => p.id === P.activeId) ? { ...P.profiles.find((p) => p.id === P.activeId) } : newDraft();
    if (P.activeId) localStorage.setItem('hatitix-active-profile', JSON.stringify({ id: P.activeId, name: P.draft.name }));
    renderProfiles();
    window.dispatchEvent(new Event('hatitix:active-profile-changed'));
});
renderProfiles();
window.addEventListener('hatitix:profile-unlocks-changed', () => previewCosmetics(P.draft.id));
window.addEventListener('hatitix:character-photo-changed', () => previewCosmetics(P.draft.id));
renderRanking();
refreshRemoteRanking();

render();
refresh();
setInterval(refresh, 30000);
