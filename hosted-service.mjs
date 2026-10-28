import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanAvatar } from './profile.js';
import { remotePresence } from './presence-policy.mjs';

const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const pair = (a, b) => [a, b].sort().join(':');
const error = (status, message = 'Não foi possível concluir esta solicitação.') => Object.assign(new Error(message), { status });
export { error as hostedError };
const utf8 = value => Buffer.from(value, 'utf8');

export function hostedPublicKey(value, kind = 'ed25519') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{50,100}$/.test(value)) throw error(401);
  const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== kind || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== value) throw error(401);
  return key;
}

export function verifyHostedSignature(envelope, purpose) {
  if (!envelope || envelope.purpose !== purpose || !id(envelope.id) || typeof envelope.payload !== 'string' || Buffer.byteLength(envelope.payload) > 140000 || typeof envelope.signature !== 'string' || envelope.signature.length > 100) throw error(401);
  if (!verify(null, utf8(purpose + '\n' + envelope.payload), hostedPublicKey(envelope.identity), Buffer.from(envelope.signature, 'base64url'))) throw error(401);
  let payload; try { payload = JSON.parse(envelope.payload); } catch { throw error(400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error(400);
  return payload;
}

function readState(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.product !== 'String Chat hosted' || value.version !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.relationships) || !Array.isArray(value.mail)) throw Error();
    return value;
  } catch (e) { if (e.code === 'ENOENT') return { product: 'String Chat hosted', version: 1, accounts: [], relationships: [], mail: [], receipts: [], seen: [], sequence: 0 }; throw new Error('O estado do servidor está inválido e foi preservado. Restaure uma cópia de segurança.'); }
}

export class HostedService extends EventEmitter {
  constructor({ statePath, tls, registrationToken, extensions = [], maxAccounts = 1000, maxMailboxBytes = 64 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024, maxMailItems = 2000, maxTotalMailItems = 100000, maxReceiptItems = 100000, maxPendingNonces = 100000, maxRequestsPerMinute = 2400, mailTtlMs = 7 * 86400000 }) {
    super();
    if (!statePath || !tls || typeof registrationToken !== 'string' || registrationToken.length < 24) throw new Error('Configure armazenamento, TLS e um token de cadastro com pelo menos 24 caracteres.');
    Object.assign(this, { statePath, tls, extensions, maxAccounts, maxMailboxBytes, maxTotalBytes, maxMailItems, maxTotalMailItems, maxReceiptItems, maxPendingNonces, maxRequestsPerMinute, mailTtlMs });
    this.tokenHash = Buffer.from(hash(registrationToken), 'hex'); this.mailDir = join(dirname(statePath), 'hosted-mail'); this.rates = new Map(); this.pendingDeletePaths = [];
    const saved = readState(statePath); this.sequence = Number.isSafeInteger(saved.sequence) ? saved.sequence : 0;
    this.accounts = new Map(); this.relationships = new Map(); this.mail = new Map(); this.receipts = new Map(); this.seen = new Map(); this.nonceCounts = new Map();
    for (const account of saved.accounts) {
      if (!id(account?.id) || this.accounts.has(account.id)) throw new Error('Conta inválida no armazenamento do servidor.');
      hostedPublicKey(account.identity); hostedPublicKey(account.exchange, 'x25519');
      this.accounts.set(account.id, { ...account, blocked: (Array.isArray(account.blocked) ? account.blocked : []).filter(id).slice(0, 1000), lastSeen: 0 });
    }
    for (const relationship of saved.relationships) if (id(relationship?.fromId) && id(relationship?.toId) && ['pending', 'friend'].includes(relationship.status)) this.relationships.set(pair(relationship.fromId, relationship.toId), relationship);
    for (const item of saved.mail) { if (!id(item?.id) || !id(item.fromId) || !id(item.toId) || !Number.isSafeInteger(item.sequence) || !Number.isFinite(item.bytes) || item.bytes < 1 || !/^[a-f0-9]{64}$/.test(item.digest || '')) throw new Error('Fila do servidor inválida.'); this.mail.set(item.fromId + ':' + item.id, item); }
    for (const receipt of saved.receipts || []) if (id(receipt?.id) && id(receipt.fromId) && id(receipt.toId) && ['acknowledged', 'expired'].includes(receipt.status)) this.receipts.set(receipt.fromId + ':' + receipt.id, receipt);
    for (const [nonce, time] of saved.seen || []) { const expiry = saved.nonceFormat === 2 ? time : time + 180000; if (typeof nonce === 'string' && /^[a-f0-9]{32}:[a-f0-9]{32}$/.test(nonce) && Number.isFinite(expiry) && expiry > Date.now()) { this.seen.set(nonce, expiry); const actor = nonce.slice(0, 32); this.nonceCounts.set(actor, (this.nonceCounts.get(actor) || 0) + 1); } }
    mkdirSync(this.mailDir, { recursive: true, mode: 0o700 }); this.prune();
  }

