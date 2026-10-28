import net from 'node:net';
import {cleanAvatar} from './profile.js';
import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { randomBytes, createCipheriv, createDecipheriv,createHash } from 'node:crypto';
import { readFileSync,writeFileSync,renameSync,mkdirSync,unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {GROUP_PERMISSIONS,groupRank,normalizeGroup,hasGroupPermission,assertGroupPermission,assertModerationTarget,cleanChannelRules,loadGroupIdentity,groupSignature,verifyGroupSignature,groupEphemeral,groupSessionKey} from './group-policy.mjs';

const MAX_FRAME = 220000, MAX_MEMBERS = 6;
const MAX_FILE=8*1024*1024;
function fileType(data){if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(data[0]===255&&data[1]===216&&data[2]===255)return'image/jpeg';if(/^GIF8[79]a$/.test(data.subarray(0,6).toString()))return'image/gif';if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return'image/webp';return'application/octet-stream';}
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const member = value => {
  if (!validId(value?.id)) throw new Error('Identificação inválida. Reinicie o programa.');
  return { id: value.id, avatar:cleanAvatar(value.avatar), name: String(value.name || 'Amigo').trim().slice(0,32) || 'Amigo', voiceChannelId:typeof value.voiceChannelId==='string'?value.voiceChannelId:null };
};
const defaultChannels=()=>[{id:'text-geral',kind:'text',name:'geral'},{id:'text-links',kind:'text',name:'links'},{id:'voice-lobby',kind:'voice',name:'Lobby'},{id:'voice-jogos',kind:'voice',name:'Jogos'},{id:'voice-cinema',kind:'voice',name:'Cinema'}];
export function listInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, values]) => values.filter(value => value.family === 'IPv4' && !value.internal).map(value => ({ name, address: value.address, kind: /radmin|famatech/i.test(name) || value.address.startsWith('26.') ? 'radmin' : 'lan' }))).sort((a,b) => Number(b.kind === 'radmin') - Number(a.kind === 'radmin'));
}
export function parseInvite(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Cole o convite completo que seu amigo enviou.'); }
  const host = url.searchParams.get('host'), port = Number(url.searchParams.get('port')), token = url.searchParams.get('key'), roomId = url.searchParams.get('room');
  const octets = host?.split('.').map(Number);
  const privateHost = octets?.length === 4 && octets.every((n,i) => Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === host.split('.')[i]) && (octets[0] === 26 || octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  if (!['stringchat:'].includes(url.protocol) || url.hostname !== 'join' || !privateHost || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token || '') || !validId(roomId)) throw new Error('Convite incompatível. Copie um convite válido do String Chat.');
  return { host, port, token, roomId };
}
export function makeWire(socket, token, onMessage, onError) {
  let key = Buffer.from(token, 'base64url'); let buffer = '', ended = false;
  const seen = new Set(); socket.setNoDelay(true); socket.setKeepAlive(true,5000);
  const fail = () => { if (ended) return; ended = true; onError(); socket.destroy(); };
  socket.on('error', fail);
  socket.on('data', bytes => {
    buffer += bytes.toString('utf8');
    if (buffer.length > MAX_FRAME) { fail(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0 && !ended) {
      const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
      try {
        const frame = JSON.parse(line);
        if (typeof frame.n !== 'string' || typeof frame.d !== 'string' || typeof frame.t !== 'string' || seen.has(frame.n)) throw new Error('Frame inválido');
        const nonce = Buffer.from(frame.n,'base64url'), tag = Buffer.from(frame.t,'base64url');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error('Frame inválido');
        const decipher = createDecipheriv('aes-256-gcm',key,nonce); decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(Buffer.from(frame.d,'base64url')),decipher.final()]);
        if (plain.length > 150000) throw new Error('Mensagem grande demais');
        seen.add(frame.n); if (seen.size > 2048) seen.delete(seen.values().next().value);
        onMessage(JSON.parse(plain.toString('utf8')));
      } catch { fail(); return; }
    }
  });
  return {
    setKey(value){if(!Buffer.isBuffer(value)||value.length!==32)throw Error('Chave de conexão inválida.');key=Buffer.from(value);seen.clear();},
    async sendAsync(message){if(socket.destroyed)throw new Error('Conexão interrompida.');if(socket.writableLength>128000)await new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(new Error('Conexão interrompida.'));};const cleanup=()=>{socket.off('drain',done);socket.off('close',fail);};socket.once('drain',done);socket.once('close',fail);});if(!this.send(message))throw new Error('Não foi possível transferir o arquivo.');},
    send(message) {
      if (socket.destroyed || ended) return false;
      const plain = Buffer.from(JSON.stringify(message)); if (plain.length > 150000 || socket.writableLength > 1024*1024) { fail(); return false; }
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce);
      const data = Buffer.concat([cipher.update(plain),cipher.final()]);
      socket.write(JSON.stringify({ n: nonce.toString('base64url'), d: data.toString('base64url'), t: cipher.getAuthTag().toString('base64url') })+'\n'); return true;
    }
  };
}

