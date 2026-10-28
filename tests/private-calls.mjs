import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {mock} from 'node:test';
import {PrivateCalls} from '../private-calls.mjs';
import {RoomService,listInterfaces} from '../room-service.mjs';

const key=()=>generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64url');
const peers=new Map(),registry=new Map(),created=[],checks=[],root=resolve('.test-results/private-calls-'+Date.now());
await mkdir(root,{recursive:true});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

class FakeRooms extends EventEmitter{
  constructor(){super();this.privateCallsVersion=1;this.publicKey=key();this.mode=null;this.room=null;this.clients=new Map();this.operations=[];this.epoch=0;this.ownId=null;}
  privateIdentity(){return this.publicKey;}
  async create(options){assert.equal(options.transient,true);assert.equal(options.room.kind,'direct');assert.equal(Object.keys(options.allowedMembers).length,2);this.operations.push('create');this.mode='host';this.room=structuredClone(options.room);this.allowed=options.allowedMembers;this.ownId=options.member.id;this.guest=null;const epoch=this.epoch;registry.set(this.room.id,this);if(this.createGate)await this.createGate.promise;if(epoch!==this.epoch)throw Error('Cancelled create');const url=new URL('stringchat://join');for(const[k,v]of Object.entries({host:'127.0.0.1',port:23456,key:randomBytes(32).toString('base64url'),room:this.room.id}))url.searchParams.set(k,v);return{room:this.room,invite:url.toString()};}
  async join(options){this.operations.push('join');assert.equal(options.transient,true);const id=new URL(options.invite).searchParams.get('room'),host=registry.get(id);assert(host);assert.equal(options.expectedHostKey,host.publicKey);assert.equal(options.expectedHostId,host.ownId);assert.equal(options.expectedRoomKind,'direct');assert.equal(options.expectedCallId,id);if(!host.allowed[options.member.id]||host.allowed[options.member.id]!==this.publicKey)throw Error('Uninvited member');if(host.clients.size>=1)throw Error('Private room full');const epoch=this.epoch;if(this.joinGate)await this.joinGate.promise;if(epoch!==this.epoch)throw Error('Cancelled join');this.mode='guest';this.room=structuredClone(host.room);this.host=host;host.guest=this;host.clients.set(options.member.id,options.member);return{room:this.room};}
  leave(){this.epoch++;this.operations.push('leave');if(this.mode==='host'){registry.delete(this.room.id);this.guest?.emit('event',{type:'room-ended'});}if(this.mode==='guest')this.host?.clients.delete(this.ownId);this.mode=null;this.clients.clear();}
}
function makePerson(id,rooms=new FakeRooms()){
  const friend=new EventEmitter();Object.assign(friend,{id,contacts:new Map(),presence:{status:'online'},verified(peerId){const contact=this.contacts.get(peerId);if(contact?.status!=='friend'||contact.needsVerification||!contact.sharedKey)throw Error('Friend not verified');return contact;},async request(contact,message){return peers.get(contact.id).calls.receive(message);}});
  const result={id,friends:friend,rooms,events:[],getMemberCalls:0};result.calls=new PrivateCalls({friends:friend,rooms,getMember:()=>{result.getMemberCalls++;return{id,name:'Test '+id[0],voiceChannelId:null};},onEvent:event=>result.events.push(event)});peers.set(id,result);created.push(result);return result;
}
function connect(a,b){const sharedKey=randomBytes(32).toString('base64url');a.friends.contacts.set(b.id,{id:b.id,name:'Friend '+b.id[0],status:'friend',identity:key(),sharedKey});b.friends.contacts.set(a.id,{id:a.id,name:'Friend '+a.id[0],status:'friend',identity:key(),sharedKey});}
const a=makePerson('a'.repeat(32)),b=makePerson('b'.repeat(32)),c=makePerson('c'.repeat(32));connect(a,b);connect(a,c);connect(b,c);
async function check(name,run){await run();checks.push(name);console.log('PASS',name);}
async function end(...people){for(const person of people)await person.calls.end();}

