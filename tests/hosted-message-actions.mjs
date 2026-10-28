import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {FriendsService} from '../friends-service.mjs';
import {HostedMessages} from '../hosted-messages.mjs';
import {verifyHostedSignature} from '../hosted-service.mjs';

const root=resolve('.test-results/hosted-message-actions-'+Date.now()),url='https://relay.test',checks=[],people=[],instances=[];
await mkdir(root,{recursive:true});
class Relay{
 constructor(){this.mail=new Map();this.receipts=new Set();this.sequence=0;this.fakeAccepted=false;}
 queue(envelope){const p=verifyHostedSignature(envelope,'stringchat-hosted-mail-v1'),key=p.fromId+':'+p.id;if(this.fakeAccepted)return{queued:false,acknowledged:true,id:p.id};if(this.mail.has(key)||this.receipts.has(key))return{queued:this.mail.has(key),acknowledged:this.receipts.has(key),id:p.id};this.mail.set(key,{id:p.id,fromId:p.fromId,toId:p.toId,sequence:++this.sequence,envelope:structuredClone(envelope)});return{queued:true,acknowledged:false,id:p.id};}
 inbox(id,after=0,limit=64){return[...this.mail.values()].filter(m=>m.toId===id&&m.sequence>after).sort((a,b)=>a.sequence-b.sequence).slice(0,limit).map(value=>structuredClone(value));}
 ack(id,items){let acknowledged=0;for(const item of items){const key=item.fromId+':'+item.id,value=this.mail.get(key);if(value?.toId===id){this.mail.delete(key);this.receipts.add(key);acknowledged++;}}return{acknowledged};}
}
const relay=new Relay();
class Client{
 constructor(person){this.person=person;this.friends=person.friends;this.url=url;this.path=join(root,person.name,'hosted.json');try{this.localState=JSON.parse(readFileSync(this.path,'utf8'));}catch{this.localState={};}this.requests=0;}
 saveLocal(){mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path,JSON.stringify(this.localState));}
 async queueEnvelope(value){this.requests++;if(this.failAt===this.requests)throw Error('Simulated relay interruption');const payload={id:value.id,fromId:this.friends.id,toId:value.toId,direction:value.direction||'request',replyTo:value.replyTo||null,createdAt:value.createdAt||Date.now(),packet:value.packet,transportType:value.transportType||'direct'},envelope=this.friends.signForService('stringchat-hosted-mail-v1',payload),result=relay.queue(envelope);if(this.loseQueueAck){this.loseQueueAck=false;throw Error('Queue ack lost');}return result;}
 async mailbox({after=0,limit=64}={}){const items=relay.inbox(this.friends.id,after,limit);return{items,next:items.at(-1)?.sequence||after};}
 async ack(items){const result=relay.ack(this.friends.id,items);if(this.loseAck){this.loseAck=false;throw Error('Mailbox ack lost');}return result;}
}
function start(name){
 let person=people.find(p=>p.name===name);if(!person){person={name,events:[]};people.push(person);}else{person.friends.close();person.transport.close();}
 person.friends=new FriendsService({path:join(root,name,'friends.json'),getName:()=>name,getGroup:()=>null});instances.push(person.friends);person.client=new Client(person);person.transport=new HostedMessages({client:person.client,friends:person.friends});person.client.directTransport=person.transport;person.friends.direct.request=(contact,envelope,command)=>person.transport.request(contact,envelope,command);person.friends.on('direct-message',event=>person.events.push(event));return person;
}
function befriend(a,b){for(const[one,two]of[[a,b],[b,a]]){const identity=two.friends.publicIdentity(),contact={...identity,id:two.friends.id,name:two.name,status:'friend',needsVerification:false,hostedServer:url,online:false};contact.sharedKey=one.friends.sharedKey(contact);one.friends.contacts.set(contact.id,contact);one.friends.persist();}}
const a=start('A'),b=start('B'),c=start('C');befriend(a,b);befriend(a,c);befriend(b,c);
async function check(name,run){await run();checks.push(name);console.log('PASS',name);}
const own=(person,friend,id)=>person.friends.direct.history(friend.friends.id).find(m=>m.id===id);
async function drain(predicate,ms=25000){const deadline=Date.now()+ms;while(!predicate()){if(Date.now()>deadline)throw Error('Queue did not settle');for(const person of[a,b])await person.transport.poll();await new Promise(resolve=>setTimeout(resolve,35));}}
async function clean(){await drain(()=>relay.mail.size===0);}

