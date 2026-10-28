import {createHash,randomBytes} from 'node:crypto';
import {unlinkSync} from 'node:fs';

const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const MAX_REVISION=2147483647;
const validRevision=value=>Number.isInteger(value)&&value>0&&value<=MAX_REVISION;
export const actionKinds=new Set(['edit','delete','reaction','pin','typing']);
// An unforgeable in-process marker: a relay accepting ciphertext is not a peer delivery receipt.
export const HOSTED_QUEUED=Symbol('stringchat-hosted-queued');
const validEmoji=value=>typeof value==='string'&&value.length>0&&value.length<=32&&!/[\s\x00-\x1f\x7f<>]/u.test(value)&&/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function reactions(item){const result={};for(const state of Object.values(item.reactionStates||{}))if(state.active){result[state.emoji]||=[];result[state.emoji].push(state.actorId);}for(const ids of Object.values(result))ids.sort();return result;}
function pinned(item){const states=Object.values(item.pinStates||{}).sort((a,b)=>a.revision-b.revision||a.actorId.localeCompare(b.actorId));return !item.deleted&&!!states.at(-1)?.pinned;}
function pending(service,friendId){return[...service.actionOutbox.values()].filter(a=>a.friendId===friendId).map(({id,targetId,kind,status,error})=>({id,targetId,kind,status,error:error||''}));}

export function initializeMessageFeatures(service,saved){
  const own=service.getIdentity().id;
  service.actionQueues=new Map();service.actionQueueSizes=new Map();service.typingStates=new Map();service.typingSent=new Map();service.typingRates=new Map();
  service.actionOutbox=new Map((Array.isArray(saved.actions)?saved.actions:[]).filter(a=>validId(a?.friendId)&&validId(a?.id)&&validId(a?.targetId)&&actionKinds.has(a?.kind)&&a.kind!=='typing'&&a.payload?.id===a.id&&a.payload?.targetId===a.targetId&&a.payload?.kind===a.kind).slice(-500).map(a=>[a.id,{...a,status:a.status==='queued'?'queued':'failed'}]));
  service.receipts=new Map((Array.isArray(saved.receipts)?saved.receipts:[]).filter(r=>validId(r?.friendId)&&validId(r?.id)&&/^[a-f0-9]{64}$/.test(r?.digest||'')).slice(-4096).map(r=>[r.friendId+':'+r.id,r]));
  service.tombstones=new Map((Array.isArray(saved.tombstones)?saved.tombstones:[]).filter(t=>validId(t?.friendId)&&validId(t?.id)&&[own,t.friendId].includes(t.authorId)&&validRevision(t.revision)).slice(-20000).map(t=>[t.friendId+':'+t.id,t]));
  service.messages=service.messages.filter(m=>m.authorId===own||m.authorId===m.friendId).map(item=>{
    item.contentRevision=validRevision(item.contentRevision)?item.contentRevision:0;item.replyTo=validId(item.replyTo)?item.replyTo:null;
    const cleanReactions={};for(const [key,state]of Object.entries(item.reactionStates||{}).slice(0,40))if(validEmoji(state?.emoji)&&[own,item.friendId].includes(state?.actorId)&&validRevision(state.revision)&&key===state.actorId+':'+state.emoji)cleanReactions[key]={actorId:state.actorId,emoji:state.emoji,active:state.active===true,revision:state.revision};item.reactionStates=cleanReactions;
    const cleanPins={};for(const state of Object.values(item.pinStates||{}))if([own,item.friendId].includes(state?.actorId)&&validRevision(state.revision))cleanPins[state.actorId]={actorId:state.actorId,pinned:state.pinned===true,revision:state.revision};item.pinStates=cleanPins;
    if(item.deleted){item.text='';delete item.attachment;}item.reactions=item.deleted?{}:reactions(item);item.pinned=pinned(item);return item;
  });
}

export function messageFeatureState(service){
  while(service.receipts.size>4096)service.receipts.delete(service.receipts.keys().next().value);
  while(service.tombstones.size>20000)service.tombstones.delete(service.tombstones.keys().next().value);
  return{actions:[...service.actionOutbox.values()],receipts:[...service.receipts.values()],tombstones:[...service.tombstones.values()]};
}

