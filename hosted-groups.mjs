import {EventEmitter} from 'node:events';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,lstatSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {RoomService} from './room-service.mjs';
import {normalizeGroup,loadGroupIdentity} from './group-policy.mjs';
import {hostedError} from './hosted-service.mjs';
import {cleanAvatar} from './profile.js';

const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
const defaults=()=>[{id:'text-geral',kind:'text',name:'geral'},{id:'text-links',kind:'text',name:'links'},{id:'voice-lobby',kind:'voice',name:'Lobby'},{id:'voice-jogos',kind:'voice',name:'Jogos'}];
function origin(value){let url;try{url=new URL(value);}catch{throw hostedError(400,'Informe o endereço HTTPS do servidor.');}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw hostedError(400,'Use o endereço HTTPS sem caminho ou senha.');return url.origin;}
function inviteFor(record){const url=new URL('stringchat://server/join');url.searchParams.set('url',record.origin);url.searchParams.set('room',record.id);url.searchParams.set('key',record.core.token);return url.toString();}

// HTTPS supplies authenticated account IDs. The existing group engine remains
// responsible for permissions, authorship, moderation, history and attachments.
export class HostedGroups extends EventEmitter {
  constructor({statePath,publicUrl='',maxGroups=64,maxMemberships=512,maxActiveMembers=128,maxVoiceMembers=6,maxEventBytes=8*1024*1024,maxTotalAttachmentBytes=512*1024*1024,leaseMs=35000}={}){
    super();if(!statePath)throw Error('Configure o armazenamento dos grupos hospedados.');
    Object.assign(this,{statePath,publicUrl:publicUrl?origin(publicUrl):'',maxGroups,maxMemberships,maxActiveMembers,maxVoiceMembers,maxEventBytes,maxTotalAttachmentBytes,leaseMs});this.directory=join(dirname(statePath),'hosted-groups');this.records=new Map();this.downloads=new Map();this.closed=false;
    let saved;try{saved=JSON.parse(readFileSync(statePath,'utf8'));if(saved.product!=='String Chat groups'||saved.version!==1||!Array.isArray(saved.groups))throw Error();}catch(error){if(error.code!=='ENOENT')throw Error('O índice dos grupos está inválido e foi preservado.');saved={groups:[]};}
    for(const id of saved.groups){if(!validId(id)||this.records.has(id))throw Error('Grupo inválido no índice.');const file=this.path(id),data=JSON.parse(readFileSync(file,'utf8'));if(data.product!=='String Chat hosted group'||data.version!==1||data.room?.id!==id||!validId(data.room.ownerId)||typeof data.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.token))throw Error('O armazenamento de um grupo está inválido e foi preservado.');this.initialize({id,ownerId:data.room.ownerId,origin:origin(data.hosted?.origin||this.publicUrl),saved:data});}
    this.sweeper=setInterval(()=>this.prune(),Math.min(5000,Math.max(500,leaseMs/2)));this.sweeper.unref?.();
  }
  path(id){if(!validId(id))throw Error('Identificador inválido.');const target=resolve(this.directory,id,'group.json');if(!target.startsWith(resolve(this.directory)+sep))throw Error('Caminho de grupo inválido.');return target;}
  saveIndex(){mkdirSync(dirname(this.statePath),{recursive:true,mode:0o700});writeFileSync(this.statePath+'.tmp',JSON.stringify({product:'String Chat groups',version:1,groups:[...this.records.values()].filter(r=>!r.transient).map(r=>r.id)}),{mode:0o600});renameSync(this.statePath+'.tmp',this.statePath);}
  save(record){if(record.transient||record.transaction)return;const core=record.core;mkdirSync(dirname(core.statePath),{recursive:true,mode:0o700});writeFileSync(core.statePath+'.tmp',JSON.stringify({product:'String Chat hosted group',version:1,room:core.room,token:core.token,history:core.history,bindings:core.bindings,ownerKey:core.identity.publicKey,hosted:{origin:record.origin,sequence:record.sequence,operations:[...record.operations]}}),{mode:0o600});renameSync(core.statePath+'.tmp',core.statePath);}
  initialize({id,ownerId,origin:publicOrigin,room,saved=null,transient=false,allowedMembers=null}){
    const core=new RoomService({statePath:transient?null:this.path(id),serverHost:true}),record={id,ownerId,origin:publicOrigin,core,transient,allowedMembers,sequence:Number(saved?.hosted?.sequence)||0,events:[],eventBytes:0,operations:new Map(),transaction:false,createdAt:Date.now()};
    core.identity=loadGroupIdentity(core.statePath);if(saved?.ownerKey&&saved.ownerKey!==core.identity.publicKey)throw Error('A chave do controlador do grupo mudou. O estado foi preservado.');core.mode='host';core.me={id:ownerId,name:'Dono do grupo',avatar:'',voiceChannelId:null};core.room=normalizeGroup(saved?.room||{...room,id,channels:room?.channels||defaults()},ownerId);core.room.memberships[ownerId]||={roleIds:['member'],nickname:'',timeoutUntil:0};core.token=saved?.token||randomBytes(32).toString('base64url');core.history=Array.isArray(saved?.history)?saved.history.slice(-200):[];core.bindings=saved?.bindings||{};core.transient=transient;core.allowedMembers=allowedMembers;
    for(const[key,value]of(saved?.hosted?.operations||[]).slice(-512))if(typeof key==='string'&&value&&typeof value.fingerprint==='string')record.operations.set(key,value);
    core.info={invite:inviteFor(record),room:core.roomFor(core.me),hostId:ownerId,selfId:ownerId,hosted:true,localAddress:null,address:null,port:null};
    core.persist=()=>this.save(record);core.sendHistory=()=>{};
    core.broadcast=(event,except=null)=>{this.append(record,event,{except});core.emit('event',event);};
    this.records.set(id,record);return record;
  }
  append(record,event,extra={}){
    const value=event.type==='room-updated'?{type:'room-updated',revision:record.core.room.revision}:event.type==='channels-updated'?{type:'channels-updated'}:clone(event);
    const row={sequence:++record.sequence,event:value,...extra},bytes=Buffer.byteLength(JSON.stringify(row));record.events.push({...row,bytes});record.eventBytes+=bytes;
    while(record.events.length>512||record.eventBytes>this.maxEventBytes){record.eventBytes-=record.events.shift().bytes;}
  }
  active(record,account){
    let identity=record.core.clients.get(account.id);if(identity){identity.name=String(account.name||'Amigo').slice(0,32);identity.avatar=cleanAvatar(account.avatar);identity.lastSeen=Date.now();return identity;}
    if(record.core.clients.size>=this.maxActiveMembers)throw hostedError(429,'O grupo atingiu o limite de participantes online.');
    identity={id:account.id,name:String(account.name||'Amigo').slice(0,32),avatar:cleanAvatar(account.avatar),voiceChannelId:null,lastSeen:Date.now(),_mediaState:{},wire:{send:event=>{this.append(record,event,{to:account.id});return true;}},socket:{end:()=>{}},};
    record.core.clients.set(account.id,identity);this.append(record,{type:'member-added',member:record.core.publicMember(identity)},{except:account.id});return identity;
  }
  member(record,account){
    if(!account||!validId(account.id))throw hostedError(401);if(record.core.room.bans.some(b=>b.id===account.id))throw hostedError(403,'Você foi banido deste grupo.');if(!record.core.room.memberships[account.id])throw hostedError(403,'Entre no grupo com um convite válido.');return this.active(record,account);
  }
  roster(record){return[...record.core.clients.values()].map(member=>record.core.publicMember(member));}
  snapshot(record,account,type='welcome'){
    const identity=this.member(record,account),core=record.core,capabilities=core.roomFor(identity).capabilities;
    return{type,hosted:true,protocol:2,room:core.roomFor(identity),hostId:record.ownerId,hostIdentity:this.service?.accounts.get(record.ownerId)?.identity||core.bindings[record.ownerId],selfId:account.id,selfMember:core.publicMember(identity),selfVoiceChannelId:identity.voiceChannelId,members:this.roster(record).filter(m=>m.id!==account.id),history:core.history.filter(m=>core.can(identity,'read',m.channelId)),cursor:record.sequence,serverUrl:record.origin,...(capabilities.manageGroup?{invite:inviteFor(record)}:{}),localAddress:null,networkAddress:null,kind:'hosted'};
  }
  shape(record,row,account){
    if(row.to&&row.to!==account.id||row.except===account.id)return null;const core=record.core,identity=core.clients.get(account.id),event=row.event;if(!identity)return null;
    if(event.type==='signal'){const source=core.clients.get(event.from);if(!source||event.to!==account.id||!core.canSignal(source,account.id))return null;return{type:'signal',from:source.id,name:source.name,payload:event.payload};}
    const channelId=event.channelId||event.message?.channelId;if(channelId&&!core.can(identity,'read',channelId))return null;
    if(event.type==='member-updated'||event.type==='member-added'||event.type==='member-back'){const current=core.clients.get(event.member?.id);if(!current)return null;return{type:event.type,member:core.publicMember(current)};}
    if(event.type==='chat'||event.type==='message-updated'){const current=core.history.find(m=>m.id===event.message?.id);if(!current)return null;return{type:event.type,message:clone(current)};}
    if(event.type==='room-updated')return{type:'room-updated',room:core.roomFor(identity),members:this.roster(record),history:core.history.filter(m=>core.can(identity,'read',m.channelId))};
    if(event.type==='channels-updated')return{type:'channels-updated',channels:core.roomFor(identity).channels};
    if(event.type==='history')return{type:'history',messages:event.messages.filter(m=>core.can(identity,'read',m.channelId))};return clone(event);
  }
  poll(record,account,after){
    this.member(record,account);if(!Number.isSafeInteger(after)||after<0)throw hostedError(400,'Cursor inválido.');
    const first=record.events[0]?.sequence??record.sequence+1;if(after>record.sequence||after<first-1)return{events:[],nextCursor:record.sequence,reset:true,snapshot:this.snapshot(record,account)};
    const events=[];let cursor=after,bytes=0;for(const row of record.events){if(row.sequence<=after)continue;const value=this.shape(record,row,account);cursor=row.sequence;if(value){const size=Buffer.byteLength(JSON.stringify(value));if(events.length&&bytes+size>1024*1024){cursor=row.sequence-1;break;}events.push(value);bytes+=size;if(events.length>=64)break;}}
    return{events,nextCursor:cursor,reset:false};
  }
  perform(record,account,name,body,run){
    const identity=this.member(record,account),operationId=body.operationId;if(!validId(operationId))throw hostedError(400,'A ação precisa de um identificador válido.');const key=account.id+':'+operationId,fingerprint=digest(JSON.stringify({name,body})),prior=record.operations.get(key);if(prior){if(prior.fingerprint!==fingerprint)throw hostedError(409,'O identificador já foi usado para outra ação.');return this.replay(record,identity,name,body,prior.result);}
    const beforeEvents=record.events.slice(),beforeBytes=record.eventBytes,beforeSequence=record.sequence;record.transaction=true;
    try{const result=clone(run(identity)??true);record.operations.set(key,{fingerprint,result});let bytes=Buffer.byteLength(JSON.stringify([...record.operations]));while(record.operations.size>512||bytes>2*1024*1024){record.operations.delete(record.operations.keys().next().value);bytes=Buffer.byteLength(JSON.stringify([...record.operations]));}record.transaction=false;this.save(record);return result;}
    catch(error){record.transaction=false;record.events=beforeEvents;record.eventBytes=beforeBytes;record.sequence=beforeSequence;if(Number.isInteger(error.status))throw error;throw hostedError(403,String(error.message||error).slice(0,180));}
  }
  replay(record,identity,name,body,result){
    const core=record.core;if(name==='manage'){
      const action=String(body.action||''),permission=action.startsWith('channel-')||action.startsWith('category-')?'manageChannels':['room-update','invite-rotate'].includes(action)?'manageGroup':action==='member-nickname'&&body.id===identity.id?null:'moderateMembers';
      if(action.startsWith('role-')||action==='member-role'){if(identity.id!==record.ownerId)throw hostedError(403);}else if(permission&&!core.can(identity,permission))throw hostedError(403);
      if(action==='room-update')return clone(core.roomFor(identity));
      if(action.startsWith('channel-')&&result?.id){const channel=core.room.channels.find(channel=>channel.id===result.id);if(!channel||!core.can(identity,'read',channel.id))throw hostedError(403);return clone(channel);}
    }
    if(result?.channelId){const current=core.history.find(message=>message.id===result.id);if(!current||!core.can(identity,'read',current.channelId))throw hostedError(403,'A mensagem não está disponível neste canal.');return clone(current);}
    return clone(result);
  }
  canJoin(record,account,key){
    if(record.core.room.bans.some(b=>b.id===account.id))throw hostedError(403,'Você foi banido deste grupo.');
    if(record.allowedMembers&&record.allowedMembers[account.id]!==account.identity)throw hostedError(403,'Esta chamada é privada para os dois participantes convidados.');
    if(!record.core.room.memberships[account.id]){if(typeof key!=='string'||key.length!==record.core.token.length||!timingSafeEqual(Buffer.from(key),Buffer.from(record.core.token)))throw hostedError(403,'Convite inválido.');if(Object.keys(record.core.room.memberships).length>=this.maxMemberships)throw hostedError(429,'O grupo atingiu o limite de membros.');record.core.room.memberships[account.id]={roleIds:['member'],nickname:'',timeoutUntil:0};record.core.bindings[account.id]=account.identity;record.core.changed();}
    const known=record.core.bindings[account.id];if(known&&known!==account.identity)throw hostedError(403,'A identidade conhecida deste membro mudou.');record.core.bindings[account.id]=account.identity;
  }
  checkVoice(record,identity,channelId){if(channelId!==null&&record.core.clients.size&&[...record.core.clients.values()].filter(p=>p.id!==identity.id&&p.voiceChannelId===channelId).length>=this.maxVoiceMembers)throw hostedError(429,`Este canal permite até ${this.maxVoiceMembers} pessoas em voz P2P.`);}
  checkPrivate(record,body){if(record.core.room.kind!=='direct')return;if(body.expectedRoomKind!=='direct'||body.expectedCallId!==record.id||body.expectedHostId!==record.ownerId||body.expectedHostKey!==(this.service?.accounts.get(record.ownerId)?.identity||record.core.bindings[record.ownerId]))throw hostedError(403,'A identidade ou o destino da chamada privada não corresponde ao convite.');}
  quit(record,identity){
    clearTimeout(identity.mediaTimer);if(identity.upload){clearTimeout(identity.upload.timer);identity.upload=null;}record.core.clearTyping(identity.id);record.core.clients.delete(identity.id);this.append(record,{type:'member-left',id:identity.id,name:identity.name});
  }
  remove(record){record.core.leave();this.records.delete(record.id);this.saveIndex();if(!record.transient){const directory=dirname(record.core.statePath);if(!resolve(directory).startsWith(resolve(this.directory)+sep)||resolve(directory)!==resolve(this.directory,record.id))throw Error('Caminho de exclusão inválido.');const check=path=>{if(lstatSync(path).isSymbolicLink())throw Error('Pasta de grupo redirecionada.');};check(directory);rmSync(directory,{recursive:true,force:true});}}
  prune(){
    if(this.closed)return;const now=Date.now();for(const record of this.records.values()){for(const identity of [...record.core.clients.values()])if(now-identity.lastSeen>this.leaseMs)this.quit(record,identity);if(record.transient&&(!record.core.clients.size||now-record.createdAt>3600000))this.remove(record);}
    for(const[key,value]of this.downloads)if(now-value.time>60000)this.downloads.delete(key);
  }
  totalAttachments(){let total=0;for(const record of this.records.values())for(const item of record.core.history)total+=item.attachment?.size||0;return total;}
  attachment(record,identity,id){const item=record.core.history.find(m=>m.attachment?.id===id&&!m.deleted);if(!item||!record.core.can(identity,'read',item.channelId))throw hostedError(404,'Arquivo indisponível neste canal.');return item.attachment;}
  download(record,identity,id,chunk){const attachment=this.attachment(record,identity,id);if(chunk===null)return attachment;const index=Number(chunk),start=index*24000;if(!Number.isInteger(index)||index<0||start>=attachment.size)throw hostedError(400,'Parte de arquivo inválida.');const key=record.id+':'+id;let cached=this.downloads.get(key);if(!cached){cached={data:record.core.readFile(id).data,time:Date.now()};this.downloads.set(key,cached);while([...this.downloads.values()].reduce((n,v)=>n+v.data.length,0)>128*1024*1024)this.downloads.delete(this.downloads.keys().next().value);}cached.time=Date.now();return{index,data:cached.data.subarray(start,start+24000).toString('base64'),end:start+24000>=attachment.size};}
  route({service,method,url,account,body}){
    if(!url.pathname.startsWith('/v1/groups'))return undefined;if(this.closed)throw hostedError(503);this.service=service;this.prune();
    if(url.pathname==='/v1/groups'&&method==='GET')return{groups:[...this.records.values()].filter(record=>record.core.room.kind!=='direct'&&record.core.room.memberships[account.id]&&!record.core.room.bans.some(b=>b.id===account.id)).map(record=>({id:record.id,name:record.core.room.name,description:record.core.room.description,ownerId:record.ownerId,members:Object.keys(record.core.room.memberships).length,online:record.core.clients.size,serverUrl:record.origin}))};
    if(url.pathname==='/v1/groups'&&method==='POST'){
      if(this.records.size>=this.maxGroups)throw hostedError(429,'O servidor atingiu o limite de grupos.');const direct=body.room?.kind==='direct',id=direct?body.room.id:randomBytes(16).toString('hex');if(!validId(id)||this.records.has(id))throw hostedError(409,'Identificador de grupo já utilizado.');const publicOrigin=this.publicUrl||origin(body.publicUrl),allowed=direct?body.allowedMembers:null;
      if(direct){if(!body.transient||body.room.callId!==id||!allowed||Object.keys(allowed).length!==2||allowed[account.id]!==account.identity||!Object.entries(allowed).every(([id,key])=>validId(id)&&service.accounts.get(id)?.identity===key)||!Object.keys(allowed).filter(id=>id!==account.id).every(id=>service.friend(account.id,id)))throw hostedError(403,'Uma chamada privada exige duas amizades verificadas.');}else if(body.transient||body.allowedMembers)throw hostedError(400);
      const room=normalizeGroup({id,kind:direct?'direct':'group',...(direct?{callId:id}:{}),name:String(body.room?.name||body.name||'Grupo da galera').slice(0,40),description:String(body.room?.description||body.description||'').slice(0,240),channels:direct?body.room.channels:defaults()},account.id),channel=body.member?.voiceChannelId??null;if(channel!==null&&!room.channels.some(item=>item.id===channel&&item.kind==='voice'))throw hostedError(400,'Canal de voz não encontrado.');const record=this.initialize({id,ownerId:account.id,origin:publicOrigin,room,transient:direct,allowedMembers:allowed});record.core.bindings[account.id]=account.identity;this.active(record,account);const identity=record.core.clients.get(account.id);if(channel!==null)record.core.updateVoice(identity,channel);this.save(record);this.saveIndex();return this.snapshot(record,account,'hosting');
    }
    if(url.pathname==='/v1/groups/join'&&method==='POST'){
      if(!validId(body.roomId))throw hostedError(400);const record=this.records.get(body.roomId);if(!record)throw hostedError(404,'Grupo não encontrado.');this.checkPrivate(record,body);this.canJoin(record,account,body.key);const identity=this.member(record,account);const channel=body.voiceChannelId??null;if(channel!==null){this.checkVoice(record,identity,channel);record.core.updateVoice(identity,channel);}this.save(record);return this.snapshot(record,account);
    }
    const match=/^\/v1\/groups\/([a-f0-9]{32})(?:\/(.*))?$/.exec(url.pathname);if(!match)throw hostedError(404);const record=this.records.get(match[1]);if(!record)throw hostedError(404,'Grupo não encontrado.');const rest=match[2]||'';if(method==='POST'&&rest==='enter'&&record.transient)throw hostedError(403,'Use o aceite da chamada privada para entrar.');const identity=this.member(record,account),core=record.core;
    if(method==='GET'&&rest==='events')return this.poll(record,account,Number(url.searchParams.get('after')||0));
    if(method==='GET'&&(!rest||rest==='snapshot'))return this.snapshot(record,account);
    if(method==='POST'&&rest==='enter'){const channel=body.voiceChannelId??null;if(channel!==null){this.checkVoice(record,identity,channel);core.updateVoice(identity,channel);}return this.snapshot(record,account);}
    if(method==='POST'&&rest==='leave'){this.quit(record,identity);if(record.transient)this.remove(record);return{ok:true};}
    if(method==='POST'&&rest==='forget'){if(account.id===record.ownerId)throw hostedError(403,'O dono precisa apagar o grupo para sair definitivamente.');this.quit(record,identity);delete core.room.memberships[account.id];core.changed();return{ok:true};}
    if(method==='DELETE'&&!rest){if(account.id!==record.ownerId)throw hostedError(403);this.remove(record);return{ok:true};}
    if(method==='POST'&&rest==='voice'){this.checkVoice(record,identity,body.channelId??null);return core.updateVoice(identity,body.channelId??null);}
    if(method==='POST'&&rest==='media')return core.updateMediaState(identity,body);
    if(method==='POST'&&rest==='typing')return core.setTyping(identity,body);
    if(method==='POST'&&rest==='chat')return this.perform(record,account,'chat',body,actor=>core.acceptChat(actor,body));
    if(method==='POST'&&rest==='messages/actions')return this.perform(record,account,'message-action',body,actor=>core.messageActionHost(actor,body));
    if(method==='POST'&&rest==='manage')return this.perform(record,account,'manage',body,actor=>{const result=core.manageHost(actor,body);if(body.action==='kick'){delete core.room.memberships[body.id];core.changed();}core.info.invite=inviteFor(record);return result;});
    if(method==='POST'&&rest==='signal'){if(!validId(body.to)||body.to===account.id||!body.payload||typeof body.payload!=='object'||Buffer.byteLength(JSON.stringify(body.payload))>100000||!core.canSignal(identity,body.to))throw hostedError(403,'A mídia precisa estar no mesmo canal de voz autorizado.');this.append(record,{type:'signal',from:account.id,to:body.to,name:identity.name,payload:body.payload},{to:body.to});return{ok:true};}
    if(method==='POST'&&rest==='uploads'){const pending=[...this.records.values()].reduce((total,r)=>total+[...r.core.clients.values()].reduce((sum,member)=>sum+(member.upload?.size||0),0),0);if(this.totalAttachments()+pending+Number(body.size||0)>this.maxTotalAttachmentBytes)throw hostedError(429,'O armazenamento de anexos do servidor está cheio.');core.beginUpload(identity,{...body,type:'media-start'});if(identity.upload?.id!==body.uploadId)throw hostedError(403,'O arquivo ou o canal não permite envio.');return{uploadId:body.uploadId};}
    const upload=/^uploads\/([a-f0-9]{32})\/(chunks|complete)$/.exec(rest);
    if(method==='POST'&&upload){if(upload[2]==='chunks'){if(identity.upload?.id!==upload[1])throw hostedError(404,'Envio não encontrado.');core.uploadChunk(identity,{uploadId:upload[1],data:body.data});if(!identity.upload)throw hostedError(400,'Parte de arquivo inválida.');return{ok:true};}return this.perform(record,account,'upload-complete:'+upload[1],body,actor=>{if(actor.upload?.id!==upload[1])throw Error('Envio não encontrado.');core.endUpload(actor,{uploadId:upload[1]});const item=core.history.find(m=>m.uploadId===upload[1]&&m.authorId===account.id);if(!item)throw Error('O arquivo não foi confirmado.');return item;});}
    const attachment=/^attachments\/([a-f0-9]{32})$/.exec(rest);if(method==='GET'&&attachment)return this.download(record,identity,attachment[1],url.searchParams.get('chunk'));
    throw hostedError(404,'Recurso de grupo não encontrado.');
  }
  close(){if(this.closed)return;this.closed=true;clearInterval(this.sweeper);for(const record of this.records.values()){this.save(record);record.core.leave();}this.downloads.clear();this.saveIndex();}
}
