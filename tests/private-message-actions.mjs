import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {DirectMessages} from '../direct-messages.mjs';

const root=resolve('.test-results/private-actions-'+Date.now()),participants=new Map(),instances=[],checks=[];
await mkdir(root,{recursive:true});
function person(name,id){const value={name,id,key:randomBytes(32).toString('base64url'),contacts:new Map(),events:[]};participants.set(id,value);return value;}
const a=person('A','a'.repeat(32)),b=person('B','b'.repeat(32)),c=person('C','c'.repeat(32));
for(const [one,two]of[[a,b],[a,c],[b,c]]){const sharedKey=randomBytes(32).toString('base64url');one.contacts.set(two.id,{id:two.id,key:two.key,sharedKey,status:'friend'});two.contacts.set(one.id,{id:one.id,key:one.key,sharedKey,status:'friend'});}
function start(person){person.direct=new DirectMessages({path:join(root,person.name,'private.json'),getIdentity:()=>({id:person.id,key:person.key}),getContact:id=>person.contacts.get(id),request:async(contact,envelope)=>participants.get(contact.id).direct.receive(envelope),onChange:()=>{},onMessage:message=>person.events.push(message)});instances.push(person.direct);return person.direct;}
for(const person of[a,b,c])start(person);
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
const message=(person,friend,id)=>person.direct.history(friend.id).find(m=>m.id===id);
const command=(kind,targetId,extra={})=>({kind,id:randomBytes(16).toString('hex'),targetId,revision:1,time:Date.now(),...extra});