try{
  await check('Ringing creates no room and reads no media member before explicit acceptance',async()=>{
    const state=await a.calls.start({friendId:b.id,mode:'video'});assert.equal(state.phase,'outgoing');assert.equal(b.calls.snapshot().phase,'incoming');assert.deepEqual(a.rooms.operations,[]);assert.deepEqual(b.rooms.operations,[]);assert.equal(a.getMemberCalls+b.getMemberCalls,0);
    assert(!Object.hasOwn(b.calls.snapshot(),'invite'));assert(!Object.hasOwn(b.calls.snapshot(),'nonce'));await end(a,b);
  });
  await check('Accept establishes only a two-person transient room with pinned identities',async()=>{
    const state=await a.calls.start({friendId:b.id});await b.calls.accept(state.callId);assert.equal(a.calls.snapshot().phase,'active');assert.equal(b.calls.snapshot().phase,'active');assert.equal(a.rooms.room.kind,'direct');assert.equal(a.rooms.clients.size,1);assert.deepEqual(Object.keys(a.rooms.allowed).sort(),[a.id,b.id]);
    const aConnecting=a.events.findIndex(e=>e.callId===state.callId&&e.phase==='connecting'),aActive=a.events.findIndex(e=>e.callId===state.callId&&e.phase==='active');assert(aConnecting>=0&&aActive>aConnecting);await end(a,b);
  });
  await check('A third account cannot enter even after learning the room invite or spoofing the allowed ID',async()=>{
    const state=await a.calls.start({friendId:b.id});await b.calls.accept(state.callId);const url=new URL('stringchat://join');for(const[k,v]of Object.entries({host:'127.0.0.1',port:23456,key:randomBytes(32).toString('base64url'),room:state.callId}))url.searchParams.set(k,v);
    const options={invite:url.toString(),member:{id:b.id},transient:true,expectedHostKey:a.rooms.publicKey,expectedHostId:a.id,expectedRoomKind:'direct',expectedCallId:state.callId};await assert.rejects(c.rooms.join(options),/Uninvited/);assert.equal(a.rooms.clients.size,1);await end(a,b);
  });
  await check('Decline, group busy and overlapping calls never start capture or create extra rooms',async()=>{
    const before=a.rooms.operations.filter(o=>o==='create').length,state=await a.calls.start({friendId:b.id});await b.calls.decline({callId:state.callId});assert.equal(a.calls.snapshot(),null);assert.equal(a.events.at(-1).reason,'declined');assert.equal(a.rooms.operations.filter(o=>o==='create').length,before);
    b.rooms.mode='host';b.rooms.room={id:'d'.repeat(32),kind:'group'};const busy=await a.calls.start({friendId:b.id});assert.equal(busy.reason,'busy');assert.equal(b.calls.snapshot(),null);b.rooms.mode=null;b.rooms.room=null;
    const incoming=await a.calls.start({friendId:b.id});await assert.rejects(a.calls.start({friendId:c.id}),/atual/);const busyOther=await c.calls.start({friendId:b.id});assert.equal(busyOther.reason,'busy');await end(a,b,c);assert.equal(incoming.phase,'outgoing');
  });
  await check('Encrypted call packets cannot be opened by another friend and altered packets are rejected',async()=>{
    const state=await a.calls.start({friendId:b.id}),contact=a.calls._contact(b.id),payload={kind:'end',callId:state.callId,nonce:a.calls.current.nonce},packet=a.calls._seal(contact,payload);
    assert(!JSON.stringify(packet).includes(state.callId));assert.throws(()=>c.calls._open(c.calls._contact(a.id),packet));await assert.rejects(b.calls.receive({type:'private-call',fromId:c.id,packet}));await assert.rejects(b.calls.receive({type:'private-call',fromId:a.id,packet:{...packet,t:randomBytes(16).toString('base64url')}}));assert.equal(b.calls.snapshot().phase,'incoming');await end(a,b);
  });
  await check('Cancelled ringing cannot be accepted later or replayed into another incoming call',async()=>{
    const state=await a.calls.start({friendId:b.id}),call={...a.calls.current},contact=a.calls._contact(b.id),packet=a.calls._seal(contact,{kind:'offer',callId:call.id,nonce:call.nonce,mode:'voice',hostKey:call.hostKey,expiresAt:Date.now()+30000});await a.calls.end(state.callId);await assert.rejects(b.calls.accept(state.callId),/tocando/);await b.calls.receive({type:'private-call',fromId:a.id,packet});assert.equal(b.calls.snapshot(),null);assert.equal(a.rooms.mode,null);
  });
  await check('Cancellation while the host is creating a room cleans up a late completion',async()=>{
    a.rooms.createGate=deferred();const state=await a.calls.start({friendId:b.id}),accepted=b.calls.accept(state.callId);await flush();assert.equal(a.rooms.mode,'host');await b.calls.end(state.callId);a.rooms.createGate.resolve();const result=await accepted;assert.equal(result.phase,'ended');assert.equal(a.rooms.mode,null);assert.equal(b.rooms.mode,null);delete a.rooms.createGate;
  });
  await check('Cancellation during guest join cannot transition either participant back to active',async()=>{
    b.rooms.joinGate=deferred();const state=await a.calls.start({friendId:b.id}),accepted=b.calls.accept(state.callId);await flush();await a.calls.end(state.callId);b.rooms.epoch++;b.rooms.joinGate.resolve();const result=await accepted;assert.equal(result.phase,'ended');assert.equal(a.calls.snapshot(),null);assert.equal(b.calls.snapshot(),null);assert.equal(a.rooms.mode,null);assert.equal(b.rooms.mode,null);delete b.rooms.joinGate;
  });
  await check('Ringing expires after thirty seconds and blocking terminates an active private call',async()=>{
    mock.timers.enable({apis:['setTimeout','Date']});const state=await a.calls.start({friendId:b.id});mock.timers.tick(30001);await flush();assert.equal(a.calls.snapshot(),null);assert.equal(b.calls.snapshot(),null);assert.equal(a.events.at(-1).reason,'timeout');mock.timers.reset();
    const next=await a.calls.start({friendId:b.id});await b.calls.accept(next.callId);a.friends.contacts.get(b.id).status='blocked';a.friends.emit('change');assert.equal(a.calls.snapshot(),null);assert.equal(a.rooms.mode,null);assert.equal(b.calls.snapshot(),null);a.friends.contacts.get(b.id).status='friend';assert.equal(state.phase,'outgoing');
  });
  await check('Real RoomService keeps a saved group untouched and rejects a third member with leaked invitation',async()=>{
    const address=listInterfaces()[0]?.address||'127.0.0.1',groupPath=join(root,'real-group.json'),saved={sentinel:'preserve existing group',room:{id:'e'.repeat(32),ownerId:'d'.repeat(32)},history:[{text:'do not import'}]};await writeFile(groupPath,JSON.stringify(saved));
    const one=makePerson('1'.repeat(32),new RoomService({statePath:groupPath})),two=makePerson('2'.repeat(32),new RoomService({statePath:join(root,'two-group.json')}));connect(one,two);
    // Explicit adapter selection is optional in PrivateCalls; real service chooses the same available interface.
    assert(address);const state=await one.calls.start({friendId:two.id});await two.calls.accept(state.callId);assert.equal(one.calls.snapshot().phase,'active');assert.equal(two.calls.snapshot().phase,'active');assert.equal(one.rooms.room.kind,'direct');assert.equal(one.rooms.history.length,0);assert.equal(await readFile(groupPath,'utf8'),JSON.stringify(saved));
    const third=new RoomService({statePath:join(root,'third-group.json')});created.push({calls:{close(){}},rooms:third});await assert.rejects(third.join({invite:one.rooms.info.invite,member:{id:two.id,name:'Spoof',voiceChannelId:'voice-direct'},transient:true,expectedHostKey:one.rooms.privateIdentity(),expectedHostId:one.id,expectedRoomKind:'direct',expectedCallId:state.callId}));assert.equal(one.rooms.clients.size,1);await end(one,two);assert.equal(await readFile(groupPath,'utf8'),JSON.stringify(saved));
  });
  await writeFile(join(root,'results.json'),JSON.stringify({checks},null,2));
}finally{mock.timers.reset();for(const person of created){person.calls.close();person.rooms.leave();}}