export function publicMessage(service,item){const value=structuredClone(item);delete value.reactionStates;delete value.pinStates;value.pendingActions=pending(service,item.friendId).filter(a=>a.targetId===item.id);return value;}

function actionPayload(command){
  if(!['edit','delete','reaction','pin'].includes(command.kind)||!validId(command.id)||!validId(command.targetId)||!validRevision(command.revision)||!Number.isFinite(command.time)||command.time<0||command.time>Date.now()+60000)throw new Error('Ação de mensagem inválida.');
  const payload={kind:command.kind,id:command.id,targetId:command.targetId,revision:command.revision,time:command.time};
  if(command.kind==='edit'){if(typeof command.text!=='string'||!command.text.trim()||command.text.length>2000)throw new Error('Escreva uma mensagem de até 2.000 caracteres.');payload.text=command.text.trim();}
  if(command.kind==='reaction'){if(!validEmoji(command.emoji)||typeof command.active!=='boolean')throw new Error('Reação inválida.');payload.emoji=command.emoji;payload.active=command.active;}
  if(command.kind==='pin'){if(typeof command.pinned!=='boolean')throw new Error('Ação de mensagem inválida.');payload.pinned=command.pinned;}
  return payload;
}

function applyAction(service,friendId,actorId,payload){
  let item=service.find(friendId,payload.targetId);
  if(!item&&payload.kind==='delete'&&actorId===friendId){
    item={id:payload.targetId,friendId,authorId:actorId,text:'',time:payload.time,status:'received',contentRevision:0,reactions:{},reactionStates:{},pinStates:{},pinned:false};service.messages.push(item);
  }
  if(!item)throw new Error('Mensagem não encontrada nesta conversa.');
  if(![friendId,service.getIdentity().id].includes(actorId))throw new Error('Participante inválido.');
  if(payload.kind==='edit'||payload.kind==='delete'){
    if(item.authorId!==actorId)throw new Error('Você só pode alterar suas próprias mensagens.');
    if(payload.revision<=(item.contentRevision||0))return item;
    if(item.deleted){if(payload.kind==='edit')throw new Error('Uma mensagem apagada não pode ser restaurada.');return item;}
    if(payload.kind==='edit'){if(item.attachment)throw new Error('Este anexo não possui texto para editar.');item.text=payload.text;item.editedAt=payload.time;}
    else{item.deleted=true;item.deletedAt=payload.time;item.text='';if(actorId===service.getIdentity().id)item.status='delivered';if(item.attachment)try{unlinkSync(service.filePath(item.attachment.id,friendId));}catch{}delete item.attachment;item.reactions={};item.pinned=false;service.tombstones.set(friendId+':'+item.id,{friendId,id:item.id,authorId:item.authorId,revision:payload.revision,time:payload.time});}
    item.contentRevision=payload.revision;
  }else{
    if(item.deleted)throw new Error('Mensagem apagada.');
    if(payload.kind==='reaction'){
      item.reactionStates||={};const key=actorId+':'+payload.emoji,old=item.reactionStates[key];if(old&&old.revision>=payload.revision)return item;
      if(!old&&(Object.keys(item.reactionStates).length>=40||Object.values(item.reactionStates).filter(s=>s.actorId===actorId).length>=20))throw new Error('O limite é de 20 reações diferentes por pessoa.');
      item.reactionStates[key]={actorId,emoji:payload.emoji,active:payload.active,revision:payload.revision};item.reactions=reactions(item);
    }else{item.pinStates||={};const old=item.pinStates[actorId];if(old&&old.revision>=payload.revision)return item;item.pinStates[actorId]={actorId,pinned:payload.pinned,revision:payload.revision};item.pinned=pinned(item);}
  }
  return item;
}

