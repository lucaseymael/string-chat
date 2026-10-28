import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, X509Certificate } from 'node:crypto';
import { FriendsService } from '../friends-service.mjs';
import { HostedService } from '../hosted-service.mjs';
import { HostedClient, normalizeHostedUrl } from '../hosted-client.mjs';
import { testTLS } from './tls-fixture.mjs';

const root = resolve('.test-results/hosted-' + Date.now()), checks = [], accounts = [], clients = [];
await mkdir(root, { recursive: true });
const {caPem,tls}=await testTLS(join(root,'tls'));
const certificateSha256 = new X509Certificate(caPem).fingerprint256.replaceAll(':', '').toLowerCase(), token = randomBytes(32).toString('base64url'), statePath = join(root, 'server/state.json');
let server = new HostedService({ statePath, tls, registrationToken: token }), address = await server.start(), url = 'https://127.0.0.1:' + address.port;
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
async function start(name) { const friends = new FriendsService({ path: join(root, name, 'friends.json'), getName: () => name, getGroup: () => null }); accounts.push(friends); const client = new HostedClient({ url, friends, registrationToken: token, caPem, certificateSha256 }); clients.push(client); await client.connect(); return { friends, client }; }
function directRequest(client, signed, raw = '') { return new Promise((resolve, reject) => { const request = https.request(url + '/v1/state', { method: 'GET', ca: caPem, headers: { 'x-stringchat-auth': signed, 'content-length': Buffer.byteLength(raw) } }, response => { const data = []; response.on('data', bytes => data.push(bytes)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(data).toString()) })); }); request.on('error', reject); request.end(raw); }); }
function rawRequest({ path = '/v1/state', method = 'GET', authentication, raw = '' }) { return new Promise((resolve, reject) => { const request = https.request(url + path, { method, ca: caPem, headers: { 'x-stringchat-auth': authentication, 'content-length': Buffer.byteLength(raw) } }, response => { const data = []; response.on('data', bytes => data.push(bytes)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(data).toString()) })); }); request.on('error', reject); request.end(raw); }); }
let refusedRequest;

