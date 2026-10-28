import net from 'node:net';
import { DirectMessages } from './direct-messages.mjs';
import { cleanAvatar } from './profile.js';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, generateKeyPairSync, createPublicKey, createPrivateKey, sign, verify, diffieHellman, hkdfSync, createHash } from 'node:crypto';
import { listInterfaces, makeWire, parseInvite } from './room-service.mjs';
import { normalizePresence, publicPresence, remotePresence } from './presence-policy.mjs';

const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const validKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
const AUTH_DOMAIN = 'stringchat-friends-v2';
const deny = () => new Error('Não foi possível concluir esta solicitação.');
const endpointFields = value => Object.fromEntries(['id', 'host', 'port', 'key', 'identity', 'exchange'].map(key => [key, value[key]]));

function publicKey(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{50,100}$/.test(value)) throw new Error('Código de identidade inválido.');
  const key = createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== expected || key.export({ type: 'spki', format: 'der' }).toString('base64url') !== value) throw new Error('Código de identidade inválido.');
  return key;
}

function keyPair(type, saved, label) {
  if (saved?.[label + 'PrivateKey']) {
    const privateKey = createPrivateKey({ key: Buffer.from(saved[label + 'PrivateKey'], 'base64url'), type: 'pkcs8', format: 'der' });
    const publicKey = createPublicKey(privateKey);
    if (privateKey.asymmetricKeyType !== type || publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') !== saved[label + 'PublicKey']) throw new Error('A identidade local está inválida. Restaure uma cópia de segurança do perfil.');
    return { privateKey, publicKey };
  }
  if (saved?.[label + 'PublicKey']) throw new Error('A chave privada local está ausente. Restaure uma cópia de segurança do perfil.');
  return generateKeyPairSync(type);
}

const exportPublic = key => key.export({ type: 'spki', format: 'der' }).toString('base64url');
const exportPrivate = key => key.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
const signatureBytes = value => Buffer.from([AUTH_DOMAIN, value.fromId, value.toId, value.identity, value.nonce, String(value.time), value.replyTo || '', value.payload].join('\n'));

export function parseFriendLink(value) {
  let url; try { url = new URL(String(value).trim()); } catch { throw new Error('Cole o código de amigo completo.'); }
  const id = url.searchParams.get('id');
  const test = new URL('stringchat://join');
  for (const key of ['host', 'port', 'key']) test.searchParams.set(key, url.searchParams.get(key) || '');
  test.searchParams.set('room', id || '');
  if (url.protocol !== 'stringchat:' || url.hostname !== 'friend' || !validId(id)) throw new Error('Código de amigo inválido.');
  const endpoint = parseInvite(test.toString()), identity = url.searchParams.get('identity'), exchange = url.searchParams.get('exchange');
  if (identity || exchange) { publicKey(identity, 'ed25519'); publicKey(exchange, 'x25519'); }
  return { id, host: endpoint.host, port: endpoint.port, key: endpoint.token, ...(identity && exchange ? { identity, exchange } : {}) };
}

export class FriendsService extends EventEmitter {
  constructor({ path, getName, getGroup, getAvatar = () => '' }) {
    super(); Object.assign(this, { path, getName, getGroup, getAvatar });
    this.contacts = new Map(); this.sockets = new Set(); this.seen = new Map(); this.stopped = false;
    try { this.saved = JSON.parse(readFileSync(path, 'utf8')); } catch { this.saved = {}; }
    this.id = validId(this.saved.id) ? this.saved.id : randomBytes(16).toString('hex');
    this.key = validKey(this.saved.key) ? this.saved.key : randomBytes(32).toString('base64url');
    this.signing = keyPair('ed25519', this.saved.authentication, 'signing');
    this.exchange = keyPair('x25519', this.saved.authentication, 'exchange');
    this.presence = normalizePresence(this.saved.presence);
    for (const contact of Array.isArray(this.saved.contacts) ? this.saved.contacts.slice(0, 64) : []) {
      if (!validId(contact?.id) || !['friend', 'incoming', 'outgoing', 'blocked'].includes(contact.status)) continue;
      let keysValid = false;
      try { publicKey(contact.identity, 'ed25519'); publicKey(contact.exchange, 'x25519'); keysValid = true; } catch {}
      const item = { ...contact, online: false, group: null, presence: 'offline', statusText: '', needsVerification: !keysValid };
      delete item.sharedKey;
      if (keysValid) item.sharedKey = this.sharedKey(item);
      this.contacts.set(item.id, item);
    }
    this.direct = new DirectMessages({ path: join(dirname(path), 'private-messages.json'), getIdentity: () => ({ id: this.id, key: this.key }), getContact: id => this.contacts.get(id), request: (endpoint, payload) => this.request(endpoint, payload), onChange: () => this.changed(), onMessage: message => this.emit('direct-message', { ...message, silent: this.presence.status === 'dnd' }) });
  }

  sharedKey(contact) {
    const shared = diffieHellman({ privateKey: this.exchange.privateKey, publicKey: publicKey(contact.exchange, 'x25519') });
    if (shared.every(byte => byte === 0)) throw deny();
    const peers = [{ id: this.id, identity: exportPublic(this.signing.publicKey) }, { id: contact.id, identity: contact.identity }].sort((a, b) => a.id.localeCompare(b.id));
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(JSON.stringify(peers)), Buffer.from('stringchat-private-pair-v2'), 32)).toString('base64url');
  }

  persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const contacts = [...this.contacts.values()].map(({ online, group, presence, statusText, sharedKey, ...contact }) => contact);
    const authentication = { version: 2, signingPrivateKey: exportPrivate(this.signing.privateKey), signingPublicKey: exportPublic(this.signing.publicKey), exchangePrivateKey: exportPrivate(this.exchange.privateKey), exchangePublicKey: exportPublic(this.exchange.publicKey) };
    writeFileSync(this.path + '.tmp', JSON.stringify({ id: this.id, key: this.key, port: this.port, presence: this.presence, authentication, contacts }));
    renameSync(this.path + '.tmp', this.path);
  }

  publicIdentity() { return { id: this.id, identity: exportPublic(this.signing.publicKey), exchange: exportPublic(this.exchange.publicKey) }; }
  signForService(purpose, payload) {
    if (!/^stringchat-[a-z0-9-]{1,48}$/.test(purpose)) throw new Error('Finalidade de assinatura inválida.');
    const value = JSON.stringify(payload); if (typeof value !== 'string' || Buffer.byteLength(value) > 140000) throw deny();
    return { id: this.id, identity: exportPublic(this.signing.publicKey), purpose, payload: value, signature: sign(null, Buffer.from(purpose + '\n' + value), this.signing.privateKey).toString('base64url') };
  }

  ownEndpoint() {
    return { id: this.id, host: this.address, port: this.port, key: this.key, identity: exportPublic(this.signing.publicKey), exchange: exportPublic(this.exchange.publicKey), avatar: cleanAvatar(this.getAvatar()), name: String(this.getName() || 'Amigo').slice(0, 32), ...publicPresence(this.presence) };
  }

  code() {
    if (!this.address || !this.port) return '';
    const url = new URL('stringchat://friend'), endpoint = this.ownEndpoint();
    for (const key of ['id', 'host', 'port', 'key', 'identity', 'exchange']) url.searchParams.set(key, String(endpoint[key]));
    return url.toString();
  }

  snapshot() {
    return { id: this.id, code: this.code(), network: this.address || null, presence: { ...this.presence }, contacts: [...this.contacts.values()].map(({ key, host, port, identity, exchange, sharedKey, ...contact }) => ({ ...contact, identityFingerprint: identity ? createHash('sha256').update(identity).digest('hex').slice(0, 24) : null, ...this.direct.summary(contact.id) })) };
  }

  changed() { this.emit('change', this.snapshot()); }
  notice(value) { this.emit('notice', { ...value, silent: this.presence.status === 'dnd' }); }
  setPresence(value) { this.presence = normalizePresence(value, { strict: true }); this.persist(); this.changed(); this.refresh().catch(() => {}); return { ...this.presence }; }
  current(contact) { return this.contacts.get(contact.id) === contact && contact.status === 'friend' && !contact.needsVerification; }
  verified(id) { const contact = this.contacts.get(id); if (!contact || contact.status !== 'friend' || contact.needsVerification || !contact.sharedKey) throw deny(); return contact; }

  async start() {
    const address = listInterfaces()[0]?.address;
    if (!address) { this.persist(); this.changed(); return; }
    this.address = address; this.server = net.createServer(socket => this.acceptSocket(socket));
    const desired = Number.isInteger(this.saved.port) && this.saved.port > 0 && this.saved.port <= 65535 ? this.saved.port : 0;
    await new Promise((resolve, reject) => {
      this.server.once('error', error => { if (error.code === 'EADDRINUSE' && desired) { this.server.once('error', reject); this.server.listen(0, address, resolve); } else reject(error); });
      this.server.listen(desired, address, resolve);
    });
    this.port = this.server.address().port; this.persist(); this.changed();
    this.timer = setInterval(() => this.refresh().catch(() => {}), 12000); this.timer.unref(); this.refresh().catch(() => {});
  }

  seal(toId, message, replyTo = '') {
    const envelope = { type: 'friend-auth', version: 2, fromId: this.id, toId, identity: exportPublic(this.signing.publicKey), nonce: randomBytes(16).toString('hex'), time: Date.now(), replyTo, payload: JSON.stringify(message) };
    if (Buffer.byteLength(envelope.payload) > 140000) throw deny();
    envelope.signature = sign(null, signatureBytes(envelope), this.signing.privateKey).toString('base64url'); return envelope;
  }

  open(envelope, { identity, fromId, replyTo, allowRequest = false } = {}) {
    if (envelope?.type !== 'friend-auth' || envelope.version !== 2 || !validId(envelope.fromId) || envelope.toId !== this.id || typeof envelope.payload !== 'string' || Buffer.byteLength(envelope.payload) > 140000 || !/^[a-f0-9]{32}$/.test(envelope.nonce || '') || !Number.isFinite(envelope.time) || Math.abs(Date.now() - envelope.time) > 60000 || typeof envelope.replyTo !== 'string' || typeof envelope.signature !== 'string' || envelope.signature.length > 100) throw deny();
    if (identity && envelope.identity !== identity || fromId && envelope.fromId !== fromId || replyTo !== undefined && envelope.replyTo !== replyTo) throw deny();
    if (!verify(null, signatureBytes(envelope), publicKey(envelope.identity, 'ed25519'), Buffer.from(envelope.signature, 'base64url'))) throw deny();
    const key = envelope.fromId + ':' + envelope.nonce;
    if (this.seen.has(key)) throw deny();
    const message = JSON.parse(envelope.payload);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw deny();
    if (message.type === 'request' && allowRequest) { if (message.from?.id !== envelope.fromId || message.from?.identity !== envelope.identity) throw deny(); }
    else if (!identity || message.fromId !== undefined && message.fromId !== envelope.fromId) throw deny();
    this.seen.set(key, Date.now()); for (const [nonce, time] of this.seen) if (time < Date.now() - 120000 || this.seen.size > 4096) this.seen.delete(nonce);
    return message;
  }

  async request(endpoint, payload) {
    publicKey(endpoint.identity, 'ed25519');
    const outgoing = this.seal(endpoint.id, payload);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port }); this.sockets.add(socket); let settled = false;
      const done = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.end(); if (error) reject(error); else resolve(result); };
      const timer = setTimeout(() => { done(new Error('Amigo indisponível. Confiram a rede Radmin e o Firewall.')); socket.destroy(); }, 4000);
      const wire = makeWire(socket, endpoint.key, result => { try { done(null, this.open(result, { identity: endpoint.identity, fromId: endpoint.id, replyTo: outgoing.nonce })); } catch { done(deny()); } }, () => done(new Error('Não foi possível falar com este amigo.')));
      socket.once('connect', () => wire.send(outgoing)); socket.once('close', () => { this.sockets.delete(socket); if (!settled) done(new Error('O amigo encerrou a conexão.')); });
    });
  }

  acceptSocket(socket) {
    if (this.sockets.size >= 128 || this.stopped) { socket.destroy(); return; }
    this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); const timer = setTimeout(() => socket.destroy(), 6000); let handled = false;
    const wire = makeWire(socket, this.key, envelope => {
      if (handled) { socket.destroy(); return; } handled = true; clearTimeout(timer);
      let message;
      try {
        const existing = this.contacts.get(envelope?.fromId);
        if (existing?.status === 'blocked') throw deny();
        message = this.open(envelope, { identity: existing?.identity, fromId: envelope?.fromId, replyTo: '', allowRequest: true });
        if (message.type !== 'request' && (!existing || existing.needsVerification || existing.identity !== envelope.identity)) throw deny();
      } catch { if (validId(envelope?.fromId) && /^[a-f0-9]{32}$/.test(envelope?.nonce || '')) wire.send(this.seal(envelope.fromId, { error: deny().message }, envelope.nonce)); socket.end(); return; }
      const reply = value => wire.send(this.seal(envelope.fromId, value, envelope.nonce));
      if(message.type==='private-call'){if(!this.privateCalls){reply({error:'Atualize o aplicativo para usar chamadas privadas.'});socket.end();return;}this.privateCalls.receive(message).then(reply).catch(()=>reply({error:deny().message})).finally(()=>socket.end());return;}
      if (message.type === 'direct') { this.direct.receive(message).then(reply).catch(() => reply({ error: deny().message })).finally(() => socket.end()); return; }
      try {
        if (message.type === 'request') this.receiveRequest(message, reply);
        else if (message.type === 'accepted') {
          const contact = this.contacts.get(message.fromId);
          if (!contact || !['outgoing', 'friend'].includes(contact.status) || contact.needsVerification) throw deny();
          contact.status = 'friend'; this.applyPresence(contact, message); this.persist(); this.changed(); reply({ ok: true, ...publicPresence(this.presence) }); this.notice({ kind: 'friend-accepted', name: contact.name });
        } else if (message.type === 'presence') {
          const contact = this.verified(message.fromId); this.applyPresence(contact, message); contact.avatar = cleanAvatar(message.avatar); contact.name = String(message.name || contact.name).slice(0, 32); this.changed();
          reply({ type: 'presence', id: this.id, name: this.getName(), avatar: cleanAvatar(this.getAvatar()), ...publicPresence(this.presence), group: this.presence.status === 'invisible' ? null : this.getGroup() });
        } else if (message.type === 'invite') {
          const contact = this.verified(message.fromId); parseInvite(message.invite); this.notice({ kind: 'group-invite', name: contact.name, invite: message.invite }); reply({ ok: true });
        } else if (message.type === 'removed') {
          this.verified(message.fromId); this.contacts.delete(message.fromId); this.persist(); this.changed(); reply({ ok: true });
        } else throw deny();
      } catch { reply({ error: deny().message }); }
      socket.end();
    }, () => {});
    socket.once('close', () => clearTimeout(timer));
  }

  applyPresence(contact, value) {
    const visible = remotePresence(value);
    Object.assign(contact, visible, { online: visible.presence !== 'offline' });
    if (!contact.online) contact.group = null;
  }

  receiveRequest(message, reply) {
    const endpoint = message.from;
    if (!validId(endpoint?.id) || endpoint.id === this.id) throw deny();
    const link = new URL('stringchat://friend'); for (const key of ['id', 'host', 'port', 'key', 'identity', 'exchange']) link.searchParams.set(key, String(endpoint[key])); parseFriendLink(link.toString());
    const previous = this.contacts.get(endpoint.id);
    if (previous?.status === 'blocked' || previous && (previous.key !== endpoint.key || previous.identity && previous.identity !== endpoint.identity || previous.exchange && previous.exchange !== endpoint.exchange)) throw deny();
    if (!previous && this.contacts.size >= 64) throw deny();
    const status = !previous?.needsVerification && ['friend', 'outgoing'].includes(previous?.status) ? 'friend' : 'incoming';
    const contact = { ...endpointFields(endpoint), avatar: cleanAvatar(endpoint.avatar), name: String(endpoint.name || 'Amigo').slice(0, 32), status, needsVerification: false, group: null };
    contact.sharedKey = this.sharedKey(contact); this.applyPresence(contact, endpoint); this.contacts.set(endpoint.id, contact); this.persist(); this.changed();
    if (status === 'incoming' && previous?.status !== 'incoming') this.notice({ kind: 'friend-request', name: contact.name });
    reply({ type: 'pending', status, id: this.id, name: this.getName(), avatar: cleanAvatar(this.getAvatar()), ...publicPresence(this.presence) });
  }

  async add(code) {
    const endpoint = parseFriendLink(code);
    if (endpoint.id === this.id) throw new Error('Esse é o seu próprio código.');
    if (!endpoint.identity || !endpoint.exchange) throw new Error('Peça um novo código de amigo no aplicativo atualizado para verificar a identidade.');
    const previous = this.contacts.get(endpoint.id);
    if (previous?.status === 'blocked') throw new Error('Desbloqueie esta pessoa antes de enviar um pedido.');
    if (previous && !previous.needsVerification && (previous.identity !== endpoint.identity || previous.exchange !== endpoint.exchange || previous.key !== endpoint.key)) throw new Error('A identidade desse amigo mudou. Remova o contato e confirme o novo código antes de adicionar novamente.');
    if (!previous && this.contacts.size >= 64) throw new Error('A lista permite até 64 contatos.');
    const reply = await this.request(endpoint, { type: 'request', from: this.ownEndpoint() });
    if (reply.error) throw new Error(reply.error);
    if (reply.id !== endpoint.id || !['friend', 'incoming'].includes(reply.status)) throw deny();
    if (this.contacts.get(endpoint.id)?.status === 'blocked') throw deny();
    const contact = { ...endpoint, avatar: cleanAvatar(reply.avatar), name: String(reply.name || 'Amigo').slice(0, 32), status: reply.status === 'friend' ? 'friend' : 'outgoing', needsVerification: false, group: null };
    contact.sharedKey = this.sharedKey(contact); this.applyPresence(contact, reply); this.contacts.set(endpoint.id, contact); this.persist(); this.changed(); return true;
  }

  async accept(id) {
    const contact = this.contacts.get(id);
    if (!contact || !['incoming', 'friend'].includes(contact.status) || contact.needsVerification) throw new Error('Pedido não encontrado. Peça um novo código de amigo.');
    const reply = await this.request(contact, { type: 'accepted', fromId: this.id, ...publicPresence(this.presence) });
    if (reply.error || this.contacts.get(id) !== contact || contact.status === 'blocked') throw deny();
    contact.status = 'friend'; this.applyPresence(contact, reply); this.persist(); this.changed(); this.refresh().catch(() => {});
  }

  async remove(id) {
    if (!validId(id)) throw new Error('Contato inválido.');
    const contact = this.contacts.get(id); if (!contact) return false;
    if (contact.status === 'blocked') throw new Error('Use Desbloquear para remover um bloqueio.');
    this.contacts.delete(id); this.persist(); this.changed();
    if (!contact.needsVerification) this.request(contact, { type: 'removed', fromId: this.id }).catch(() => {});
    return true;
  }

  async block(id) {
    if (!validId(id) || id === this.id) throw new Error('Contato inválido.');
    const previous = this.contacts.get(id); if (!previous) throw new Error('Contato não encontrado.');
    const contact = { ...previous, status: 'blocked', online: false, group: null, presence: 'offline', statusText: '' }; this.contacts.set(id, contact); this.persist(); this.changed();
    if (!previous.needsVerification) this.request(previous, { type: 'removed', fromId: this.id }).catch(() => {});
    return true;
  }

  async unblock(id) {
    if (!validId(id)) throw new Error('Contato inválido.');
    if (this.contacts.get(id)?.status !== 'blocked') throw new Error('Esse contato não está bloqueado.');
    this.contacts.delete(id); this.persist(); this.changed(); return true;
  }

  async refresh() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      await Promise.all([...this.contacts.values()].filter(c => c.status === 'friend' && !c.needsVerification && !c.hostedServer).map(async contact => {
        try {
          const reply = await this.request(contact, { type: 'presence', fromId: this.id, name: this.getName(), avatar: cleanAvatar(this.getAvatar()), ...publicPresence(this.presence) });
          if (!this.current(contact)) return;
          if (reply.type !== 'presence' || reply.id !== contact.id) throw deny();
          this.applyPresence(contact, reply); contact.group = contact.online ? reply.group : null;
          contact.name = String(reply.name || contact.name).slice(0, 32); contact.avatar = cleanAvatar(reply.avatar);
        } catch { if (this.current(contact)) Object.assign(contact, { online: false, group: null, presence: 'offline', statusText: '' }); }
      }));
      this.changed();
    } finally { this.refreshing = false; }
  }

  async invite(id) {
    const contact = this.verified(id), group = this.getGroup();
    if (!group?.invite) throw new Error('Entre em um grupo antes de convidar.');
    const reply = await this.request(contact, { type: 'invite', fromId: this.id, invite: group.invite });
    if (reply.error || !this.current(contact)) throw deny();
  }

  close() { this.direct.close(); this.stopped = true; clearInterval(this.timer); for (const socket of this.sockets) socket.destroy(); this.server?.close(); }
}
