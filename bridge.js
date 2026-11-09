(() => {
    const { ipcRenderer } = require('electron');
    window.hatitix = {
        rooms: () => ipcRenderer.invoke('rooms:list'),
        loadProfiles: () => ipcRenderer.invoke('profiles:load'),
        saveProfiles: (d) => ipcRenderer.invoke('profiles:save', d),
        getToken: () => ipcRenderer.invoke('token:get'),
        resizeWindow: (size) => ipcRenderer.invoke('window:size', size),
        getWindowSize: () => ipcRenderer.invoke('window:size:get'),
        setFullscreen: (enabled) => ipcRenderer.invoke('window:fullscreen:set', !!enabled),
        getFullscreen: () => ipcRenderer.invoke('window:fullscreen:get'),
        onFullscreenChanged: (callback) => ipcRenderer.on('window:fullscreen-changed', (_event, enabled) => callback(!!enabled)),
        listReplays: () => ipcRenderer.invoke('replays:list'),
        saveReplay: (data, details) => ipcRenderer.invoke('replays:save', data, details),
        readReplay: (id) => ipcRenderer.invoke('replays:read', id),
        deleteReplay: (id) => ipcRenderer.invoke('replays:delete', id),
        listMaps: () => ipcRenderer.invoke('maps:list'),
        saveMap: (data, details) => ipcRenderer.invoke('maps:save', data, details),
        deleteMap: (id) => ipcRenderer.invoke('maps:delete', id),
        setAcceleration: (mode) => ipcRenderer.invoke('performance:acceleration:set', mode),
        discord: () => ipcRenderer.send('discord'),
        quit: () => ipcRenderer.send('quit')
    };
})();
