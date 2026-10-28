import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { FriendsService } from '../friends-service.mjs';
import { HostedService } from '../hosted-service.mjs';
import { HostedClient } from '../hosted-client.mjs';
import { HostedMessages } from '../hosted-messages.mjs';
import { PrivateCalls } from '../private-calls.mjs';
import { HostedPrivateCallTransport } from '../hosted-private-call-transport.mjs';
import { testTLS } from './tls-fixture.mjs';

const root = resolve('.test-results/hosted-calls-' + Date.now()), checks = [], people = [], registry = new Map();
await mkdir(root, { recursive: true });
const {tls,caPem}=await testTLS(join(root,'tls'));
const registrationToken = randomBytes(32).toString('base64url'), statePath = join(root, 'server/state.json');
let server = new HostedService({ statePath, tls, registrationToken }); const address = await server.start(), url = 'https://127.0.0.1:' + address.port;
class Rooms extends EventEmitter {
  constructor() { super(); this.privateCallsVersion = 1; this.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'); this.clients = new Map(); this.operations = []; }
  privateIdentity() { return this.publicKey; }
  async create(options) { assert.equal(options.transient, true); assert.equal(options.room.kind, 'direct'); assert.equal(Object.keys(options.allowedMembers).length, 2); this.operations.push('create'); this.room = options.room; this.mode = 'host'; this.allowed = options.allowedMembers; this.ownId = options.member.id; registry.set(this.room.id, this); const invite = new URL('stringchat://join'); for (const [k, v] of Object.entries({ host: '127.0.0.1', port: '23456', key: randomBytes(32).toString('base64url'), room: this.room.id })) invite.searchParams.set(k, v); return { room: this.room, invite: invite.href }; }
  async join(options) { const host = registry.get(new URL(options.invite).searchParams.get('room')); assert(host); assert.equal(options.expectedHostKey, host.publicKey); assert.equal(options.expectedHostId, host.ownId); assert.equal(host.allowed[options.member.id], this.publicKey); this.operations.push('join'); this.mode = 'guest'; this.room = host.room; this.host = host; this.ownId = options.member.id; host.clients.set(this.ownId, options.member); }
  leave() { if (this.mode === 'host') registry.delete(this.room.id); else this.host?.clients.delete(this.ownId); this.mode = null; this.room = null; this.clients.clear(); }
}
async function person(name) {
  const friends = new FriendsService({ path: join(root, name, 'friends.json'), getName: () => name, getGroup: () => null }), client = new HostedClient({ url, friends, registrationToken, caPem }), rooms = new Rooms(), events = [];
  const calls = new PrivateCalls({ friends, rooms, getMember: () => ({ id: friends.id, name }), onEvent: event => events.push(event) }), transport = new HostedPrivateCallTransport({ client, friends, privateCalls: calls });
  friends.privateCalls = calls; client.extraTransport = transport; client.directTransport = new HostedMessages({ client, friends, extraTransport: transport }); friends.request = (endpoint, envelope, command) => client.request(endpoint, envelope, command);
  const value = { friends, client, rooms, calls, transport, events }; people.push(value); await client.connect(); return value;
}
async function pump(operation) { let settled = false, result, failure; Promise.resolve(operation).then(value => { result = value; settled = true; }, error => { failure = error; settled = true; }); for (let i = 0; !settled && i < 100; i++) { for (const person of people) if (!person.transport.closed) await person.client.poll(); await new Promise(resolve => setTimeout(resolve, 3)); } if (!settled) throw Error('RPC did not settle'); if (failure) throw failure; return result; }
async function check(name, run) { await run(); checks.push(name); console.log('PASS', name); }
try {
  const a = await person('Call A'), b = await person('Call B'), c = await person('Call C');
  for (const target of [b, c]) { await a.client.friendRequest(target.friends.id); await target.client.friendAccept(a.friends.id); } await a.client.state();
  await check('Encrypted HTTPS ringing requires a peer reply and captures no media before consent', async () => {
    const pending = a.calls.start({ friendId: b.friends.id, mode: 'video' }); let resolved = false; pending.then(() => { resolved = true; }); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(resolved, false); assert.equal(b.calls.snapshot(), null); assert.equal(a.transport.pending.size, 1);
    const state = await pump(pending); assert.equal(state.phase, 'outgoing'); assert.equal(b.calls.snapshot().phase, 'incoming'); assert.deepEqual(a.rooms.operations, []); assert.deepEqual(b.rooms.operations, []);
    const stored = JSON.stringify([...server.mail.values()]); assert(!stored.includes('callId')); await pump(b.calls.decline(state.callId)); assert.equal(a.calls.snapshot(), null); assert.equal(b.calls.snapshot(), null);
  });
  await check('Consent connects a restricted two-person room using the encrypted call RPC domain', async () => {
    const state = await pump(a.calls.start({ friendId: b.friends.id })); await pump(b.calls.accept(state.callId)); assert.equal(a.calls.snapshot().phase, 'active'); assert.equal(b.calls.snapshot().phase, 'active'); assert.equal(a.rooms.clients.size, 1); assert.deepEqual(Object.keys(a.rooms.allowed).sort(), [a.friends.id, b.friends.id].sort()); await pump(a.calls.end()); assert.equal(b.calls.snapshot(), null);
  });
  await check('A signed reply from another friend cannot confirm the pending call', async () => {
    const command = { kind: 'offer', callId: randomBytes(16).toString('hex'), nonce: randomBytes(32).toString('base64url'), mode: 'voice', hostKey: a.rooms.publicKey, expiresAt: Date.now() + 30000 };
    const promise = a.transport.request(a.friends.contacts.get(b.friends.id), { type: 'private-call', fromId: a.friends.id, packet: a.calls._seal(a.friends.contacts.get(b.friends.id), command) }); promise.catch(() => {}); const pending = [...a.transport.pending.values()][0];
    const id = randomBytes(16).toString('hex'), payload = { id, fromId: c.friends.id, toId: a.friends.id, transportType: 'private-call', direction: 'reply', replyTo: pending.id, createdAt: Date.now(), expiresAt: Date.now() + 30000, packet: c.calls._seal(c.friends.contacts.get(a.friends.id), { ...command, kind: 'ringing' }) }, item = { id, fromId: c.friends.id, envelope: c.friends.signForService('stringchat-hosted-mail-v1', payload) };
    await assert.rejects(a.transport.tryReceipt(item), /identidade/); assert.equal(a.transport.pending.size, 1); await a.client.cancelMailbox([pending.id]); clearTimeout(pending.timer); a.transport.pending.delete(pending.id); pending.reject(Error('Test cleanup')); await assert.rejects(promise);
  });
  await check('Offline call offers expire on server restart while direct messages remain queued', async () => {
    const contact = a.friends.contacts.get(b.friends.id), callId = randomBytes(16).toString('hex'), command = { kind: 'text', id: randomBytes(16).toString('hex'), text: 'Keep offline message', time: Date.now() }, directId = a.client.directTransport.operationId(contact, command);
    await a.client.queueEnvelope({ toId: b.friends.id, id: callId, packet: a.calls._seal(contact, { kind: 'offer', callId, nonce: randomBytes(32).toString('base64url') }), transportType: 'private-call', expiresAt: Date.now() + 30000 });
    await a.client.queueEnvelope({ toId: b.friends.id, id: directId, packet: a.friends.direct.seal(contact, command) });
    server.mail.get(a.friends.id + ':' + callId).expiresAt = Date.now() - 1; await server.close(); server = new HostedService({ statePath, tls, registrationToken }); await server.start({ port: address.port }); const inbox = await b.client.mailbox(); assert(!inbox.items.some(item => item.id === callId)); assert(inbox.items.some(item => item.id === directId));
    await a.client.cancelMailbox([directId]); assert((await b.client.mailbox()).items.some(item => item.id === directId)); await b.client.poll(); assert.equal(b.calls.snapshot(), null); assert.equal(b.friends.direct.history(a.friends.id).at(-1).text, 'Keep offline message');
  });
  await check('Closing rejects outstanding RPC and cancels the queued offer', async () => {
    const contact = a.friends.contacts.get(b.friends.id), command = { kind: 'offer', callId: randomBytes(16).toString('hex'), nonce: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 30000 }, promise = a.transport.request(contact, { type: 'private-call', fromId: a.friends.id, packet: a.calls._seal(contact, command) }); promise.catch(() => {}); const id = [...a.transport.pending.keys()][0]; await new Promise(resolve => setTimeout(resolve, 30)); await a.transport.close(); await assert.rejects(promise, /encerrado/); assert.equal((await a.client.messageStatus([id])).items[0].status, 'expired'); assert.equal(a.transport.pending.size, 0);
  });
  await writeFile(resolve('.test-results/hosted-private-calls-results.json'), JSON.stringify({ checks, realHttps: true, localEphemeralIdentities: true, simulatedMediaRooms: true }, null, 2));
} finally { for (const person of people) { person.calls.close(); await person.client.close(); person.friends.close(); } await server.close(); }
