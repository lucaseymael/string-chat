import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {HOSTED_QUEUED} from './message-model.mjs';
import {verifyHostedSignature} from './hosted-service.mjs';

const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const actionKinds=new Set(['edit','delete','reaction','pin']);
const fileKinds=new Set(['file-begin','file-chunk','file-end']);
const CHUNK=24*1024,MAX_AGE=7*86400000;
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))));

/** Persistent ciphertext relay adapter. Only an authenticated peer reply confirms delivery. */
export class HostedMessages {
  constructor({client,friends,extraTransport=null}){
    Object.assign(this,{client,friends,extraTransport});this.cursor=0;this.polling=null;this.fileInbox=new Map();this.closed=false;
    const saved=client.localState.directMessages;
    this.state=saved?.version===1&&saved.outbox&&saved.receipts?saved:{version:1,outbox:{},receipts:{}};
    for(const[id,record]of Object.entries(this.state.outbox))if(!validId(id)||!validId(record?.friendId)||!validId(record?.commandId)||!['text',...fileKinds,...actionKinds].includes(record?.kind))delete this.state.outbox[id];
    this.client.localState.directMessages=this.state;
  }
  save(){this.client.localState.directMessages=this.state;this.client.saveLocal();}
  contact(id){const value=this.friends.verified(id);if(value.hostedServer!==this.client.url||!value.sharedKey)throw Error('A amizade não está disponível neste servidor.');return{...value};}
  mac(contact,purpose,value){return createHmac('sha256',Buffer.from(contact.sharedKey,'base64url')).update('stringchat-hosted-direct-v1\n'+purpose+'\n'+value).digest('hex');}
  operationId(contact,command){return this.mac(contact,'request',canonical(command)).slice(0,32);}
  metadata(contact,command,id){const fields={...command};delete fields.text;delete fields.data;return{id,friendId:contact.id,peerIdentity:contact.identity,kind:command.kind,commandId:command.id,fields,fingerprint:this.mac(contact,'command',canonical(command)),createdAt:Date.now(),status:'pending'};}
  queued(id,transportId){return{[HOSTED_QUEUED]:true,id,transportId};}

  async request(endpoint,envelope,command){
    if(this.closed||envelope?.type!=='direct'||envelope.fromId!==this.friends.id||!validId(command?.id))throw Error('Envio hospedado inválido.');
    const contact=this.contact(endpoint.id),decoded=this.friends.direct.open(contact,envelope.packet);
    if(canonical(decoded)!==canonical(command))throw Error('Os metadados do envio não correspondem ao conteúdo.');
    const id=this.operationId(contact,command);
    if(command.kind==='typing'){
      if(contact.online)await this.client.queueEnvelope({toId:contact.id,id,packet:envelope.packet});
      return this.queued(command.id,id);
    }
    if(!['text',...fileKinds,...actionKinds].includes(command.kind))throw Error('Este envio não é compatível com a entrega hospedada.');
    let record=this.state.outbox[id];
    if(record&&(record.peerIdentity!==contact.identity||record.fingerprint!==this.mac(contact,'command',canonical(command))))throw Error('A identidade do envio mudou.');
    if(!record){if(Object.keys(this.state.outbox).length>=8192)throw Error('Resolva os envios pendentes antes de continuar.');record=this.metadata(contact,command,id);this.state.outbox[id]=record;this.save();}
    try{await this.client.queueEnvelope({toId:contact.id,id,packet:envelope.packet,createdAt:record.createdAt});record.status='queued';delete record.error;this.save();}
    catch(error){record.status='pending';record.error=String(error.message||error).slice(0,200);this.save();throw error;}
    return this.queued(command.id,id);
  }

