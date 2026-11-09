const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');

const PLAY_URL = 'https://www.haxball.com/play';
const REPLAY_URL = 'https://www.haxball.com/replay';
const LIST_URL = 'https://www.haxball.com/rs/api/list';
const DISCORD_URL = 'https://discord.gg/UykyWjWWW';
const HEADER_HEIGHT = 52; // debe coincidir con --header-h en index.html

// Cada proceso obtiene su propio perfil Chromium/datos para permitir abrir HaTitix varias veces.
// La instancia 1 conserva la carpeta userData existente; las adicionales quedan aisladas.
const baseUserDataPath = app.getPath('userData');
const instanceLockDir = path.join(baseUserDataPath, '.instance-locks');
fs.mkdirSync(instanceLockDir, { recursive: true });
function processIsRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
}
let instanceSlot = 0;
let instanceLockPath = '';
for (let slot = 1; slot <= 64 && !instanceSlot; slot++) {
    const lockPath = path.join(instanceLockDir, `instance-${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
            fs.closeSync(fd);
            instanceSlot = slot;
            instanceLockPath = lockPath;
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let ownerPid = 0;
            try { ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid); } catch (_) {}
            if (!ownerPid) {
                try { if (Date.now() - fs.statSync(lockPath).mtimeMs < 30000) break; }
                catch (_) { continue; }
            }
            if (processIsRunning(ownerPid)) break;
            try { fs.unlinkSync(lockPath); } catch (_) { break; }
        }
    }
}
if (!instanceSlot) throw new Error('No se pudo reservar un perfil de instancia de HaTitix.');
const instanceUserDataPath = instanceSlot === 1
    ? baseUserDataPath
    : path.join(baseUserDataPath, 'instances', `instance-${instanceSlot}`);
fs.mkdirSync(instanceUserDataPath, { recursive: true });
app.setPath('userData', instanceUserDataPath);
const instanceSessionDataPath = instanceSlot === 1
    ? baseUserDataPath
    : path.join(instanceUserDataPath, 'session-data');
fs.mkdirSync(instanceSessionDataPath, { recursive: true });
app.setPath('sessionData', instanceSessionDataPath);
function releaseInstanceSlot() {
    if (!instanceLockPath) return;
    try {
        const owner = JSON.parse(fs.readFileSync(instanceLockPath, 'utf8'));
        if (Number(owner.pid) === process.pid) fs.unlinkSync(instanceLockPath);
    } catch (_) {}
    instanceLockPath = '';
}
app.on('will-quit', releaseInstanceSlot);
process.on('exit', releaseInstanceSlot);

let win;
let gameView;
let gameVisible = false;
let fullscreenRenderResolution = null;

// El render de juego va por su propio temporizador para no quedar clavado a 60 Hz.
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
let accelerationMode = 'hardware';
try {
    const savedPerformance = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'performance.json'), 'utf8'));
    if (savedPerformance.acceleration === 'software') accelerationMode = 'software';
} catch (_) {}
if (accelerationMode === 'software') app.disableHardwareAcceleration();
else {
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

// ---- Lista de salas: formato binario de Haxball ----
function parseRooms(raw) {
    let b = Buffer.from(raw);
    if (b[0] !== 0) {
        for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
            try {
                const out = fn(b);
                if (out[0] === 0) { b = out; break; }
            } catch (_) { /* probar siguiente */ }
        }
    }
    const rooms = [];
    let o = 1;
    try {
        while (o + 2 <= b.length) {
            const idLen = b.readUInt16BE(o); o += 2;
            const id = b.toString('latin1', o, o + idLen); o += idLen;
            const dLen = b.readUInt16BE(o); o += 2;
            const end = o + dLen;
            let p = o + 2; // salta la versión de sala (uint16)
            const nl = b[p++]; const name = b.toString('utf8', p, p + nl); p += nl;
            const fl = b[p++]; const flag = b.toString('latin1', p, p + fl).toLowerCase(); p += fl;
            p += 8; // latitud + longitud (float32 x2), no las usamos
            const hasPassword = b[p++] === 1;
            const maxPlayers = b[p++];
            const players = b[p++];
            rooms.push({ id, name, flag, hasPassword, maxPlayers, players });
            o = end;
        }
    } catch (_) { /* si el final está truncado, devolvemos lo parseado */ }
    if (!rooms.length) {
        throw new Error('No se pudo leer la lista. Primeros bytes: ' + b.subarray(0, 16).toString('hex'));
    }
    return rooms;
}

ipcMain.handle('rooms:list', async () => {
    const res = await fetch(LIST_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseRooms(await res.arrayBuffer());
});

ipcMain.handle('window:size:get', () => win && !win.isDestroyed()
    ? (fullscreenRenderResolution ? [fullscreenRenderResolution.width, fullscreenRenderResolution.height, true] : [...win.getSize(), win.isFullScreen()])
    : [1200, 800, false]);
ipcMain.handle('window:fullscreen:get', () => !!(win && !win.isDestroyed() && win.isFullScreen()));
ipcMain.handle('window:fullscreen:set', async (_event, enabled) => {
    if (!win || win.isDestroyed()) throw new Error('La ventana ya no está disponible.');
    const target = !!enabled;
    if (win.isFullScreen() === target) return target;
    const eventName = target ? 'enter-full-screen' : 'leave-full-screen';
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true; clearTimeout(timeout); win?.removeListener(eventName, finish); resolve();
        };
        const timeout = setTimeout(finish, 900);
        win.once(eventName, finish);
        win.setFullScreen(target);
    });
    return !!(win && !win.isDestroyed() && win.isFullScreen());
});
ipcMain.handle('window:size', async (_event, size) => {
    if (!win || win.isDestroyed()) throw new Error('La ventana ya no está disponible.');
    const width = Number(size?.width), height = Number(size?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 600 || width > 3840 || height < 500 || height > 2160) {
        throw new Error('Usa un ancho entre 600 y 3840 y un alto entre 500 y 2160 píxeles.');
    }
    const wasFullscreen = win.isFullScreen();
    if (win.isMinimized()) win.restore();
    if (wasFullscreen) {
        // La pantalla completa ocupa la resolución nativa del monitor; la
        // elección del usuario se aplica al buffer de render y se escala al área.
        fullscreenRenderResolution = { width, height };
        return [width, height, true];
    }
    if (!win || win.isDestroyed()) throw new Error('La ventana ya no está disponible.');
    if (win.isMaximized()) win.unmaximize();
    win.setResizable(true);
    win.setSize(width, height);
    win.center();
    fullscreenRenderResolution = null;
    await new Promise((resolve) => setTimeout(resolve, 160));
    if (!win || win.isDestroyed()) throw new Error('La ventana se cerró mientras cambiaba el tamaño.');
    return [width, height, false];
});

// ---- Ventana ----
function layoutGame() {
    if (!win || !gameView) return;
    const [width, height] = win.getContentSize();
    gameView.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) });
}

function showGame(show) {
    gameVisible = show;
    if (gameView) gameView.setVisible(show);
}

function createWindow() {
    win = new BrowserWindow({
        width: 800,
        height: 700,
        minWidth: 600,
        minHeight: 500,
        resizable: true,
        center: true,
        title: `HaTitix APP — Instancia ${instanceSlot}`,
        icon: path.join(__dirname, 'hatitix-icon.png'),
        backgroundColor: '#080c08',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            // Solo se cargan archivos locales: el cliente de Haxball corre dentro de la app
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    win.once('ready-to-show', () => {
        if (!win || win.isDestroyed()) return;
        win.show();
        win.setFullScreen(instanceSlot === 1);
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    win.on('enter-full-screen', () => win && !win.isDestroyed() && win.webContents.send('window:fullscreen-changed', true));
    win.on('leave-full-screen', () => {
        if (!win || win.isDestroyed()) return;
        if (fullscreenRenderResolution) {
            const { width, height } = fullscreenRenderResolution;
            win.setSize(width, height); win.center(); fullscreenRenderResolution = null;
        }
        win.webContents.send('window:fullscreen-changed', false);
    });
    win.on('closed', () => { win = null; gameView = null; });
}

// ---- Perfiles ----
const profilesFile = () => path.join(app.getPath('userData'), 'profiles.json');
let profileData = null;

function cleanAvatar(a) {
    const c = Array.from(String(a || '').replace(/[\uFE00-\uFE0F\u200D]/g, '').trim());
    const emoji = c.find((x) => x.codePointAt(0) > 0x7f);
    return emoji || c.slice(0, 2).join('');
}

function cleanProfile(p) {
    const ex = p.extrapolation;
    const n = ex === null || ex === undefined || ex === '' ? null : Math.round(Number(ex));
    return {
        id: String(p.id || Date.now()).slice(0, 40),
        name: String(p.name || '').trim().slice(0, 25),
        avatar: cleanAvatar(p.avatar),
        flag: /^[a-z]{2}(-[a-z]{3})?$/.test(p.flag) ? p.flag : '',
        extrapolation: Number.isFinite(n) ? n : null
    };
}

function sanitize(d) {
    const profiles = (Array.isArray(d?.profiles) ? d.profiles : []).slice(0, 50).map(cleanProfile).filter((p) => p.name);
    const activeId = profiles.some((p) => p.id === d?.activeId) ? d.activeId : (profiles[0]?.id ?? null);
    return { profiles, activeId };
}

function getProfiles() {
    if (!profileData) {
        try { profileData = sanitize(JSON.parse(fs.readFileSync(profilesFile(), 'utf8'))); }
        catch { profileData = { profiles: [], activeId: null }; }
    }
    return profileData;
}

ipcMain.handle('profiles:load', () => getProfiles());
ipcMain.handle('profiles:save', (_e, d) => {
    profileData = sanitize(d);
    fs.mkdirSync(path.dirname(profilesFile()), { recursive: true });
    fs.writeFileSync(profilesFile(), JSON.stringify(profileData, null, 2));
    if (!gameVisible && gameView) gameView.webContents.loadURL(PLAY_URL); // recarga en segundo plano
    return profileData;
});

// ---- Biblioteca local de repeticiones HBR2 ----
const replaysDir = () => path.join(app.getPath('userData'), 'replays');
const replayPath = (id, extension) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Repetición no válida.');
    return path.join(replaysDir(), id + extension);
};
ipcMain.handle('replays:list', () => {
    try {
        return fs.readdirSync(replaysDir()).filter((name) => name.endsWith('.json')).map((name) => {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(replaysDir(), name), 'utf8'));
                return fs.existsSync(replayPath(meta.id, '.hbr2')) ? meta : null;
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch { return []; }
});
ipcMain.handle('replays:save', (_event, data, details = {}) => {
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw new Error('El archivo de repetición está vacío o supera 256 MB.');
    fs.mkdirSync(replaysDir(), { recursive: true });
    const id = crypto.randomUUID();
    const safeName = String(details.name || 'Partida').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 80) || 'Partida';
    const meta = { id, name: safeName, size: bytes.length, createdAt: new Date().toISOString() };
    fs.writeFileSync(replayPath(id, '.hbr2'), bytes);
    fs.writeFileSync(replayPath(id, '.json'), JSON.stringify(meta, null, 2));
    return meta;
});
ipcMain.handle('replays:read', (_event, id) => {
    const bytes = fs.readFileSync(replayPath(id, '.hbr2'));
    return Uint8Array.from(bytes);
});
ipcMain.handle('replays:delete', (_event, id) => {
    for (const ext of ['.hbr2', '.json']) {
        const target = replayPath(id, ext);
        if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    return true;
});
// ---- Biblioteca local de mapas/estadios ----
const mapsDir = () => path.join(app.getPath('userData'), 'maps');
const mapPath = (id) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Mapa no válido.');
    return path.join(mapsDir(), id + '.json');
};
const cleanMapName = (name) => String(name || 'Mapa').replace(/[\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 80) || 'Mapa';
function stableMapValue(value) {
    if (Array.isArray(value)) return value.map(stableMapValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).filter((key) => key !== '__savedId').sort().map((key) => [key, stableMapValue(value[key])]));
}
function mapFingerprint(stadium) {
    const canonical = { ...stadium };
    delete canonical.name; delete canonical.__savedId;
    return crypto.createHash('sha256').update(JSON.stringify(stableMapValue(canonical))).digest('hex');
}
ipcMain.handle('maps:list', () => {
    try {
        const seen = new Set();
        return fs.readdirSync(mapsDir()).filter((name) => name.endsWith('.json')).map((name) => {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(mapsDir(), name), 'utf8'));
                return { id: meta.id, name: meta.name || 'Mapa', stadium: meta.stadium };
            } catch { return null; }
        }).filter((entry) => {
            if (!entry?.id || !entry.stadium) return false;
            const fingerprint = mapFingerprint(entry.stadium);
            if (seen.has(fingerprint)) return false;
            seen.add(fingerprint); return true;
        }).sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
});
ipcMain.handle('maps:save', (_event, data, details = {}) => {
    let stadium;
    try { stadium = typeof data === 'string' ? JSON.parse(data) : data; } catch { throw new Error('El archivo no contiene JSON válido.'); }
    if (!stadium || typeof stadium !== 'object' || !Array.isArray(stadium.vertexes) || !Array.isArray(stadium.segments)) throw new Error('No parece un mapa de Haxball válido.');
    fs.mkdirSync(mapsDir(), { recursive: true });
    const fingerprint = mapFingerprint(stadium);
    for (const file of fs.readdirSync(mapsDir()).filter((name) => name.endsWith('.json'))) {
        try {
            const existing = JSON.parse(fs.readFileSync(path.join(mapsDir(), file), 'utf8'));
            if (existing.id && existing.stadium && mapFingerprint(existing.stadium) === fingerprint) {
                return { id: existing.id, name: existing.name || 'Mapa', stadium: existing.stadium, duplicate: true };
            }
        } catch (_) { /* ignorar mapas corruptos y continuar */ }
    }
    const id = crypto.randomUUID();
    const meta = { id, name: cleanMapName(details.name || stadium.name || 'Mapa'), stadium, fingerprint };
    const target = mapPath(id);
    const temporary = `${target}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(meta), { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(temporary, target);
    } catch (error) {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
        throw new Error(`No se pudo escribir el mapa en la biblioteca local: ${error.message}`);
    }
    return { id, name: meta.name, stadium: meta.stadium, duplicate: false };
});
ipcMain.handle('maps:delete', (_event, id) => { const target = mapPath(id); if (fs.existsSync(target)) fs.unlinkSync(target); return true; });
ipcMain.handle('performance:acceleration:set', (_event, mode) => {
    const next = mode === 'software' ? 'software' : 'hardware';
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'performance.json'), JSON.stringify({ acceleration: next }));
    app.relaunch();
    app.exit(0);
    return true;
});
ipcMain.on('profile:active', (e) => {
    const d = getProfiles();
    e.returnValue = d.profiles.find((p) => p.id === d.activeId) || null;
});

