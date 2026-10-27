import net from 'node:net';
import {cleanAvatar} from './profile.js';
import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync,writeFileSync,renameSync,mkdirSync,unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

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
  const key = Buffer.from(token, 'base64url'); let buffer = '', ended = false;
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
  constructor({statePath=null}={}) { super(); this.statePath=statePath; this.history=[];this.mediaMemory=new Map();this.pendingReads=new Map();this.pendingUploads=new Map(); this.mode = null; this.server = null; this.socket = null; this.clients = new Map(); this.generation = 0; this.info = null; this.retryTimer = null; this.reconnectingSince = null; this.sockets = new Set(); }
  persist() {
    if(!this.statePath || this.mode!=='host') return;
    mkdirSync(dirname(this.statePath),{recursive:true});
    writeFileSync(this.statePath+'.tmp',JSON.stringify({room:this.room,token:this.token,port:this.info?.port,history:this.history})); renameSync(this.statePath+'.tmp',this.statePath);
  }
  sendHistory(wire=null) { for(let i=0;i<this.history.length;i+=20) { const event={type:'history',messages:this.history.slice(i,i+20)}; if(wire) wire.send(event); else this.emit('event',event); } }
  pruneHistory(){while(this.history.length>200){const old=this.history.shift();if(old?.attachment){this.mediaMemory.delete(old.attachment.id);const file=this.attachmentPath(old.attachment.id);if(file)try{unlinkSync(file);}catch{}}}}
  async create({ room, member: input, address }) {
    if (this.mode === 'host') return this.info;
    if (this.mode) throw new Error('Você já está em uma sala.');
    const me = member(input);
    if (!validId(room?.id)) throw new Error('Sala inválida.');
    const addresses = listInterfaces();
    address ||= addresses[0]?.address;
    if (!address || !(addresses.some(item => item.address === address) || address === '127.0.0.1')) throw new Error('Nenhuma rede disponível. Ligue o Radmin VPN e tente novamente.');
    let saved=null; try { saved=JSON.parse(readFileSync(this.statePath,'utf8')); } catch {}
    this.mode = 'host'; this.me = me; this.room = { id:validId(saved?.room?.id)?saved.room.id:room.id, name:String(room.name&&room.name!=='Grupo da galera'?room.name:saved?.room?.name||room.name||'Grupo da galera').slice(0,40), channels:Array.isArray(saved?.room?.channels)?saved.room.channels.slice(0,24):defaultChannels() };
    if(me.voiceChannelId!==null&&!this.room.channels.some(c=>c.id===me.voiceChannelId&&c.kind==='voice')) me.voiceChannelId='voice-lobby';
    this.history=Array.isArray(saved?.history)?saved.history.slice(-200):[];
    this.token = /^[A-Za-z0-9_-]{43}$/.test(saved?.token||'')?saved.token:randomBytes(32).toString('base64url'); this.localAddress = address;
    this.server = net.createServer(socket => this.accept(socket));
    const preferredPort=Number.isInteger(saved?.port)&&saved.port>0&&saved.port<=65535?saved.port:0;
    try { await new Promise((resolve,reject) => { const failed=error=>{if(error.code==='EADDRINUSE'&&preferredPort){this.server.once('error',reject);this.server.listen(0,address,resolve);}else reject(error);}; this.server.once('error',failed); this.server.listen(preferredPort,address,resolve); }); }
    catch (error) { this.leave(); throw new Error(`Não foi possível abrir a sala na rede escolhida (${error.code}).`); }
    this.server.on('error', () => this.emit('event',{type:'network-error',message:'A rede da sala ficou indisponível. Confira o Radmin.'}));
    const port = this.server.address().port;
    const url = new URL('stringchat://join'); url.searchParams.set('host',address); url.searchParams.set('port',port); url.searchParams.set('room',this.room.id); url.searchParams.set('key',this.token);
    this.info = { invite:url.toString(), address, port, localAddress:address, room:this.room, hostId:me.id, selfId:me.id, kind:address.startsWith('26.')?'radmin':'lan' };
    this.persist(); this.emit('event',{type:'hosting',...this.info}); this.sendHistory(); return this.info;
  }
  accept(socket) {
    this.sockets.add(socket); socket.once('close',()=>this.sockets.delete(socket));
    let entry = null, pings = 0, windowStart = Date.now();
    const deadline = setTimeout(()=>socket.destroy(),8000);
    const wire = makeWire(socket,this.token,message => {
      if (Date.now()-windowStart>1000) { pings=0; windowStart=Date.now(); }
      if (++pings>1000) { socket.destroy(); return; }
      if (!entry) {
        if (message.type !== 'hello' || message.roomId !== this.room?.id) { socket.destroy(); return; }
        let identity; try { identity=member(message.member); } catch { socket.destroy(); return; }
        if (identity.id===this.me.id || this.clients.size>=MAX_MEMBERS-1 && !this.clients.has(identity.id)) { wire.send({type:'rejected',message:'A sala está cheia (até 6 pessoas).'}); socket.end(); return; }
        const previous = this.clients.get(identity.id); const resumed=!!previous;
        if (previous) { clearTimeout(previous.expiry); if (previous.socket && previous.socket!==socket) previous.socket.destroy(); }
        entry = { ...identity,socket,wire }; this.clients.set(entry.id,entry); clearTimeout(deadline);
        if(entry.voiceChannelId!==null&&!this.room.channels.some(c=>c.id===entry.voiceChannelId&&c.kind==='voice')) entry.voiceChannelId='voice-lobby';
        wire.send({type:'welcome',room:this.room,hostId:this.me.id,selfId:entry.id,selfVoiceChannelId:entry.voiceChannelId,resumed,members:[this.me,...[...this.clients.values()].filter(p=>p.id!==entry.id).map(p=>({id:p.id,name:p.name,avatar:p.avatar,voiceChannelId:p.voiceChannelId}))]});
        this.sendHistory(wire);
        this.broadcast({type:resumed?'member-back':'member-added',member:identity},entry.id); return;
      }
      if (message.type==='signal' && validId(message.to) && message.to!==entry.id && message.payload && typeof message.payload==='object') {
        const event={type:'signal',from:entry.id,name:entry.name,payload:message.payload};
        if (message.to===this.me.id) this.emit('event',event); else this.clients.get(message.to)?.wire.send(event);
      } else if (message.type==='ping') wire.send({type:'pong'});
      else if (message.type==='leave') { this.remove(entry.id,socket); socket.end(); }
      else if(message.type==='voice-change') this.updateVoice(entry,message.channelId);
      else if(message.type==='chat') this.acceptChat(entry,message);
      else if(message.type==='profile-change'){entry.name=String(message.name||'Amigo').trim().slice(0,32)||'Amigo';entry.avatar=cleanAvatar(message.avatar);this.broadcast({type:'member-updated',member:{id:entry.id,name:entry.name,avatar:entry.avatar,voiceChannelId:entry.voiceChannelId}});}
      else if(message.type==='media-start')this.beginUpload(entry,message);
      else if(message.type==='media-chunk')this.uploadChunk(entry,message);
      else if(message.type==='media-end')this.endUpload(entry,message);
      else if(message.type==='media-get'&&validId(message.id)){entry.fileQueue=(entry.fileQueue||Promise.resolve()).then(()=>this.streamFile(wire,message.id)).catch(()=>wire.send({type:'media-error',id:message.id,message:'Arquivo indisponível no computador do criador.'}));}
    },()=>{});
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
    clearTimeout(entry.expiry); this.clients.delete(id); this.broadcast({type:'member-left',id,name:entry.name});
  }
  broadcast(event,except=null) { this.emit('event',event); for (const peer of this.clients.values()) if(peer.id!==except) peer.wire.send(event); }
  attachmentPath(id){if(!validId(id))throw new Error('Arquivo inválido.');return this.statePath?`${dirname(this.statePath)}/media/${id}.bin`:null;}
  findAttachment(id){return this.history.find(item=>item.attachment?.id===id)?.attachment;}
  readFile(id){const attachment=this.findAttachment(id);if(!attachment)throw new Error('Arquivo não encontrado.');const data=this.mediaMemory.get(id)||readFileSync(this.attachmentPath(id));if(data.length!==attachment.size||data.length>MAX_FILE)throw new Error('Arquivo inválido.');return{...attachment,data};}
  storeAttachment(identity,{name,channelId,uploadId},data){
    if(!data.length||data.length>MAX_FILE||!this.room.channels.some(c=>c.id===channelId&&c.kind==='text'))throw new Error('Arquivo inválido. O limite é 8 MB.');
    const id=randomBytes(16).toString('hex'),filename=String(name||'arquivo').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,120)||'arquivo';
    const attachment={id,name:filename,mime:fileType(data),size:data.length};const file=this.attachmentPath(id);
    if(file){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,data);}else this.mediaMemory.set(id,Buffer.from(data));
    const item={id:randomBytes(16).toString('hex'),authorId:identity.id,name:identity.name,text:'',channelId,time:Date.now(),attachment,uploadId};this.history.push(item);
    let total=this.history.reduce((sum,m)=>sum+(m.attachment?.size||0),0);
    while(this.history.length>200||total>128*1024*1024){const old=this.history.shift();if(old?.attachment){total-=old.attachment.size;this.mediaMemory.delete(old.attachment.id);const oldFile=this.attachmentPath(old.attachment.id);if(oldFile)try{unlinkSync(oldFile);}catch{}}}
    this.persist();this.broadcast({type:'chat',message:item});return item;
  }
  beginUpload(entry,message){
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
  async streamFile(wire,id){const file=this.readFile(id);await wire.sendAsync({type:'media-data-start',id,size:file.size,mime:file.mime,name:file.name});for(let i=0;i<file.data.length;i+=24000)await wire.sendAsync({type:'media-data-chunk',id,data:file.data.subarray(i,i+24000).toString('base64')});await wire.sendAsync({type:'media-data-end',id});}
  async getAttachment(id){if(!validId(id))throw new Error('Arquivo inválido.');if(this.mode==='host')return this.readFile(id);if(this.mode!=='guest'||this.socket?.destroyed)throw new Error('O grupo está desconectado.');if(this.pendingReads.has(id))return this.pendingReads.get(id).promise;const pending={chunks:[],received:0};pending.promise=new Promise((resolve,reject)=>{pending.resolve=resolve;pending.reject=reject;pending.timer=setTimeout(()=>{this.pendingReads.delete(id);reject(new Error('Não foi possível carregar o arquivo.'));},120000);});this.pendingReads.set(id,pending);this.wire.send({type:'media-get',id});return pending.promise;}
  receiveFile(event){const pending=this.pendingReads.get(event.id);if(!pending)return;
    if(event.type==='media-error'){clearTimeout(pending.timer);this.pendingReads.delete(event.id);pending.reject(new Error(event.message));return;}
    if(event.type==='media-data-start'){if(!Number.isInteger(event.size)||event.size<1||event.size>MAX_FILE){pending.reject(new Error('Arquivo grande demais.'));return;}pending.meta={id:event.id,size:event.size,name:event.name,mime:event.mime};}
    else if(event.type==='media-data-chunk'&&pending.meta&&typeof event.data==='string'&&event.data.length<33000){const bytes=Buffer.from(event.data,'base64');pending.received+=bytes.length;if(pending.received<=pending.meta.size)pending.chunks.push(bytes);}
    else if(event.type==='media-data-end'){clearTimeout(pending.timer);this.pendingReads.delete(event.id);if(pending.meta&&pending.received===pending.meta.size){const data=Buffer.concat(pending.chunks);pending.resolve({...pending.meta,mime:fileType(data),data});}else pending.reject(new Error('Arquivo incompleto.'));}
  }
  updateVoice(identity,channelId) {
    if(channelId!==null && !this.room.channels.some(c=>c.id===channelId&&c.kind==='voice')) throw new Error('Canal de voz não encontrado.');
    identity.voiceChannelId=channelId; this.broadcast({type:'member-updated',member:{id:identity.id,name:identity.name,avatar:identity.avatar,voiceChannelId:channelId}});
  }
  voice(channelId) {
    if(this.mode==='host') this.updateVoice(this.me,channelId);
    else if(this.mode==='guest') { this.me.voiceChannelId=channelId; this.wire.send({type:'voice-change',channelId}); }
  }
  setName(name,avatar=this.me?.avatar){if(!this.me)return;this.me.avatar=cleanAvatar(avatar);this.me.name=String(name||'Amigo').trim().slice(0,32)||'Amigo';if(this.mode==='host')this.broadcast({type:'member-updated',member:this.me});else if(this.mode==='guest')this.wire?.send({type:'profile-change',name:this.me.name,avatar:this.me.avatar});}
  createChannel({kind,name}) {
    if(this.mode!=='host') throw new Error('Somente o criador do grupo pode criar canais.');
    name=String(name||'').trim().slice(0,32);
    if(!name || !['voice','text'].includes(kind) || this.room.channels.length>=24) throw new Error('Escolha um nome. O grupo permite até 24 canais.');
    const channel={id:`${kind}-${randomBytes(8).toString('hex')}`,kind,name}; this.room.channels.push(channel); this.persist(); this.broadcast({type:'channels-updated',channels:this.room.channels}); return channel;
  }
  acceptChat(identity,message) {
    if(typeof message.text!=='string' || !message.text.trim() || message.text.length>2000 || !this.room.channels.some(c=>c.id===message.channelId&&c.kind==='text')) return;
    if(!identity.chatWindow||Date.now()-identity.chatWindow>1000){identity.chatWindow=Date.now();identity.chatCount=0;}
    if(++identity.chatCount>10){const event={type:'network-error',message:'Muitas mensagens de uma vez. Aguarde um instante.'};if(identity.wire)identity.wire.send(event);else this.emit('event',event);return;}
    identity.lastChat=Date.now(); const item={id:randomBytes(16).toString('hex'),authorId:identity.id,name:identity.name,text:message.text.trim(),channelId:message.channelId,time:Date.now()};
    this.history.push(item);this.pruneHistory(); this.persist(); this.broadcast({type:'chat',message:item});
  }
  chat({channelId,text}) {
    if(this.mode==='host') this.acceptChat(this.me,{channelId,text});
    else if(this.mode==='guest' && !this.socket?.destroyed) this.wire.send({type:'chat',channelId,text});
    else throw new Error('Aguarde a conexão com o grupo voltar.');
  }
  async join({ invite,member:input }) {
    if (this.mode) throw new Error('Saia da sala atual antes de entrar em outra.');
    this.target=parseInvite(invite);const canonical=new URL(invite);canonical.protocol='stringchat:';this.currentInvite=canonical.toString(); this.me=member(input); this.mode='guest'; this.reconnectingSince=null;
    try { return await this.connect(false); } catch(error) { this.leave(); throw error; }
  }
  connect(retry) {
    const generation=this.generation, target=this.target;
    return new Promise((resolve,reject)=>{
      const socket=net.createConnection({host:target.host,port:target.port}); this.socket=socket; let welcomed=false, settled=false;
      const finishError=message=>{ if (!settled) { settled=true; reject(new Error(message)); } };
      const deadline=setTimeout(()=>{ finishError('A sala não respondeu. Confira se os dois estão na mesma rede Radmin e se o Firewall permite o String Chat.'); socket.destroy(); },9000);
      const wire=makeWire(socket,target.token,event=>{
        if (event.type==='welcome') {
          if (event.room?.id!==target.roomId || event.selfId!==this.me.id || !validId(event.hostId) || !Array.isArray(event.members)) { socket.destroy(); return; }
          clearTimeout(deadline); welcomed=true; settled=true; this.reconnectingSince=null; this.room=event.room;
          this.localAddress=socket.localAddress?.replace(/^::ffff:/,'');
          const welcome={...event,localAddress:this.localAddress,kind:target.host.startsWith('26.')?'radmin':'lan'};
          this.emit('event',welcome); this.heartbeat=setInterval(()=>wire.send({type:'ping'}),5000); resolve(welcome);
        } else if (event.type==='rejected') { finishError(String(event.message||'Acesso negado.')); socket.destroy(); }
        else if(welcomed&&event.type.startsWith('media-'))this.receiveFile(event);
        else if(welcomed&&event.type==='upload-error'){const pending=this.pendingUploads.get(event.uploadId);if(pending){clearTimeout(pending.timer);this.pendingUploads.delete(event.uploadId);pending.reject(new Error(event.message));}}
        else if(welcomed&&event.type==='chat'){const pending=this.pendingUploads.get(event.message?.uploadId);if(pending){clearTimeout(pending.timer);this.pendingUploads.delete(event.message.uploadId);pending.resolve(event.message);}this.emit('event',event);}
        else if (welcomed && event.type==='room-ended') { this.leave(); this.emit('event',event); }
        else if (welcomed && event.type!=='pong') this.emit('event',event);
      },()=>finishError('Não foi possível entrar. Confira o convite, a rede Radmin e a permissão do String Chat no Firewall.'));
      this.wire=wire;
      socket.once('connect',()=>wire.send({type:'hello',roomId:target.roomId,member:this.me}));
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
    if (this.mode==='host') return !!this.clients.get(to)?.wire.send({type:'signal',from:this.me.id,name:this.me.name,payload});
    if (this.mode==='guest' && this.socket && !this.socket.destroyed) return this.wire.send({type:'signal',to,payload});
    return false;
  }
  leave() {
    this.generation++; clearTimeout(this.retryTimer); this.retryTimer=null; clearInterval(this.heartbeat);
    if (this.mode==='host') for (const peer of this.clients.values()) { clearTimeout(peer.expiry); peer.wire.send({type:'room-ended'}); peer.socket?.end(); }
    else if(this.mode==='guest') this.wire?.send({type:'leave'});
    this.mode=null;this.currentInvite=null; this.socket?.destroy(); this.socket=null;
    for(const map of [this.pendingReads,this.pendingUploads]){for(const pending of map.values()){clearTimeout(pending.timer);pending.reject(new Error('Você saiu do grupo.'));}map.clear();}
    for(const socket of this.sockets) socket.destroy(); this.sockets.clear(); this.clients.clear(); this.server?.close(); this.server=null; this.info=null;
  }
}
