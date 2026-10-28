import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import {RoomRouter} from '../room-router.mjs';
let finish;
class PendingBackend extends EventEmitter{constructor(){super();this.mode=null;}create(){return new Promise(resolve=>{finish=resolve;});}leave(){}}
const local=new PendingBackend(),router=new RoomRouter({local}),opening=router.create({});
assert.equal(router.mode,'connecting');assert.throws(()=>router.setHosted(null),/Saia/);await assert.rejects(router.create({}),/Saia/);assert.throws(()=>router.choose(local),/Saia/);
finish({});await opening;assert.equal(router.mode,null);router.setHosted(null);
console.log('PASS Pending room operations block another room or server switch until completion');
