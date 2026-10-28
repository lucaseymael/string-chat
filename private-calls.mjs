import {createCipheriv,createDecipheriv,hkdfSync,randomBytes,createPublicKey} from 'node:crypto';
import {parseInvite} from './room-service.mjs';
import {parseHostedInvite} from './hosted-room-client.mjs';
const privateInvite=value=>new URL(value).hostname==='server'?parseHostedInvite(value):parseInvite(value);

const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const validNonce=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const CALL_TIMEOUT=30000,CONNECT_TIMEOUT=30000,RECENT_TIMEOUT=300000;
const reasons=new Set(['ended','declined','busy','timeout','cancelled','failed','blocked','disconnected','closed']);
const roomKey=value=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{50,100}$/.test(value))throw Error('Identidade da chamada inválida.');
  const key=createPublicKey({key:Buffer.from(value,'base64url'),type:'spki',format:'der'});
  if(key.asymmetricKeyType!=='ed25519'||key.export({type:'spki',format:'der'}).toString('base64url')!==value)throw Error('Identidade da chamada inválida.');
  return value;
};
const callArgument=value=>typeof value==='string'?value:value?.callId;

/** Consent and encrypted signaling for a two-person ephemeral media room. No capture APIs are used here. */
export class PrivateCalls {
  constructor({friends,rooms,getMember,onEvent=()=>{}}){
    if(!friends||!rooms||typeof getMember!=='function')throw Error('Configuração da chamada privada inválida.');
    Object.assign(this,{friends,rooms,getMember,onEvent});this.current=null;this.closed=false;this.recent=new Map();this.accepting=new Map();
    this.roomListener=event=>{
      const call=this.current;
      if(!call||!this._ownsRoom(call))return;
      if(event.type==='room-ended'||event.type==='moderation-ended'||event.type==='member-left'&&event.id===call.friendId){this._finish(call,'disconnected');this._notifyEnd(call,'disconnected');}
    };
    this.friendListener=()=>{const call=this.current;if(!call)return;try{this._contact(call.friendId);}catch{this._finish(call,'blocked');}};
    rooms.on?.('event',this.roomListener);
    friends.on?.('change',this.friendListener);
  }