try{
 let first;
 await check('A relay acknowledgement only produces queued status and the server stores ciphertext',async()=>{
   first=await a.friends.direct.sendText({friendId:b.friends.id,text:'Offline private secret 🎧'});assert.equal(first.status,'queued');assert.equal(b.friends.direct.history(a.friends.id).length,0);assert(!JSON.stringify([...relay.mail.values()]).includes('Offline private secret'));
   await a.transport.poll();assert.equal(own(a,b,first.id).status,'queued');
   relay.fakeAccepted=true;const accepted=await a.friends.direct.sendText({friendId:b.friends.id,text:'A server cannot claim delivered'});relay.fakeAccepted=false;assert.equal(accepted.status,'queued');assert.equal(own(a,b,accepted.id).status,'queued');
 });
 await check('Only a real encrypted peer receipt marks text delivered, without duplicate unread events',async()=>{
   await b.transport.poll();assert.equal(own(a,b,first.id).status,'queued');assert.equal(own(b,a,first.id).text,'Offline private secret 🎧');await a.transport.poll();assert.equal(own(a,b,first.id).status,'delivered');const unread=b.friends.direct.summary(a.friends.id).unread;await b.transport.poll();assert.equal(b.friends.direct.summary(a.friends.id).unread,unread);await clean();
 });
 await check('An offline eight megabyte file is rebuilt after a recipient restart before chunks are acknowledged',async()=>{
   const data=Buffer.alloc(8*1024*1024,47);data.write('GIF89a');const sent=await a.friends.direct.sendFile({friendId:b.friends.id,name:'offline.gif',data});assert.equal(sent.status,'queued');const before=relay.mail.size;assert(before>300);await b.transport.poll();assert.equal(relay.mail.size,before);assert(b.friends.direct.uploads.size>0);start('B');
   await drain(()=>own(a,b,sent.id)?.status==='delivered');assert(b.friends.direct.getFile({friendId:a.friends.id,id:sent.id}).data.equals(data));assert.equal(Object.values(a.transport.state.outbox).filter(r=>r.commandId===sent.id).length,0);await clean();
 });
 await check('Queued edits, reactions and pins wait for authenticated peer receipts across sender restart',async()=>{
   await a.friends.direct.edit({friendId:b.friends.id,id:first.id,text:'Edited while offline'});assert.equal(own(a,b,first.id).text,'Offline private secret 🎧');assert.equal(a.friends.direct.pending({friendId:b.friends.id})[0].status,'queued');start('A');assert.equal(a.friends.direct.pending({friendId:b.friends.id})[0].status,'queued');
   await drain(()=>own(a,b,first.id).text==='Edited while offline');await a.friends.direct.react({friendId:b.friends.id,id:first.id,emoji:'🎧'});assert.equal(own(a,b,first.id).reactions['🎧'],undefined);await a.friends.direct.pin({friendId:b.friends.id,id:first.id,pinned:true});assert.equal(own(a,b,first.id).pinned,false);
   await drain(()=>own(a,b,first.id).pinned&&own(a,b,first.id).reactions['🎧']?.length===1);assert.equal(own(b,a,first.id).pinned,true);await clean();
 });
 await check('Actions delivered before their original text are deferred rather than discarded',async()=>{
   const item=await a.friends.direct.sendText({friendId:b.friends.id,text:'Original ordered text'});await a.friends.direct.edit({friendId:b.friends.id,id:item.id,text:'Deferred ordered edit'});const mails=[...relay.mail.values()].filter(m=>m.fromId===a.friends.id),commands=mails.map(m=>({m,p:a.friends.direct.open(a.friends.contacts.get(b.friends.id),verifyHostedSignature(m.envelope,'stringchat-hosted-mail-v1').packet)}));const text=commands.find(v=>v.p.kind==='text'&&v.p.id===item.id).m,edit=commands.find(v=>v.p.kind==='edit'&&v.p.targetId===item.id).m;[text.sequence,edit.sequence]=[edit.sequence,text.sequence];await b.transport.poll();assert(relay.mail.has(edit.fromId+':'+edit.id));
   await drain(()=>own(a,b,item.id).text==='Deferred ordered edit');assert.equal(own(b,a,item.id).text,'Deferred ordered edit');await clean();
 });
 await check('Server-forged signatures and receipts for a different command never confirm delivery',async()=>{
   const item=await a.friends.direct.sendText({friendId:b.friends.id,text:'Receipt binding'}),record=Object.values(a.transport.state.outbox).find(r=>r.commandId===item.id);
   const packet=b.friends.direct.seal(b.friends.contacts.get(a.friends.id),{ok:true,id:randomBytes(16).toString('hex')});await b.client.queueEnvelope({toId:a.friends.id,id:randomBytes(16).toString('hex'),direction:'reply',replyTo:record.id,packet});await assert.rejects(a.transport.poll(),/corresponde/);assert.equal(own(a,b,item.id).status,'queued');
   for(const[k,v]of relay.mail)if(v.toId===a.friends.id)relay.mail.delete(k);
   const wrong=b.friends.signForService('stringchat-hosted-mail-v1',{id:randomBytes(16).toString('hex'),fromId:b.friends.id,toId:a.friends.id,direction:'reply',replyTo:record.id,createdAt:Date.now(),packet});wrong.signature=randomBytes(64).toString('base64url');const value={id:JSON.parse(wrong.payload).id,fromId:b.friends.id,toId:a.friends.id,sequence:++relay.sequence,envelope:wrong};relay.mail.set(value.fromId+':'+value.id,value);await assert.rejects(a.transport.poll());assert.equal(own(a,b,item.id).status,'queued');relay.mail.delete(value.fromId+':'+value.id);await drain(()=>own(a,b,item.id).status==='delivered');await clean();
 });
 await check('Lost mailbox acknowledgement after receipt persistence cannot regress delivery after restart',async()=>{
   const item=await a.friends.direct.sendText({friendId:b.friends.id,text:'Persist receipt before ack'});await b.transport.poll();a.client.loseAck=true;await assert.rejects(a.transport.poll(),/ack lost/);assert.equal(own(a,b,item.id).status,'delivered');start('A');await a.transport.poll();assert.equal(own(a,b,item.id).status,'delivered');assert.equal(Object.keys(a.transport.state.receipts).length,0);await clean();
 });
 await check('Sender restart resumes a partially enqueued file instead of falsely marking a partial transfer delivered',async()=>{
   a.client.failAt=a.client.requests+10;await assert.rejects(a.friends.direct.sendFile({friendId:b.friends.id,name:'partial.bin',data:Buffer.alloc(400000,83)}),/interruption/);const item=a.friends.direct.history(b.friends.id).at(-1);assert.equal(item.status,'failed');start('A');await drain(()=>own(a,b,item.id).status==='delivered');assert.equal(b.friends.direct.getFile({friendId:a.friends.id,id:item.id}).data.length,400000);await clean();
 });
 await check('Unconfirmed queued content is retained while older delivered history is pruned',async()=>{
   const item=await a.friends.direct.sendText({friendId:b.friends.id,text:'Keep pending payload'});for(let i=0;i<205;i++)a.friends.direct.storeIncoming(a.friends.contacts.get(b.friends.id),{id:randomBytes(16).toString('hex'),text:'Retained history '+i,time:Date.now()});assert.equal(own(a,b,item.id).status,'queued');assert(a.friends.direct.history(b.friends.id).length<=202);await drain(()=>!Object.values(a.transport.state.outbox).some(record=>record.commandId===item.id));assert.equal(own(b,a,item.id).text,'Keep pending payload');await clean();
 });
 await check('Offline delivery beyond the LAN freshness window still requires a real peer receipt',async()=>{
   const item=await a.friends.direct.sendText({friendId:b.friends.id,text:'Offline beyond sixty seconds'}),now=Date.now;Date.now=()=>now()+120000;
   try{await b.transport.poll();assert.equal(own(a,b,item.id).status,'queued');await a.transport.poll();assert.equal(own(a,b,item.id).status,'delivered');}finally{Date.now=now;}await clean();
 });
 await check('Signed private call packets use their own transport without touching the direct decoder',async()=>{
   const seen=[];b.transport.extraTransport={async receive(item,contact,payload){seen.push({id:item.id,friendId:contact.id,type:payload.transportType});await b.client.ack([item]);}};
   const open=b.friends.direct.open;b.friends.direct.open=()=>{throw Error('Call packet reached DM decoder');};
   try{await a.client.queueEnvelope({toId:b.friends.id,id:randomBytes(16).toString('hex'),packet:{n:'call-domain',d:'opaque-call',t:'tag'},transportType:'private-call'});await b.transport.poll();assert.equal(seen.length,1);assert.equal(seen[0].friendId,a.friends.id);assert.equal(seen[0].type,'private-call');}finally{b.friends.direct.open=open;b.transport.extraTransport=null;}await clean();
 });
 await check('Blocking drops queued automatic retries and incoming blocked mail without stalling other contacts',async()=>{
   a.client.loseQueueAck=true;await assert.rejects(a.friends.direct.sendText({friendId:b.friends.id,text:'Do not automatically resend after block'}),/ack lost/);const item=a.friends.direct.history(b.friends.id).at(-1),before=a.client.requests;
   await b.friends.direct.sendText({friendId:a.friends.id,text:'Already in relay before block'});a.friends.contacts.get(b.friends.id).status='blocked';await a.transport.poll();assert.equal(a.client.requests,before);assert.equal(a.friends.direct.find(b.friends.id,item.id).status,'failed');assert(!Object.values(a.transport.state.outbox).some(record=>record.friendId===b.friends.id));assert(!relay.inbox(a.friends.id).some(value=>value.fromId===b.friends.id));
   for(const[k,v]of relay.mail)if(v.fromId===a.friends.id||v.toId===a.friends.id)relay.mail.delete(k);a.friends.contacts.get(b.friends.id).status='friend';a.friends.persist();
 });
 await writeFile(join(root,'results.json'),JSON.stringify({checks,cryptography:'Real Ed25519/X25519/AEAD; in-memory ciphertext relay; no TLS test in this suite'},null,2));
}finally{for(const person of people)person.transport.close();for(const service of instances)service.close();}
