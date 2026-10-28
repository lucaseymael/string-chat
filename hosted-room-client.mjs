import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {normalizeHostedUrl} from './hosted-client.mjs';

const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const operationId=()=>randomBytes(16).toString('hex');
export function parseHostedInvite(value){
  let url;try{url=new URL(String(value).trim());}catch{throw Error('Cole o convite completo do grupo hospedado.');}
  if(url.protocol!=='stringchat:'||url.hostname!=='server'||url.pathname!=='/join')throw Error('Convite de servidor inválido.');
  const serverUrl=normalizeHostedUrl(url.searchParams.get('url')),roomId=url.searchParams.get('room'),key=url.searchParams.get('key');
  if(!validId(roomId)||!/^[A-Za-z0-9_-]{43}$/.test(key||''))throw Error('O convite de servidor está incompleto.');return{serverUrl,roomId,key};
}

// Node-side adapter. It uses the configured HTTPS client's signatures and TLS
// validation; renderer code never receives account private keys.
export class HostedRoomClient extends EventEmitter {
  constructor({client,pollIntervalMs=1000}={}){super();if(!client?.api||!client?.friends)throw Error('Conecte uma conta ao servidor antes de entrar em grupos.');this.client=client;this.pollIntervalMs=Math.max(250,pollIntervalMs);this.privateCallsVersion=1;this.hosted=true;this.mode=null;this.room=null;this.me=null;this.info=null;this.currentInvite=null;this.clients=new Map();this.history=[];this.generation=0;this.pollBusy=false;this.cursor=0;this.retrySince=0;this.lastMedia='';this.pendingDownloads=new Map();}
  privateIdentity(){return this.client.friends.publicIdentity().identity;}
  path(suffix=''){if(!this.room?.id)throw Error('Entre em um grupo hospedado.');return'/v1/groups/'+this.room.id+(suffix?'/'+suffix:'');}
  async list(){return this.client.api('GET','/v1/groups');}
  async create({room,member,transient=false,allowedMembers=null}={}){
    if(this.mode)throw Error('Saia da sala atual antes de criar outra.');const generation=this.generation;this.starting=true;
    try{const snapshot=await this.client.api('POST','/v1/groups',{room,member,transient,allowedMembers,publicUrl:this.client.url});if(generation!==this.generation){await this.client.api(snapshot.room?.kind==='direct'?'POST':'DELETE','/v1/groups/'+snapshot.room.id+(snapshot.room.kind==='direct'?'/leave':''),{}).catch(()=>{});throw Error('Criação do grupo cancelada.');}this.activate(snapshot,'hosting');this.startPolling();return this.info;}finally{this.starting=false;}
  }
  async join({invite,member,transient=false,expectedHostKey=null,expectedHostId=null,expectedRoomKind=null,expectedCallId=null}={}){
    if(this.mode)throw Error('Saia da sala atual antes de entrar em outra.');const target=parseHostedInvite(invite);if(target.serverUrl!==this.client.url)throw Error('Conecte-se ao servidor deste convite antes de entrar.');if(transient&&(!expectedHostKey||!validId(expectedHostId)||expectedRoomKind!=='direct'||expectedCallId!==target.roomId))throw Error('A chamada privada não informou as identidades esperadas.');
    const generation=this.generation;const snapshot=await this.client.api('POST','/v1/groups/join',{roomId:target.roomId,key:target.key,voiceChannelId:member?.voiceChannelId??null,expectedHostKey,expectedHostId,expectedRoomKind,expectedCallId});
    if(generation!==this.generation){await this.client.api('POST','/v1/groups/'+target.roomId+'/leave',{}).catch(()=>{});throw Error('Entrada no grupo cancelada.');}
    if(snapshot.room?.kind==='direct'&&(!transient||snapshot.hostIdentity!==expectedHostKey||snapshot.hostId!==expectedHostId||snapshot.room.callId!==expectedCallId)){await this.client.api('POST','/v1/groups/'+target.roomId+'/leave',{}).catch(()=>{});throw Error('A identidade ou o destino da chamada privada mudou.');}
    this.currentInvite=String(invite).trim();this.activate(snapshot,'welcome');this.startPolling();return this.info;
  }
  async enter(roomId,{voiceChannelId=null}={}){if(this.mode)throw Error('Saia da sala atual antes de entrar em outra.');if(!validId(roomId))throw Error('Grupo inválido.');const generation=this.generation,snapshot=await this.client.api('POST','/v1/groups/'+roomId+'/enter',{voiceChannelId});if(generation!==this.generation){await this.client.api('POST','/v1/groups/'+roomId+'/leave',{}).catch(()=>{});throw Error('Entrada no grupo cancelada.');}this.activate(snapshot,'welcome');this.startPolling();return this.info;}
  activate(snapshot,type='welcome',resumed=false){
    if(!snapshot?.hosted||!validId(snapshot.room?.id)||!validId(snapshot.selfId)||snapshot.selfId!==this.client.friends.id||snapshot.serverUrl!==this.client.url||!Array.isArray(snapshot.members))throw Error('O servidor retornou um grupo inválido.');
    this.room=snapshot.room;this.me={...snapshot.selfMember,id:snapshot.selfId,name:snapshot.selfMember?.name||this.client.friends.getName(),voiceChannelId:snapshot.selfVoiceChannelId??null};this.mode=snapshot.hostId===snapshot.selfId?'host':'guest';this.clients=new Map(snapshot.members.filter(m=>m.id!==snapshot.selfId).map(member=>[member.id,{...member}]));this.history=(snapshot.history||[]).slice(-200);this.cursor=snapshot.cursor||0;this.retrySince=0;this.lastMedia='';
    if(snapshot.invite)this.currentInvite=snapshot.invite;this.info={...snapshot,type,hosted:true,networkAddress:null,localAddress:null,address:null,kind:'hosted',invite:this.currentInvite};
    this.emit('event',{...this.info,resumed});for(let i=0;i<this.history.length;i+=20)this.emit('event',{type:'history',messages:this.history.slice(i,i+20)});
  }
  startPolling(){clearInterval(this.pollTimer);this.pollTimer=setInterval(()=>this.poll().catch(()=>{}),this.pollIntervalMs);this.pollTimer.unref?.();}
  remember(item){if(!validId(item?.id))return;const existing=this.history.findIndex(message=>message.id===item.id);if(existing<0)this.history.push(item);else if((item.revision||0)>=(this.history[existing].revision||0))this.history[existing]=item;this.history=this.history.slice(-200);}
  apply(event){
    if(event.type==='room-updated'){this.room=event.room;const visible=new Set(this.room.channels.map(channel=>channel.id));this.history=this.history.filter(message=>visible.has(message.channelId));if(this.info)this.info.room=event.room;if(Array.isArray(event.members)){this.clients=new Map(event.members.filter(m=>m.id!==this.me.id).map(member=>[member.id,{...member}]));const self=event.members.find(m=>m.id===this.me.id);if(self)Object.assign(this.me,self);}for(const message of event.history||[])this.remember(message);}
    else if(event.type==='channels-updated')this.room.channels=event.channels;
    else if(['member-added','member-back','member-updated'].includes(event.type)){if(event.member?.id===this.me.id)Object.assign(this.me,event.member);else if(validId(event.member?.id))this.clients.set(event.member.id,{...event.member});}
    else if(event.type==='member-left')this.clients.delete(event.id);
    else if(['chat','message-updated'].includes(event.type))this.remember(event.message);
    else if(event.type==='history')for(const message of event.messages||[])this.remember(message);
    else if(event.type==='invite-rotated'){const target=parseHostedInvite(event.invite);if(target.serverUrl!==this.client.url||target.roomId!==this.room.id)throw Error('O servidor alterou o destino do convite.');this.currentInvite=event.invite;if(this.info)this.info.invite=event.invite;}
    else if(event.type==='moderation-ended'||event.type==='room-ended'){this.reset();this.emit('event',event);return;}
    this.emit('event',event);if(event.type==='room-updated'&&Array.isArray(event.history))for(let i=0;i<event.history.length;i+=20)this.emit('event',{type:'history',messages:event.history.slice(i,i+20)});
  }
  async poll(){
    if(this.pollPromise)await this.pollPromise;if(!this.mode)return;if(this.pollPromise)return this.pollPromise;
    const pending=this.pollOnce();this.pollPromise=pending;try{return await pending;}finally{if(this.pollPromise===pending)this.pollPromise=null;}
  }
  async pollOnce(){
    if(!this.mode)return;this.pollBusy=true;const generation=this.generation,path=this.path('events')+'?after='+this.cursor;
    try{const result=await this.client.api('GET',path);if(generation!==this.generation||!this.mode)return;if(result.reset){this.activate(result.snapshot,'welcome',true);}else{if(!Array.isArray(result.events)||!Number.isSafeInteger(result.nextCursor))throw Error('A atualização do grupo é inválida.');for(const event of result.events){if(!this.mode)break;this.apply(event);}this.cursor=result.nextCursor;}if(this.retrySince){this.retrySince=0;this.emit('event',{type:'network-status',status:'connected'});}}
    catch(error){if(generation!==this.generation||!this.mode)return;if([401,403,404].includes(error.status)){const type=error.status===403?'moderation-ended':'room-ended';this.reset();this.emit('event',{type,action:error.status===403?'removed':undefined,message:error.message,reason:error.message});return;}this.retrySince||=Date.now();this.emit('event',{type:'network-status',status:'reconnecting'});if(Date.now()-this.retrySince>40000){this.reset();this.emit('event',{type:'room-ended',message:'O servidor do grupo ficou indisponível. Entre novamente quando a conexão voltar.'});}throw error;}
    finally{this.pollBusy=false;}
  }
  async command(suffix,body,{idempotent=false}={}){if(!this.mode)throw Error('Entre em um grupo hospedado.');const generation=this.generation,result=await this.client.api('POST',this.path(suffix),{...body,...(idempotent?{operationId:body?.operationId||operationId()}: {})});if(generation!==this.generation)throw Error('A chamada mudou enquanto a ação era enviada.');await this.poll().catch(()=>{});return result;}
  manage(input){return this.command('manage',input,{idempotent:true});}
  createChannel(input){return this.manage({action:'channel-create',...input});}
  messageAction(input){return this.command('messages/actions',input,{idempotent:true});}
  chat(input){return this.command('chat',input,{idempotent:true});}
  voice(channelId){return this.command('voice',{channelId});}
  typing(input){return this.command('typing',input);}
  async mediaState(input){const next=JSON.stringify(Object.fromEntries(['mic','deafened','screen','camera','screenAudio'].map(key=>[key,input?.[key]===true])));if(next===this.lastMedia)return true;const result=await this.command('media',JSON.parse(next));this.lastMedia=next;return result;}
  signal(input){return this.command('signal',input);}
  setName(){if(this.mode)this.poll().catch(()=>{});}
  async sendAttachment({channelId,name,data}){
    data=Buffer.from(data);if(!data.length||data.length>8*1024*1024)throw Error('O limite por arquivo é 8 MB.');const id=operationId(),generation=this.generation,path=this.path('uploads');await this.client.api('POST',path,{uploadId:id,channelId,name,size:data.length});for(let offset=0;offset<data.length;offset+=24000){if(generation!==this.generation)throw Error('O envio foi cancelado.');await this.client.api('POST',path+'/'+id+'/chunks',{data:data.subarray(offset,offset+24000).toString('base64')});}if(generation!==this.generation)throw Error('O envio foi cancelado.');const result=await this.client.api('POST',path+'/'+id+'/complete',{operationId:operationId()});if(generation!==this.generation)throw Error('O envio foi cancelado.');await this.poll().catch(()=>{});return result;
  }
  getAttachment(id){if(!validId(id))return Promise.reject(Error('Arquivo inválido.'));if(this.pendingDownloads.has(id))return this.pendingDownloads.get(id);const pending=this.download(id).finally(()=>this.pendingDownloads.delete(id));this.pendingDownloads.set(id,pending);return pending;}
  async download(id){const generation=this.generation,path=this.path('attachments/'+id),meta=await this.client.api('GET',path);if(!Number.isInteger(meta.size)||meta.size<1||meta.size>8*1024*1024)throw Error('O arquivo é inválido.');const chunks=[];let received=0;for(let index=0;received<meta.size;index++){if(generation!==this.generation)throw Error('Download cancelado.');const part=await this.client.api('GET',path+'?chunk='+index);if(part.index!==index||typeof part.data!=='string'||part.data.length>33000)throw Error('Parte de arquivo inválida.');const bytes=Buffer.from(part.data,'base64');if(!bytes.length||bytes.length>24000||received+bytes.length>meta.size)throw Error('Arquivo incompleto.');chunks.push(bytes);received+=bytes.length;}return{...meta,data:Buffer.concat(chunks)};}
  reset(){this.generation++;clearInterval(this.pollTimer);this.pollTimer=null;this.mode=null;this.room=null;this.me=null;this.info=null;this.currentInvite=null;this.clients.clear();this.history=[];this.lastMedia='';this.cursor=0;this.pendingDownloads.clear();}
  leave(){const path=this.room?this.path('leave'):null;this.reset();return path?this.client.api('POST',path,{}).catch(()=>{}):Promise.resolve();}
  async forget(){const path=this.path('forget');await this.client.api('POST',path,{});this.reset();}
  close(){return this.leave();}
}
