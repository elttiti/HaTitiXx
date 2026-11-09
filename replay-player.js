const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const API = require('node-haxball')({
    setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window),
    setInterval: setInterval.bind(window), clearInterval: clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), console
});
const GameRenderer = require('node-haxball/examples/renderers/defaultRenderer.js');
const $ = (selector) => document.querySelector(selector);
const canvas = $('#replay-canvas');
let replayReader = null, renderer = null, duration = 0, ended = false, lastUiUpdate = 0;

function makeTextures() {
    const tile = (color, stripe) => {
        const image = document.createElement('canvas'); image.width = image.height = 128;
        const ctx = image.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = stripe; ctx.fillRect(0, 0, 128, 64);
        return image;
    };
    return { grass: tile('#6d8c56', '#789660'), concrete: tile('#536873', '#647984'), concrete2: tile('#687b84', '#7e9097'), typing: tile('#6d8c56', '#789660') };
}
function timeText(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function updateProgress(force = false) {
    if (!replayReader) return;
    const now = performance.now();
    if (!force && now - lastUiUpdate < 150) return;
    lastUiUpdate = now;
    const frame = replayReader.getCurrentFrameNo();
    $('#seek').value = String(Math.max(0, frame));
    $('#time').textContent = `${timeText(replayReader.getTime())} / ${timeText(duration)}`;
}
function renderReplay() {
    if (!replayReader) return;
    try {
        if (!renderer) {
            renderer = new GameRenderer(API, { canvas, images: makeTextures(), paintGame: true });
            renderer.room = replayReader;
            renderer.initialize();
        }
        renderer.room = replayReader;
        renderer.render();
        $('#message').hidden = true;
        updateProgress();
    } catch (error) {
        $('#error').textContent = `No se pudo dibujar la repetición: ${error.message}`;
        replayReader.setSpeed(0);
    }
}
function loadReplay() {
    try {
        const id = new URLSearchParams(location.search).get('id');
        if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Identificador de repetición no válido.');
        const replayDir = path.join(app.getPath('userData'), 'replays');
        const replayFile = path.join(replayDir, `${id}.hbr2`);
        let metadata = {};
        try { metadata = JSON.parse(fs.readFileSync(path.join(replayDir, `${id}.json`), 'utf8')); } catch { /* metadatos opcionales */ }
        const data = fs.readFileSync(replayFile);
        replayReader = API.Replay.read(data, {
            render: renderReplay,
            onGameTick: () => updateProgress(),
            onEnd: () => { ended = true; replayReader?.setSpeed(0); $('#message').textContent = 'Fin de la repetición'; $('#message').hidden = false; updateProgress(true); }
        }, {
            requestAnimationFrame: window.requestAnimationFrame.bind(window),
            cancelAnimationFrame: window.cancelAnimationFrame.bind(window)
        });
        duration = replayReader.length();
        $('#seek').max = String(Math.max(1, replayReader.maxFrameNo));
        const date = metadata.createdAt ? new Date(metadata.createdAt).toLocaleString('es-AR') : '';
        $('#title').textContent = `${metadata.name || 'Partida'}${date ? ` · ${date}` : ''} · ${timeText(duration)}`;
        replayReader.setSpeed(Number($('#speed').value));
        updateProgress(true);
    } catch (error) {
        $('#message').textContent = 'No se pudo abrir esta repetición.';
        $('#error').textContent = error.message || 'El archivo puede estar dañado o ser de una versión incompatible.';
    }
}
$('#play').onclick = () => {
    if (!replayReader) return;
    if (ended) { ended = false; replayReader.setCurrentFrameNo(0); $('#message').hidden = true; }
    replayReader.setSpeed(Number($('#speed').value));
    $('#message').hidden = true;
};
$('#pause').onclick = () => replayReader?.setSpeed(0);
$('#speed').onchange = () => { if (replayReader && replayReader.getSpeed() > 0) replayReader.setSpeed(Number($('#speed').value)); };
$('#seek').oninput = () => {
    if (!replayReader) return;
    ended = false; replayReader.setSpeed(0); replayReader.setCurrentFrameNo(Number($('#seek').value));
    $('#message').hidden = true; updateProgress(true);
};
window.addEventListener('beforeunload', () => { replayReader?.destroy(); renderer?.finalize?.(); });
loadReplay();