  snapshot(){return this.current?this._view(this.current):null;}
  _view(call,phase=call.phase,reason=call.reason||''){
    return{type:'private-call',phase,callId:call.id,friendId:call.friendId,name:call.name,avatar:call.avatar||null,mode:call.mode,initiator:call.initiator,expiresAt:call.expiresAt||0,reason,silent:this.friends.presence?.status==='dnd'};
  }
  _emit(call,phase=call.phase,reason=call.reason||''){const event=this._view(call,phase,reason);try{this.onEvent(event);}catch{}return event;}
  _contact(id){
    if(this.closed||!validId(id)||id===this.friends.id)throw Error('Amigo indisponível para chamada.');
    const contact=typeof this.friends.verified==='function'?this.friends.verified(id):this.friends.contacts?.get(id);
    if(contact?.status!=='friend'||contact.needsVerification||!validNonce(contact.sharedKey)||typeof contact.identity!=='string')throw Error('Revalide a amizade para iniciar uma chamada.');
    return{...contact};
  }
  _assertSupport(){if(this.rooms.privateCallsVersion!==1||typeof this.rooms.privateIdentity!=='function')throw Error('Atualize o aplicativo para usar chamadas privadas com acesso restrito.');}
  async _identity(){this._assertSupport();const identity=await this.rooms.privateIdentity();return roomKey(typeof identity==='string'?identity:identity?.publicKey);}
  _member(){const member=this.getMember();if(!member||member.id!==this.friends.id)throw Error('Identidade local da chamada inválida.');return{...member,id:this.friends.id,voiceChannelId:'voice-direct'};}
  _ownsRoom(call){return this.rooms.room?.kind==='direct'&&this.rooms.room?.id===call.id;}
  _matches(call){return !this.closed&&this.current===call&&!call.finished;}
  _assertLive(call){if(!this._matches(call))throw Error('A chamada já foi encerrada.');this._contact(call.friendId);}
  _remember(call,reason){
    const now=Date.now();for(const[id,value]of this.recent)if(now-value.time>RECENT_TIMEOUT)this.recent.delete(id);
    this.recent.set(call.id,{friendId:call.friendId,nonce:call.nonce,time:now,reason});while(this.recent.size>256)this.recent.delete(this.recent.keys().next().value);
  }
  _timer(call,ms,reason='timeout'){
    clearTimeout(call.timer);call.expiresAt=Date.now()+ms;
    call.timer=setTimeout(()=>{if(this._matches(call)){this._finish(call,reason);this._notifyEnd(call,reason);}},ms);call.timer.unref?.();
  }
  _finish(call,reason='ended'){
    if(call.finished)return this._view(call,'ended',call.reason);
    call.finished=true;call.reason=reasons.has(reason)?reason:'ended';call.phase='ended';call.expiresAt=0;clearTimeout(call.timer);this._remember(call,call.reason);
    if(this.current===call)this.current=null;
    if(this._ownsRoom(call))this.rooms.leave();
    return this._emit(call,'ended',call.reason);
  }
  _key(contact){const ids=[this.friends.id,contact.id].sort().join(':');return Buffer.from(hkdfSync('sha256',Buffer.from(contact.sharedKey,'base64url'),Buffer.from(ids),Buffer.from('stringchat-private-calls-v1'),32));}
  _seal(contact,payload){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this._key(contact),nonce),value={...payload,fromId:this.friends.id,toId:contact.id,time:Date.now()};
    const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return{n:nonce.toString('base64url'),d:data.toString('base64url'),t:cipher.getAuthTag().toString('base64url')};
  }
  _open(contact,packet){
    if(!packet||typeof packet.d!=='string'||packet.d.length>16000||typeof packet.n!=='string'||typeof packet.t!=='string')throw Error('Sinalização privada inválida.');
    const nonce=Buffer.from(packet.n,'base64url'),tag=Buffer.from(packet.t,'base64url');if(nonce.length!==12||tag.length!==16)throw Error('Sinalização privada inválida.');
    const decipher=createDecipheriv('aes-256-gcm',this._key(contact),nonce);decipher.setAuthTag(tag);
    const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(packet.d,'base64url')),decipher.final()]).toString('utf8'));
    if(!value||value.fromId!==contact.id||value.toId!==this.friends.id||!Number.isFinite(value.time)||Math.abs(Date.now()-value.time)>60000||!validId(value.callId)||!validNonce(value.nonce))throw Error('Sinalização privada inválida.');
    return value;
  }
  async _send(call,payload){
    const contact=this._contact(call.friendId),message={...payload,callId:call.id,nonce:call.nonce};
    const reply=await this.friends.request(contact,{type:'private-call',fromId:this.friends.id,packet:this._seal(contact,message)});
    const current=this._contact(call.friendId);if(current.sharedKey!==contact.sharedKey)throw Error('A identidade da amizade mudou durante a chamada.');
    if(reply?.type!=='private-call-reply'||reply.fromId!==contact.id)throw Error('O amigo não confirmou a chamada. Atualizem os aplicativos.');
    const result=this._open(contact,reply.packet);if(result.callId!==call.id||result.nonce!==call.nonce)throw Error('Confirmação de outra chamada.');return result;
  }
  _reply(contact,command,payload){return{type:'private-call-reply',fromId:this.friends.id,packet:this._seal(contact,{...payload,callId:command.callId,nonce:command.nonce})};}
  _notifyEnd(call,reason){if(this.closed)return;this._send(call,{kind:'end',reason}).catch(()=>{});}

  async start({friendId,mode='voice'}){
    const contact=this._contact(friendId);
    if(!['voice','video'].includes(mode))throw Error('Escolha uma chamada de voz ou vídeo.');
    if(this.current||this.rooms.mode)throw Error('Encerre a chamada ou saia do grupo atual antes de iniciar outra.');
    this.rooms.prepareFriend?.(contact);this._assertSupport();
    const call={id:randomBytes(16).toString('hex'),nonce:randomBytes(32).toString('base64url'),friendId,mode,name:contact.name||'Amigo',avatar:contact.avatar||null,phase:'outgoing',initiator:true,finished:false};
    this.current=call;this._timer(call,CALL_TIMEOUT);this._emit(call);
    try{
      call.hostKey=await this._identity();this._assertLive(call);
      const reply=await this._send(call,{kind:'offer',mode,hostKey:call.hostKey,expiresAt:call.expiresAt});
      if(!this._matches(call))return this._view(call,'ended',call.reason);
      if(reply.kind==='busy'||reply.kind==='ended')return this._finish(call,reply.reason||'busy');
      if(reply.kind!=='ringing')throw Error('O amigo não confirmou o toque da chamada.');
      return this._view(call);
    }catch(error){if(this._matches(call)){this._finish(call,'failed');this._notifyEnd(call,'failed');throw error;}return this._view(call,'ended',call.reason);}
  }

  accept(value){
    const id=callArgument(value);if(this.accepting.has(id))return this.accepting.get(id);
    const result=this._accept(id);this.accepting.set(id,result);result.finally(()=>this.accepting.delete(id)).catch(()=>{});return result;
  }
  async _accept(id){
    const call=this.current;
    if(!call||call.id!==id||call.initiator||call.phase!=='incoming')throw Error('Esta chamada não está mais tocando.');
    this._assertLive(call);this._assertSupport();if(this.rooms.mode){this._finish(call,'busy');this._notifyEnd(call,'busy');throw Error('Saia do grupo atual antes de atender.');}
    call.phase='connecting';this._timer(call,CONNECT_TIMEOUT);this._emit(call);
    try{
      const ownKey=await this._identity();this._assertLive(call);
      const reply=await this._send(call,{kind:'accept',guestKey:ownKey});this._assertLive(call);
      if(reply.kind==='ended'||reply.kind==='busy')return this._finish(call,reply.reason||'cancelled');
      if(reply.kind!=='connect'||roomKey(reply.hostKey)!==call.hostKey||typeof reply.invite!=='string')throw Error('O convite privado não foi confirmado.');
      const target=privateInvite(reply.invite);if(target.roomId!==call.id)throw Error('Convite de outra chamada.');
      if(this.rooms.mode)throw Error('Outra sala foi aberta durante o atendimento.');
      await this.rooms.join({invite:reply.invite,member:this._member(),transient:true,expectedHostKey:call.hostKey,expectedHostId:call.friendId,expectedRoomKind:'direct',expectedCallId:call.id});
      this._assertLive(call);if(!this._ownsRoom(call))throw Error('A sala privada não confirmou o acesso restrito.');
      const connected=await this._send(call,{kind:'connected'});this._assertLive(call);if(connected.kind!=='active')throw Error('A chamada foi encerrada durante a conexão.');
      call.phase='active';call.expiresAt=0;clearTimeout(call.timer);return this._emit(call);
    }catch(error){if(this._matches(call)){this._finish(call,'failed');this._notifyEnd(call,'failed');throw error;}if(this._ownsRoom(call))this.rooms.leave();return this._view(call,'ended',call.reason);}
  }

  async decline(value){const call=this.current;if(!call||call.id!==callArgument(value)||call.initiator||call.phase!=='incoming')return false;this._finish(call,'declined');await this._send(call,{kind:'decline'}).catch(()=>{});return this._view(call,'ended','declined');}
  async end(value){const id=callArgument(value)||this.current?.id,call=this.current;if(!call||call.id!==id)return false;const reason=call.phase==='active'?'ended':'cancelled';this._finish(call,reason);await this._send(call,{kind:'end',reason}).catch(()=>{});return this._view(call,'ended',reason);}

  async receive(message){
    if(message?.type!=='private-call')throw Error('Sinalização privada inválida.');
    const contact=this._contact(message.fromId),command=this._open(contact,message.packet);
    let response;
    if(command.kind==='offer')response=await this._offer(contact,command);
    else{
      const call=this.current;
      if(!call||call.id!==command.callId||call.nonce!==command.nonce||call.friendId!==contact.id)response={kind:'ended',reason:'cancelled'};
      else if(command.kind==='accept')response=await this._accepted(call,command);
      else if(command.kind==='connected'){
        await this.rooms.poll?.();
        if(!call.initiator||call.phase!=='connecting'||!this._ownsRoom(call)||!this.rooms.clients?.has(call.friendId))throw Error('O participante ainda não entrou na chamada privada.');
        call.phase='active';call.expiresAt=0;clearTimeout(call.timer);this._emit(call);response={kind:'active'};
      }else if(command.kind==='decline'){this._finish(call,'declined');response={kind:'ended',reason:'declined'};}
      else if(command.kind==='end'){const reason=reasons.has(command.reason)?command.reason:'ended';this._finish(call,reason);response={kind:'ended',reason};}
      else throw Error('Sinalização privada inválida.');
    }
    const current=this._contact(contact.id);if(current.sharedKey!==contact.sharedKey)throw Error('A identidade da amizade mudou durante a chamada.');
    return this._reply(contact,command,response);
  }
  async _offer(contact,command){
    if(!this.current&&!this.rooms.mode)this.rooms.prepareFriend?.(contact);
    this._assertSupport();
    if(!['voice','video'].includes(command.mode)||!Number.isFinite(command.expiresAt)||command.expiresAt<=Date.now()||command.expiresAt>Date.now()+CALL_TIMEOUT+5000)throw Error('Convite de chamada expirado.');
    const hostKey=roomKey(command.hostKey),recent=this.recent.get(command.callId);
    if(recent){if(recent.friendId!==contact.id||recent.nonce!==command.nonce)throw Error('Identificação de chamada já usada.');return{kind:'ended',reason:recent.reason};}
    const previous=this.current;
    if(previous){if(previous.id===command.callId&&previous.nonce===command.nonce&&previous.friendId===contact.id&&!previous.initiator)return{kind:previous.phase==='incoming'?'ringing':'active'};return{kind:'busy',reason:'busy'};}
    if(this.rooms.mode){this._remember({id:command.callId,friendId:contact.id,nonce:command.nonce},'busy');return{kind:'busy',reason:'busy'};}
    const call={id:command.callId,nonce:command.nonce,friendId:contact.id,mode:command.mode,name:contact.name||'Amigo',avatar:contact.avatar||null,hostKey,initiator:false,phase:'incoming',finished:false};
    this.current=call;this._timer(call,Math.min(CALL_TIMEOUT,command.expiresAt-Date.now()));this._emit(call);return{kind:'ringing'};
  }
  async _accepted(call,command){
    if(!call.initiator||call.phase!=='outgoing')return{kind:'ended',reason:call.phase==='active'?'busy':'cancelled'};
    this._assertLive(call);if(this.rooms.mode){this._finish(call,'busy');return{kind:'busy',reason:'busy'};}
    const guestKey=roomKey(command.guestKey);call.phase='connecting';this._timer(call,CONNECT_TIMEOUT);this._emit(call);
    try{
      const info=await this.rooms.create({room:{id:call.id,callId:call.id,kind:'direct',name:'Chamada privada',channels:[{id:'text-direct',kind:'text',name:'Conversa privada'},{id:'voice-direct',kind:'voice',name:'Chamada privada'}]},member:this._member(),transient:true,allowedMembers:{[this.friends.id]:call.hostKey,[call.friendId]:guestKey}});
      this._assertLive(call);if(!this._ownsRoom(call)||typeof info?.invite!=='string'||privateInvite(info.invite).roomId!==call.id)throw Error('A sala privada não confirmou o acesso restrito.');
      return{kind:'connect',invite:info.invite,hostKey:call.hostKey};
    }catch(error){if(this._matches(call)){this._finish(call,'failed');this._notifyEnd(call,'failed');throw error;}if(this._ownsRoom(call))this.rooms.leave();return{kind:'ended',reason:call.reason||'cancelled'};}
  }
  close(){
    const call=this.current;if(call){this._notifyEnd(call,'closed');this._finish(call,'closed');}
    this.closed=true;this.rooms.off?.('event',this.roomListener);this.friends.off?.('change',this.friendListener);for(const item of this.accepting.values())item.catch(()=>{});this.accepting.clear();
  }
}