function nextRevision(service,item,kind,emoji){
  const own=service.getIdentity().id;let maximum=kind==='edit'||kind==='delete'?item.contentRevision||0:kind==='reaction'?item.reactionStates?.[own+':'+emoji]?.revision||0:Math.max(0,...Object.values(item.pinStates||{}).map(s=>s.revision));
  for(const action of service.actionOutbox.values())if(action.friendId===item.friendId&&action.targetId===item.id&&(kind==='pin'?action.kind==='pin':kind==='reaction'?action.kind==='reaction'&&action.payload.emoji===emoji:['edit','delete'].includes(action.kind)))maximum=Math.max(maximum,action.payload.revision||0);
  if(maximum>=MAX_REVISION)throw new Error('Limite de revisões atingido.');return maximum+1;
}

async function deliverAction(service,contact,action){
  try{const result=await service.command(contact,action.payload);service.contact(contact.id);if(result?.[HOSTED_QUEUED]){if(service.actionOutbox.has(action.id)){action.status='queued';action.error='';service.persist();service.onChange();const item=service.find(contact.id,action.targetId);if(item)service.onMessage({...publicMessage(service,item),event:'updated'});}return publicMessage(service,service.find(contact.id,action.targetId));}const item=applyAction(service,contact.id,service.getIdentity().id,action.payload);service.actionOutbox.delete(action.id);service.publish(item,'updated');return publicMessage(service,item);}
  catch(error){action.status='failed';action.error=String(error.message||error).slice(0,200);service.actionOutbox.set(action.id,action);try{service.persist();}catch{}service.onChange();const item=service.find(contact.id,action.targetId);if(item)service.onMessage({...publicMessage(service,item),event:'updated'});error.operationId=action.id;throw error;}
}

