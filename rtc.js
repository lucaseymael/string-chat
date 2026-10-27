import { screenEncoding } from './advanced-settings.js';
import { requestViewerQuality,requestVideoRecovery,handleMediaControl,applyPlaybackBuffer } from './rtc-controls.js';
import {cleanAvatar} from './profile.js';
import {associateMedia,configureReceiver} from './media-policy.js';
// All media flows directly between browsers. Only room-control messages use the creator as a hub.
export const MAX_PEOPLE = 6;
const MAX_WIRE = 130000;
const MAX_JSON = 180000;
const idPattern = /^[a-f0-9]{32}$/;
const uid = () => crypto.randomUUID().replaceAll('-', '');
const cleanName = (name, fallback = 'Amigo') => typeof name === 'string' ? name.trim().slice(0, 32) || fallback : fallback;
const emit = (target, type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));

export async function encodeCode(payload) {
  const compressed = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('deflate'));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `SC.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export async function decodeCode(value) {
  const code = value.trim().replace(/\s/g, '');
  if (code.length > MAX_WIRE || !/^SC\.[A-Za-z0-9_-]+$/.test(code)) throw new Error('Código inválido. Cole o convite ou a resposta completos, começando com SC.');
  let data;
  try {
    const raw = Uint8Array.from(atob(code.slice(3).replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        total += chunk.length;
        if (total > MAX_JSON) throw new Error('Código grande demais.');
        chunks.push(chunk);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new Error('Código corrompido. Peça para copiar e enviar novamente.'); }
  if (data?.v !== 1 || !['offer', 'answer'].includes(data.type) || !idPattern.test(data.from?.id) || !idPattern.test(data.to) || !idPattern.test(data.room?.id) || typeof data.from.name !== 'string' || data.from.name.length > 32 || typeof data.room.name !== 'string' || data.room.name.length > 40 || data.desc?.type !== data.type || typeof data.desc.sdp !== 'string' || data.desc.sdp.length > 100000 || !data.desc.sdp.startsWith('v=0') || !data.desc.sdp.includes('a=fingerprint:') || !Number.isFinite(data.expiresAt)) {
    throw new Error('Esse código não é um convite ou uma resposta compatível.');
  }
  if (Date.now() > data.expiresAt) throw new Error('Esse convite expirou. Gere um novo e repita a troca de códigos.');
  if (data.expiresAt > Date.now() + 11 * 60 * 1000) throw new Error('Validade do código inválida. Confira o relógio dos computadores.');
  return data;
}

export function iceConfig(settings) {
  if (settings.network === 'lan') return { iceServers: [], bundlePolicy: 'max-bundle' };
  if (settings.network === 'custom') {
    if (!/^(stun|stuns|turn|turns):[^\s]+$/.test(settings.iceUrl || '')) throw new Error('Informe uma URL STUN ou TURN válida.');
    const server = { urls: settings.iceUrl };
    if (/^turns?:/.test(settings.iceUrl)) {
      if (!settings.iceUser || !settings.icePassword) throw new Error('Informe usuário e senha do servidor TURN.');
      server.username = settings.iceUser; server.credential = settings.icePassword;
    }
    return { iceServers: [server], bundlePolicy: 'max-bundle' };
  }
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' };
}

export function waitForIce(pc, timeout = 14000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); pc.removeEventListener('connectionstatechange', closed); };
    const changed = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const closed = () => { if (pc.connectionState === 'closed') { cleanup(); reject(new Error('A conexão foi cancelada.')); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('A descoberta de rede demorou demais. Confira a conexão ou escolha LAN / VPN nas configurações e gere outro convite.')); }, timeout);
    pc.addEventListener('icegatheringstatechange', changed); pc.addEventListener('connectionstatechange', closed);
  });
}

export class MeshCall extends EventTarget {
  constructor(settings) {
    super(); this.settings = settings;this.selfIdentity=globalThis.window?.stringChat?.identity?.id||uid(); this.id = this.selfIdentity; this.peers = new Map(); this.room = null;
    this.hostId = null; this.isHost = false; this.startedAt = null; this.generation = 0;
    this.mic = null; this.screen = null; this.screenAudio = null; this.camera = null;
    this.pttDown=false;this.micOn = false; this.deafened = false; this.chatSeen = new Set();
    this.externalSignal = false; this.networkAddress = null; this.networkStatus = null; this.networkInfo = null; this.networkQueue = Promise.resolve(); this.recoveries = new Map();
    this.voiceChannelId='voice-lobby';
    if (globalThis.window?.stringChat?.onRoomEvent) window.stringChat.onRoomEvent(event => {
      this.networkQueue = this.networkQueue.then(() => this.handleNetworkEvent(event)).catch(error => emit(this,'error',error.message));
    });
  }
  get active() { return !!this.room; }
  get connected() { return [...this.peers.values()].filter(p => p.channel?.readyState === 'open' && p.admitted); }
  get meta() { return { id: this.id, name: cleanName(this.settings.name, 'Você'), mic: !!(this.mic && this.micOn && !this.deafened && (this.settings.voiceInputMode!=='ptt'||this.pttDown)), screen: !!this.screen, camera: !!this.camera, avatar: cleanAvatar(this.settings.avatar), screenAudio: !!this.screenAudio, screenAudioVolume:this.settings.screenVolume,screenAudioState:this.screenAudio?'active':this.settings.screenSound?'unavailable':'off', deafened: this.deafened,voiceChannelId:this.voiceChannelId }; }
  startHost(name = 'Sala da galera') {
    if (this.active) return;
    this.isHost = true; this.hostId = this.id; this.room = { id: uid(), name: name.trim().slice(0, 40) || 'Sala da galera' };
    this.startedAt = Date.now(); emit(this, 'change');
  }
  async hostNetwork(name,address) {
    if(this.active && !this.isHost) throw new Error('Só quem criou a sala pode convidar.');
    this.externalSignal=true; this.startHost(name);
    if(name?.trim())this.room.name=name.trim().slice(0,40);
    try { this.networkInfo=await window.stringChat.createRoom({room:this.room,member:this.meta,address}); return this.networkInfo; }
    catch(error) { this.externalSignal=false; throw error; }
  }
  async joinNetwork(invite) {
    if(this.active) throw new Error('Saia da sala atual antes de entrar em outra.');
    this.externalSignal=true; this.networkInfo={invite}; this.networkStatus='connecting'; emit(this,'change');
    try { return await window.stringChat.joinRoom({invite,member:this.meta}); }
    catch(error) { this.externalSignal=false;this.networkInfo=null; this.networkStatus=null; emit(this,'change'); throw error; }
  }
  async handleNetworkEvent(event) {
    if(!this.externalSignal) return;
    if(event.type==='hosting') {
      this.room=event.room; this.networkAddress=event.localAddress; this.networkInfo=event; this.settings.network='lan'; this.networkStatus='connected'; emit(this,'change'); return;
    }
    if(event.type==='welcome') {
      this.networkAddress=event.localAddress; this.settings.network='lan'; this.networkStatus='connected';
      if(event.selfVoiceChannelId!==undefined)this.voiceChannelId=event.selfVoiceChannelId;
      this.room=event.room; this.hostId=event.hostId; this.isHost=false; this.startedAt ||= Date.now();
      const present=new Set(event.members.map(m=>m.id));
      for(const peer of [...this.peers.values()]) if(!present.has(peer.id)) this.dropPeer(peer.id);
      for(const item of event.members) {
        if(item.id===this.id || this.peers.has(item.id)) continue;
        const peer=this.makePeer(item.id,item.name,true);
        Object.assign(peer.meta,{voiceChannelId:item.voiceChannelId,avatar:cleanAvatar(item.avatar)});
        await this.syncPeer(peer); await peer.pc.setLocalDescription(await peer.pc.createOffer()); this.route(peer.id,{desc:peer.pc.localDescription.toJSON()});
      }
      emit(this,'change'); emit(this,'network-joined'); return;
    }
    if(event.type==='member-added') {
      if(event.member.id!==this.id && !this.peers.has(event.member.id)) Object.assign(this.makePeer(event.member.id,event.member.name,false).meta,{voiceChannelId:event.member.voiceChannelId,avatar:cleanAvatar(event.member.avatar)});
      return;
    }
    if(event.type==='member-left') { this.dropPeer(event.id,`${event.name} saiu.`); return; }
    if(event.type==='member-updated') {
      if(event.member.id===this.id) this.voiceChannelId=event.member.voiceChannelId;
      else {const peer=this.peers.get(event.member.id);if(peer){const before=peer.meta.voiceChannelId;peer.meta.voiceChannelId=event.member.voiceChannelId;peer.name=cleanName(event.member.name);peer.meta.avatar=cleanAvatar(event.member.avatar);await this.syncPeer(peer);if(before!==peer.meta.voiceChannelId){if(before===this.voiceChannelId)emit(this,'voice-sound','leave');if(peer.meta.voiceChannelId===this.voiceChannelId)emit(this,'voice-sound','join');}}}
      emit(this,'change'); return;
    }
    if(event.type==='channels-updated') { if(this.room)this.room.channels=event.channels;emit(this,'change');return; }
    if(event.type==='chat') {const item=event.message;emit(this,'chat',{...item,self:item.authorId===this.id});return;}
    if(event.type==='history') {for(const item of event.messages)emit(this,'chat',{...item,self:item.authorId===this.id,history:true});return;}
    if(event.type==='member-back') {
      const peer=this.peers.get(event.member.id); if(peer && ['failed','disconnected','closed'].includes(peer.pc.connectionState)) this.connectionFailed(peer);
      return;
    }
    if(event.type==='signal') {
      if(event.payload?.reset) { this.dropPeer(event.from); this.makePeer(event.from,event.name,false); return; }
      await this.receiveSignal(event.from,event.name,event.payload); return;
    }
    if(event.type==='network-status') { this.networkStatus=event.status; emit(this,'change'); return; }
    if(event.type==='network-error') { emit(this,'error',event.message); return; }
    if(event.type==='room-ended') { this.leave(); emit(this,'ended',event.message||'O criador encerrou a sala.'); }
  }
  async changeVoiceChannel(id) {
    if(!this.externalSignal) throw new Error('Entre em um grupo primeiro.');
    await window.stringChat.changeVoiceChannel(id); this.voiceChannelId=id; await this.updateTracks();
  }
  async createInvite(name) {
    if (this.active && !this.isHost) throw new Error('Peça um convite para a pessoa que criou a sala.');
    if (this.peers.size >= MAX_PEOPLE - 1) throw new Error('A sala comporta até 6 pessoas. Remova convites pendentes ou espere alguém sair.');
    this.startHost(name);
    const peer = this.makePeer(uid(), 'Aguardando amigo', true, true);
    peer.expiresAt = Date.now() + 10 * 60 * 1000;
    try {
      await this.syncPeer(peer);
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await waitForIce(peer.pc);
      if (!this.peers.has(peer.id)) throw new Error('Convite cancelado.');
      const payload = { v: 1, type: 'offer', room: this.room, from: { id: this.id, name: this.meta.name }, to: peer.id, desc: peer.pc.localDescription.toJSON(), expiresAt: peer.expiresAt };
      peer.expireTimer = setTimeout(() => { if (!peer.admitted) this.dropPeer(peer.id, 'Convite expirado'); }, 10 * 60 * 1000);
      return { id: peer.id, code: await encodeCode(payload) };
    } catch (error) { this.dropPeer(peer.id); throw error; }
  }
  async join(code) {
    if (this.active) throw new Error('Saia da sala atual antes de entrar em outra.');
    const data = await decodeCode(code);
    if (data.type !== 'offer') throw new Error('Cole um convite. Códigos de resposta são usados por quem criou a sala.');
    const generation = this.generation;
    this.id = data.to; this.room = data.room; this.hostId = data.from.id; this.isHost = false; this.startedAt = Date.now();
    const peer = this.makePeer(data.from.id, data.from.name, false, true);
    try {
      await peer.pc.setRemoteDescription(data.desc);
      this.adoptRemoteSlots(peer);
      await this.syncPeer(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await waitForIce(peer.pc);
      if (this.generation !== generation) throw new Error('Entrada cancelada.');
      emit(this, 'change');
      peer.expireTimer = setTimeout(() => { if (!peer.admitted) { this.leave(); emit(this, 'ended', 'A resposta não foi aplicada a tempo. Peça um novo convite.'); } }, Math.max(1000, data.expiresAt - Date.now()));
      return encodeCode({ v: 1, type: 'answer', room: data.room, from: { id: this.id, name: this.meta.name }, to: peer.id, desc: peer.pc.localDescription.toJSON(), expiresAt: data.expiresAt });
    } catch (error) { this.leave(); throw error; }
  }
  async accept(code) {
    const data = await decodeCode(code);
    if (!this.isHost || !this.room || data.type !== 'answer' || data.to !== this.id || data.room.id !== this.room.id) throw new Error('Essa resposta não pertence a um convite desta sala.');
    const peer = this.peers.get(data.from.id);
    if (!peer || !peer.manual || peer.pc.signalingState !== 'have-local-offer' || data.expiresAt !== peer.expiresAt) throw new Error('Convite já usado, cancelado ou desconhecido. Gere outro convite para esse amigo.');
    peer.name = cleanName(data.from.name);
    await peer.pc.setRemoteDescription(data.desc);
    peer.connectTimer = setTimeout(() => { if (!peer.admitted) { this.dropPeer(peer.id); emit(this, 'error', 'Não foi possível conectar. A rede pode precisar de VPN ou TURN. Gere um novo convite depois de ajustar a conexão.'); } }, 45000);
    emit(this, 'change');
  }
  cancelInvite(id) {
    const peer = this.peers.get(id);
    if (peer && !peer.admitted) this.dropPeer(id);
  }
  makePeer(id, name, initiator, manual = false) {
    if (this.peers.has(id)) return this.peers.get(id);
    if (id === this.id || !idPattern.test(id) || this.peers.size >= MAX_PEOPLE - 1) throw new Error('Limite da sala ou identificação inválida.');
    const pc = new RTCPeerConnection(iceConfig(this.settings));
    const peer = { id, name: cleanName(name), pc, channel: null, initiator, manual, admitted: false, meta: {}, tracks: new Map(), candidates: [], queue: Promise.resolve(), restarts: 0, paramsQueue: Promise.resolve(), previousStats: new Map(), stats: null };
    this.peers.set(id, peer);
    // Only the offerer creates m-lines. The answerer adopts the offered transceivers;
    // pre-creating them on the answerer would leave duplicate, unassociated senders.
    peer.slots = initiator ? [pc.addTransceiver('audio', { direction: 'sendrecv' }), pc.addTransceiver('video', { direction: 'sendrecv' }), pc.addTransceiver('audio', { direction: 'sendrecv' }), pc.addTransceiver('video', { direction: 'sendrecv' })] : [];
    associateMedia(peer);
    pc.ontrack = event => {
      const slot = pc.getTransceivers().indexOf(event.transceiver);
      configureReceiver(event.receiver,slot,this.settings.playbackBuffer);peer.tracks.set(slot, event.track);
      event.track.onunmute = () => emit(this, 'tracks', peer);
      event.track.onended = () => emit(this, 'tracks', peer);
      emit(this, 'tracks', peer);
    };
    pc.ondatachannel = event => { if (event.channel.label === 'stringchat-control' && !peer.channel) this.bindChannel(peer, event.channel); else event.channel.close(); };
    pc.onicecandidate = event => { if (event.candidate && !manual) this.route(id, { candidate: event.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (!this.peers.has(id)) return;
      emit(this, 'change');
      if (pc.connectionState === 'connected') { clearTimeout(peer.disconnectTimer); clearTimeout(peer.recoveryTimer); this.configurePeer(peer); }
      if (pc.connectionState === 'disconnected') {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = setTimeout(() => this.connectionFailed(peer), 16000);
      }
      if (pc.connectionState === 'failed') this.connectionFailed(peer);
    };
    if (initiator) this.bindChannel(peer, pc.createDataChannel('stringchat-control', { ordered: true }));
    emit(this, 'change'); return peer;
  }
  bindChannel(peer, channel) {
    peer.channel = channel;
    channel.onopen = () => {
      clearTimeout(peer.connectTimer); clearTimeout(peer.expireTimer); clearTimeout(peer.disconnectTimer);
      this.send(peer, { type: 'hello', member: this.meta });
      emit(this, 'change');
    };
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_WIRE) return;
      peer.queue = peer.queue.then(async () => {
        if (!this.peers.has(peer.id)) return;
        const message = JSON.parse(event.data);
        await this.handle(peer, message);
      }).catch(error => emit(this, 'error', `Falha ao processar conexão: ${error.message}`));
    };
    channel.onclose = () => {
      if (!this.peers.has(peer.id)) return;
      if(this.externalSignal) { this.connectionFailed(peer,true); return; }
      if (peer.id === this.hostId && !this.isHost) { this.leave(); emit(this, 'ended', 'O criador desconectou. A sala foi encerrada; criem outra para continuar.'); }
      else this.dropPeer(peer.id, `${peer.name} desconectou.`);
    };
    channel.onerror = () => emit(this, 'change');
  }
  send(peer, message) {
    if (peer?.channel?.readyState !== 'open') return false;
    if (peer.channel.bufferedAmount > 1024 * 1024) return false;
    try { peer.channel.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  broadcast(message) { for (const peer of this.connected) this.send(peer, message); }
  async handle(peer, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'hello') {
      if (message.member?.id !== peer.id) return;
      const wasAdmitted = peer.admitted;
      peer.meta = this.sanitizeMember(message.member); peer.name = peer.meta.name; peer.admitted = true;
      if (!wasAdmitted) {
        emit(this, 'memberjoined', peer.name);
        this.configurePeer(peer);
        if (this.isHost && !this.externalSignal) {
          this.send(peer, { type: 'mesh-start', peers: this.connected.filter(p => p.id !== peer.id).map(p => ({ id: p.id, name: p.name })) });
          this.sendRoster();
        }
      }
      emit(this, 'change'); return;
    }
    if (!peer.admitted) return;
    if(await handleMediaControl.call(this,peer,message))return;
    if (message.type === 'state') {
      if (message.member?.id !== peer.id) return;
      peer.meta = this.sanitizeMember(message.member); peer.name = peer.meta.name;
      if(this.externalSignal) await this.syncPeer(peer);
      emit(this, 'change'); emit(this, 'tracks', peer); return;
    }
    if (message.type === 'chat') {
      if (!idPattern.test(message.id) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000 || this.chatSeen.has(message.id)) return;
      if (peer.lastChat && Date.now() - peer.lastChat < 150) return;
      peer.lastChat = Date.now(); this.chatSeen.add(message.id);
      if (this.chatSeen.size > 1000) this.chatSeen.delete(this.chatSeen.values().next().value);
      emit(this, 'chat', { id: message.id, name: peer.name, text: message.text, time: Date.now(), self: false }); return;
    }
    if (this.isHost && message.type === 'route' && idPattern.test(message.to)) {
      const target = this.peers.get(message.to);
      if (target?.admitted && target.id !== peer.id) this.send(target, { type: 'signal', from: peer.id, name: peer.name, payload: message.payload });
      return;
    }
    if (peer.id !== this.hostId || this.isHost) return;
    if (message.type === 'room-ended') { this.leave(); emit(this, 'ended', 'O criador encerrou a sala.'); return; }
    if (message.type === 'roster' && Array.isArray(message.members)) {
      const members = message.members.slice(0, MAX_PEOPLE).filter(m => idPattern.test(m?.id));
      const present = new Set(members.map(m => m.id));
      for (const p of [...this.peers.values()]) { if (p.id !== this.hostId && !present.has(p.id)) this.dropPeer(p.id); }
      for (const member of members) {
        const p = this.peers.get(member.id);
        if (p) { p.name = cleanName(member.name); }
      }
      emit(this, 'change'); return;
    }
    if (message.type === 'mesh-start' && Array.isArray(message.peers)) {
      for (const member of message.peers.slice(0, MAX_PEOPLE - 2)) {
        if (!idPattern.test(member?.id) || member.id === this.id || member.id === this.hostId || this.peers.has(member.id)) continue;
        const p = this.makePeer(member.id, member.name, true);
        try {
          await this.syncPeer(p);
          await p.pc.setLocalDescription(await p.pc.createOffer());
          this.route(p.id, { desc: p.pc.localDescription.toJSON() });
        } catch (error) { this.dropPeer(p.id); emit(this, 'error', error.message); }
      }
      return;
    }
    if (message.type === 'signal' && idPattern.test(message.from) && message.from !== this.id && message.from !== this.hostId) {
      await this.receiveSignal(message.from, message.name, message.payload);
    }
  }
  sanitizeMember(member) {
    return { id: member.id, name: cleanName(member.name), mic: !!member.mic, screen: !!member.screen, camera: !!member.camera, avatar: cleanAvatar(member.avatar), screenAudio: !!member.screenAudio,screenAudioVolume:Number.isFinite(member.screenAudioVolume)?Math.max(0,Math.min(200,member.screenAudioVolume)):100,screenAudioState:['active','unavailable','off'].includes(member.screenAudioState)?member.screenAudioState:member.screenAudio?'active':'unavailable', deafened: !!member.deafened,voiceChannelId:member.voiceChannelId||null };
  }
  sendRoster() {
    if(this.externalSignal) return;
    if (this.isHost) this.broadcast({ type: 'roster', members: [this.meta, ...this.connected.map(p => ({ ...p.meta, id: p.id, name: p.name }))] });
  }
  route(to, payload) {
    if(this.externalSignal) {
      const address=this.networkAddress;
      // Use the adapter that actually carries the room connection (Radmin or LAN).
      if(address && payload.candidate && payload.candidate.candidate.split(/\s+/)[4]!==address) return;
      if(address && payload.desc) payload={...payload,desc:{...payload.desc,sdp:payload.desc.sdp.split('\r\n').filter(line=>!line.startsWith('a=candidate:') || line.split(/\s+/)[4]===address).join('\r\n')}};
      window.stringChat.sendRoomSignal({to,payload}).catch(error=>emit(this,'error',error.message)); return;
    }
    if (!this.isHost) this.send(this.peers.get(this.hostId), { type: 'route', to, payload });
  }
  async receiveSignal(id, name, payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.desc && (!['offer', 'answer'].includes(payload.desc.type) || typeof payload.desc.sdp !== 'string' || payload.desc.sdp.length > 100000)) return;
    if (payload.candidate && (typeof payload.candidate.candidate !== 'string' || payload.candidate.candidate.length > 4096)) return;
    const peer = this.peers.get(id) || this.makePeer(id, name, false);
    if (payload.desc) {
      if(payload.desc.type==='offer'&&(peer.makingOffer||peer.pc.signalingState!=='stable')){if(this.id<peer.id){peer.ignoreOffer=true;return;}peer.offerRevision=(peer.offerRevision||0)+1;if(peer.pc.signalingState!=='stable')await peer.pc.setLocalDescription({type:'rollback'});}
      if(payload.desc.type==='answer'&&peer.pc.signalingState!=='have-local-offer')return;peer.ignoreOffer=false;
      await peer.pc.setRemoteDescription(payload.desc);
      if (!peer.slots.length) this.adoptRemoteSlots(peer);
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
      if (payload.desc.type === 'offer') {
        await this.syncPeer(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.route(id, { desc: peer.pc.localDescription.toJSON() });
      }
      this.configurePeer(peer);
    } else if (payload.candidate && !peer.ignoreOffer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate);
      else if (peer.candidates.length < 80) peer.candidates.push(payload.candidate);
    }
  }
  adoptRemoteSlots(peer) {
    const slots = peer.pc.getTransceivers().filter(slot => slot.mid !== null);
    if (slots.length !== 4 || slots[0].receiver.track.kind !== 'audio' || slots[1].receiver.track.kind !== 'video' || slots[2].receiver.track.kind !== 'audio' || slots[3].receiver.track.kind !== 'video') throw new Error('Atualize o String Chat nos dois computadores para usar tela e webcam juntas.');
    peer.slots = slots;associateMedia(peer);
    for (const slot of slots) slot.direction = 'sendrecv';
  }
  async syncPeer(peer) {
    const sameVoice=!this.externalSignal || this.voiceChannelId && this.voiceChannelId===peer.meta.voiceChannelId;
    const tracks = sameVoice?[this.mic, this.screen, this.screenAudio, this.camera]:[null,null,null,null];
    await Promise.all(peer.slots.map((slot, i) => slot.sender.replaceTrack(tracks[i] || null)));
    await this.configurePeer(peer);
  }
  configurePeer(peer,strictScreen=false) {
    // Serialize get/setParameters transactions, including stats-triggered and settings updates.
    peer.paramsQueue = peer.paramsQueue.catch(() => {}).then(async () => {
      if (peer.pc.signalingState === 'closed') {if(strictScreen)throw Error('Conexão encerrada.');return;}
      for (const [i, slot] of peer.slots.entries()) {
        const sender = slot.sender;
        if (!sender.track || !peer.pc.remoteDescription) {if(strictScreen&&i===1)throw Error('Vídeo indisponível.');continue;}
        const params = sender.getParameters();
        if (!params.encodings?.length) {if(strictScreen&&i===1)throw Error('Vídeo sem codificação ativa.');continue;}
        const bitrate = i === 1 ? this.settings.bitrate * 1000000 : i === 3 ? 3000000 : i === 2 ? 256000 : 128000;
        for (const encoding of params.encodings) {
          encoding.maxBitrate = bitrate;
          if (i === 3) { encoding.maxFramerate=30; encoding.scaleResolutionDownBy=1; }
          if (i === 0 || i === 2) { encoding.priority='high';encoding.networkPriority='high'; }
          if (i === 1) { Object.assign(encoding,screenEncoding(this.settings,peer.viewerProfile,this.screen?.getSettings().height||this.settings.resolution));encoding.priority='medium';encoding.networkPriority='medium'; }
        }
        if (i === 1) params.degradationPreference = this.settings.streamPriority === 'fluid' ? 'maintain-framerate' : 'maintain-resolution';
        try { await sender.setParameters(params); }
        catch (error) {
          if(strictScreen&&i===1)throw error;
          if (error.name === 'InvalidStateError' || peer.pc.signalingState === 'closed') continue;
          emit(this, 'error', `O navegador não aplicou o limite de ${i === 1 ? 'vídeo' : 'áudio'}: ${error.message}`);
        }
      }
    });
    return peer.paramsQueue;
  }
  setPushToTalk(down){down=!!down;if(this.pttDown===down)return;this.pttDown=down;this.announce();}
  requestViewerQuality(id,profile){return requestViewerQuality.call(this,id,profile);}
  requestVideoRecovery(id,manual){return requestVideoRecovery.call(this,id,manual);}
  applyPlaybackBuffer(mode){return applyPlaybackBuffer.call(this,mode);}
  async updateTracks({ mic = this.mic, screen = this.screen, screenAudio = this.screenAudio, camera = this.camera } = {}) {
    this.mic = mic; this.screen = screen; this.screenAudio = screenAudio; this.camera = camera;
    if (this.mic) this.mic.enabled = this.meta.mic;
    const results = await Promise.allSettled([...this.peers.values()].map(p => this.syncPeer(p)));
    for (const result of results) if (result.status === 'rejected') emit(this, 'error', `Não foi possível enviar a mídia: ${result.reason.message}`);
    this.announce();
  }
  announce() {
    if (this.mic) this.mic.enabled = this.meta.mic;
    this.broadcast({ type: 'state', member: this.meta }); this.sendRoster(); emit(this, 'change');
  }
  sendChat(text) {
    text = text.trim(); if (!text || text.length > 2000) return false;
    if(this.externalSignal) {window.stringChat.sendGroupChat({channelId:this.textChannelId||'text-geral',text}).catch(error=>emit(this,'error',error.message));return true;}
    if (!this.connected.length) throw new Error('Conecte um amigo antes de enviar uma mensagem.');
    // Wait for a complete mesh so a message cannot appear delivered to absent connections.
    if ([...this.peers.values()].some(p => !p.manual && !p.admitted)) throw new Error('Aguarde a conexão com todos os amigos terminar.');
    const id = uid(); let delivered = 0;
    for (const peer of this.connected) if (this.send(peer, { type: 'chat', id, text })) delivered++;
    if (!delivered) throw new Error('A conexão está ocupada. Tente enviar de novo.');
    emit(this, 'chat', { id, name: this.meta.name, text, time: Date.now(), self: true }); return true;
  }
  connectionFailed(peer,channelClosed=false) {
    if (!this.peers.has(peer.id) || peer.pc.connectionState === 'connected' && !channelClosed) return;
    if(this.externalSignal) {
      if(!peer.initiator || peer.recoveryTimer) return;
      const count=this.recoveries.get(peer.id)||0;
      if(count>=3) { emit(this,'error',`Não há rota de mídia para ${peer.name}. Confira o Radmin e a permissão do String Chat no Firewall.`); return; }
      peer.recoveryTimer=setTimeout(async()=>{
        if(!this.externalSignal || !this.peers.has(peer.id)) return;
        this.recoveries.set(peer.id,count+1);
        const {id,name}=peer; this.dropPeer(id); this.route(id,{reset:true});
        const next=this.makePeer(id,name,true);
        try { await this.syncPeer(next); await next.pc.setLocalDescription(await next.pc.createOffer()); this.route(id,{desc:next.pc.localDescription.toJSON()}); }
        catch(error) { emit(this,'error',error.message); }
      },1500);
      emit(this,'change'); return;
    }
    if (!peer.manual && peer.initiator && peer.restarts < 2 && this.peers.get(this.hostId)?.channel?.readyState === 'open') {
      peer.restarts++;
      peer.queue = peer.queue.then(async () => {
        await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
        this.route(peer.id, { desc: peer.pc.localDescription.toJSON() });
      }).catch(() => this.dropPeer(peer.id));
      return;
    }
    if (peer.id === this.hostId && !this.isHost) { this.leave(); emit(this, 'ended', 'Conexão com o criador perdida. Peça outro convite; em redes restritivas, use VPN ou TURN.'); }
    else { this.dropPeer(peer.id); emit(this, 'error', `A conexão com ${peer.name} falhou. Tente um novo convite ou use VPN / TURN.`); }
  }
  dropPeer(id, reason) {
    const peer = this.peers.get(id); if (!peer) return;
    if(peer.qualityRequest){clearTimeout(peer.qualityRequest.timer);peer.qualityRequest.reject(Error('O participante saiu.'));peer.qualityRequest=null;}
    this.peers.delete(id); clearTimeout(peer.expireTimer); clearTimeout(peer.connectTimer); clearTimeout(peer.disconnectTimer); clearTimeout(peer.recoveryTimer);
    peer.channel?.close(); peer.pc.close();
    emit(this, 'peerremoved', id); if (reason && peer.admitted) emit(this, 'memberleft', reason);
    if (this.isHost) this.sendRoster(); emit(this, 'change');
  }
  leave() {
    if(this.externalSignal) window.stringChat.leaveRoom().catch(()=>{});
    this.externalSignal=false; this.networkAddress=null; this.networkInfo=null; this.networkStatus=null; this.recoveries.clear();
    if (this.isHost) this.broadcast({ type: 'room-ended' });
    this.generation++; this.room = null; this.isHost = false; this.hostId = null; this.startedAt = null;
    for (const peer of [...this.peers.values()]) this.dropPeer(peer.id);
    for (const track of [this.mic, this.screen, this.screenAudio, this.camera]) track?.stop();
    this.mic = this.screen = this.screenAudio = this.camera = null; this.pttDown=false;this.micOn = false; this.deafened = false; this.chatSeen.clear(); this.id = this.selfIdentity;
    emit(this, 'change');
  }
  async readStats() {
    const result = [];
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState === 'closed') continue;
      try {
        const reports = await peer.pc.getStats();
        const sample = { id: peer.id, name: peer.name, state: peer.pc.connectionState, up: 0, down: 0, fpsOut: null, fpsIn: null, widthOut: null, heightOut: null, widthIn: null, heightIn: null, rtt: null, loss: null, codec: null, limitation: null, route: null, videoTarget: this.settings.bitrate };
        let packetsLost = 0, packetsReceived = 0;sample.audioJitterMs=null;sample.videoJitterMs=null;sample.availableUpload=null;sample.encoderMs=null;
        for (const report of reports.values()) {
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            const pair = reports.get(report.selectedCandidatePairId);
            if(pair)sample.availableUpload=pair.availableOutgoingBitrate?pair.availableOutgoingBitrate/1000000:null;
            if (pair) { sample.rtt = pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null; const local = reports.get(pair.localCandidateId), remote = reports.get(pair.remoteCandidateId); sample.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN (retransmitido)' : `${(local?.address||'').startsWith('26.') || (remote?.address||'').startsWith('26.') ? 'Radmin' : 'Direta'} · ${local?.protocol?.toUpperCase() || 'P2P'}`; }
          }
          if (!['outbound-rtp', 'inbound-rtp'].includes(report.type) || report.isRemote) continue;
          const outbound = report.type === 'outbound-rtp';
          const bytes = outbound ? report.bytesSent : report.bytesReceived;
          const previous = peer.previousStats.get(report.id);
          if (previous && bytes >= previous.bytes && report.timestamp > previous.time) {
            const rate = (bytes - previous.bytes) * 8 / ((report.timestamp - previous.time) * 1000);
            sample[outbound ? 'up' : 'down'] += rate;
          }
          if(!outbound&&report.jitterBufferEmittedCount>(previous?.jitterCount||0)){const count=report.jitterBufferEmittedCount-(previous?.jitterCount||0),delay=(report.jitterBufferDelay||0)-(previous?.jitterDelay||0);if(report.mid===peer.slots[1]?.mid)sample.videoJitterMs=1000*delay/count;if(report.mid===peer.slots[2]?.mid)sample.audioJitterMs=1000*delay/count;}
          peer.previousStats.set(report.id, { bytes: bytes || 0, time: report.timestamp,jitterCount:report.jitterBufferEmittedCount||0,jitterDelay:report.jitterBufferDelay||0,frames:report.framesEncoded||0,encodeTime:report.totalEncodeTime||0 });
          if (!outbound) { packetsLost += Math.max(0, report.packetsLost || 0); packetsReceived += report.packetsReceived || 0; }
          if ((report.kind === 'video' || report.mediaType === 'video') && report.mid === peer.slots[1]?.mid) {
            sample[outbound ? 'fpsOut' : 'fpsIn'] = report.framesPerSecond ?? null;
            sample[outbound ? 'widthOut' : 'widthIn'] = report.frameWidth ?? null;
            sample[outbound ? 'heightOut' : 'heightIn'] = report.frameHeight ?? null;
            if (outbound){sample.limitation=report.qualityLimitationReason;const frames=report.framesEncoded-(previous?.frames||0);if(frames>0)sample.encoderMs=1000*((report.totalEncodeTime||0)-(previous?.encodeTime||0))/frames;}
            const codec = reports.get(report.codecId); if (codec) sample.codec = codec.mimeType.replace('video/', '');
          }
        }
        if (packetsReceived + packetsLost) sample.loss = 100 * packetsLost / (packetsReceived + packetsLost);
        peer.stats = sample; result.push(sample);
      } catch { /* A peer can leave between the snapshot and getStats. */ }
    }
    return result;
  }
}
