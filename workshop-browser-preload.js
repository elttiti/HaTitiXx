'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workshopBrowser', Object.freeze({
    action: (name, value) => ipcRenderer.invoke('workshop-browser:action', name, value),
    onState(callback) {
        if (typeof callback !== 'function') return;
        ipcRenderer.on('workshop-browser:state', (_event, state) => callback(state));
    }
}));