try{
 let original,answer;
 await check('Replies reference a delivered message in the same private conversation',async()=>{
   original=await a.direct.sendText({friendId:b.id,text:'Primeira mensagem'});
   answer=await b.direct.sendText({friendId:a.id,text:'Resposta',replyTo:original.id});
   assert.equal(message(a,b,answer.id).replyTo,original.id);assert.equal(message(b,a,answer.id).replyTo,original.id);
   await assert.rejects(c.direct.sendText({friendId:b.id,text:'Referência alheia',replyTo:original.id}),/respondida/);
   assert.equal(c.direct.history(b.id).length,0);
 });
 await check('Edits propagate without adding unread messages and reject another author',async()=>{
   const unread=b.direct.summary(a.id).unread;await a.direct.edit({friendId:b.id,id:original.id,text:'Texto corrigido'});
   assert.equal(message(b,a,original.id).text,'Texto corrigido');assert(message(b,a,original.id).editedAt);assert.equal(b.direct.summary(a.id).unread,unread);
   await assert.rejects(b.direct.edit({friendId:a.id,id:original.id,text:'Forjado'}),/próprias/);
   await assert.rejects(b.direct.command(b.contacts.get(a.id),command('edit',original.id,{text:'Forjado',revision:99})),/próprias/);
   assert.equal(message(a,b,original.id).text,'Texto corrigido');
 });
 await check('Independent reactions and pin state converge at both participants',async()=>{
   await Promise.all([a.direct.react({friendId:b.id,id:original.id,emoji:'🎧'}),b.direct.react({friendId:a.id,id:original.id,emoji:'🎧'})]);
   assert.deepEqual(message(a,b,original.id).reactions['🎧'],[a.id,b.id]);assert.deepEqual(message(a,b,original.id).reactions,message(b,a,original.id).reactions);
   await a.direct.react({friendId:b.id,id:original.id,emoji:'🎧',active:false});assert.deepEqual(message(b,a,original.id).reactions['🎧'],[b.id]);
   await Promise.all([a.direct.pin({friendId:b.id,id:original.id,pinned:true}),b.direct.pin({friendId:a.id,id:original.id,pinned:false})]);assert.equal(message(a,b,original.id).pinned,message(b,a,original.id).pinned);
   await a.direct.pin({friendId:b.id,id:original.id,pinned:true});assert.equal(message(b,a,original.id).pinned,true);
   assert(!Object.hasOwn(message(a,b,original.id),'pinStates'));assert(!Object.hasOwn(message(a,b,original.id),'reactionStates'));
 });
 await check('A lost acknowledgement survives restart and cannot overwrite a newer edit',async()=>{
   const real=a.direct.request;a.direct.request=async(...args)=>{await real(...args);throw Error('Ack lost');};let operationId;
   try{await a.direct.edit({friendId:b.id,id:original.id,text:'Edição com confirmação perdida'});}catch(error){operationId=error.operationId;}
   assert(operationId);assert.equal(a.direct.pending({friendId:b.id}).length,1);assert.equal(message(b,a,original.id).text,'Edição com confirmação perdida');
   a.direct.close();start(a);assert.equal(a.direct.pending({friendId:b.id})[0].status,'failed');
   await a.direct.edit({friendId:b.id,id:original.id,text:'Edição mais recente'});await a.direct.retryAction({friendId:b.id,operationId});
   assert.equal(message(a,b,original.id).text,'Edição mais recente');assert.equal(message(b,a,original.id).text,'Edição mais recente');assert.equal(a.direct.pending({friendId:b.id}).length,0);
 });
 await check('Out-of-order edits and conflicting operation IDs never roll content back',async()=>{
   const item=await a.direct.sendText({friendId:b.id,text:'Ordenação'}),latest=command('edit',item.id,{text:'Revisão 4',revision:4});
   await a.direct.command(a.contacts.get(b.id),latest);await a.direct.command(a.contacts.get(b.id),command('edit',item.id,{text:'Revisão 2',revision:2}));
   assert.equal(message(b,a,item.id).text,'Revisão 4');await a.direct.command(a.contacts.get(b.id),latest);
   await assert.rejects(a.direct.command(a.contacts.get(b.id),{...latest,text:'Mesmo ID, outro conteúdo'}),/já usada/);
   assert.equal(message(b,a,item.id).text,'Revisão 4');
 });
 await check('Deletion is a durable tombstone and replay cannot restore text or files',async()=>{
   const initial={kind:'text',id:original.id,text:'Primeira mensagem',time:original.time};
   await a.direct.remove({friendId:b.id,id:original.id});assert.equal(message(b,a,original.id).deleted,true);assert.equal(message(b,a,original.id).text,'');
   await a.direct.command(a.contacts.get(b.id),initial);assert.equal(message(b,a,original.id).deleted,true);
   await assert.rejects(a.direct.command(a.contacts.get(b.id),command('edit',original.id,{text:'Ressuscitar',revision:99})),/restaurada/);
   b.direct.close();start(b);await a.direct.command(a.contacts.get(b.id),initial);assert.equal(message(b,a,original.id).deleted,true);
   b.direct.deleteAt(b.direct.messages.findIndex(m=>m.friendId===a.id&&m.id===original.id));b.direct.persist();b.direct.close();start(b);const unread=b.direct.summary(a.id).unread;await a.direct.command(a.contacts.get(b.id),initial);assert.equal(message(b,a,original.id),undefined);assert.equal(b.direct.summary(a.id).unread,unread);
   const file=await a.direct.sendFile({friendId:b.id,name:'imagem.gif',data:Buffer.from('GIF89aPRIVATE')});const path=b.direct.filePath(file.id,a.id);
   await access(path);await a.direct.remove({friendId:b.id,id:file.id});await assert.rejects(access(path));assert.throws(()=>b.direct.getFile({friendId:a.id,id:file.id}),/não encontrado/);
   const ack=await a.direct.command(a.contacts.get(b.id),{kind:'file-begin',id:file.id,name:'old.gif',size:12});assert.equal(ack.done,true);await assert.rejects(access(path));
 });
 await check('An undelivered own message can be removed before a delayed initial packet arrives',async()=>{
   const real=a.direct.request;a.direct.request=async()=>{throw Error('Offline');};await assert.rejects(a.direct.sendText({friendId:b.id,text:'Nunca entregar'}));const item=a.direct.history(b.id).at(-1);a.direct.request=real;
   await a.direct.remove({friendId:b.id,id:item.id});await a.direct.command(a.contacts.get(b.id),{kind:'text',id:item.id,text:'Nunca entregar',time:item.time});assert.equal(message(b,a,item.id).deleted,true);assert.equal(message(b,a,item.id).text,'');
 });
 await check('Typing is transient, deduplicated, rate limited and expires without persistence',async()=>{
   const before=b.direct.history(a.id).length;assert.equal(await a.direct.typing({friendId:b.id}),true);assert.equal(b.direct.typingState(a.id),true);assert.equal(await a.direct.typing({friendId:b.id}),false);
   assert.equal(await a.direct.typing({friendId:b.id,typing:false}),true);assert.equal(b.direct.typingState(a.id),false);
   await new Promise(r=>setTimeout(r,510));await a.direct.typing({friendId:b.id});await new Promise(r=>setTimeout(r,6100));assert.equal(b.direct.typingState(a.id),false);assert.equal(b.direct.history(a.id).length,before);
   assert(b.events.some(e=>e.event==='typing'&&e.typing));assert(b.events.some(e=>e.event==='typing'&&!e.typing));
   const stored=JSON.parse(await readFile(b.direct.path));assert(!Object.hasOwn(stored,'typingStates'));
 });
 await check('A common friend cannot decrypt pairwise ciphertext or react in another conversation',async()=>{
   const packet=a.direct.seal(a.contacts.get(b.id),{kind:'text',id:randomBytes(16).toString('hex'),text:'segredo',time:Date.now()});
   assert.throws(()=>c.direct.open(c.contacts.get(b.id),packet));await assert.rejects(c.direct.react({friendId:b.id,id:answer.id,emoji:'🎧'}),/não encontrada/);
   await assert.rejects(b.direct.react({friendId:a.id,id:answer.id,emoji:'not-an-emoji'}),/Reação/);
 });
 await check('Blocking during a file transfer stops subsequent chunks and legacy history stays readable',async()=>{
   const real=a.direct.request;a.direct.request=async(contact,envelope)=>{const reply=await real(contact,envelope);a.contacts.get(b.id).status='blocked';return reply;};
   await assert.rejects(a.direct.sendFile({friendId:b.id,name:'blocked.bin',data:Buffer.alloc(100000)}),/amizade/);assert.equal(b.direct.uploads.size,1);assert.equal([...b.direct.uploads.values()][0].received,0);
   a.contacts.get(b.id).status='friend';a.direct.request=real;delete a.contacts.get(b.id).sharedKey;
   assert(a.direct.history(b.id).length>0);await assert.rejects(a.direct.sendText({friendId:b.id,text:'Sem chave'}),/Revalide/);
 });
 await writeFile(join(root,'results.json'),JSON.stringify({checks},null,2));
}finally{for(const service of instances)service.close();}