export class RoomService extends EventEmitter {
  constructor({statePath=null,serverHost=false}={}) { super(); this.statePath=statePath;this.serverHost=serverHost;this.privateCallsVersion=1;this.transient=false;this.allowedMembers=null; this.history=[];this.mediaMemory=new Map();this.pendingReads=new Map();this.pendingUploads=new Map();this.pendingCommands=new Map();this.commandCache=new Map();this.typingTimers=new Map();this.bindings={};this.identity=null; this.mode = null; this.server = null; this.socket = null; this.clients = new Map(); this.generation = 0; this.info = null; this.retryTimer = null; this.reconnectingSince = null; this.sockets = new Set(); }
  roomIdentities(){return this.serverHost?[...this.clients.values()]:[this.me,...this.clients.values()].filter(Boolean);}
  privateIdentity(){this.identity||=loadGroupIdentity(this.statePath);return this.identity.publicKey;}
  persist() {
    if(!this.statePath || this.mode!=='host'||this.transient) return;
    mkdirSync(dirname(this.statePath),{recursive:true});
    writeFileSync(this.statePath+'.tmp',JSON.stringify({room:this.room,token:this.token,port:this.info?.port,history:this.history,bindings:this.bindings,ownerKey:this.identity?.publicKey})); renameSync(this.statePath+'.tmp',this.statePath);
  }
  sendHistory(wire=null,identity=this.me) { const history=this.history.filter(m=>this.can(identity,'read',m.channelId));for(let i=0;i<history.length;i+=20) { const event={type:'history',messages:history.slice(i,i+20)}; if(wire) wire.send(event); else this.emit('event',event); } }
  pruneHistory(){while(this.history.length>200){const old=this.history.shift();if(old?.attachment){this.mediaMemory.delete(old.attachment.id);const file=this.attachmentPath(old.attachment.id);if(file)try{unlinkSync(file);}catch{}}}}
  async create({ room, member: input, address,transient=false,allowedMembers=null }) {
    if (this.mode === 'host') return this.info;
    if (this.mode) throw new Error('Você já está em uma sala.');
    const me = member(input),generation=this.generation;
    if (!validId(room?.id)) throw new Error('Sala inválida.');
    const addresses = listInterfaces();
    address ||= addresses[0]?.address;
    if (!address || !(addresses.some(item => item.address === address) || address === '127.0.0.1')) throw new Error('Nenhuma rede disponível. Ligue o Radmin VPN e tente novamente.');
    const direct=room.kind==='direct';if(direct){if(!transient||!validId(room.callId)||room.callId!==room.id||!allowedMembers||typeof allowedMembers!=='object'||Object.keys(allowedMembers).length!==2||!Object.keys(allowedMembers).every(validId)||!allowedMembers[me.id]||!Object.values(allowedMembers).every(key=>typeof key==='string'&&key.length<128))throw Error('Chamada privada precisa de duas identidades autorizadas.');}else if(transient||allowedMembers)throw Error('Opções de chamada privada inválidas.');
    let saved=null;if(!transient)try { saved=JSON.parse(readFileSync(this.statePath,'utf8')); } catch {}
    this.identity ||= loadGroupIdentity(this.statePath);
    if(direct&&allowedMembers[me.id]!==this.identity.publicKey)throw Error('A chave do dono não corresponde à chamada privada.');
    if(saved?.ownerKey&&saved.ownerKey!==this.identity.publicKey)throw Error('A chave do dono mudou. O grupo anterior foi preservado.');
    if(saved?.room?.ownerId&&saved.room.ownerId!==me.id)throw Error('Este perfil não é o dono do grupo salvo.');
    this.transient=transient;this.allowedMembers=direct?{...allowedMembers}:null;
    this.mode = 'host'; this.me = me; this.room = normalizeGroup({...saved?.room,...(direct?{kind:'direct',callId:room.callId}:{}),id:validId(saved?.room?.id)?saved.room.id:room.id, name:String(room.name&&room.name!=='Grupo da galera'?room.name:saved?.room?.name||room.name||'Grupo da galera').slice(0,40),channels:direct?room.channels:Array.isArray(saved?.room?.channels)?saved.room.channels:defaultChannels()},me.id);
    this.bindings=Object.fromEntries(Object.entries(saved?.bindings||{}).filter(([id,key])=>validId(id)&&typeof key==='string'&&key.length<128).slice(-512));this.bindings[me.id]=this.identity.publicKey;
    if(me.voiceChannelId!==null&&!this.room.channels.some(c=>c.id===me.voiceChannelId&&c.kind==='voice')) me.voiceChannelId=this.room.channels.find(c=>c.kind==='voice')?.id||null;
    this.history=Array.isArray(saved?.history)?saved.history.slice(-200):[];
    this.token = /^[A-Za-z0-9_-]{43}$/.test(saved?.token||'')?saved.token:randomBytes(32).toString('base64url'); this.localAddress = address;
    this.server = net.createServer(socket => this.accept(socket));this.server.maxConnections=32;const server=this.server;
    const preferredPort=Number.isInteger(saved?.port)&&saved.port>0&&saved.port<=65535?saved.port:0;
    try { await new Promise((resolve,reject) => {this.pendingCreate={server,reject};const failed=error=>{if(generation!==this.generation){reject(Error('A criação da chamada foi cancelada.'));return;}if(error.code==='EADDRINUSE'&&preferredPort){server.once('error',reject);server.listen(0,address,resolve);}else reject(error);};server.once('error',failed);server.listen(preferredPort,address,resolve); }); }
    catch (error) { const canceled=generation!==this.generation||this.server!==server;if(!canceled)this.leave();if(canceled)throw Error('A criação da chamada foi cancelada.');throw new Error(`Não foi possível abrir a sala na rede escolhida (${error.code}).`); }
    finally{if(this.pendingCreate?.server===server)this.pendingCreate=null;}
    if(generation!==this.generation||this.mode!=='host'||this.server!==server){server.close();throw Error('A criação da chamada foi cancelada.');}
    this.server.on('error', () => this.emit('event',{type:'network-error',message:'A rede da sala ficou indisponível. Confira o Radmin.'}));
    const port = this.server.address().port;
    const url = new URL('stringchat://join'); url.searchParams.set('host',address); url.searchParams.set('port',port); url.searchParams.set('room',this.room.id); url.searchParams.set('key',this.token);
    this.info = { invite:url.toString(), address, port, localAddress:address, room:this.roomFor(me),selfMember:this.publicMember(me),hostKey:this.identity.publicKey,private:direct, hostId:me.id, selfId:me.id, kind:address.startsWith('26.')?'radmin':'lan' };
    this.persist(); this.emit('event',{type:'hosting',...this.info}); this.sendHistory(); return this.info;
  }
  accept(socket) {
    this.sockets.add(socket); socket.once('close',()=>this.sockets.delete(socket));
    let entry = null, pings = 0, windowStart = Date.now();const nonce=randomBytes(32).toString('base64url'),ephemeral=groupEphemeral();
    const deadline = setTimeout(()=>socket.destroy(),8000);
    const wire = makeWire(socket,this.token,message => {
      if (Date.now()-windowStart>1000) { pings=0; windowStart=Date.now(); }
      if (++pings>1000) { socket.destroy(); return; }
      if (!entry) {
        if (message.type !== 'hello' || message.roomId !== this.room?.id) { socket.destroy(); return; }
        let identity; try { identity=member(message.member); } catch { socket.destroy(); return; }
        try{if(typeof message.ephemeralKey!=='string'||message.ephemeralKey.length>128)throw Error();wire.setKey(groupSessionKey(ephemeral,message.ephemeralKey,this.token,[this.room.id,nonce,identity.id,this.me.id]));}catch{socket.destroy();return;}
        if(this.allowedMembers&&this.allowedMembers[identity.id]!==message.publicKey){wire.send({type:'rejected',message:'Esta chamada é privada para os dois participantes convidados.'});socket.end();return;}
        const fields=['join',this.room.id,nonce,identity.id,this.me.id,ephemeral.publicKey,message.ephemeralKey];
        if(this.room.bans.some(b=>b.id===identity.id)){wire.send({type:'rejected',message:'Você foi banido deste grupo.'});socket.end();return;}
        if(message.nonce!==nonce||!verifyGroupSignature(message.publicKey,fields,message.proof)||(this.bindings[identity.id]&&this.bindings[identity.id]!==message.publicKey)){wire.send({type:'rejected',message:'A identidade deste participante não corresponde à chave conhecida.'});socket.end();return;}
        if(!this.bindings[identity.id]&&Object.keys(this.bindings).length>=512){wire.send({type:'rejected',message:'O grupo atingiu o limite de identidades registradas.'});socket.end();return;}
        if (identity.id===this.me.id || this.clients.size>=(this.room.kind==='direct'?1:MAX_MEMBERS-1) && !this.clients.has(identity.id)) { wire.send({type:'rejected',message:'A sala atingiu o limite de participantes.'}); socket.end(); return; }
        const previous = this.clients.get(identity.id); const resumed=!!previous;
        if (previous) { clearTimeout(previous.expiry);clearTimeout(previous.mediaTimer); if (previous.socket && previous.socket!==socket) previous.socket.destroy(); }
        this.bindings[identity.id]=message.publicKey;this.room.memberships[identity.id]||={roleIds:['member'],nickname:'',timeoutUntil:0};
        entry = { ...identity,_mediaState:previous?._mediaState||{},socket,wire }; this.clients.set(entry.id,entry); clearTimeout(deadline);
        if(entry.voiceChannelId!==null&&(!this.room.channels.some(c=>c.id===entry.voiceChannelId&&c.kind==='voice')||!this.can(entry,'connect',entry.voiceChannelId))) entry.voiceChannelId=null;
        this.persist();
        wire.send({type:'welcome',protocol:2,room:this.roomFor(entry),hostId:this.me.id,selfId:entry.id,selfMember:this.publicMember(entry),selfVoiceChannelId:entry.voiceChannelId,resumed,members:[this.publicMember(this.me),...[...this.clients.values()].filter(p=>p.id!==entry.id).map(p=>this.publicMember(p))]});
        this.sendHistory(wire,entry);
        this.broadcast({type:resumed?'member-back':'member-added',member:this.publicMember(entry)},entry.id); return;
      }
      if(this.clients.get(entry.id)?.socket!==socket)return;
      if (message.type==='signal' && validId(message.to) && message.to!==entry.id && message.payload && typeof message.payload==='object') {
        if(!this.canSignal(entry,message.to))return;
        const event={type:'signal',from:entry.id,name:entry.name,payload:message.payload};
        if (message.to===this.me.id) this.emit('event',event); else this.clients.get(message.to)?.wire.send(event);
      } else if (message.type==='ping') wire.send({type:'pong'});
      else if (message.type==='leave') { this.remove(entry.id,socket); socket.end(); }
      else if(message.type==='voice-change') this.runCommand(entry,message,()=>this.updateVoice(entry,message.channelId));
      else if(message.type==='chat') this.runCommand(entry,message,()=>this.acceptChat(entry,message));
      else if(message.type==='manage')this.runCommand(entry,message,()=>this.manageHost(entry,message.payload));
      else if(message.type==='message-action')this.runCommand(entry,message,()=>this.messageActionHost(entry,message.payload));
      else if(message.type==='typing')this.runCommand(entry,message,()=>this.setTyping(entry,message));
      else if(message.type==='media-state')this.runCommand(entry,message,()=>this.updateMediaState(entry,message));
      else if(message.type==='profile-change'){entry.name=String(message.name||'Amigo').trim().slice(0,32)||'Amigo';entry.avatar=cleanAvatar(message.avatar);this.broadcast({type:'member-updated',member:this.publicMember(entry)});}
      else if(message.type==='media-start')this.beginUpload(entry,message);
      else if(message.type==='media-chunk')this.uploadChunk(entry,message);
      else if(message.type==='media-end')this.endUpload(entry,message);
      else if(message.type==='media-get'&&validId(message.id)){entry.fileQueue=(entry.fileQueue||Promise.resolve()).then(()=>this.streamFile(wire,message.id,entry)).catch(()=>wire.send({type:'media-error',id:message.id,message:'Arquivo indisponível no computador do criador.'}));}
    },()=>{});
    wire.send({type:'challenge',protocol:2,nonce,roomId:this.room.id,roomKind:this.room.kind,callId:this.room.callId||null,hostId:this.me.id,publicKey:this.identity.publicKey,ephemeralKey:ephemeral.publicKey,proof:groupSignature(this.identity,['host',this.room.id,nonce,this.me.id,ephemeral.publicKey,this.room.kind,this.room.callId||''])});
    socket.once('close',()=>{
      clearTimeout(deadline);
      if(entry?.upload){clearTimeout(entry.upload.timer);entry.upload=null;}
      if (!entry || this.clients.get(entry.id)?.socket!==socket) return;
      entry.socket=null;
      entry.expiry=setTimeout(()=>this.remove(entry.id,null),30000);
    });
  }
  remove(id,socket) {
    const entry=this.clients.get(id); if (!entry || entry.socket!==socket) return;
    clearTimeout(entry.expiry);clearTimeout(entry.mediaTimer); this.clients.delete(id);this.clearTyping(id); this.broadcast({type:'member-left',id,name:entry.name});
  }
  can(identity,permission,channelId=null){const channel=channelId===null?null:this.room?.channels.find(c=>c.id===channelId);return!!this.room&&(!channelId||!!channel)&&hasGroupPermission(this.room,identity.id,permission,channel);}
  publicMember(identity){const membership=this.room?.memberships[identity.id],media=identity._mediaState||{},serverMuted=membership?.serverMuted===true,serverDeafened=membership?.serverDeafened===true,connected=!!identity.voiceChannelId&&this.can(identity,'connect',identity.voiceChannelId),deafened=media.deafened===true||serverDeafened,screen=connected&&media.screen===true;return{id:identity.id,name:identity.name,avatar:identity.avatar,voiceChannelId:identity.voiceChannelId,roleIds:membership?.roleIds||['member'],rolePosition:identity.id===this.room.ownerId?1000:groupRank(this.room,identity.id),nickname:membership?.nickname||'',timeoutUntil:membership?.timeoutUntil||0,serverMuted,serverDeafened,mic:connected&&media.mic===true&&!serverMuted&&!deafened,deafened,screen,camera:connected&&media.camera===true,screenAudio:screen&&media.screenAudio===true};}
  roomFor(identity){const capabilities=Object.fromEntries(GROUP_PERMISSIONS.map(permission=>[permission,this.can(identity,permission)]));capabilities.manageRoles=identity.id===this.room.ownerId;const channels=this.room.channels.filter(c=>this.can(identity,'read',c.id)).map(channel=>({...channel,capabilities:Object.fromEntries(['read','send','react','connect'].map(permission=>[permission,this.can(identity,permission,channel.id)]))}));const room={...this.room,capabilities,channels,categories:this.room.categories.filter(category=>capabilities.manageChannels||channels.some(channel=>channel.categoryId===category.id))};if(!this.can(identity,'moderateMembers'))delete room.bans;return room;}
  broadcast(event,except=null) {
    const ownEvent=event.type==='room-updated'?{...event,room:this.roomFor(this.me)}:event.type==='channels-updated'?{...event,channels:this.roomFor(this.me).channels}:event;this.emit('event',ownEvent);
    for(const peer of this.clients.values()){
      if(peer.id===except)continue;
      const channelId=event.message?.channelId||event.channelId;
      if(channelId&&!this.can(peer,'read',channelId))continue;
      if(event.type==='room-updated')peer.wire.send({...event,room:this.roomFor(peer)});
      else if(event.type==='channels-updated')peer.wire.send({...event,channels:this.roomFor(peer).channels});
      else peer.wire.send(event);
    }
  }
  attachmentPath(id){if(!validId(id))throw new Error('Arquivo inválido.');return this.statePath?`${dirname(this.statePath)}/media/${id}.bin`:null;}
  findAttachment(id){return this.history.find(item=>item.attachment?.id===id)?.attachment;}
  readFile(id){const attachment=this.findAttachment(id);if(!attachment)throw new Error('Arquivo não encontrado.');const data=this.mediaMemory.get(id)||readFileSync(this.attachmentPath(id));if(data.length!==attachment.size||data.length>MAX_FILE)throw new Error('Arquivo inválido.');return{...attachment,data};}
  storeAttachment(identity,{name,channelId,uploadId},data){
    if(!data.length||data.length>MAX_FILE||!this.room.channels.some(c=>c.id===channelId&&c.kind==='text'))throw new Error('Arquivo inválido. O limite é 8 MB.');
    this.assertSend(identity,channelId);
    const id=randomBytes(16).toString('hex'),filename=String(name||'arquivo').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,120)||'arquivo';
    const attachment={id,name:filename,mime:fileType(data),size:data.length};const file=this.attachmentPath(id);
    if(file){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,data);}else this.mediaMemory.set(id,Buffer.from(data));
    const item={id:randomBytes(16).toString('hex'),authorId:identity.id,name:identity.name,text:'',channelId,time:Date.now(),revision:0,attachment,uploadId};this.history.push(item);this.noteSend(identity,channelId);
    let total=this.history.reduce((sum,m)=>sum+(m.attachment?.size||0),0);
    while(this.history.length>200||total>128*1024*1024){const old=this.history.shift();if(old?.attachment){total-=old.attachment.size;this.mediaMemory.delete(old.attachment.id);const oldFile=this.attachmentPath(old.attachment.id);if(oldFile)try{unlinkSync(oldFile);}catch{}}}
    this.persist();this.broadcast({type:'chat',message:item});return item;
  }
  beginUpload(entry,message){
    if(!this.can(entry,'send',message.channelId)){entry.wire.send({type:'upload-error',uploadId:message.uploadId,message:'Você não pode enviar neste canal.'});return;}
    if(entry.upload||!validId(message.uploadId)||!Number.isInteger(message.size)||message.size<1||message.size>MAX_FILE||!this.room.channels.some(c=>c.id===message.channelId&&c.kind==='text')){entry.wire.send({type:'upload-error',uploadId:message.uploadId,message:'Escolha um arquivo de até 8 MB em um canal de texto.'});return;}
    entry.upload={id:message.uploadId,size:message.size,name:String(message.name||'arquivo').slice(0,120),channelId:message.channelId,chunks:[],received:0,timer:setTimeout(()=>{entry.upload=null;entry.wire.send({type:'upload-error',uploadId:message.uploadId,message:'O envio demorou demais. Tente novamente.'});},120000)};
  }
  uploadChunk(entry,message){const upload=entry.upload;if(!upload||upload.id!==message.uploadId||typeof message.data!=='string'||message.data.length>33000)return;const bytes=Buffer.from(message.data,'base64');if(upload.received+bytes.length>upload.size){clearTimeout(upload.timer);entry.upload=null;return;}upload.chunks.push(bytes);upload.received+=bytes.length;}
  endUpload(entry,message){const upload=entry.upload;if(!upload||upload.id!==message.uploadId)return;clearTimeout(upload.timer);entry.upload=null;try{if(upload.received!==upload.size)throw new Error('Arquivo incompleto.');this.storeAttachment(entry,{...upload,uploadId:upload.id},Buffer.concat(upload.chunks));}catch(error){entry.wire.send({type:'upload-error',uploadId:upload.id,message:error.message});}}
  async sendAttachment({channelId,name,data}){
    data=Buffer.from(data);if(!data.length||data.length>MAX_FILE)throw new Error('O limite por arquivo é 8 MB.');
    const uploadId=randomBytes(16).toString('hex');if(this.mode==='host')return this.storeAttachment(this.me,{channelId,name,uploadId},data);
    if(this.mode!=='guest'||this.socket?.destroyed)throw new Error('Aguarde a conexão com o grupo.');
    const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pendingUploads.delete(uploadId);reject(new Error('O envio não foi confirmado.'));},120000);this.pendingUploads.set(uploadId,{resolve,reject,timer});});
    result.catch(()=>{});
    try{await this.wire.sendAsync({type:'media-start',uploadId,channelId,name,size:data.length});for(let i=0;i<data.length;i+=24000)await this.wire.sendAsync({type:'media-chunk',uploadId,data:data.subarray(i,i+24000).toString('base64')});await this.wire.sendAsync({type:'media-end',uploadId});}catch(error){const pending=this.pendingUploads.get(uploadId);if(pending){clearTimeout(pending.timer);this.pendingUploads.delete(uploadId);pending.reject(error);}}
    return result;
  }
  async streamFile(wire,id,identity=this.me){const item=this.history.find(m=>m.attachment?.id===id);if(!item||item.deleted||!this.can(identity,'read',item.channelId))throw Error('Arquivo indisponível.');const file=this.readFile(id);await wire.sendAsync({type:'media-data-start',id,size:file.size,mime:file.mime,name:file.name});for(let i=0;i<file.data.length;i+=24000){if(!this.can(identity,'read',item.channelId)||item.deleted)throw Error('Acesso ao arquivo removido.');await wire.sendAsync({type:'media-data-chunk',id,data:file.data.subarray(i,i+24000).toString('base64')});}await wire.sendAsync({type:'media-data-end',id});}
  async getAttachment(id){if(!validId(id))throw new Error('Arquivo inválido.');if(this.mode==='host')return this.readFile(id);if(this.mode!=='guest'||this.socket?.destroyed)throw new Error('O grupo está desconectado.');if(this.pendingReads.has(id))return this.pendingReads.get(id).promise;const pending={chunks:[],received:0};pending.promise=new Promise((resolve,reject)=>{pending.resolve=resolve;pending.reject=reject;pending.timer=setTimeout(()=>{this.pendingReads.delete(id);reject(new Error('Não foi possível carregar o arquivo.'));},120000);});this.pendingReads.set(id,pending);this.wire.send({type:'media-get',id});return pending.promise;}
  receiveFile(event){const pending=this.pendingReads.get(event.id);if(!pending)return;
    if(event.type==='media-error'){clearTimeout(pending.timer);this.pendingReads.delete(event.id);pending.reject(new Error(event.message));return;}
    if(event.type==='media-data-start'){if(!Number.isInteger(event.size)||event.size<1||event.size>MAX_FILE){pending.reject(new Error('Arquivo grande demais.'));return;}pending.meta={id:event.id,size:event.size,name:event.name,mime:event.mime};}
    else if(event.type==='media-data-chunk'&&pending.meta&&typeof event.data==='string'&&event.data.length<33000){const bytes=Buffer.from(event.data,'base64');pending.received+=bytes.length;if(pending.received<=pending.meta.size)pending.chunks.push(bytes);}
    else if(event.type==='media-data-end'){clearTimeout(pending.timer);this.pendingReads.delete(event.id);if(pending.meta&&pending.received===pending.meta.size){const data=Buffer.concat(pending.chunks);pending.resolve({...pending.meta,mime:fileType(data),data});}else pending.reject(new Error('Arquivo incompleto.'));}
  }
  updateVoice(identity,channelId) {
    if(channelId!==null && !this.room.channels.some(c=>c.id===channelId&&c.kind==='voice')) throw new Error('Canal de voz não encontrado.');
    if(channelId!==null)assertGroupPermission(this.room,identity.id,'connect',this.room.channels.find(c=>c.id===channelId));
    identity.voiceChannelId=channelId; this.broadcast({type:'member-updated',member:this.publicMember(identity)});return this.publicMember(identity);
  }
  voice(channelId) {
    if(this.mode==='host') return this.updateVoice(this.me,channelId);
    else if(this.mode==='guest') return this.requestCommand('voice-change',{channelId});
  }
  setName(name,avatar=this.me?.avatar){if(!this.me)return;this.me.avatar=cleanAvatar(avatar);this.me.name=String(name||'Amigo').trim().slice(0,32)||'Amigo';if(this.mode==='host')this.broadcast({type:'member-updated',member:this.publicMember(this.me)});else if(this.mode==='guest')this.wire?.send({type:'profile-change',name:this.me.name,avatar:this.me.avatar});}
  createChannel({kind,name}) {
    if(this.mode==='host')return this.manageHost(this.me,{action:'channel-create',kind,name});
    if(this.mode==='guest')return this.manage({action:'channel-create',kind,name});
    throw Error('Entre em um grupo antes de criar canais.');
  }
  requestCommand(type,payload){
    if(this.mode!=='guest'||this.socket?.destroyed||!this.wire) return Promise.reject(Error('Aguarde a conexão com o grupo.'));
    const requestId=randomBytes(16).toString('hex');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pendingCommands.delete(requestId);reject(Error('O criador não confirmou a ação.'));},10000);this.pendingCommands.set(requestId,{resolve,reject,timer});if(!this.wire.send({type,requestId,...(type==='manage'||type==='message-action'?{payload}:payload)})){clearTimeout(timer);this.pendingCommands.delete(requestId);reject(Error('Não foi possível enviar a ação.'));}});
  }
  runCommand(identity,message,action){
    const id=validId(message.requestId)?message.requestId:null,key=id?identity.id+':'+id:null,fingerprint=createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const previous=key?this.commandCache.get(key):null;if(previous&&Date.now()-previous.time<300000){identity.wire?.send(previous.fingerprint===fingerprint?previous.event:{type:'command-result',requestId:id,ok:false,error:'Este identificador de ação já foi usado.'});return;}
    let event;try{const result=action();event={type:'command-result',requestId:id,ok:true,result:result??true};}catch(error){event={type:'command-result',requestId:id,ok:false,error:String(error.message||error).slice(0,180)};}
    if(key){event=JSON.parse(JSON.stringify(event));this.commandCache.set(key,{event,fingerprint,time:Date.now()});while(this.commandCache.size>512)this.commandCache.delete(this.commandCache.keys().next().value);identity.wire?.send(event);}else if(!event.ok)identity.wire?.send({type:'network-error',message:event.error});
  }
  manage(payload){if(this.mode==='host')return this.manageHost(this.me,payload);if(this.mode==='guest')return this.requestCommand('manage',payload);throw Error('Entre em um grupo.');}
  changed(){this.room.revision++;for(const identity of this.roomIdentities())if(identity.voiceChannelId&&!this.can(identity,'connect',identity.voiceChannelId))this.updateVoice(identity,null);if(this.info)this.info.room=this.roomFor(this.me);this.persist();this.broadcast({type:'room-updated',room:this.room,members:this.roomIdentities().map(member=>this.publicMember(member))});this.broadcast({type:'channels-updated',channels:this.room.channels});for(const peer of this.clients.values())this.sendHistory(peer.wire,peer);}
  manageHost(identity,input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Ação inválida.');
    if(this.room.kind==='direct')throw Error('Uma chamada privada não possui gestão de grupo.');
    if(input.expectedRevision!==undefined&&input.expectedRevision!==this.room.revision)throw Error('O grupo mudou. Atualize antes de salvar novamente.');
    const room=this.room,action=input.action,name=String(input.name||'').trim().slice(0,40),id=input.id;
    const getChannel=()=>{const channel=room.channels.find(c=>c.id===id);if(!channel)throw Error('Canal não encontrado.');return channel;};
    const exactOrder=(values,rows)=>Array.isArray(values)&&values.length===rows.length&&new Set(values).size===rows.length&&values.every(id=>rows.some(row=>row.id===id));
    let result=true;
    if(action==='room-update'){
      assertGroupPermission(room,identity.id,'manageGroup');if(input.name!==undefined){if(!name)throw Error('Escolha um nome para o grupo.');room.name=name;}if(input.description!==undefined)room.description=String(input.description).trim().slice(0,240);result=room;
    }else if(action.startsWith('channel-')){
      assertGroupPermission(room,identity.id,'manageChannels');
      const existing=room.channels.find(c=>c.id===id);
      if(existing&&!this.can(identity,'read',existing.id))throw Error('Canal não encontrado.');
      if(input.permissions!==undefined){const stable=value=>JSON.stringify(Object.entries(cleanChannelRules(value)).sort(([a],[b])=>a.localeCompare(b)).map(([role,rules])=>[role,Object.entries(rules).sort(([a],[b])=>a.localeCompare(b))]));if(stable(input.permissions)!==stable(existing?.permissions||{}))assertGroupPermission(room,identity.id,'managePermissions');}
      if(action==='channel-create'){
        if(!['text','voice'].includes(input.kind)||!name||room.channels.length>=24)throw Error('Escolha nome e tipo. O limite é 24 canais.');
        const channel={id:input.kind+'-'+randomBytes(8).toString('hex'),kind:input.kind,name:name.slice(0,32),description:'',categoryId:null,slowmode:0,permissions:{}};this.editChannel(channel,input);room.channels.push(channel);result=channel;
      }else if(action==='channel-update'){const channel=getChannel();this.editChannel(channel,input);result=channel;}
      else if(action==='channel-delete'){const channel=getChannel();if(room.channels.filter(c=>c.kind===channel.kind).length<=1)throw Error('Mantenha ao menos um canal de texto e um de voz.');for(const member of this.roomIdentities())if(member.voiceChannelId===channel.id)this.updateVoice(member,null);room.channels=room.channels.filter(c=>c.id!==id);this.clearTyping(null,id);}
      else if(action==='channel-reorder'){const visible=room.channels.filter(c=>this.can(identity,'read',c.id));if(!exactOrder(input.ids,visible))throw Error('A ordem precisa incluir todos os canais visíveis uma vez.');const ordered=input.ids.map(id=>room.channels.find(c=>c.id===id)),ids=new Set(input.ids);room.channels=room.channels.map(c=>ids.has(c.id)?ordered.shift():c);}
      else throw Error('Ação de canal inválida.');
    }else if(action.startsWith('category-')){
      assertGroupPermission(room,identity.id,'manageChannels');const category=room.categories.find(c=>c.id===id);
      if(action==='category-create'){if(!name||room.categories.length>=24)throw Error('Escolha um nome. O limite é 24 categorias.');result={id:'category-'+randomBytes(8).toString('hex'),name};room.categories.push(result);}
      else if(action==='category-update'){if(!category||!name)throw Error('Categoria inválida.');category.name=name;result=category;}
      else if(action==='category-delete'){if(!category)throw Error('Categoria não encontrada.');room.categories=room.categories.filter(c=>c.id!==id);for(const channel of room.channels)if(channel.categoryId===id)channel.categoryId=null;}
      else if(action==='category-reorder'){if(!exactOrder(input.ids,room.categories))throw Error('Ordem de categorias inválida.');room.categories=input.ids.map(id=>room.categories.find(c=>c.id===id));}
      else throw Error('Ação de categoria inválida.');
    }else if(action.startsWith('role-')||action==='member-role'){
      if(identity.id!==room.ownerId)throw Error('Somente o dono pode alterar cargos.');
      if(action==='role-create'){if(!name||room.roles.length>=26)throw Error('Escolha um nome. O limite é 24 cargos personalizados.');const role={id:'role-'+randomBytes(8).toString('hex'),name:name.slice(0,32),color:'#91a9c9',position:1,permissions:[]};this.editRole(role,input);room.roles.push(role);result=role;}
      else if(action==='role-update'){const role=room.roles.find(r=>r.id===id);if(!role||['member','admin'].includes(id))throw Error('Os cargos padrão não podem ser alterados.');this.editRole(role,input);result=role;}
      else if(action==='role-delete'){if(['member','admin'].includes(id)||!room.roles.some(r=>r.id===id))throw Error('Cargo inválido.');room.roles=room.roles.filter(r=>r.id!==id);for(const membership of Object.values(room.memberships))membership.roleIds=membership.roleIds.filter(roleId=>roleId!==id);for(const channel of room.channels)delete channel.permissions[id];}
      else if(action==='member-role'){if(!validId(id)||id===room.ownerId||!room.roles.some(r=>r.id===input.roleId)||input.roleId==='member'||typeof input.enabled!=='boolean')throw Error('Membro ou cargo inválido.');const membership=room.memberships[id]||=( {roleIds:['member'],nickname:'',timeoutUntil:0});membership.roleIds=membership.roleIds.filter(roleId=>roleId!==input.roleId);if(input.enabled)membership.roleIds.push(input.roleId);result=membership;}
      else throw Error('Ação de cargo inválida.');
    }else if(action==='member-nickname'){
      if(id!==identity.id)assertModerationTarget(room,identity.id,id);if(!validId(id))throw Error('Membro inválido.');const membership=room.memberships[id]||={roleIds:['member'],nickname:'',timeoutUntil:0};membership.nickname=String(input.nickname||'').trim().slice(0,32);result=membership;
    }else if(['kick','ban','move','timeout','server-mute','server-deafen'].includes(action)){
      assertModerationTarget(room,identity.id,id);const target=this.clients.get(id);
      if(action==='kick'||action==='ban'){
        if(action==='ban'&&!room.bans.some(b=>b.id===id)){if(room.bans.length>=512)throw Error('Limite de banimentos atingido.');room.bans.push({id,reason:String(input.reason||'').trim().slice(0,160),time:Date.now()});}
        if(target){if(target.upload){clearTimeout(target.upload.timer);target.upload=null;}clearTimeout(target.expiry);this.clients.delete(id);this.clearTyping(id);target.wire.send({type:'moderation-ended',action,reason:String(input.reason||'').trim().slice(0,160)});target.socket?.end();this.broadcast({type:'member-left',id,name:target.name});}
      }else if(action==='timeout'){
        const seconds=Number(input.seconds);if(!Number.isInteger(seconds)||seconds<0||seconds>28*86400)throw Error('Duração inválida.');const membership=room.memberships[id]||={roleIds:['member'],nickname:'',timeoutUntil:0};membership.timeoutUntil=seconds?Date.now()+seconds*1000:0;if(seconds&&target?.voiceChannelId)this.updateVoice(target,null);result=membership;
      }else if(action==='move'){if(!target)throw Error('O membro está offline.');this.updateVoice(target,input.channelId??null);result=this.publicMember(target);}
      else{if(!target||typeof input.enabled!=='boolean')throw Error('Membro ou estado inválido.');const membership=room.memberships[id]||={roleIds:['member'],nickname:'',timeoutUntil:0};if(action==='server-mute')membership.serverMuted=input.enabled;else membership.serverDeafened=input.enabled;this.broadcast({type:'member-updated',member:this.publicMember(target)});result=this.publicMember(target);}
    }else if(action==='unban'){
      assertGroupPermission(room,identity.id,'moderateMembers');if(!validId(id))throw Error('Membro inválido.');room.bans=room.bans.filter(b=>b.id!==id);
    }else if(action==='invite-rotate'){
      assertGroupPermission(room,identity.id,'manageGroup');this.token=randomBytes(32).toString('base64url');const invite=new URL(this.info.invite);invite.searchParams.set('key',this.token);this.info.invite=invite.toString();this.broadcast({type:'invite-rotated',invite:this.info.invite});result={invite:this.info.invite};
    }else throw Error('Ação de grupo inválida.');
    this.changed();if(action==='member-role'||action==='member-nickname'||action==='timeout'){const target=id===this.me.id?this.me:this.clients.get(id);if(target)this.broadcast({type:'member-updated',member:this.publicMember(target)});}return result;
  }
  editChannel(channel,input){
    const original=channel;channel={...channel};
    if(input.name!==undefined){const name=String(input.name||'').trim().slice(0,32);if(!name)throw Error('Escolha um nome.');channel.name=name;}
    if(input.description!==undefined)channel.description=String(input.description).trim().slice(0,240);
    if(input.categoryId!==undefined){if(input.categoryId!==null&&!this.room.categories.some(c=>c.id===input.categoryId))throw Error('Categoria não encontrada.');channel.categoryId=input.categoryId;}
    if(input.slowmode!==undefined){if(channel.kind!=='text'||!Number.isInteger(input.slowmode)||input.slowmode<0||input.slowmode>21600)throw Error('Intervalo de mensagens inválido.');channel.slowmode=input.slowmode;}
    if(input.permissions!==undefined){const rules=cleanChannelRules(input.permissions);if(Object.keys(rules).some(id=>!this.room.roles.some(r=>r.id===id)))throw Error('Cargo de permissão não encontrado.');channel.permissions=rules;}
    Object.assign(original,channel);
  }
  editRole(role,input){
    const original=role;role={...role};
    if(input.name!==undefined){const name=String(input.name||'').trim().slice(0,32);if(!name)throw Error('Escolha um nome.');role.name=name;}
    if(input.color!==undefined){if(!/^#[a-f0-9]{6}$/i.test(input.color))throw Error('Cor inválida.');role.color=input.color;}
    if(input.position!==undefined){if(!Number.isInteger(input.position)||input.position<1||input.position>90)throw Error('Posição de cargo inválida.');role.position=input.position;}
    if(input.permissions!==undefined){if(!Array.isArray(input.permissions)||input.permissions.some(p=>!GROUP_PERMISSIONS.includes(p)))throw Error('Permissão inválida.');role.permissions=[...new Set(input.permissions)];}
    Object.assign(original,role);
  }
  assertSend(identity,channelId){
    const channel=this.room.channels.find(c=>c.id===channelId&&c.kind==='text');if(!channel)throw Error('Canal de texto não encontrado.');assertGroupPermission(this.room,identity.id,'send',channel);
    const previous=identity.channelSends?.get(channelId)||0;if(channel.slowmode&&!this.can(identity,'manageMessages')&&Date.now()-previous<channel.slowmode*1000)throw Error(`Este canal permite uma mensagem a cada ${channel.slowmode} segundos.`);
  }
  noteSend(identity,channelId){identity.channelSends||=new Map();identity.channelSends.set(channelId,Date.now());this.setTyping(identity,{channelId,active:false},true);}
  replyReference(id,channelId){if(id===undefined||id===null)return null;if(!validId(id))throw Error('Referência de resposta inválida.');const item=this.history.find(m=>m.id===id&&m.channelId===channelId&&!m.deleted);if(!item)throw Error('A mensagem respondida não está disponível neste canal.');return{id:item.id,authorId:item.authorId,name:item.name,text:(item.text||item.attachment?.name||'Anexo').slice(0,160)};}
  rememberMessage(item){if(!validId(item?.id))return;const index=this.history.findIndex(m=>m.id===item.id);if(index<0)this.history.push(item);else if((item.revision||0)>=(this.history[index].revision||0))this.history[index]=item;this.history=this.history.slice(-200);}
  messageAction(input){if(this.mode==='host')return this.messageActionHost(this.me,input);if(this.mode==='guest')return this.requestCommand('message-action',input);throw Error('Entre em um grupo.');}
  messageActionHost(identity,input){
    if(!input||typeof input!=='object'||!validId(input.id))throw Error('Mensagem inválida.');const item=this.history.find(m=>m.id===input.id);if(!item||input.channelId!==item.channelId)throw Error('Mensagem não encontrada neste canal.');const channel=this.room.channels.find(c=>c.id===item.channelId&&c.kind==='text');if(!channel)throw Error('Este canal não está mais disponível.');assertGroupPermission(this.room,identity.id,'read',channel);
    if(input.expectedRevision!==undefined&&input.expectedRevision!==(item.revision||0))throw Error('A mensagem mudou. Atualize antes de tentar novamente.');
    const action=input.action;if(item.deleted){if(action==='delete')return item;throw Error('Esta mensagem foi apagada.');}
    if(action==='edit'){
      assertGroupPermission(this.room,identity.id,'send',channel);if(item.authorId!==identity.id)throw Error('Você só pode editar suas próprias mensagens.');if(typeof input.text!=='string'||input.text.length>2000||!input.text.trim()&&!item.attachment)throw Error('Escreva uma mensagem de até 2000 caracteres.');item.text=input.text.trim();item.editedAt=Date.now();
    }else if(action==='delete'){
      if(item.authorId!==identity.id)assertGroupPermission(this.room,identity.id,'manageMessages');if(item.attachment){this.mediaMemory.delete(item.attachment.id);const file=this.attachmentPath(item.attachment.id);if(file)try{unlinkSync(file);}catch{}delete item.attachment;}item.text='';item.deleted=true;item.deletedAt=Date.now();item.deletedBy=identity.id;delete item.reactions;delete item.pinned;delete item.reply;
    }else if(action==='reaction'){
      assertGroupPermission(this.room,identity.id,'react',channel);const emoji=input.emoji;if(typeof emoji!=='string'||[...emoji].length>16||!/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(emoji)||/[\x00-\x1f<>]/.test(emoji)||typeof input.enabled!=='boolean')throw Error('Reação inválida.');
      item.reactions||=[];let reaction=item.reactions.find(r=>r.emoji===emoji);if(input.enabled&&!reaction){if(item.reactions.length>=12)throw Error('Esta mensagem atingiu o limite de reações diferentes.');reaction={emoji,memberIds:[]};item.reactions.push(reaction);}if(reaction){reaction.memberIds=reaction.memberIds.filter(id=>id!==identity.id);if(input.enabled)reaction.memberIds.push(identity.id);item.reactions=item.reactions.filter(r=>r.memberIds.length);}
    }else if(action==='pin'){
      assertGroupPermission(this.room,identity.id,'manageMessages');if(typeof input.enabled!=='boolean')throw Error('Estado inválido.');if(input.enabled&&!item.pinned&&this.history.filter(m=>m.pinned&&m.channelId===item.channelId).length>=50)throw Error('O limite é 50 mensagens fixadas por canal.');item.pinned=input.enabled;if(input.enabled){item.pinnedBy=identity.id;item.pinnedAt=Date.now();}
    }else throw Error('Ação de mensagem inválida.');
    item.revision=(item.revision||0)+1;this.persist();this.broadcast({type:'message-updated',message:item});return item;
  }
  typing({channelId,active}){if(this.mode==='host')return this.setTyping(this.me,{channelId,active});if(this.mode==='guest')return this.requestCommand('typing',{channelId,active});throw Error('Entre em um grupo.');}
  mediaState(input){if(this.mode==='host')return this.updateMediaState(this.me,input);if(this.mode==='guest')return this.requestCommand('media-state',input);throw Error('Entre em um grupo.');}
  updateMediaState(identity,input){
    const state=Object.fromEntries(['mic','deafened','screen','camera','screenAudio'].map(key=>[key,input?.[key]===true]));
    if(JSON.stringify(identity._mediaState)===JSON.stringify(state))return this.publicMember(identity);identity._mediaState=state;
    if(!identity.mediaTimer){identity.mediaTimer=setTimeout(()=>{identity.mediaTimer=null;if(this.mode==='host'&&(identity===this.me||this.clients.get(identity.id)===identity))this.broadcast({type:'member-updated',member:this.publicMember(identity)});},40);identity.mediaTimer.unref?.();}
    return this.publicMember(identity);
  }
  setTyping(identity,{channelId,active},internal=false){
    if(typeof active!=='boolean'||!this.room.channels.some(c=>c.id===channelId&&c.kind==='text'))return false;
    if(active)assertGroupPermission(this.room,identity.id,'send',this.room.channels.find(c=>c.id===channelId));
    const key=identity.id+':'+channelId,previous=this.typingTimers.get(key),now=Date.now();if(previous){clearTimeout(previous.timer);this.typingTimers.delete(key);}
    if(!active){if(previous)this.broadcast({type:'typing',channelId,memberId:identity.id,name:identity.name,active:false});return true;}
    const timer=setTimeout(()=>{this.typingTimers.delete(key);this.broadcast({type:'typing',channelId,memberId:identity.id,name:identity.name,active:false});},6000);timer.unref?.();this.typingTimers.set(key,{timer,memberId:identity.id,channelId,time:now});if(!previous||now-previous.time>=1000)this.broadcast({type:'typing',channelId,memberId:identity.id,name:identity.name,active:true,expiresAt:now+6000});return true;
  }
  clearTyping(memberId=null,channelId=null){for(const[key,item]of this.typingTimers)if((memberId===null||item.memberId===memberId)&&(channelId===null||item.channelId===channelId)){clearTimeout(item.timer);this.typingTimers.delete(key);this.broadcast({type:'typing',channelId:item.channelId,memberId:item.memberId,active:false});}}
  acceptChat(identity,message) {
    if(typeof message.text!=='string' || !message.text.trim() || message.text.length>2000 || !this.room.channels.some(c=>c.id===message.channelId&&c.kind==='text'))throw Error('Mensagem ou canal inválido.');
    this.assertSend(identity,message.channelId);
    const reply=this.replyReference(message.replyTo,message.channelId);
    if(!identity.chatWindow||Date.now()-identity.chatWindow>1000){identity.chatWindow=Date.now();identity.chatCount=0;}
    if(++identity.chatCount>10)throw Error('Muitas mensagens de uma vez. Aguarde um instante.');
    identity.lastChat=Date.now(); const item={id:randomBytes(16).toString('hex'),authorId:identity.id,name:identity.name,text:message.text.trim(),channelId:message.channelId,time:Date.now(),revision:0,...(reply?{replyTo:reply.id,reply}: {})};
    this.history.push(item);this.noteSend(identity,message.channelId);this.pruneHistory(); this.persist(); this.broadcast({type:'chat',message:item});return item;
  }
  chat({channelId,text,replyTo}) {
    if(this.mode==='host') return this.acceptChat(this.me,{channelId,text,replyTo});
    else if(this.mode==='guest' && !this.socket?.destroyed) return this.requestCommand('chat',{channelId,text,replyTo});
    else throw new Error('Aguarde a conexão com o grupo voltar.');
  }
  async join({ invite,member:input,transient=false,expectedHostKey=null,expectedHostId=null,expectedRoomKind=null,expectedCallId=null }) {
    if (this.mode) throw new Error('Saia da sala atual antes de entrar em outra.');
    if(transient&&(!expectedHostKey||!validId(expectedHostId)||expectedRoomKind!=='direct'||!validId(expectedCallId)))throw Error('A chamada privada não informou as identidades esperadas.');
    this.transient=transient;this.expectedHostKey=expectedHostKey;this.expectedHostId=expectedHostId;this.expectedRoomKind=expectedRoomKind;this.expectedCallId=expectedCallId;
    this.identity ||= loadGroupIdentity(this.statePath);this.target=parseInvite(invite);const canonical=new URL(invite);canonical.protocol='stringchat:';this.currentInvite=canonical.toString(); this.me=member(input);this.history=[]; this.mode='guest'; this.reconnectingSince=null;
    try { return await this.connect(false); } catch(error) { this.leave(); throw error; }
  }
  connect(retry) {
    const generation=this.generation, target=this.target;
    return new Promise((resolve,reject)=>{
      const socket=net.createConnection({host:target.host,port:target.port}); this.socket=socket; let welcomed=false, settled=false;
      const finishError=message=>{ if (!settled) { settled=true; reject(new Error(message)); } };
      const deadline=setTimeout(()=>{ finishError('A sala não respondeu. Confira se os dois estão na mesma rede Radmin e se o Firewall permite o String Chat.'); socket.destroy(); },9000);
      const wire=makeWire(socket,target.token,event=>{
        if(this.generation!==generation||this.mode!=='guest')return;
        if(event.type==='challenge'){
          try{
            if(welcomed||event.protocol!==2||event.roomId!==target.roomId||!validId(event.hostId)||typeof event.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(event.nonce)||!verifyGroupSignature(event.publicKey,['host',target.roomId,event.nonce,event.hostId,event.ephemeralKey,event.roomKind,event.callId||''],event.proof))throw Error('A identidade do criador não foi confirmada.');
            if(this.expectedHostKey&&event.publicKey!==this.expectedHostKey||this.expectedHostId&&event.hostId!==this.expectedHostId||this.expectedRoomKind&&event.roomKind!==this.expectedRoomKind||this.expectedCallId&&event.callId!==this.expectedCallId||event.roomKind==='direct'&&!this.transient)throw Error('A identidade ou o destino da chamada privada não corresponde ao convite recebido.');
            const known=this.identity.hosts[target.roomId];if(known&&known!==event.publicKey)throw Error('A chave conhecida do criador mudou. Peça um novo convite por um canal confiável.');
            const ephemeral=groupEphemeral(),fields=['join',target.roomId,event.nonce,this.me.id,event.hostId,event.ephemeralKey,ephemeral.publicKey];
            wire.send({type:'hello',roomId:target.roomId,member:this.me,nonce:event.nonce,publicKey:this.identity.publicKey,ephemeralKey:ephemeral.publicKey,proof:groupSignature(this.identity,fields)});
            wire.setKey(groupSessionKey(ephemeral,event.ephemeralKey,target.token,[target.roomId,event.nonce,this.me.id,event.hostId]));this.identity.hosts[target.roomId]=event.publicKey;this.identity.persist();
          }catch(error){finishError(error.message);socket.destroy();}
        }else if (event.type==='welcome') {
          if (event.room?.id!==target.roomId || event.selfId!==this.me.id || !validId(event.hostId) || !Array.isArray(event.members)) { socket.destroy(); return; }
          if(this.expectedRoomKind&&event.room.kind!==this.expectedRoomKind||this.expectedCallId&&event.room.callId!==this.expectedCallId){socket.destroy();return;}
          clearTimeout(deadline); welcomed=true; settled=true; this.reconnectingSince=null; this.room=event.room;this.me.voiceChannelId=event.selfVoiceChannelId;
          this.localAddress=socket.localAddress?.replace(/^::ffff:/,'');
          const welcome={...event,localAddress:this.localAddress,kind:target.host.startsWith('26.')?'radmin':'lan'};
          this.emit('event',welcome); this.heartbeat=setInterval(()=>wire.send({type:'ping'}),5000); resolve(welcome);
        } else if (event.type==='rejected') { finishError(String(event.message||'Acesso negado.')); socket.destroy(); }
        else if(welcomed&&event.type==='command-result'){const pending=this.pendingCommands.get(event.requestId);if(pending){clearTimeout(pending.timer);this.pendingCommands.delete(event.requestId);if(event.ok)pending.resolve(event.result);else pending.reject(Error(String(event.error||'A ação foi recusada.')));}}
        else if(welcomed&&event.type.startsWith('media-'))this.receiveFile(event);
        else if(welcomed&&event.type==='upload-error'){const pending=this.pendingUploads.get(event.uploadId);if(pending){clearTimeout(pending.timer);this.pendingUploads.delete(event.uploadId);pending.reject(new Error(event.message));}}
        else if(welcomed&&event.type==='chat'){const pending=this.pendingUploads.get(event.message?.uploadId);if(pending){clearTimeout(pending.timer);this.pendingUploads.delete(event.message.uploadId);pending.resolve(event.message);}this.rememberMessage(event.message);this.emit('event',event);}
        else if(welcomed&&event.type==='message-updated'){this.rememberMessage(event.message);this.emit('event',event);}
        else if(welcomed&&event.type==='history'){for(const item of event.messages||[])this.rememberMessage(item);this.emit('event',event);}
        else if(welcomed&&event.type==='room-updated'){this.room=event.room;this.emit('event',event);}
        else if(welcomed&&event.type==='channels-updated'){this.room.channels=event.channels;this.emit('event',event);}
        else if(welcomed&&event.type==='member-updated'){if(event.member?.id===this.me.id)Object.assign(this.me,event.member);this.emit('event',event);}
        else if(welcomed&&event.type==='invite-rotated'){this.target=parseInvite(event.invite);this.currentInvite=event.invite;this.emit('event',event);}
        else if(welcomed&&event.type==='moderation-ended'){this.leave();this.emit('event',event);}
        else if (welcomed && event.type==='room-ended') { this.leave(); this.emit('event',event); }
        else if (welcomed && event.type!=='pong') this.emit('event',event);
      },()=>finishError('Não foi possível entrar. Confira o convite, a rede Radmin e a permissão do String Chat no Firewall.'));
      this.wire=wire;
      socket.once('connect',()=>{});
      socket.once('close',()=>{
        clearTimeout(deadline); clearInterval(this.heartbeat);
        finishError('A sala fechou a conexão. Peça ao criador um convite atualizado.');
        if (this.generation!==generation || this.mode!=='guest') return;
        if (welcomed || retry) this.scheduleReconnect();
      });
    });
  }
  scheduleReconnect() {
    if (this.retryTimer) return;
    this.reconnectingSince ||= Date.now();
    if (Date.now()-this.reconnectingSince>40000) { this.leave(); this.emit('event',{type:'room-ended',message:'A sala ficou indisponível. Confira o Radmin e entre novamente.'}); return; }
    this.emit('event',{type:'network-status',status:'reconnecting'});
    this.retryTimer=setTimeout(()=>{ this.retryTimer=null; this.connect(true).catch(()=>{}); },2000);
  }
  signal({to,payload}) {
    if (!validId(to) || !payload || typeof payload!=='object') throw new Error('Mensagem de conexão inválida.');
    if (this.mode==='host') return this.canSignal(this.me,to)&&!!this.clients.get(to)?.wire.send({type:'signal',from:this.me.id,name:this.me.name,payload});
    if (this.mode==='guest' && this.socket && !this.socket.destroyed) return this.wire.send({type:'signal',to,payload});
    return false;
  }
  canSignal(identity,to){const target=!this.serverHost&&to===this.me.id?this.me:this.clients.get(to);return!!target&&!!identity.voiceChannelId&&identity.voiceChannelId===target.voiceChannelId&&this.can(identity,'connect',identity.voiceChannelId)&&this.can(target,'connect',target.voiceChannelId);}
  leave() {
    this.generation++; clearTimeout(this.retryTimer); this.retryTimer=null; clearInterval(this.heartbeat);
    if(this.pendingCreate){const pending=this.pendingCreate;this.pendingCreate=null;pending.reject(Error('A criação da chamada foi cancelada.'));}
    clearTimeout(this.me?.mediaTimer);
    if (this.mode==='host') for (const peer of this.clients.values()) { clearTimeout(peer.expiry);clearTimeout(peer.mediaTimer);if(peer.upload){clearTimeout(peer.upload.timer);peer.upload=null;} peer.wire.send({type:'room-ended'}); peer.socket?.end(); }
    else if(this.mode==='guest') this.wire?.send({type:'leave'});
    this.mode=null;this.currentInvite=null;this.transient=false;this.allowedMembers=null;this.expectedHostKey=this.expectedHostId=this.expectedRoomKind=this.expectedCallId=null; this.socket?.destroy(); this.socket=null;
    for(const map of [this.pendingReads,this.pendingUploads,this.pendingCommands]){for(const pending of map.values()){clearTimeout(pending.timer);pending.reject(new Error('Você saiu do grupo.'));}map.clear();}
    for(const value of this.typingTimers.values())clearTimeout(value.timer);this.typingTimers.clear();this.commandCache.clear();
    for(const socket of this.sockets) socket.destroy(); this.sockets.clear(); this.clients.clear(); this.server?.close(); this.server=null; this.info=null;
  }
}