ipcMain.handle('token:get', () => new Promise((resolve) => {
    const tw = new BrowserWindow({
        parent: win, modal: true, width: 520, height: 720, title: 'Verificación de Haxball', autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:hax-captcha' }
    });
    let done = false, timer;
    const finish = (token) => {
        if (done) return;
        done = true; clearInterval(timer); resolve(token);
        if (!tw.isDestroyed()) tw.close();
    };
    tw.on('closed', () => finish(null));
    tw.loadURL('https://www.haxball.com/headlesstoken');
    timer = setInterval(async () => {
        if (tw.isDestroyed()) return;
        try {
            const txt = await tw.webContents.executeJavaScript(
                "document.documentElement.innerText + ' ' + [...document.querySelectorAll('input,textarea')].map(e => e.value).join(' ')");
            const m = /thr1\.[\w-]+\.[\w-]+/.exec(txt);
            if (m) finish(m[0]);
        } catch (_) { /* la página todavía carga */ }
    }, 700);
}));

ipcMain.on('discord', () => shell.openExternal(DISCORD_URL));
ipcMain.on('quit', () => app.quit());

process.on('uncaughtException', (error) => { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `[uncaughtException] ${error.stack || error}\n`); } catch (_) {} });
process.on('unhandledRejection', (error) => { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `[unhandledRejection] ${error?.stack || error}\n`); } catch (_) {} });
process.on('uncaughtException', (error) => { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `[uncaughtException] ${error.stack || error}\n`); } catch (_) {} });
process.on('unhandledRejection', (error) => { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `[unhandledRejection] ${error?.stack || error}\n`); } catch (_) {} });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
