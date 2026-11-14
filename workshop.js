(() => {
    'use strict';
    const $ = (selector) => document.querySelector(selector);
    const workshop = $('#workshop-menu');
    const community = $('#modal-community-maps');
    const list = $('#community-maps-list');
    const status = $('#community-maps-status');
    const uploadInput = $('#upload-map-file');
    const hidden = (element) => !element || element.classList.contains('hidden');
    const closeCommunity = () => community?.classList.add('hidden');
    const closeWorkshop = () => workshop?.classList.add('hidden');
    const openWorkshop = () => { closeCommunity(); workshop?.classList.remove('hidden'); };
    const safeFilename = (name) => String(name || 'mapa').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 60) || 'mapa';
    const validStadium = (value) => {
        let stadium = value;
        if (typeof stadium === 'string') stadium = JSON.parse(stadium);
        if (!stadium || typeof stadium !== 'object' || !Array.isArray(stadium.vertexes) || !Array.isArray(stadium.segments)) throw new Error('El archivo no tiene un estadio Haxball válido.');
        return stadium;
    };
    function setStatus(message, isError = false) {
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('community-status-error', isError);
    }
    function downloadMap(name, data) {
        const stadium = validStadium(data);
        const blob = new Blob([JSON.stringify(stadium, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = `${safeFilename(name)}.hbs`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
    function showMapsMessage(message) {
        const note = document.createElement('div'); note.className = 'community-maps-empty'; note.textContent = message; list.replaceChildren(note);
    }
    async function publishMapToCommunity(name, data, saveLocalCopy = false) {
        const accounts = window.HatitixAccounts;
        if (!accounts?.getUser?.()) {
            setStatus('Inicia sesión en CUENTA para publicar mapas.', true);
            closeCommunity(); accounts?.show?.(); return false;
        }
        try {
            const stadium = validStadium(data);
            await accounts.api('/api/maps/upload', {
                method: 'POST',
                body: JSON.stringify({ name: String(name || 'Mapa').slice(0, 50), data: JSON.stringify(stadium) })
            });
            if (saveLocalCopy) {
                try { await window.hatitix.saveMap(JSON.stringify(stadium), { name }); }
                catch (_) { /* publicar online no depende de si ya existe una copia local */ }
            }
            await loadCommunityMaps();
            setStatus(`«${name}» publicado en la comunidad.`);
            return true;
        } catch (error) {
            const message = [404, 405].includes(error.status)
                ? 'No se publicó: el relay todavía no tiene habilitada la ruta /api/maps/upload.'
                : `No se pudo publicar el mapa: ${error.message || 'error'}`;
            setStatus(message, true); return false;
        }
    }
    function makeMapCard(map) {
        const row = document.createElement('article'); row.className = 'community-map-row';
        const details = document.createElement('div'); details.className = 'community-map-details';
        const name = document.createElement('strong'); name.textContent = map.name || 'Mapa sin nombre';
        const author = document.createElement('small'); author.textContent = map.source === 'online' ? `Comunidad · ${map.author || 'Jugador'}` : 'Guardado en este dispositivo';
        details.append(name, author);
        const actions = document.createElement('div'); actions.className = 'community-map-actions';
        const store = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: map.source === 'local' ? 'Ya está en /store' : 'Guardar en /store', disabled: map.source === 'local' });
        store.addEventListener('click', async () => {
            try {
                if (map.source !== 'online' || !/^[0-9a-f-]{36}$/i.test(map.id)) throw new Error('No se pudo identificar el mapa online.');
                const result = await window.HatitixAccounts.api(`/api/maps/download/${encodeURIComponent(map.id)}`);
                const stadium = validStadium(result.data);
                const saved = await window.hatitix.saveMap(JSON.stringify(stadium), { name: map.name });
                await loadCommunityMaps();
                setStatus(saved.duplicate ? `«${map.name}» ya estaba guardado en /store.` : `«${map.name}» guardado en /store.`);
            } catch (error) { setStatus(`No se pudo guardar el mapa en /store: ${error.message || 'error'}`, true); }
        });
        const publish = Object.assign(document.createElement('button'), { type: 'button', className: 'btn main', textContent: 'Publicar en comunidad' });
        publish.addEventListener('click', () => publishMapToCommunity(map.name, map.stadium));
        const download = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Descargar .hbs' });
        download.addEventListener('click', async () => {
            try {
                let data = map.stadium;
                if (map.source === 'online') {
                    if (!/^[0-9a-f-]{36}$/i.test(map.id)) throw new Error('ID de mapa no válido.');
                    const result = await window.HatitixAccounts.api(`/api/maps/download/${encodeURIComponent(map.id)}`);
                    data = result.data;
                    try { await window.hatitix.saveMap(data, { name: map.name }); } catch (_) { /* ya guardado o biblioteca local no disponible */ }
                }
                downloadMap(map.name, data);
                setStatus(`Descargando «${map.name}» como archivo .hbs.`);
            } catch (error) { setStatus(`No se pudo descargar el mapa: ${error.message || 'error'}`, true); }
        });
        const load = Object.assign(document.createElement('button'), { type: 'button', className: 'btn main', textContent: 'Cargar en sala' });
        load.addEventListener('click', async () => {
            try {
                let data = map.stadium;
                if (map.source === 'online') {
                    if (!/^[0-9a-f-]{36}$/i.test(map.id)) throw new Error('ID de mapa no válido.');
                    const result = await window.HatitixAccounts.api(`/api/maps/download/${encodeURIComponent(map.id)}`);
                    data = result.data;
                }
                const stadium = validStadium(data);
                const loaded = window.HatitixWorkshop?.loadStadium(stadium, map.name);
                if (loaded) closeCommunity();
            } catch (error) { setStatus(`No se pudo cargar el mapa: ${error.message || 'error'}`, true); }
        });
        if (map.source === 'local') actions.append(publish);
        actions.append(store, download, load); row.append(details, actions); return row;
    }
    async function loadAllOnlineMaps() {
        const maps = [], pageSize = 200;
        for (let page = 0; page < 500; page++) {
            const offset = page * pageSize;
            const result = await window.HatitixAccounts.api(`/api/maps/list?limit=${pageSize}&offset=${offset}`);
            const rows = Array.isArray(result.maps) ? result.maps : [];
            maps.push(...rows.map((map) => ({
                id: String(map.id || ''), name: String(map.name || 'Mapa'), author: String(map.author_name || map.author || 'Jugador'),
                source: 'online', stadium: null
            })));
            if (result.hasMore !== true && rows.length < pageSize) break;
            if (rows.length === 0) break;
            if (page === 499) throw new Error('La lista supera el máximo que se puede cargar de una vez.');
        }
        return maps;
    }
    async function loadCommunityMaps() {
        showMapsMessage('Cargando todos los mapas…'); setStatus('Mapas locales y de la comunidad.');
        const localRequest = window.hatitix?.listMaps?.() || Promise.resolve([]);
        const localMaps = await localRequest.catch(() => []);
        let onlineMaps = [], onlineAvailable = false;
        try {
            onlineMaps = await loadAllOnlineMaps();
            onlineAvailable = true;
        } catch (_) {
            setStatus('No hay conexión comunitaria todavía. Puedes gestionar tus mapas locales; el servidor debe tener habilitadas las rutas /api/maps.');
        }
        const local = localMaps.map((map) => ({ id: String(map.id || ''), name: String(map.name || 'Mapa'), source: 'local', stadium: map.stadium }));
        const maps = [...onlineMaps, ...local];
        if (!maps.length) {
            showMapsMessage(onlineAvailable ? 'Todavía no hay mapas compartidos. ¡Sube el primero!' : 'Todavía no hay mapas locales ni mapas comunitarios disponibles.');
            return;
        }
        list.replaceChildren(...maps.map(makeMapCard));
        if (onlineAvailable) setStatus(`${onlineMaps.length} mapa(s) de la comunidad y ${local.length} mapa(s) local(es).`);
    }
    $('#btn-community-maps')?.addEventListener('click', () => {
        closeWorkshop(); community?.classList.remove('hidden'); loadCommunityMaps();
    });
    $('#btn-close-workshop')?.addEventListener('click', closeWorkshop);
    $('#btn-close-community-maps')?.addEventListener('click', closeCommunity);
    $('#btn-refresh-community-maps')?.addEventListener('click', loadCommunityMaps);
    workshop?.addEventListener('click', (event) => { if (event.target === workshop) closeWorkshop(); });
    community?.addEventListener('click', (event) => { if (event.target === community) closeCommunity(); });
    $('#btn-haxmaps')?.addEventListener('click', () => window.hatitix?.openWorkshopBrowser?.('https://haxmaps.com/').catch((error) => setStatus(error.message || 'No se pudo abrir HaxMaps.', true)));
    $('#btn-haxcolors')?.addEventListener('click', () => window.hatitix?.openWorkshopBrowser?.('https://haxcolors.com/?lang=es').catch((error) => setStatus(error.message || 'No se pudo abrir HaxColors.', true)));
    uploadInput?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) return setStatus('El mapa supera el límite de 2 MB.', true);
        try {
            const text = await file.text(), stadium = validStadium(text);
            const name = file.name.replace(/\.(hbs|json)$/i, '').slice(0, 50) || 'Mapa';
            await publishMapToCommunity(name, stadium, true);
        } catch (error) { setStatus(`No se pudo leer el mapa: ${error.message || 'error'}`, true); }
    });
    document.addEventListener('keydown', (event) => {
        const communityOpen = !hidden(community), workshopOpen = !hidden(workshop);
        if (event.code === 'Escape' && (communityOpen || workshopOpen)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (communityOpen) { closeCommunity(); openWorkshop(); } else closeWorkshop();
            return;
        }
        if (event.shiftKey && event.code === 'Tab') {
            event.preventDefault(); event.stopImmediatePropagation();
            if (communityOpen) { closeCommunity(); openWorkshop(); }
            else if (workshopOpen) closeWorkshop();
            else openWorkshop();
        }
    }, true);
})();