try {
  let a = await start('User A'), b = await start('User B'), c = await start('User C');
  await check('HTTPS rejects untrusted certificates, wrong certificate pins and plaintext URLs', async () => {
    assert.throws(() => normalizeHostedUrl('http://127.0.0.1:123')); assert.throws(() => normalizeHostedUrl('https://user:password@example.com'));
    const untrusted = new HostedClient({ url, friends: a.friends }); clients.push(untrusted); await assert.rejects(untrusted.api('GET', '/v1/state'));
    const wrongPin = new HostedClient({ url, friends: a.friends, caPem, certificateSha256: 'a'.repeat(64) }); clients.push(wrongPin); await assert.rejects(wrongPin.api('GET', '/v1/state'));
  });
  await check('Only authenticated registration with the configured token creates accounts', async () => {
    const outsider = new FriendsService({ path: join(root, 'outsider/friends.json'), getName: () => 'Outsider', getGroup: () => null }); accounts.push(outsider);
    const client = new HostedClient({ url, friends: outsider, registrationToken: 'wrong', caPem }); clients.push(client); await assert.rejects(client.connect(), error => error.status === 403); assert.equal(server.accounts.size, 3);
    const signed = a.client.signedRequest('GET', '/v1/state').authentication; assert.equal((await directRequest(a.client, signed)).status, 200); assert.equal((await directRequest(a.client, signed)).status, 409);
    const altered = JSON.parse(Buffer.from(a.client.signedRequest('GET', '/v1/state').authentication, 'base64url').toString()); altered.id = b.friends.id; assert.equal((await directRequest(a.client, Buffer.from(JSON.stringify(altered)).toString('base64url'))).status, 401);
  });
  await check('HTTP authentication binds actor, exact method, path and body and retains live nonces at capacity', async () => {
    const signed = a.client.signedRequest('POST', '/v1/presence', { presence: 'dnd' });
    assert.equal((await rawRequest({ ...signed, method: 'POST', path: '/v1/presence', raw: JSON.stringify({ presence: 'online' }) })).status, 401);
    assert.equal((await rawRequest({ ...signed, method: 'POST', path: '/v1/register' })).status, 401);
    assert.equal((await rawRequest({ ...signed, method: 'GET', path: '/v1/presence' })).status, 401);
    const claims = JSON.parse(Buffer.from(a.client.signedRequest('GET', '/v1/state').authentication, 'base64url').toString()); claims.payload = JSON.stringify({ ...JSON.parse(claims.payload), id: b.friends.id });
    assert.equal((await rawRequest({ authentication: Buffer.from(JSON.stringify(claims)).toString('base64url') })).status, 401);
    assert.equal((await rawRequest({ ...signed, method: 'POST', path: '/v1/presence' })).status, 200);
    const parsed = JSON.parse(JSON.parse(Buffer.from(signed.authentication, 'base64url').toString()).payload), nonce = a.friends.id + ':' + parsed.nonce, limit = server.maxPendingNonces; server.maxPendingNonces = server.seen.size;
    assert.equal((await rawRequest(a.client.signedRequest('GET', '/v1/state'))).status, 429); assert(server.seen.has(nonce)); assert.equal((await rawRequest({ ...signed, method: 'POST', path: '/v1/presence' })).status, 409); server.maxPendingNonces = limit;
    const future = { ...a.friends.publicIdentity(), method: 'GET', path: '/v1/state', bodyHash: parsed.bodyHash, nonce: randomBytes(16).toString('hex'), time: Date.now() + 85000 }; future.bodyHash = JSON.parse(JSON.parse(Buffer.from(a.client.signedRequest('GET', '/v1/state').authentication, 'base64url').toString()).payload).bodyHash;
    const authentication = Buffer.from(JSON.stringify(a.friends.signForService('stringchat-hosted-http-v1', future))).toString('base64url'); assert.equal((await rawRequest({ authentication })).status, 200); assert(server.seen.get(a.friends.id + ':' + future.nonce) > Date.now() + 170000);
    refusedRequest = { ...a.client.signedRequest('GET', '/v1/missing'), path: '/v1/missing' }; assert.equal((await rawRequest(refusedRequest)).status, 404);
  });
  await check('Directory exposes public identities and friendships require recipient acceptance', async () => {
    const found = await a.client.directory('User B'); assert.equal(found.accounts[0].id, b.friends.id); assert.equal(found.accounts[0].online, undefined); assert(!JSON.stringify(found).includes('PrivateKey'));
    await a.client.friendRequest(b.friends.id); await assert.rejects(a.client.friendAccept(b.friends.id), error => error.status === 403); await b.client.state(); assert.equal(b.friends.contacts.get(a.friends.id).status, 'incoming'); await b.client.friendAccept(a.friends.id); await a.client.state();
    assert.equal(a.friends.contacts.get(b.friends.id).status, 'friend'); assert.equal(a.friends.contacts.get(b.friends.id).sharedKey, b.friends.contacts.get(a.friends.id).sharedKey);
  });
  await check('Hosted invisible presence withholds status text without preventing message delivery', async () => {
    a.friends.setPresence({ status: 'invisible', statusText: 'Private detail' }); await a.client.setPresence(); const state = await b.client.state(); const contact = state.contacts.find(value => value.id === a.friends.id); assert.equal(contact.online, false); assert.equal(contact.presence, 'offline'); assert.equal(contact.statusText, '');
  });
  await check('Profile changes propagate through presence and invalid snapshots leave local contacts intact', async () => {
    const avatar = 'data:image/png;base64,aGVsbG8='; await a.client.setPresence({ status: 'idle', statusText: 'Updated', name: ' Updated account ', avatar }); const state = await b.client.state(), contact = state.contacts.find(value => value.id === a.friends.id); assert.equal(contact.name, 'Updated account'); assert.equal(contact.avatar, avatar); assert.equal(contact.presence, 'idle');
    await a.client.setPresence({ status: 'online', avatar: 'https://external.invalid/image.svg' }); assert.equal((await b.client.state()).contacts.find(value => value.id === a.friends.id).avatar, '');
    const before = JSON.stringify([...b.friends.contacts]); assert.throws(() => b.client.synchronizeContacts({ ...state, contacts: [...state.contacts, { ...state.contacts[0], id: b.friends.id }] })); assert.equal(JSON.stringify([...b.friends.contacts]), before);
    assert.throws(() => b.client.synchronizeContacts({ ...state, contacts: [...state.contacts, state.contacts[0]] })); assert.equal(JSON.stringify([...b.friends.contacts]), before);
  });
  await check('Mailbox signatures cannot impersonate a different HTTP actor or hide ciphertext tampering', async () => {
    const packet = b.friends.direct.seal(b.friends.contacts.get(a.friends.id), { kind: 'text', id: randomBytes(16).toString('hex'), text: 'Signed', time: Date.now() }), payload = { id: randomBytes(16).toString('hex'), fromId: b.friends.id, toId: a.friends.id, direction: 'request', replyTo: null, createdAt: Date.now(), packet }, envelope = b.friends.signForService('stringchat-hosted-mail-v1', payload);
    await assert.rejects(a.client.api('POST', '/v1/mailbox', { envelope }), error => error.status === 403);
    const changed = structuredClone(envelope); changed.payload = JSON.stringify({ ...payload, packet: { ...packet, d: packet.d.slice(0, -1) + (packet.d.at(-1) === 'a' ? 'b' : 'a') } }); await assert.rejects(b.client.api('POST', '/v1/mailbox', { envelope: changed }), error => error.status === 401); assert.equal(server.mail.size, 0);
  });
  let queued, messageId = randomBytes(16).toString('hex'), operationId = randomBytes(16).toString('hex');
  await check('Offline messages stay encrypted in a persistent queue and are idempotent', async () => {
    b.client.close(); const packet = a.friends.direct.seal(a.friends.contacts.get(b.friends.id), { kind: 'text', id: messageId, text: 'Private offline contents', time: Date.now() });
    queued = { toId: b.friends.id, id: operationId, packet }; assert.equal((await a.client.queueEnvelope(queued)).queued, true); await a.client.queueEnvelope(queued); assert.equal(server.mail.size, 1);
    const stored = [...server.mail.values()][0], bytes = await readFile(server.mailPath(stored.fromId, stored.id), 'utf8'); assert(!bytes.includes('Private offline contents')); assert(!JSON.stringify(server.accounts.get(a.friends.id)).includes('PrivateKey'));
    const unrelated = await c.client.mailbox(); assert.equal(unrelated.items.length, 0); const fakeAck = await c.client.ack([{ fromId: a.friends.id, id: operationId }]); assert.equal(fakeAck.acknowledged, 0); assert.equal(server.mail.size, 1);
  });
  await check('A server restart preserves queued ciphertext and recipient-only acknowledgements', async () => {
    const port = address.port; await server.close(); server = new HostedService({ statePath, tls, registrationToken: token }); address = await server.start({ port });
    assert.equal((await rawRequest(refusedRequest)).status, 409);
    b.client = new HostedClient({ url, friends: b.friends, caPem, certificateSha256 }); clients.push(b.client); await b.client.connect(); const inbox = await b.client.mailbox(); assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0].payload.id, operationId);
    await assert.rejects(b.client.api('POST', '/v1/mailbox/ack', { items: [{ fromId: a.friends.id, id: operationId }, { fromId: 'invalid', id: operationId }] }), error => error.status === 400); assert.equal(server.mail.size, 1);
    const capacity = server.maxReceiptItems; server.maxReceiptItems = server.receipts.size; await assert.rejects(b.client.ack(inbox.items), error => error.status === 429); assert.equal(server.mail.size, 1); server.maxReceiptItems = capacity;
    const message = await b.friends.direct.receive({ type: 'direct', fromId: a.friends.id, packet: inbox.items[0].payload.packet }); assert.equal(b.friends.direct.history(a.friends.id).at(-1).text, 'Private offline contents');
    await b.client.queueEnvelope({ toId: a.friends.id, id: randomBytes(16).toString('hex'), direction: 'reply', replyTo: operationId, packet: message.packet }); await b.client.ack(inbox.items); assert.equal((await b.client.mailbox()).items.length, 0);
    const reply = (await a.client.mailbox()).items[0]; assert.equal(reply.payload.replyTo, operationId); const decoded = a.friends.direct.open(a.friends.contacts.get(b.friends.id), reply.payload.packet); assert.equal(decoded.ok, true); assert.equal(decoded.id, messageId); await a.client.ack([reply]);
    assert.equal((await a.client.messageStatus([operationId])).items[0].status, 'acknowledged');
  });
  await check('Mailbox quotas reject extra entries and unaccepted or blocked senders cannot enqueue', async () => {
    const packet = a.friends.direct.seal(a.friends.contacts.get(b.friends.id), { kind: 'text', id: randomBytes(16).toString('hex'), text: 'Quota check', time: Date.now() }); server.maxMailItems = 1;
    await a.client.queueEnvelope({ toId: b.friends.id, id: randomBytes(16).toString('hex'), packet }); await assert.rejects(a.client.queueEnvelope({ toId: b.friends.id, id: randomBytes(16).toString('hex'), packet }), error => error.status === 429);
    await b.client.friendBlock(a.friends.id); assert.equal(server.mail.size, 0); await assert.rejects(a.client.queueEnvelope({ toId: b.friends.id, id: randomBytes(16).toString('hex'), packet })); assert.equal((await a.client.directory('User B')).accounts.length, 0);
    await b.client.friendUnblock(a.friends.id); await assert.rejects(a.client.queueEnvelope({ toId: b.friends.id, id: randomBytes(16).toString('hex'), packet }));
  });
  await writeFile(resolve('.test-results/hosted-services-results.json'), JSON.stringify({ checks, https: true, localCertificateAuthority: true, sameComputer: true }, null, 2));
} finally { for (const client of clients) client.close(); for (const account of accounts) account.close(); await server.close(); }
