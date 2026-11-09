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
    $('#page-estadisticas').classList.toggle('hidden', p !== 'estadisticas');
    $('#page-misiones').classList.toggle('hidden', p !== 'misiones');
    $('#page-repeticiones').classList.toggle('hidden', p !== 'repeticiones');
    if (p === 'repeticiones') renderReplays();
    setView('lobby');
}
document.querySelectorAll('.navb[data-page]').forEach((b) => b.onclick = () => showPage(b.dataset.page));

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

function pmsg(t) { $('#p-msg').textContent = t; }

function renderProfiles() {
    const d = P.draft;
    $('#plist').replaceChildren(...P.profiles.map((p) => {
        const c = document.createElement('div');
        c.className = 'pcard' + (p.id === d.id ? ' sel' : '');
        const av = Object.assign(document.createElement('div'), { className: 'av', textContent: p.avatar });
        const info = document.createElement('div');
        const b = Object.assign(document.createElement('b'), { textContent: p.name });
        info.append(b);
        if (p.flag) info.append(flagImg(p.flag));
        c.append(av, info);
        if (p.id === P.activeId) c.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: '● ACTIVO' }));
        c.onclick = () => { P.draft = { ...p }; pmsg(''); renderProfiles(); };
        return c;
    }));
    const saved = P.profiles.some((p) => p.id === d.id);
    $('#p-title').textContent = saved ? d.name : 'Nuevo perfil';
    $('#p-name').value = d.name;
    $('#p-avatar').value = d.avatar;
    $('#p-extra').value = d.extrapolation ?? '';
    $('#p-delete').style.display = saved ? '' : 'none';
    document.querySelectorAll('#flags button').forEach((b) => b.classList.toggle('on', b.dataset.flag === d.flag));
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
    const profiles = [...P.profiles];
    const i = profiles.findIndex((p) => p.id === d.id);
    i < 0 ? profiles.push(d) : (profiles[i] = d);
    const res = await hatitix.saveProfiles({ profiles, activeId: activate || !P.activeId ? d.id : P.activeId });
    Object.assign(P, res);
    P.draft = { ...(P.profiles.find((p) => p.id === d.id) || newDraft()) };
    pmsg(activate ? 'Guardado y activado ✓' : 'Guardado ✓');
    renderProfiles();
}

$('#p-new').onclick = () => { P.draft = newDraft(); pmsg(''); renderProfiles(); };
$('#p-save').onclick = () => persist(false);
$('#p-activate').onclick = () => persist(true);
$('#p-delete').onclick = async () => {
    const res = await hatitix.saveProfiles({ profiles: P.profiles.filter((p) => p.id !== P.draft.id), activeId: P.activeId });
    Object.assign(P, res);
    P.draft = P.profiles[0] ? { ...P.profiles[0] } : newDraft();
    renderProfiles();
};

P.draft = newDraft();
buildFlags();
hatitix.loadProfiles().then((d) => {
    Object.assign(P, d);
    P.draft = P.profiles.find((p) => p.id === P.activeId) ? { ...P.profiles.find((p) => p.id === P.activeId) } : newDraft();
    renderProfiles();
});
renderProfiles();

render();
refresh();
setInterval(refresh, 30000);