  reconstruct(record,cache){
    const contact=this.contact(record.friendId);if(contact.identity!==record.peerIdentity)throw Error('A identidade do destinatário mudou. Confirme a amizade antes de reenviar.');
    const command={...record.fields},item=this.friends.direct.find(record.friendId,record.commandId);
    if(actionKinds.has(record.kind)){const action=this.friends.direct.actionOutbox.get(record.commandId);if(!action||action.friendId!==record.friendId)return null;Object.assign(command,action.payload);}
    else if(record.kind==='text'){if(!item||item.deleted)return null;command.text=item.text;}
    else if(record.kind==='file-chunk'){
      if(!item?.attachment||item.deleted)return null;const key=record.friendId+':'+record.commandId;
      let data=cache.get(key);if(!data){data=readFileSync(this.friends.direct.filePath(record.commandId,record.friendId));cache.set(key,data);}
      command.data=data.subarray(command.index*CHUNK,(command.index+1)*CHUNK).toString('base64');
    }else if(!item?.attachment||item.deleted)return null;
    if(record.fingerprint!==this.mac(contact,'command',canonical(command)))throw Error('O conteúdo pendente mudou e não será reenviado automaticamente.');
    return{contact,command};
  }
  async flushPending(){
    const cache=new Map();let count=0;
    for(const[id,record]of Object.entries(this.state.outbox)){
      if(this.closed)break;if(record.status!=='pending'||count>=128)continue;count++;
      try{
        const value=this.reconstruct(record,cache);if(!value){delete this.state.outbox[id];continue;}
        await this.client.queueEnvelope({toId:record.friendId,id,packet:this.friends.direct.seal(value.contact,value.command),createdAt:record.createdAt});record.status='queued';delete record.error;
        this.friends.direct.markHostedQueued({friendId:record.friendId,id:record.commandId,kind:record.kind});
      }catch(error){record.error=String(error.message||error).slice(0,200);}
    }
    if(count)this.save();
  }
  verifyItem(item){
    const contact=this.contact(item.fromId),payload=verifyHostedSignature(item.envelope,'stringchat-hosted-mail-v1');
    if(item.envelope.id!==contact.id||item.envelope.identity!==contact.identity||payload.fromId!==contact.id||payload.toId!==this.friends.id||payload.id!==item.id||!validId(item.id)||!Number.isSafeInteger(item.sequence)||item.sequence<=0||!['request','reply'].includes(payload.direction)||payload.direction==='reply'&&!validId(payload.replyTo))throw Error('A identidade da mensagem hospedada não foi confirmada.');
    return{contact,payload};
  }
  async queueReply(contact,requestId,reply){
    if(this.closed)throw Error('A entrega hospedada foi encerrada.');
    const value=this.friends.direct.open(contact,reply.packet),id=this.mac(contact,'reply',requestId+'\n'+canonical(value)).slice(0,32);
    await this.client.queueEnvelope({toId:contact.id,id,direction:'reply',replyTo:requestId,packet:reply.packet});
  }
  async processReply(item,contact,payload){
    const record=this.state.outbox[payload.replyTo];if(!record)return this.client.ack([item]);
    if(record.friendId!==contact.id||record.peerIdentity!==contact.identity)throw Error('Confirmação de outra conversa.');
    const reply=this.friends.direct.open(contact,payload.packet);
    if(reply.id!==record.commandId||typeof reply.ok!=='boolean')throw Error('A confirmação não corresponde ao envio.');
    this.state.receipts[item.id]={item,replyTo:payload.replyTo};this.save();
    await this.applyReceipt(item.id);
  }
  async applyReceipt(receiptId){
    const saved=this.state.receipts[receiptId];if(!saved)return;
    const{contact,payload}=this.verifyItem(saved.item),record=this.state.outbox[saved.replyTo];
    if(record){
      if(record.friendId!==contact.id||record.peerIdentity!==contact.identity)throw Error('Confirmação de outra conversa.');
      const reply=this.friends.direct.open(contact,payload.packet);if(reply.id!==record.commandId||typeof reply.ok!=='boolean')throw Error('Confirmação inválida.');
      const error=reply.ok?'':String(reply.error||'O destinatário recusou o envio.').slice(0,200);
      if(actionKinds.has(record.kind))this.friends.direct.confirmQueuedAction({friendId:record.friendId,operationId:record.commandId,error});
      else if(record.kind==='text'||record.kind==='file-end')this.friends.direct.confirmQueuedMessage({friendId:record.friendId,id:record.commandId,error});
      if(reply.ok&&record.kind==='file-end'){for(const[id,frame]of Object.entries(this.state.outbox))if(frame.friendId===record.friendId&&frame.commandId===record.commandId&&fileKinds.has(frame.kind))delete this.state.outbox[id];}
      else delete this.state.outbox[saved.replyTo];
      if(reply.ok&&record.kind==='delete')for(const[id,frame]of Object.entries(this.state.outbox))if(frame.friendId===record.friendId&&frame.commandId===record.fields.targetId&&fileKinds.has(frame.kind))delete this.state.outbox[id];
      this.save();
    }
    await this.client.ack([saved.item]);delete this.state.receipts[receiptId];this.save();
  }
  defer(command,error){
    if(fileKinds.has(command.kind)&&/incompleto|expirado|envios atuais|liberar espaço/i.test(error.message||''))return true;
    return /Muitas mensagens|Aguarde antes de atualizar/i.test(error.message||'');
  }
  async processRequest(item,contact,payload){
    let command;try{command=this.friends.direct.open(contact,payload.packet);}catch{await this.client.ack([item]);return;}
    if(!validId(command?.id)||item.id!==this.operationId(contact,command)){await this.client.ack([item]);return;}
    if(command.kind==='typing'&&Math.abs(Date.now()-command.time)>6000){await this.client.ack([item]);return;}
    if(actionKinds.has(command.kind)&&command.kind!=='delete'&&!this.friends.direct.find(contact.id,command.targetId)&&!this.friends.direct.tombstones.has(contact.id+':'+command.targetId))return;
    if(command.replyTo&&!this.friends.direct.find(contact.id,command.replyTo)&&!this.friends.direct.tombstones.has(contact.id+':'+command.replyTo))return;
    const uploadKey=contact.id+':'+command.id;
    if(fileKinds.has(command.kind)){let tracked=this.fileInbox.get(uploadKey);if(!tracked){tracked=new Map();this.fileInbox.set(uploadKey,tracked);}tracked.set(item.id,item);}
    let reply;
    try{reply=await this.friends.direct.receive({type:'direct',fromId:contact.id,packet:payload.packet});}
    catch(error){
      if(this.closed||this.friends.stopped)return;
      if(this.defer(command,error))return;
      reply={type:'direct-reply',fromId:this.friends.id,packet:this.friends.direct.seal(contact,{ok:false,id:command.id,error:String(error.message||'Envio inválido.').slice(0,200)})};
      await this.queueReply(contact,item.id,reply);await this.client.ack([item]);return;
    }
    if(command.kind==='file-begin'||command.kind==='file-chunk'){
      if(this.friends.direct.find(contact.id,command.id)?.deleted){await this.client.ack([item]);this.fileInbox.get(uploadKey)?.delete(item.id);}
      return;
    }
    if(command.kind==='typing'){await this.client.ack([item]);return;}
    await this.queueReply(contact,item.id,reply);
    if(command.kind==='file-end'){
      const tracked=[...(this.fileInbox.get(uploadKey)?.values()||[])];for(let start=0;start<tracked.length;start+=512)await this.client.ack(tracked.slice(start,start+512));this.fileInbox.delete(uploadKey);
    }else{
      await this.client.ack([item]);
      if(command.kind==='delete'){
        const key=contact.id+':'+command.targetId,tracked=[...(this.fileInbox.get(key)?.values()||[])];for(let start=0;start<tracked.length;start+=512)await this.client.ack(tracked.slice(start,start+512));this.fileInbox.delete(key);
      }
    }
  }
  poll(){if(this.closed)return Promise.resolve({processed:0});if(this.polling)return this.polling;this.polling=this._poll().finally(()=>{this.polling=null;});return this.polling;}
  dropUnavailable(){
    let changed=false;const messages=new Set();
    for(const[id,record]of Object.entries(this.state.outbox)){
      const contact=this.friends.contacts.get(record.friendId);if(contact?.status==='friend'&&!contact.needsVerification&&contact.identity===record.peerIdentity&&contact.hostedServer===this.client.url)continue;
      const item=this.friends.direct.find(record.friendId,record.commandId);if(item&&item.status!=='delivered'){item.status='failed';item.deliveryError='A amizade não está disponível para este envio.';messages.add(item);}
      const action=this.friends.direct.actionOutbox.get(record.commandId);if(action){action.status='failed';action.error='A amizade não está disponível para esta ação.';const target=this.friends.direct.find(record.friendId,action.targetId);if(target)messages.add(target);}
      delete this.state.outbox[id];changed=true;
    }
    for(const[id,saved]of Object.entries(this.state.receipts)){const contact=this.friends.contacts.get(saved.item?.fromId);if(contact?.status!=='friend'||contact.needsVerification||contact.identity!==saved.item?.envelope?.identity){delete this.state.receipts[id];changed=true;}}
    if(changed){this.save();if(messages.size)for(const item of messages)this.friends.direct.publish(item,'updated');else this.friends.direct.persist();}
  }
  async _poll(){
    this.dropUnavailable();await this.flushPending();if(this.closed)return{processed:0};
    const resumable=new Map();for(const record of Object.values(this.state.outbox))if(fileKinds.has(record.kind)){const item=this.friends.direct.find(record.friendId,record.commandId);if(item?.status==='failed'&&!item.deleted)resumable.set(record.friendId+':'+record.commandId,item);}
    for(const item of resumable.values())if(!this.closed&&!this.friends.direct.busy.has(item.friendId)){try{await this.friends.direct.retry({friendId:item.friendId,id:item.id});}catch{}}
    for(const id of Object.keys(this.state.receipts))await this.applyReceipt(id);
    let processed=0;
    for(let page=0;page<2;page++){
      if(this.closed)break;
      const result=await this.client.mailbox({after:this.cursor,limit:64});if(!result.items.length){this.cursor=0;break;}
      for(const item of result.items){if(this.closed)break;const known=this.friends.contacts.get(item.fromId);if(known&&known.status!=='friend'){await this.client.ack([item]);this.cursor=Math.max(this.cursor,item.sequence);processed++;continue;}const{contact,payload}=this.verifyItem(item);if(payload.transportType==='private-call'){if(this.extraTransport){if(payload.direction==='reply')await this.extraTransport.tryReceipt(item,contact,payload);else await this.extraTransport.receive(item,contact,payload);}}else{if(payload.transportType&&payload.transportType!=='direct')throw Error('Tipo de transporte hospedado inválido.');if(payload.direction==='reply')await this.processReply(item,contact,payload);else await this.processRequest(item,contact,payload);}this.cursor=Math.max(this.cursor,item.sequence);processed++;}
      if(result.items.length<64){this.cursor=0;break;}
    }
    for(const[id,record]of Object.entries(this.state.outbox))if(record.status==='queued'&&Date.now()-record.createdAt>MAX_AGE){if(actionKinds.has(record.kind))this.friends.direct.confirmQueuedAction({friendId:record.friendId,operationId:record.commandId,error:'O prazo de entrega hospedada expirou. Tente novamente.'});else if(['text','file-end'].includes(record.kind))this.friends.direct.confirmQueuedMessage({friendId:record.friendId,id:record.commandId,error:'O prazo de entrega hospedada expirou. Tente novamente.'});delete this.state.outbox[id];this.save();}
    return{processed,pending:Object.keys(this.state.outbox).length};
  }
  close(){this.closed=true;this.fileInbox.clear();}
}
