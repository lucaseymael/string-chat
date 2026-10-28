import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FriendsService, parseFriendLink } from '../friends-service.mjs';
import { makeWire } from '../room-service.mjs';
import { normalizePresence } from '../presence-policy.mjs';

const root = resolve('.test-results/friends-presence-' + Date.now()), services = [], checks = [];
await mkdir(root, { recursive: true });
const group = { name: 'Private group', invite: `stringchat://join?host=127.0.0.1&port=12345&key=${randomBytes(32).toString('base64url')}&room=${'e'.repeat(32)}` };
async function start(name) { const service = new FriendsService({ path: root + '/' + name + '/friends.json', getName: () => name, getGroup: () => group }); services.push(service); await service.start(); assert(service.address); return service; }
async function until(fn, timeout = 4000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw Error('Timed out waiting for state.'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function refresh(service) { await until(() => !service.refreshing); await service.refresh(); }
async function befriend(a, b) { await a.add(b.code()); await b.accept(a.id); await refresh(a); await refresh(b); }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
async function raw(endpoint, value) { return new Promise((resolve, reject) => { const socket = net.createConnection({ host: endpoint.host, port: endpoint.port }); const timer = setTimeout(() => { socket.destroy(); reject(Error('Timed out.')); }, 3000); const wire = makeWire(socket, endpoint.key, result => { clearTimeout(timer); socket.end(); resolve(result); }, () => { clearTimeout(timer); reject(Error('Wire closed.')); }); socket.once('connect', () => wire.send(value)); }); }

let a, b, c;
try {
  a = await start('A'); b = await start('B'); c = await start('C'); await befriend(a, b); await befriend(a, c); await befriend(b, c);
  await check('Signed friend identities establish a private pairwise key without exposing secrets to the UI', async () => {
    const ab = a.contacts.get(b.id), ba = b.contacts.get(a.id);
    assert.equal(ab.sharedKey, ba.sharedKey); assert.notEqual(ab.sharedKey, a.contacts.get(c.id).sharedKey); assert.notEqual(ab.sharedKey, c.contacts.get(b.id).sharedKey);
    const snapshot = a.snapshot(), shown = snapshot.contacts.find(contact => contact.id === b.id);
    for (const field of ['key', 'host', 'port', 'identity', 'exchange', 'sharedKey']) assert.equal(shown[field], undefined);
    assert.equal(snapshot.authentication, undefined); assert.equal(shown.needsVerification, false); assert.equal(shown.identityFingerprint.length, 24);
    const saved = JSON.parse(await readFile(a.path, 'utf8')); assert(saved.authentication.signingPrivateKey); assert(saved.contacts.every(contact => !contact.sharedKey));
    const packet = a.direct.seal(ab, { kind: 'text', id: randomBytes(16).toString('hex'), text: 'only A and B', time: Date.now() });
    assert.throws(() => c.direct.open(c.contacts.get(b.id), packet));
  });

  await check('Available, idle and do-not-disturb status and custom text propagate with bounded input', async () => {
    a.setPresence({ status: 'idle', statusText: 'Taking a break\n🎧' }); await refresh(b);
    assert.equal(b.contacts.get(a.id).presence, 'idle'); assert.equal(b.contacts.get(a.id).statusText, 'Taking a break 🎧'); assert.equal(b.contacts.get(a.id).online, true);
    a.setPresence({ status: 'dnd', statusText: 'x'.repeat(300) }); await refresh(b); assert.equal(b.contacts.get(a.id).presence, 'dnd'); assert.equal(b.contacts.get(a.id).statusText.length, 128);
    assert.throws(() => a.setPresence({ status: 'forged', statusText: '' })); assert.throws(() => normalizePresence({ status: 'online', statusText: {} }, { strict: true }));
  });

  await check('Invisible status presents offline and withholds the status text and group', async () => {
    a.setPresence({ status: 'online', statusText: 'Visible' }); await refresh(b); assert.equal(b.contacts.get(a.id).group.name, group.name);
    a.setPresence({ status: 'invisible', statusText: 'Private status' }); await refresh(b);
    const contact = b.contacts.get(a.id); assert.equal(contact.online, false); assert.equal(contact.presence, 'offline'); assert.equal(contact.statusText, ''); assert.equal(contact.group, null);
    assert.equal(a.snapshot().presence.status, 'invisible'); assert.equal(a.snapshot().presence.statusText, 'Private status');
    await b.direct.sendText({ friendId: a.id, text: 'Delivered while invisible' }); assert.equal(b.contacts.get(a.id).online, false); assert.equal(b.contacts.get(a.id).presence, 'offline');
  });

  await check('Do-not-disturb delivers private messages and invitations as silent events', async () => {
    a.direct.markRead(b.id); a.setPresence({ status: 'dnd', statusText: 'Concentrating' }); let received, notice;
    a.once('direct-message', value => { received = value; }); await b.direct.sendText({ friendId: a.id, text: 'No interruption' });
    assert.equal(received.text, 'No interruption'); assert.equal(received.silent, true); assert.equal(a.direct.summary(b.id).unread, 1);
    a.once('notice', value => { notice = value; }); await b.invite(a.id); assert.equal(notice.kind, 'group-invite'); assert.equal(notice.silent, true);
  });

  await check('A third contact cannot forge control messages even with both public friend codes', async () => {
    const endpoint = parseFriendLink(b.code()), before = { ...b.contacts.get(a.id) };
    for (const type of ['presence', 'removed', 'invite', 'accepted']) {
      const reply = await c.request(endpoint, { type, fromId: a.id, name: 'Forged name', presence: 'online', invite: group.invite }); assert(reply.error);
    }
    assert.equal(b.contacts.get(a.id).identity, before.identity); assert.equal(b.contacts.get(a.id).name, before.name); assert.equal(b.contacts.get(a.id).status, 'friend');
    const forged = c.seal(b.id, { type: 'presence', fromId: a.id, name: 'Wrong signer' }); forged.fromId = a.id; forged.identity = a.publicIdentity().identity;
    const response = await raw(endpoint, forged); assert(b.open ? a.open(response, { identity: b.publicIdentity().identity, fromId: b.id, replyTo: forged.nonce }).error : false);
  });

  await check('Signed requests reject replay and replies are bound to the originating nonce', async () => {
    const endpoint = parseFriendLink(b.code()), packet = a.seal(b.id, { type: 'presence', fromId: a.id, presence: 'idle', statusText: 'One request', name: 'A' });
    const first = await raw(endpoint, packet); assert.equal(a.open(first, { identity: endpoint.identity, fromId: b.id, replyTo: packet.nonce }).type, 'presence');
    const second = await raw(endpoint, packet); assert(a.open(second, { identity: endpoint.identity, fromId: b.id, replyTo: packet.nonce }).error);
    const reply = b.seal(a.id, { ok: true }, randomBytes(16).toString('hex')); assert.throws(() => a.open(reply, { identity: endpoint.identity, fromId: b.id, replyTo: packet.nonce }));
  });

  await check('Blocking prevents incoming requests, presence, invitations and private packets without exposing block state', async () => {
    const endpoint = parseFriendLink(a.code()), contact = { ...b.contacts.get(a.id) }, before = a.direct.messages.length;
    const packet = b.direct.seal(contact, { kind: 'text', id: randomBytes(16).toString('hex'), text: 'Blocked packet', time: Date.now() });
    await a.block(b.id); assert.equal(a.contacts.get(b.id).status, 'blocked');
    for (const payload of [{ type: 'request', from: b.ownEndpoint() }, { type: 'presence', fromId: b.id }, { type: 'invite', fromId: b.id, invite: group.invite }, { type: 'removed', fromId: b.id }, { type: 'direct', fromId: b.id, packet }]) {
      const reply = await b.request(endpoint, payload); assert.equal(reply.error, 'Não foi possível concluir esta solicitação.'); assert(!Object.keys(reply).some(key => ['name', 'group', 'presence', 'blocked'].includes(key)));
    }
    assert.equal(a.contacts.get(b.id).status, 'blocked'); assert.equal(a.direct.messages.length, before); await assert.rejects(a.add(b.code())); await assert.rejects(a.direct.sendText({ friendId: b.id, text: 'Local block' }));
    await until(() => !b.contacts.has(a.id));
  });

  await check('Blocking and own presence persist; unblocking requires a new friend request', async () => {
    const id = a.id, identity = a.publicIdentity().identity; a.close(); a = await start('A'); assert.equal(a.id, id); assert.equal(a.publicIdentity().identity, identity); assert.equal(a.presence.status, 'dnd'); assert.equal(a.contacts.get(b.id).status, 'blocked');
    await a.unblock(b.id); assert.equal(a.contacts.has(b.id), false); await assert.rejects(a.direct.sendText({ friendId: b.id, text: 'Still no friendship' })); await befriend(a, b);
    await a.direct.sendText({ friendId: b.id, text: 'Reconnected safely' }); assert.equal(b.direct.history(a.id).at(-1).text, 'Reconnected safely');
  });

  await check('Removal preserves messages on disk and cannot delete a local block marker', async () => {
    const history = a.direct.history(b.id), before = history.length; await a.remove(b.id); await until(() => !b.contacts.has(a.id));
    assert.equal(a.contacts.has(b.id), false); assert.equal(a.direct.messages.filter(m => m.friendId === b.id).length, before); await befriend(a, b); assert.equal(a.direct.history(b.id).length, before);
    await a.block(b.id); await assert.rejects(a.remove(b.id)); assert.equal(a.contacts.get(b.id).status, 'blocked');
  });

  await check('Legacy profiles retain identity and history but require an explicit new signed code', async () => {
    const directory = root + '/Legacy', id = randomBytes(16).toString('hex'), messageId = randomBytes(16).toString('hex'); await mkdir(directory);
    await writeFile(directory + '/friends.json', JSON.stringify({ id, key: randomBytes(32).toString('base64url'), contacts: [{ id: c.id, host: c.address, port: c.port, key: c.key, name: 'C', status: 'friend' }] }));
    await writeFile(directory + '/private-messages.json', JSON.stringify({ messages: [{ id: messageId, friendId: c.id, authorId: id, text: 'Existing history', time: Date.now(), status: 'delivered' }] }));
    const legacy = await start('Legacy'); assert.equal(legacy.id, id); assert.equal(legacy.snapshot().contacts[0].needsVerification, true); assert.equal(legacy.direct.history(c.id)[0].text, 'Existing history');
    await assert.rejects(legacy.direct.sendText({ friendId: c.id, text: 'Requires revalidation' })); const oldCode = new URL(c.code()); oldCode.searchParams.delete('identity'); oldCode.searchParams.delete('exchange'); await assert.rejects(legacy.add(oldCode.toString()));
    await legacy.add(c.code()); await c.accept(legacy.id); assert.equal(legacy.contacts.get(c.id).needsVerification, false); assert(legacy.contacts.get(c.id).sharedKey); assert.equal(legacy.direct.history(c.id)[0].id, messageId);
  });

  await writeFile(resolve('.test-results/friends-presence-results.json'), JSON.stringify({ checks, sameComputer: true, identityProtocol: 2 }, null, 2));
} finally { for (const service of services) service.close(); }