  mailPath(sender, itemId) { if (!id(sender) || !id(itemId)) throw error(400); return join(this.mailDir, sender + '-' + itemId + '.json'); }
  persist() {
    const accounts = [...this.accounts.values()].map(({ lastSeen, ...account }) => account);
    const value = { product: 'String Chat hosted', version: 1, nonceFormat: 2, sequence: this.sequence, accounts, relationships: [...this.relationships.values()], mail: [...this.mail.values()], receipts: [...this.receipts.values()], seen: [...this.seen] };
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 }); writeFileSync(this.statePath + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(this.statePath + '.tmp', this.statePath);
    for (const path of this.pendingDeletePaths.splice(0)) try { unlinkSync(path); } catch {}
  }
  prune() {
    const now = Date.now();
    for (const [key, item] of this.receipts) if (now - item.createdAt > this.mailTtlMs) this.receipts.delete(key);
    for (const [key, item] of this.mail) if (now - item.createdAt > this.mailTtlMs || item.expiresAt && item.expiresAt <= now) { this.mail.delete(key); this.recordExpired(key, item); this.pendingDeletePaths.push(this.mailPath(item.fromId, item.id)); }
    this.pruneNonces(now);
  }
  recordExpired(key, item) { if (this.receipts.size < this.maxReceiptItems || this.receipts.has(key)) this.receipts.set(key, { id: item.id, fromId: item.fromId, toId: item.toId, createdAt: Date.now(), status: 'expired' }); }
  pruneNonces(now = Date.now()) { for (const [key, expiry] of this.seen) if (expiry <= now) { this.seen.delete(key); const actor = key.slice(0, 32), remaining = (this.nonceCounts.get(actor) || 1) - 1; if (remaining) this.nonceCounts.set(actor, remaining); else this.nonceCounts.delete(actor); } }
  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.server) throw new Error('Servidor já iniciado.');
    this.server = https.createServer({ ...this.tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (req, res) => this.handle(req, res));
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, resolve); });
    this.server.on('error', e => this.emit('warning', { code: e.code || 'SERVER_ERROR' })); this.persist(); return this.server.address();
  }
  async close() { if (!this.server) return; for (const extension of this.extensions) await extension.close?.(); this.persist(); const server = this.server; this.server = null; await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }); }
  rate(address) {
    const now = Date.now(); let value = this.rates.get(address);
    if (!value || now - value.start > 60000) { value = { start: now, count: 0 }; this.rates.set(address, value); }
    if (++value.count > this.maxRequestsPerMinute) throw error(429, 'Muitas solicitações. Aguarde um minuto.');
    for (const [key, entry] of this.rates) if (now - entry.start > 60000) this.rates.delete(key);
  }
  async body(req) {
    const chunks = []; let size = 0;
    for await (const bytes of req) { size += bytes.length; if (size > 160000) throw error(413, 'Solicitação grande demais.'); chunks.push(bytes); }
    return Buffer.concat(chunks).toString('utf8');
  }
  authenticate(req, raw) {
    const header = req.headers['x-stringchat-auth']; if (typeof header !== 'string' || header.length > 6000) throw error(401);
    let envelope; try { envelope = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { throw error(401); }
    const auth = verifyHostedSignature(envelope, 'stringchat-hosted-http-v1');
    if (auth.id !== envelope.id || auth.identity !== envelope.identity || auth.method !== req.method || auth.path !== req.url || auth.bodyHash !== hash(raw) || !/^[a-f0-9]{32}$/.test(auth.nonce || '') || !Number.isFinite(auth.time) || Math.abs(Date.now() - auth.time) > 90000) throw error(401);
    const account = this.accounts.get(auth.id);
    if (account && (account.identity !== auth.identity || account.exchange !== auth.exchange)) throw error(401);
    if (!account && !(req.method === 'POST' && req.url === '/v1/register')) throw error(401);
    if (!account) { hostedPublicKey(auth.exchange, 'x25519'); let registration; try { registration = JSON.parse(raw); } catch { throw error(400); } if (typeof registration?.registrationToken !== 'string' || !timingSafeEqual(Buffer.from(hash(registration.registrationToken), 'hex'), this.tokenHash)) throw error(403); }
    this.pruneNonces(); const nonce = auth.id + ':' + auth.nonce; if (this.seen.has(nonce)) throw error(409, 'Solicitação já processada.');
    if (this.seen.size >= this.maxPendingNonces || (this.nonceCounts.get(auth.id) || 0) >= 4096) throw error(429, 'Aguarde antes de enviar mais solicitações.');
    this.seen.set(nonce, auth.time + 90001); this.nonceCounts.set(auth.id, (this.nonceCounts.get(auth.id) || 0) + 1);
    if (account) account.lastSeen = Date.now(); return { auth, account };
  }
  publicAccount(account, showPresence = false) {
    const online = account.lastSeen > Date.now() - 35000 && account.presence !== 'offline';
    return { id: account.id, name: account.name, avatar: account.avatar, identity: account.identity, exchange: account.exchange, ...(showPresence ? { online, presence: online ? account.presence : 'offline', statusText: online ? account.statusText : '' } : {}) };
  }
  blocked(a, b) { return this.accounts.get(a)?.blocked.includes(b) || this.accounts.get(b)?.blocked.includes(a); }
  friend(a, b) { return !this.blocked(a, b) && this.relationships.get(pair(a, b))?.status === 'friend'; }
  deletePairMail(a, b) { for (const [key, item] of this.mail) if (pair(item.fromId, item.toId) === pair(a, b)) { this.mail.delete(key); this.pendingDeletePaths.push(this.mailPath(item.fromId, item.id)); } }

  async handle(req, res) {
    const reply = (status, value) => { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
    let authenticated = false;
    try {
      this.rate(req.socket.remoteAddress || 'unknown');
      if (req.method === 'GET' && req.url === '/health') { reply(200, { product: 'String Chat hosted', version: 1 }); return; }
      const raw = await this.body(req), { auth, account } = this.authenticate(req, raw); authenticated = true; let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { throw error(400); } if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400); }
      this.prune(); const value = await this.route(req.method, new URL(req.url, 'https://local.invalid'), auth, account, body); this.persist(); reply(200, value);
    } catch (e) { if (authenticated) try { this.persist(); } catch {} reply(Number.isInteger(e.status) ? e.status : 500, { error: Number.isInteger(e.status) ? e.message : 'Falha ao processar a solicitação.' }); }
  }

  async route(method, url, auth, account, body) {
    if (method === 'POST' && url.pathname === '/v1/register') {
      if (!account) {
        if (typeof body.registrationToken !== 'string' || !timingSafeEqual(Buffer.from(hash(body.registrationToken), 'hex'), this.tokenHash)) throw error(403);
        if (this.accounts.size >= this.maxAccounts) throw error(429, 'O servidor atingiu o limite de contas.');
        account = { id: auth.id, identity: auth.identity, exchange: auth.exchange, name: '', avatar: '', blocked: [], presence: 'offline', statusText: '', createdAt: Date.now() }; this.accounts.set(auth.id, account);
      }
      account.name = String(body.name || 'Amigo').trim().slice(0, 32) || 'Amigo'; account.avatar = cleanAvatar(body.avatar); account.lastSeen = Date.now();
      return { account: this.publicAccount(account, true), protocol: 1 };
    }
    if (method === 'POST' && url.pathname === '/v1/presence') { Object.assign(account, remotePresence(body)); if (typeof body.name === 'string') account.name = body.name.trim().slice(0, 32) || 'Amigo'; if (Object.hasOwn(body, 'avatar')) account.avatar = cleanAvatar(body.avatar); return { ok: true }; }
    if (method === 'GET' && url.pathname === '/v1/directory') {
      const query = (url.searchParams.get('query') || '').trim().slice(0, 64).toLocaleLowerCase(); if (query.length < 2) throw error(400, 'Digite pelo menos dois caracteres.');
      return { accounts: [...this.accounts.values()].filter(value => value.id !== account.id && !this.blocked(account.id, value.id) && (value.name.toLocaleLowerCase().includes(query) || value.id === query)).slice(0, 20).map(value => this.publicAccount(value)) };
    }
    if (method === 'GET' && /^\/v1\/identities\/[a-f0-9]{32}$/.test(url.pathname)) { const target = this.accounts.get(url.pathname.split('/').at(-1)); if (!target || this.blocked(account.id, target.id)) throw error(404); return this.publicAccount(target, this.friend(account.id, target.id)); }
    if (method === 'GET' && url.pathname === '/v1/state') {
      const contacts = [];
      for (const relationship of this.relationships.values()) if ([relationship.fromId, relationship.toId].includes(account.id)) {
        const otherId = relationship.fromId === account.id ? relationship.toId : relationship.fromId, other = this.accounts.get(otherId); if (!other || this.blocked(account.id, otherId)) continue;
        contacts.push({ ...this.publicAccount(other, relationship.status === 'friend'), status: relationship.status === 'friend' ? 'friend' : relationship.fromId === account.id ? 'outgoing' : 'incoming' });
      }
      return { account: this.publicAccount(account, true), contacts, blocked: account.blocked.map(value => this.accounts.get(value)).filter(Boolean).map(value => ({ id: value.id, name: value.name, avatar: value.avatar })), serverTime: Date.now() };
    }
    if (method === 'POST' && url.pathname.startsWith('/v1/friends/')) {
      const otherId = body.id, other = this.accounts.get(otherId); if (!id(otherId) || !other || otherId === account.id) throw error(400);
      const key = pair(account.id, otherId), action = url.pathname.split('/').at(-1), relationship = this.relationships.get(key);
      const count = who => [...this.relationships.values()].filter(value => [value.fromId, value.toId].includes(who)).length + this.accounts.get(who).blocked.length;
      if (action === 'block') { if (!account.blocked.includes(otherId)) { if (!relationship && count(account.id) >= 64) throw error(429); account.blocked.push(otherId); } this.relationships.delete(key); this.deletePairMail(account.id, otherId); return { ok: true }; }
      if (action === 'unblock') { account.blocked = account.blocked.filter(value => value !== otherId); return { ok: true }; }
      if (this.blocked(account.id, otherId)) throw error(403);
      if (action === 'request') { if (!relationship && (count(account.id) >= 64 || count(otherId) >= 64)) throw error(429); if (!relationship) this.relationships.set(key, { fromId: account.id, toId: otherId, status: 'pending', createdAt: Date.now() }); return { ok: true }; }
      if (action === 'accept') { if (!relationship || relationship.toId !== account.id || relationship.status !== 'pending') throw error(403); relationship.status = 'friend'; return { ok: true }; }
      if (action === 'remove') { this.relationships.delete(key); this.deletePairMail(account.id, otherId); return { ok: true }; }
      throw error(404);
    }
    if (method === 'POST' && url.pathname === '/v1/mailbox') {
      const envelope = body.envelope, payload = verifyHostedSignature(envelope, 'stringchat-hosted-mail-v1');
      if (envelope.id !== account.id || envelope.identity !== account.identity || payload.fromId !== account.id || !id(payload.id) || !id(payload.toId) || !this.friend(account.id, payload.toId) || !['request', 'reply'].includes(payload.direction) || payload.direction === 'reply' && !id(payload.replyTo) || !Number.isFinite(payload.createdAt)) throw error(403);
      const transportType = payload.transportType || 'direct'; if (!['direct', 'private-call'].includes(transportType)) throw error(400);
      if (transportType === 'private-call' && (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + 35000 || payload.expiresAt > payload.createdAt + 35000 || payload.createdAt > Date.now() + 5000)) throw error(400, 'A sinalização da chamada expirou.');
      const packet = payload.packet; if (!packet || typeof packet.n !== 'string' || typeof packet.t !== 'string' || typeof packet.d !== 'string' || packet.d.length > 90000 || Buffer.from(packet.n, 'base64url').length !== 12 || Buffer.from(packet.t, 'base64url').length !== 16) throw error(400);
      const key = account.id + ':' + payload.id, existing = this.mail.get(key) || this.receipts.get(key); if (existing) { if (existing.toId !== payload.toId) throw error(409); if (existing.status !== 'expired') return { queued: !!this.mail.get(key), acknowledged: existing.status === 'acknowledged', id: payload.id }; this.receipts.delete(key); }
      const data = JSON.stringify(envelope), bytes = Buffer.byteLength(data), inbox = [...this.mail.values()].filter(item => item.toId === payload.toId);
      if (this.mail.size >= this.maxTotalMailItems || inbox.length >= this.maxMailItems || inbox.reduce((total, item) => total + item.bytes, 0) + bytes > this.maxMailboxBytes || [...this.mail.values()].reduce((total, item) => total + item.bytes, 0) + bytes > this.maxTotalBytes) throw error(429, 'A fila de mensagens está cheia. Tente novamente mais tarde.');
      const file = this.mailPath(account.id, payload.id); writeFileSync(file + '.tmp', data, { mode: 0o600 }); renameSync(file + '.tmp', file);
      this.mail.set(key, { id: payload.id, fromId: account.id, toId: payload.toId, transportType, ...(transportType === 'private-call' ? { expiresAt: payload.expiresAt } : {}), createdAt: Date.now(), sequence: ++this.sequence, bytes, digest: hash(data) }); return { queued: true, acknowledged: false, id: payload.id };
    }
    if (method === 'GET' && url.pathname === '/v1/mailbox') {
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0), limit = Math.max(1, Math.min(64, Number(url.searchParams.get('limit')) || 32));
      const items = [...this.mail.values()].filter(item => item.toId === account.id && item.sequence > after && this.friend(item.fromId, item.toId)).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(item => { const value = readFileSync(this.mailPath(item.fromId, item.id), 'utf8'); if (hash(value) !== item.digest) throw error(500); return { id: item.id, fromId: item.fromId, sequence: item.sequence, envelope: JSON.parse(value) }; });
      return { items, next: items.at(-1)?.sequence || after };
    }
    if (method === 'POST' && url.pathname === '/v1/mailbox/ack') {
      if (!Array.isArray(body.items) || body.items.length > 512 || body.items.some(value => !id(value?.fromId) || !id(value?.id))) throw error(400); let acknowledged = 0;
      const eligible = new Map(); for (const value of body.items) { const key = value.fromId + ':' + value.id, item = this.mail.get(key); if (item?.toId === account.id) eligible.set(key, item); }
      if (this.receipts.size + [...eligible.keys()].filter(key => !this.receipts.has(key)).length > this.maxReceiptItems) throw error(429, 'Aguarde a liberação do histórico de confirmações.');
      for (const [key, item] of eligible) { this.mail.delete(key); this.receipts.set(key, { id: item.id, fromId: item.fromId, toId: item.toId, createdAt: Date.now(), status: 'acknowledged' }); this.pendingDeletePaths.push(this.mailPath(item.fromId, item.id)); acknowledged++; }
      return { ok: true, acknowledged };
    }
    if (method === 'POST' && url.pathname === '/v1/mailbox/status') {
      if (!Array.isArray(body.ids) || body.ids.length > 512 || body.ids.some(value => !id(value))) throw error(400);
      return { items: body.ids.map(value => ({ id: value, status: this.mail.has(account.id + ':' + value) ? 'queued' : this.receipts.get(account.id + ':' + value)?.status || 'unknown' })) };
    }
    if (method === 'POST' && url.pathname === '/v1/mailbox/cancel') {
      if (!Array.isArray(body.ids) || body.ids.length > 64 || body.ids.some(value => !id(value))) throw error(400); let cancelled = 0;
      for (const value of body.ids) { const key = account.id + ':' + value, item = this.mail.get(key); if (!item || item.transportType !== 'private-call') continue; this.mail.delete(key); this.recordExpired(key, item); this.pendingDeletePaths.push(this.mailPath(item.fromId, item.id)); cancelled++; }
      return { ok: true, cancelled };
    }
    for (const extension of this.extensions) { const value = await extension.route({ service: this, method, url, auth, account, body }); if (value !== undefined) return value; }
    throw error(404, 'Recurso não encontrado.');
  }
}