export const messageFeatureMethods={
  confirmQueuedAction({friendId,operationId,error=''}){this.contact(friendId);const action=this.actionOutbox.get(operationId);if(!action||action.friendId!==friendId)return null;const previous=this.find(friendId,action.targetId);if(previous?.deleted||!previous){this.actionOutbox.delete(action.id);if(previous)this.publish(previous,'updated');else this.persist();return previous?publicMessage(this,previous):null;}if(error){action.status='failed';action.error=String(error).slice(0,200);this.persist();this.onChange();this.onMessage({...publicMessage(this,previous),event:'updated'});return publicMessage(this,previous);}const item=applyAction(this,friendId,this.getIdentity().id,action.payload);this.actionOutbox.delete(action.id);try{this.publish(item,'updated');}catch(reason){this.actionOutbox.set(action.id,action);throw reason;}return publicMessage(this,item);},
  replyReference(friendId,id,{incoming=false}={}){if(id===undefined||id===null||id==='')return null;const item=this.find(friendId,id)||(incoming?this.tombstones.get(friendId+':'+id):null);if(!validId(id)||!item||!incoming&&(item.deleted||item.status==='sending'||item.status==='failed'))throw new Error('A mensagem respondida não está disponível nesta conversa.');return id;},
  receiveFeature(contact,command){
    if(command.kind==='typing'){
      if(typeof command.typing!=='boolean'||!Number.isFinite(command.time)||Math.abs(Date.now()-command.time)>60000)throw new Error('Estado de digitação inválido.');
      const now=Date.now(),old=this.typingRates.get(contact.id);
      if(old&&old.id===command.id){if(old.commandTime!==command.time||old.typing!==command.typing)throw new Error('Identificação da ação já usada.');return;}
      if(old&&command.time<old.commandTime)return;
      if(command.typing&&old&&now-old.time<500)throw new Error('Aguarde antes de atualizar a digitação.');this.typingRates.set(contact.id,{time:now,id:command.id,commandTime:command.time,typing:command.typing});this.clearTyping(contact.id,false);
      if(command.typing){const expiresAt=now+6000,timer=setTimeout(()=>this.clearTyping(contact.id),6000);timer.unref();this.typingStates.set(contact.id,{expiresAt,timer});}
      this.onMessage({event:'typing',friendId:contact.id,authorId:contact.id,typing:command.typing,expiresAt:command.typing?now+6000:now});return;
    }
    const payload=actionPayload(command),hash=digest(payload),key=contact.id+':'+command.id,receipt=this.receipts.get(key);
    if(receipt){if(receipt.digest!==hash)throw new Error('Identificação da ação já usada.');return;}
    const item=applyAction(this,contact.id,contact.id,payload);this.receipts.set(key,{friendId:contact.id,id:command.id,digest:hash});this.publish(item,'updated');
  },
  pending({friendId}){this.contact(friendId);return pending(this,friendId);},
  enqueueAction(friendId,run){const count=this.actionQueueSizes.get(friendId)||0;if(count>=32)return Promise.reject(new Error('Aguarde as ações anteriores.'));this.actionQueueSizes.set(friendId,count+1);const previous=this.actionQueues.get(friendId)||Promise.resolve(),next=previous.catch(()=>{}).then(run);this.actionQueues.set(friendId,next);next.finally(()=>{const remaining=(this.actionQueueSizes.get(friendId)||1)-1;if(remaining)this.actionQueueSizes.set(friendId,remaining);else this.actionQueueSizes.delete(friendId);if(this.actionQueues.get(friendId)===next)this.actionQueues.delete(friendId);}).catch(()=>{});return next;},
  mutate({friendId,id,kind,...value}){return this.enqueueAction(friendId,async()=>{
    const contact=this.contact(friendId);this.key(contact);const item=this.find(friendId,id);if(!item||item.deleted)throw new Error('Mensagem não encontrada nesta conversa.');
    if((kind==='edit'||kind==='delete')&&item.authorId!==this.getIdentity().id)throw new Error('Você só pode alterar suas próprias mensagens.');if(this.actionOutbox.size>=500)throw new Error('Resolva as ações pendentes antes de continuar.');
    const payload=actionPayload({kind,id:randomBytes(16).toString('hex'),targetId:id,revision:nextRevision(this,item,kind,value.emoji),time:Date.now(),...value});if(kind==='edit'&&item.attachment)throw new Error('Este anexo não possui texto para editar.');
    const action={id:payload.id,friendId,targetId:id,kind,payload,status:'pending',time:Date.now()};this.actionOutbox.set(action.id,action);this.persist();this.onChange();return deliverAction(this,contact,action);
  });},
  edit({friendId,id,text}){return this.mutate({friendId,id,kind:'edit',text});},
  remove({friendId,id}){return this.mutate({friendId,id,kind:'delete'});},
  react({friendId,id,emoji,active=true}){return this.mutate({friendId,id,kind:'reaction',emoji,active});},
  pin({friendId,id,pinned=true}){return this.mutate({friendId,id,kind:'pin',pinned});},
  retryAction({friendId,operationId}){return this.enqueueAction(friendId,async()=>{const contact=this.contact(friendId);this.key(contact);const action=this.actionOutbox.get(operationId);if(!action||action.friendId!==friendId)throw new Error('Ação pendente não encontrada.');action.status='pending';return deliverAction(this,contact,action);});},
  async typing({friendId,typing=true}){
    const contact=this.contact(friendId);this.key(contact);if(typeof typing!=='boolean')throw new Error('Estado de digitação inválido.');const now=Date.now(),last=this.typingSent.get(friendId);if(last&&last.typing===typing&&now-last.sentAt<1500)return false;if(typing&&last&&now-last.sentAt<500)return false;
    const time=Math.max(now,(last?.time||0)+1);this.typingSent.set(friendId,{typing,time,sentAt:now});await this.command(contact,{kind:'typing',id:randomBytes(16).toString('hex'),typing,time});return true;
  },
  clearTyping(friendId,notify=true){const state=this.typingStates.get(friendId);if(!state)return;clearTimeout(state.timer);this.typingStates.delete(friendId);if(notify)this.onMessage({event:'typing',friendId,authorId:friendId,typing:false,expiresAt:Date.now()});},
  typingState(friendId){this.contact(friendId);return this.typingStates.get(friendId)?.expiresAt>Date.now();},
  closeFeatures(){for(const state of this.typingStates.values())clearTimeout(state.timer);this.typingStates.clear();},
};
