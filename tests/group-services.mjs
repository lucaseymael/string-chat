import{RoomService,listInterfaces}from'../room-service.mjs';
import{FriendsService}from'../friends-service.mjs';
import{mkdir,writeFile}from'node:fs/promises';
import{resolve}from'node:path';
import assert from'node:assert/strict';
const root=resolve(`.test-results/group-services-${Date.now()}`);await mkdir(root,{recursive:true});
const services=[],checks=[];const member=n=>({id:String(n).padStart(32,'0'),name:`Pessoa ${n}`,voiceChannelId:'voice-lobby'});
const wait=(service,predicate,ms=15000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{service.off('event',handler);reject(new Error('Event timeout'));},ms);const handler=event=>{if(predicate(event)){clearTimeout(timer);service.off('event',handler);resolve(event);}};service.on('event',handler);});
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
let host,guest,third,info;
try{
  host=new RoomService({statePath:root+'/group.json'});guest=new RoomService();third=new RoomService();services.push(host,guest,third);
  await check('Automatic encrypted room joining on detected Radmin adapter',async()=>{info=await host.create({room:{id:'a'.repeat(32),name:'Grupo QA'},member:member(1),address:listInterfaces()[0].address});await guest.join({invite:info.invite,member:member(2)});await third.join({invite:info.invite,member:member(3)});assert.equal(host.clients.size,2);assert.equal(guest.localAddress,info.address);});
  await check('One invite accepts multiple friends without answer codes',async()=>{assert.equal(info.invite.startsWith('stringchat://join?'),true);assert.equal(host.clients.size,2);});
  await check('Voice channels and text channels synchronize',async()=>{const added=wait(guest,e=>e.type==='channels-updated');const c=host.createChannel({kind:'text',name:'outro-canal'});await added;const changed=wait(third,e=>e.type==='member-updated'&&e.member.id===member(2).id);guest.voice('voice-jogos');assert.equal((await changed).member.voiceChannelId,'voice-jogos');const chat=wait(third,e=>e.type==='chat'&&e.message.text==='Olá 😄');guest.chat({channelId:c.id,text:'Olá 😄'});assert.equal((await chat).message.channelId,c.id);});
  await check('8 MB GIF attachment transfers intact with backpressure',async()=>{const gif=Buffer.alloc(8*1024*1024,17);gif.write('GIF89a');const event=wait(third,e=>e.type==='chat'&&e.message.attachment);await guest.sendAttachment({channelId:'text-geral',name:'teste.gif',data:gif});const attachment=(await event).message.attachment;assert.equal(attachment.mime,'image/gif');const received=await third.getAttachment(attachment.id);assert(Buffer.from(received.data).equals(gif));});
  await check('Temporary signaling loss reconnects without new invite',async()=>{const resumed=wait(guest,e=>e.type==='welcome'&&e.resumed);guest.socket.destroy();await resumed;assert.equal(host.clients.size,2);});
  await check('Incorrect invitation key is rejected',async()=>{const bad=new URL(info.invite);bad.searchParams.set('key','z'.repeat(43));const intruder=new RoomService();services.push(intruder);await assert.rejects(intruder.join({invite:bad.toString(),member:member(4)}));assert.equal(host.clients.size,2);});
  await check('Group channels and history survive host restart',async()=>{host.leave();guest.leave();third.leave();await new Promise(r=>setTimeout(r,100));const restored=new RoomService({statePath:root+'/group.json'});services.push(restored);const result=await restored.create({room:{id:'b'.repeat(32),name:'Grupo QA'},member:member(1),address:info.address});assert.equal(result.room.id,info.room.id);assert(result.room.channels.some(c=>c.name==='outro-canal'));assert(restored.history.some(m=>m.attachment));restored.leave();});
  const a=new FriendsService({path:root+'/a-friends.json',getName:()=> 'Alice',getGroup:()=>({name:'Grupo QA',invite:info.invite})}),b=new FriendsService({path:root+'/b-friends.json',getName:()=> 'Bruno',getGroup:()=>null});services.push(a,b);await a.start();await b.start();
  await check('Friend request, acceptance and online presence',async()=>{await a.add(b.code());assert.equal(b.contacts.get(a.id).status,'incoming');await b.accept(a.id);assert.equal(a.contacts.get(b.id).status,'friend');await a.refresh();assert.equal(a.contacts.get(b.id).online,true);});
  await check('Friends receive group invitations',async()=>{const notice=new Promise(resolve=>b.once('notice',resolve));await a.invite(b.id);assert.equal((await notice).kind,'group-invite');});
  await check('Offline friend is detected',async()=>{b.close();await a.refresh();assert.equal(a.contacts.get(b.id).online,false);});
  await writeFile(resolve('.test-results/group-services-results.json'),JSON.stringify({checks,interfaceKind:info.address.startsWith('26.')?'Radmin':'LAN',sameComputer:true},null,2));
}finally{for(const service of services){if(service instanceof RoomService)service.leave();else service.close();}}
