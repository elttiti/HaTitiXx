// Se ejecuta en Haxball (y sus iframes) antes que la página: aplica el perfil activo.
const { ipcRenderer } = require('electron');

try {
    if (/(^|\.)haxball\.com$/.test(location.hostname)) {
        const p = ipcRenderer.sendSync('profile:active');
        if (p) {
            const set = (k, v) => localStorage.setItem(k, String(v));
            if (p.name) set('player_name', p.name);
            if (p.avatar) set('avatar', p.avatar);
            if (p.extrapolation !== null) set('extrapolation', p.extrapolation);
            if (p.flag) {
                let geo = {};
                try { geo = JSON.parse(localStorage.getItem('geo')) || {}; } catch (_) { /* vacío */ }
                set('geo', JSON.stringify({ lat: geo.lat ?? 0, lon: geo.lon ?? 0, code: p.flag }));
            }
        }
    }
} catch (_) { /* nunca romper la página */ }
