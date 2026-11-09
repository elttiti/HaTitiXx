const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hatitix', {
    rooms: () => ipcRenderer.invoke('rooms:list'),
    view: (v) => ipcRenderer.send('view', v),
    join: (id) => ipcRenderer.send('join', id),
    go: (where) => ipcRenderer.send('go', where),
    discord: () => ipcRenderer.send('discord'),
    quit: () => ipcRenderer.send('quit'),
    loadProfiles: () => ipcRenderer.invoke('profiles:load'),
    saveProfiles: (d) => ipcRenderer.invoke('profiles:save', d)
});
