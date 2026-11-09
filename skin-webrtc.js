(() => {
    'use strict';

    const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
    const MAX_PROFILE_IMAGE_CHARS = 2600;
    const MAX_DATA_MESSAGE_CHARS = 12000;

    function cleanProfile(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const cleanImage = (image) => image === '' ? ''
            : typeof image === 'string' && image.length <= MAX_PROFILE_IMAGE_CHARS
                && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(image) ? image : null;
        const me = cleanImage(value.me), teamPhoto = cleanImage(value.teamPhoto);
        if (me === null || teamPhoto === null || !['none', 'red', 'blue', 'all'].includes(value.team)) return null;
        return { me, teamPhoto, team: value.team };
    }

    class HatitixSkinWebRTC {
        constructor(options) {
            this.options = options;
            this.socket = null;
            this.active = false;
            this.joined = false;
            this.hostId = null;
            this.hostEpoch = -1;
            this.revision = -1;
            this.members = new Map();
            this.peers = new Map();
            this.channels = new Map();
            this.pendingCandidates = new Map();
            this.remoteProfiles = new Map();
            this.localProfile = null;
            this.pingTimer = null;
            this.retryTimer = null;
            this.retryMs = 1000;
            this.generation = 0;
            this.authFailed = false;
        }

        connect() {
            this.active = true;
            this._connectSignal();
        }

        disconnect() {
            this.active = false;
            this.generation++;
            clearTimeout(this.retryTimer); this.retryTimer = null;
            clearInterval(this.pingTimer); this.pingTimer = null;
            const socket = this.socket;
            this.socket = null;
            if (socket) { socket.onclose = null; socket.onerror = null; try { socket.close(); } catch (_) { /* already closed */ } }
            this._closePeerConnections();
            this.members.clear(); this.remoteProfiles.clear(); this.localProfile = null;
            this.options.onClear?.();
        }

        setPreferHost(enabled) {
            const preferHost = !!enabled;
            if (this.options.preferHost === preferHost) return;
            this.options.preferHost = preferHost;
            if (this.joined) this._sendSignal({ type: 'host-preference', preferHost });
        }

        _connectSignal() {
            if (!this.active || this.authFailed) return;
            clearTimeout(this.retryTimer); this.retryTimer = null;
            const generation = ++this.generation;
            this._status('Conectando al servidor de señalización…');
            let socket;
            try { socket = new WebSocket(this.options.url); }
            catch (_) { this._status('No se pudo abrir la URL de señalización.'); return; }
            this.socket = socket;
            socket.onopen = () => {
                if (!this._current(socket, generation)) return;
                socket.send(JSON.stringify({ type: 'auth', token: this.options.token }));
            };
            socket.onmessage = (event) => {
                if (!this._current(socket, generation)) return;
                let message;
                try { message = JSON.parse(event.data); } catch (_) { return; }
                this._handleSignalMessage(message).catch(() => {});
            };
            socket.onerror = () => { if (this._current(socket, generation)) this._status('No se pudo conectar al servidor de señalización; revisá URL, TLS e Internet.'); };
            socket.onclose = () => {
                if (!this._current(socket, generation)) return;
                this.socket = null; this.joined = false;
                this._closePeerConnections();
                this.members.clear(); this.remoteProfiles.clear();
                this.hostId = null; this.hostEpoch = -1; this.revision = -1;
                this.options.onClear?.();
                if (!this.active || this.authFailed) return;
                this._status('Se perdió la señalización; reintentando…');
                const delay = this.retryMs;
                this.retryMs = Math.min(20000, this.retryMs * 2);
                this.retryTimer = setTimeout(() => this._connectSignal(), delay);
            };
        }

        _current(socket, generation) { return this.active && this.socket === socket && this.generation === generation; }
        _sendSignal(payload) {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
            try { this.socket.send(JSON.stringify(payload)); return true; } catch (_) { return false; }
        }
        async _handleSignalMessage(message) {
            if (message.type === 'authenticated') {
                this._sendSignal({ type: 'join', roomId: this.options.roomId, playerId: this.options.playerId, preferHost: this.options.preferHost === true });
                return;
            }
            if (message.type === 'topology') {
                this._applyTopology(message);
                return;
            }
            if (message.type === 'signal') {
                await this._handleRtcSignal(message);
                return;
            }
            if (message.type === 'pong') return;
            if (message.type === 'error') {
                if (message.code === 'auth_failed') {
                    this.authFailed = true;
                    this._status('La clave compartida no coincide con la del servidor de señalización.');
                    this.socket?.close();
                } else this._status(`Señalización rechazó la operación (${String(message.code || 'error')}).`);
            }
        }

        _applyTopology(message) {
            if (!Array.isArray(message.members) || !Number.isInteger(message.hostId) || !Number.isInteger(message.hostEpoch)) return;
            if (message.hostEpoch < this.hostEpoch || message.hostEpoch === this.hostEpoch && message.revision < this.revision) return;
            const nextMembers = new Map();
            for (const item of message.members) {
                const id = Number(item?.playerId);
                if (Number.isInteger(id) && id >= 0 && id <= 65535) nextMembers.set(id, item);
            }
            if (!nextMembers.has(message.hostId) || !nextMembers.has(this.options.playerId)) return;
            const hostChanged = this.hostId !== message.hostId || this.hostEpoch !== message.hostEpoch;
            const departed = [...this.members.keys()].filter((id) => !nextMembers.has(id));
            if (hostChanged) {
                this._closePeerConnections();
                this.remoteProfiles.clear();
                this.options.onClear?.();
            } else {
                for (const id of departed) {
                    this._closePeer(id);
                    this.remoteProfiles.delete(id);
                    this.options.onRemoteLeave?.(id);
                }
            }
            this.hostId = message.hostId;
            this.hostEpoch = message.hostEpoch;
            this.revision = message.revision;
            this.members = nextMembers;
            this.joined = true;
            this.retryMs = 1000;
            this.authFailed = false;
            if (this.pingTimer === null) {
                this._sendGamePing();
                this.pingTimer = setInterval(() => this._sendGamePing(), 2500);
            }
            if (this.hostId === this.options.playerId) {
                for (const id of this.members.keys()) if (id !== this.options.playerId) this._ensureHostPeer(id).catch(() => {});
            }
            this._statusForPeers();
        }

        _sendGamePing() {
            if (!this.joined || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
            let pingMs = null;
            try { pingMs = this.options.getGamePing?.(); } catch (_) { /* ping unavailable */ }
            if (Number.isFinite(pingMs) && pingMs >= 0) this._sendSignal({ type: 'gameping', pingMs: Math.round(pingMs) });
        }

        _sendRtc(toPlayerId, kind, body) {
            this._sendSignal({ type: 'signal', toPlayerId, epoch: this.hostEpoch, kind, body });
        }

        _createPeerConnection(playerId, isHostInitiator) {
            if (this.peers.has(playerId)) return this.peers.get(playerId);
            const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            this.peers.set(playerId, pc);
            pc.onicecandidate = (event) => {
                if (this.peers.get(playerId) !== pc) return;
                this._sendRtc(playerId, 'candidate', event.candidate ? event.candidate.toJSON() : null);
            };
            pc.onconnectionstatechange = () => {
                if (this.peers.get(playerId) !== pc) return;
                if (pc.connectionState === 'failed') this._status(`No se pudo crear un canal WebRTC directo con ${playerId}. Esta red puede necesitar TURN.`);
                else this._statusForPeers();
            };
            pc.oniceconnectionstatechange = () => {
                if (this.peers.get(playerId) === pc && pc.iceConnectionState === 'failed') {
                    this._status(`Falló ICE con ${playerId}; la red puede bloquear conexiones directas. Se requiere un servidor TURN para esa red.`);
                }
            };
            if (isHostInitiator) {
                const channel = pc.createDataChannel('hatitix-skins', { ordered: true });
                this._attachChannel(playerId, channel);
            } else {
                pc.ondatachannel = (event) => this._attachChannel(playerId, event.channel);
            }
            return pc;
        }

        async _ensureHostPeer(playerId) {
            if (!this.active || !this.joined || this.hostId !== this.options.playerId || playerId === this.options.playerId || !this.members.has(playerId) || this.peers.has(playerId)) return;
            const pc = this._createPeerConnection(playerId, true);
            try {
                const offer = await pc.createOffer();
                if (this.peers.get(playerId) !== pc || !this.active) return;
                await pc.setLocalDescription(offer);
                this._sendRtc(playerId, 'description', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
            } catch (_) {
                this._closePeer(playerId);
                this._status(`No se pudo iniciar WebRTC con ${playerId}.`);
            }
        }

        async _handleRtcSignal(message) {
            const from = Number(message.fromPlayerId);
            if (message.epoch !== this.hostEpoch || !this.members.has(from) || from === this.options.playerId) return;
            const isHost = this.hostId === this.options.playerId;
            const body = message.body;
            if (message.kind === 'description') {
                if (!body || !['offer', 'answer'].includes(body.type) || typeof body.sdp !== 'string' || body.sdp.length > 18000) return;
                if (body.type === 'offer') {
                    if (isHost || from !== this.hostId) return;
                    const pc = this._createPeerConnection(from, false);
                    try {
                        await pc.setRemoteDescription(body);
                        await this._flushCandidates(from, pc);
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        this._sendRtc(from, 'description', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
                    } catch (_) { this._closePeer(from); this._status('Falló la negociación WebRTC con el anfitrión.'); }
                } else {
                    if (!isHost || from === this.hostId) return;
                    const pc = this.peers.get(from);
                    if (!pc) return;
                    try { await pc.setRemoteDescription(body); await this._flushCandidates(from, pc); }
                    catch (_) { this._closePeer(from); this._status('No se pudo aceptar la respuesta WebRTC de un jugador.'); }
                }
                return;
            }
            if (message.kind === 'candidate') {
                if (isHost ? from === this.hostId : from !== this.hostId) return;
                const pc = this.peers.get(from);
                if (!pc || !pc.remoteDescription) {
                    const queued = this.pendingCandidates.get(from) || [];
                    if (queued.length < 64) queued.push(body);
                    this.pendingCandidates.set(from, queued);
                    return;
                }
                try { await pc.addIceCandidate(body); } catch (_) { /* ignore stale ICE candidate */ }
            }
        }

        async _flushCandidates(playerId, pc) {
            const queued = this.pendingCandidates.get(playerId) || [];
            this.pendingCandidates.delete(playerId);
            for (const candidate of queued) {
                try { await pc.addIceCandidate(candidate); } catch (_) { /* ignore stale candidate */ }
            }
        }

        _attachChannel(playerId, channel) {
            const pc = this.peers.get(playerId);
            this.channels.set(playerId, channel);
            channel.onopen = () => {
                if (this.channels.get(playerId) !== channel) return;
                if (this.hostId === this.options.playerId) this._sendSnapshot(playerId, channel).catch(() => {});
                else this._sendLocalProfileToHost();
                this._statusForPeers();
            };
            channel.onmessage = (event) => {
                if (this.channels.get(playerId) !== channel || typeof event.data !== 'string' || event.data.length > MAX_DATA_MESSAGE_CHARS) return;
                let message;
                try { message = JSON.parse(event.data); } catch (_) { return; }
                this._handleDataMessage(playerId, message);
            };
            channel.onerror = () => this._status(`Error en el canal de datos WebRTC con ${playerId}.`);
            channel.onclose = () => {
                if (this.channels.get(playerId) !== channel) return;
                this.channels.delete(playerId);
                if (this.hostId === this.options.playerId) {
                    this.remoteProfiles.delete(playerId);
                    this.options.onRemoteLeave?.(playerId);
                    this._broadcast({ type: 'leave', playerId });
                } else if (playerId === this.hostId) {
                    this.remoteProfiles.clear();
                    this.options.onClear?.();
                }
                this._statusForPeers();
            };
            if (pc?.connectionState === 'connected') this._statusForPeers();
        }

        async _sendSnapshot(playerId, channel) {
            if (this.channels.get(playerId) !== channel || channel.readyState !== 'open') return;
            const local = await this._readLocalProfile();
            if (local && this.channels.get(playerId) === channel && channel.readyState === 'open') {
                this._sendOn(channel, { type: 'profile', playerId: this.options.playerId, profile: local });
            }
            for (const [id, profile] of this.remoteProfiles) {
                if (id !== playerId && this.channels.get(playerId) === channel && channel.readyState === 'open') {
                    this._sendOn(channel, { type: 'profile', playerId: id, profile });
                }
            }
        }

        async _readLocalProfile() {
            try {
                const profile = cleanProfile(await this.options.getLocalProfile?.());
                if (profile) this.localProfile = profile;
                return this.localProfile;
            } catch (_) { return this.localProfile; }
        }

        _sendLocalProfileToHost() {
            this._readLocalProfile().then((profile) => {
                if (profile) this._sendOn(this.channels.get(this.hostId), { type: 'profile', profile });
            }).catch(() => {});
        }

        _sendOn(channel, payload) {
            if (!channel || channel.readyState !== 'open') return false;
            const data = JSON.stringify(payload);
            if (data.length > MAX_DATA_MESSAGE_CHARS) return false;
            try { channel.send(data); return true; } catch (_) { return false; }
        }

        _handleDataMessage(fromPlayerId, message) {
            if (!message || typeof message !== 'object') return;
            if (this.hostId === this.options.playerId) {
                if (message.type !== 'profile') return;
                const profile = cleanProfile(message.profile);
                if (!profile || !this.members.has(fromPlayerId)) return;
                this.remoteProfiles.set(fromPlayerId, profile);
                this.options.onRemoteProfile?.(fromPlayerId, profile);
                this._broadcast({ type: 'profile', playerId: fromPlayerId, profile }, fromPlayerId);
                return;
            }
            if (fromPlayerId !== this.hostId) return;
            if (message.type === 'profile') {
                const playerId = Number(message.playerId), profile = cleanProfile(message.profile);
                if (!Number.isInteger(playerId) || playerId === this.options.playerId || !this.members.has(playerId) || !profile) return;
                this.remoteProfiles.set(playerId, profile);
                this.options.onRemoteProfile?.(playerId, profile);
            } else if (message.type === 'leave') {
                const playerId = Number(message.playerId);
                if (Number.isInteger(playerId)) { this.remoteProfiles.delete(playerId); this.options.onRemoteLeave?.(playerId); }
            }
        }

        _broadcast(payload, excludePlayerId = null) {
            for (const [id, channel] of this.channels) if (id !== excludePlayerId) this._sendOn(channel, payload);
        }

        publishProfile(profile) {
            const cleaned = cleanProfile(profile);
            if (!cleaned) return;
            this.localProfile = cleaned;
            if (!this.joined) return;
            if (this.hostId === this.options.playerId) {
                this._broadcast({ type: 'profile', playerId: this.options.playerId, profile: cleaned });
            } else this._sendLocalProfileToHost();
        }

        _closePeer(playerId) {
            const channel = this.channels.get(playerId);
            this.channels.delete(playerId);
            if (channel) { channel.onclose = null; try { channel.close(); } catch (_) { /* already closed */ } }
            const pc = this.peers.get(playerId);
            this.peers.delete(playerId);
            if (pc) { pc.onicecandidate = null; pc.ondatachannel = null; try { pc.close(); } catch (_) { /* already closed */ } }
            this.pendingCandidates.delete(playerId);
        }

        _closePeerConnections() {
            for (const playerId of new Set([...this.peers.keys(), ...this.channels.keys()])) this._closePeer(playerId);
        }

        _statusForPeers() {
            if (!this.active) return;
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) { this._status('Conectando al servidor de señalización…'); return; }
            if (!this.joined) { this._status('Autenticando con el servidor de señalización…'); return; }
            const total = Math.max(0, this.members.size - 1);
            const open = [...this.channels.values()].filter((channel) => channel.readyState === 'open').length;
            const hostPreferred = this.members.get(this.hostId)?.preferHost === true;
            if (this.hostId === this.options.playerId) this._status(`Anfitrión WebRTC (${hostPreferred ? 'prioridad manual' : 'automático por ping'}): ${open}/${total} conexiones directas.`);
            else if (open) this._status(`WebRTC directo conectado al anfitrión ${this.hostId}${hostPreferred ? ' (prioridad manual)' : ''}.`);
            else this._status(`Señalización conectada; estableciendo WebRTC directo con el anfitrión${hostPreferred ? ' priorizado manualmente' : ''}…`);
        }

        _status(text) { this.options.onStatus?.(text); }
    }

    window.HatitixSkinWebRTC = HatitixSkinWebRTC;
})();
