import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { publicPresence } from './presence-policy.mjs';
import { cleanAvatar } from './profile.js';
import { verifyHostedSignature, hostedPublicKey } from './hosted-service.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function normalizeHostedUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Informe o endereço HTTPS do seu servidor.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use um endereço HTTPS sem senha, caminho ou parâmetros.');
  return url.origin;
}

export class HostedClient extends EventEmitter {
  constructor({ url, friends, registrationToken = '', statePath, caPem, certificateSha256 = '', timeoutMs = 10000, pollIntervalMs = 1000 }) {
    super(); this.url = normalizeHostedUrl(url); this.friends = friends; this.registrationToken = registrationToken; this.timeoutMs = timeoutMs; this.pollIntervalMs = Math.max(250, pollIntervalMs); this.connected = false;
    this.statePath = statePath || join(dirname(friends.path), 'hosted-client-' + hash(this.url).slice(0, 12) + '.json');
    try { this.localState = JSON.parse(readFileSync(this.statePath, 'utf8')); if (!this.localState || typeof this.localState !== 'object' || Array.isArray(this.localState)) throw Error(); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('O estado local de hospedagem está inválido e foi preservado.'); this.localState = { version: 1 }; }
    const pin = certificateSha256.replaceAll(':', '').toLowerCase(); if (pin && !/^[a-f0-9]{64}$/.test(pin)) throw new Error('A impressão digital do certificado precisa conter um SHA-256 válido.');
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(caPem ? { ca: caPem } : {}), checkServerIdentity(host, cert) { const failure = tls.checkServerIdentity(host, cert); if (failure) return failure; if (pin && hash(cert.raw) !== pin) return new Error('O certificado do servidor mudou. Confira a impressão digital.'); } });
  }
  saveLocal() { mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 }); writeFileSync(this.statePath + '.tmp', JSON.stringify(this.localState), { mode: 0o600 }); renameSync(this.statePath + '.tmp', this.statePath); }
  signedRequest(method, path, body) {
    const raw = body === undefined ? '' : JSON.stringify(body), identity = this.friends.publicIdentity();
    if (Buffer.byteLength(raw) > 160000) throw new Error('Solicitação grande demais.');
    const signed = this.friends.signForService('stringchat-hosted-http-v1', { ...identity, method, path, nonce: randomBytes(16).toString('hex'), time: Date.now(), bodyHash: hash(raw) });
    return { raw, authentication: Buffer.from(JSON.stringify(signed)).toString('base64url') };
  }
  api(method, path, body) {
    if (!/^\/v1\/[a-z0-9/?=&%_.:!~*'()+-]+$/i.test(path) || path.length > 2048) return Promise.reject(new Error('Caminho de servidor inválido.'));
    const signed = this.signedRequest(method, path, body);
    return new Promise((resolve, reject) => {
      const request = https.request(this.url + path, { method, agent: this.agent, headers: { 'x-stringchat-auth': signed.authentication, 'content-type': 'application/json', 'content-length': Buffer.byteLength(signed.raw) } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', data => { bytes += data.length; if (bytes > 12 * 1024 * 1024) { response.destroy(new Error('Resposta grande demais.')); return; } chunks.push(data); });
        response.on('error', reject); response.on('end', () => { let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('Resposta do servidor inválida.')); return; } if (response.statusCode < 200 || response.statusCode >= 300) { reject(Object.assign(new Error(String(value.error || 'O servidor recusou a solicitação.').slice(0, 240)), { status: response.statusCode })); return; } resolve(value); });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('O servidor não respondeu.'))); request.on('error', reject); request.end(signed.raw);
    });
  }
  async connect() {
    this.friends.persist();
    const value = await this.api('POST', '/v1/register', { registrationToken: this.registrationToken, name: this.friends.getName(), avatar: this.friends.getAvatar() });
    this.registrationToken = ''; await this.setPresence(); await this.state(); this.connected = true; this.emit('status', { connected: true, url: this.url }); return value;
  }
  async setPresence(value = this.friends.presence) { return this.api('POST', '/v1/presence', { ...(value.status ? publicPresence(value) : value), ...(typeof value.name === 'string' ? { name: value.name } : {}), ...(Object.hasOwn(value, 'avatar') ? { avatar: value.avatar } : {}) }); }
  async state() { const value = await this.api('GET', '/v1/state'); this.synchronizeContacts(value); return value; }
  synchronizeContacts(value) {
    if (!Array.isArray(value.contacts) || !Array.isArray(value.blocked) || value.contacts.length + value.blocked.length > 64) throw new Error('Lista de contatos do servidor inválida.');
    const present = new Set(), next = new Map(this.friends.contacts);
    for (const raw of value.contacts) {
      if (!validId(raw.id) || raw.id === this.friends.id || present.has(raw.id) || !['friend', 'incoming', 'outgoing'].includes(raw.status)) throw new Error('Contato do servidor inválido.');
      hostedPublicKey(raw.identity); hostedPublicKey(raw.exchange, 'x25519'); present.add(raw.id);
      const previous = this.friends.contacts.get(raw.id); if (previous?.status === 'blocked') continue;
      if (previous?.needsVerification && previous.status === 'friend') throw new Error('Revalide o contato antigo com um novo código antes de usá-lo no servidor.');
      if (previous?.identity && (previous.identity !== raw.identity || previous.exchange !== raw.exchange)) throw new Error('A identidade de um contato mudou. Confirme um novo código antes de continuar.');
      const contact = { ...previous, id: raw.id, identity: raw.identity, exchange: raw.exchange, name: String(raw.name || 'Amigo').slice(0, 32), avatar: cleanAvatar(raw.avatar), status: raw.status, online: raw.online === true, presence: ['online', 'idle', 'dnd'].includes(raw.presence) ? raw.presence : 'offline', statusText: String(raw.statusText || '').slice(0, 128), group: null, hostedServer: this.url, needsVerification: false };
      contact.sharedKey = this.friends.sharedKey(contact); next.set(raw.id, contact);
    }
    for (const raw of value.blocked) { if (!validId(raw.id) || raw.id === this.friends.id || present.has(raw.id)) throw new Error('Contato do servidor inválido.'); const previous = this.friends.contacts.get(raw.id); next.set(raw.id, { ...previous, id: raw.id, name: String(raw.name || 'Amigo').slice(0, 32), avatar: cleanAvatar(raw.avatar), status: 'blocked', online: false, presence: 'offline', statusText: '', group: null, hostedServer: this.url }); present.add(raw.id); }
    for (const [id, contact] of next) if (contact.hostedServer === this.url && !present.has(id) && contact.status !== 'blocked') next.delete(id);
    if (next.size > 64) throw new Error('O limite de contatos locais foi atingido.');
    this.friends.contacts = next;
    this.friends.persist(); this.friends.changed();
  }
  directory(query) { return this.api('GET', '/v1/directory?query=' + encodeURIComponent(String(query || '').trim())); }
  identity(id) { if (!validId(id)) return Promise.reject(new Error('Contato inválido.')); return this.api('GET', '/v1/identities/' + id); }
  async friendAction(action, id) { if (!['request', 'accept', 'remove', 'block', 'unblock'].includes(action) || !validId(id)) throw new Error('Ação de amizade inválida.'); const value = await this.api('POST', '/v1/friends/' + action, { id }); if (action === 'unblock' && this.friends.contacts.get(id)?.status === 'blocked') this.friends.contacts.delete(id); await this.state(); return value; }
  friendRequest(id) { return this.friendAction('request', id); }
  friendAccept(id) { return this.friendAction('accept', id); }
  friendRemove(id) { return this.friendAction('remove', id); }
  friendBlock(id) { return this.friendAction('block', id); }
  friendUnblock(id) { return this.friendAction('unblock', id); }
  async queueEnvelope({ toId, id, packet, direction = 'request', replyTo = null, createdAt = Date.now(), transportType = 'direct', expiresAt }) {
    if (!validId(toId) || !validId(id) || !['request', 'reply'].includes(direction) || direction === 'reply' && !validId(replyTo)) throw new Error('Envelope inválido.');
    const contact = this.friends.verified(toId);
    if (contact.hostedServer !== this.url) throw new Error('A amizade não pertence a este servidor.');
    const envelope = this.friends.signForService('stringchat-hosted-mail-v1', { id, fromId: this.friends.id, toId, direction, replyTo, createdAt, transportType, ...(expiresAt ? { expiresAt } : {}), packet });
    const result = await this.api('POST', '/v1/mailbox', { envelope }); if (this.friends.contacts.get(toId)?.sharedKey !== contact.sharedKey || this.friends.contacts.get(toId)?.status !== 'friend') throw new Error('A amizade mudou durante o envio.'); return result;
  }
  async mailbox({ after = 0, limit = 32 } = {}) {
    const result = await this.api('GET', '/v1/mailbox?after=' + Math.max(0, Math.floor(after)) + '&limit=' + Math.max(1, Math.min(64, Math.floor(limit))));
    if (!Array.isArray(result.items)) throw new Error('Fila de mensagens inválida.');
    for (const item of result.items) {
      const payload = verifyHostedSignature(item.envelope, 'stringchat-hosted-mail-v1'), contact = this.friends.verified(item.fromId);
      if (contact.hostedServer !== this.url || !contact.identity || item.envelope.identity !== contact.identity || item.envelope.id !== item.fromId || payload.fromId !== item.fromId || payload.toId !== this.friends.id || payload.id !== item.id || !validId(item.id) || !Number.isSafeInteger(item.sequence) || item.sequence <= 0) throw new Error('A identidade de uma mensagem não pôde ser verificada.');
      item.payload = payload;
    }
    return result;
  }
  ack(items) { if (!Array.isArray(items)) return Promise.reject(new Error('Confirmação inválida.')); return this.api('POST', '/v1/mailbox/ack', { items: items.map(({ fromId, id }) => ({ fromId, id })) }); }
  messageStatus(ids) { return this.api('POST', '/v1/mailbox/status', { ids }); }
  cancelMailbox(ids) { return this.api('POST', '/v1/mailbox/cancel', { ids }); }
  async request(endpoint, envelope, command) {
    if (envelope.type === 'direct') { if (!this.directTransport) throw new Error('A entrega hospedada ainda não foi conectada.'); return this.directTransport.request(endpoint, envelope, command); }
    if (envelope.type === 'private-call') { if (!this.extraTransport) throw new Error('As chamadas privadas hospedadas não foram conectadas.'); return this.extraTransport.request(endpoint, envelope); }
    if (envelope.type === 'presence') { const snapshot = await this.state(), contact = snapshot.contacts.find(item => item.id === endpoint.id); if (!contact || contact.status !== 'friend') throw new Error('Amizade indisponível.'); return { type: 'presence', ...contact, group: null }; }
    if (envelope.type === 'accepted') { await this.friendAccept(endpoint.id); return { ok: true, ...publicPresence(this.friends.presence) }; }
    if (envelope.type === 'removed') { await this.friendRemove(endpoint.id); return { ok: true }; }
    throw new Error('Esta ação não está disponível neste transporte.');
  }
  async poll() { if (this.directTransport) return this.directTransport.poll(); return this.mailbox(); }
  startPolling(callback = () => {}) {
    if (this.timer) return;
    this.timer = setInterval(async () => { if (this.polling || !this.connected) return; this.polling = true; try { if (Date.now() - (this.lastState || 0) > 10000) { await this.state(); this.lastState = Date.now(); } const value = await this.poll(); callback(value); } catch (error) { this.emit('warning', { message: error.message }); } finally { this.polling = false; } }, this.pollIntervalMs); this.timer.unref();
  }
  close() { clearInterval(this.timer); this.timer = null; this.connected = false; this.directTransport?.close?.(); const closing = Promise.resolve(this.extraTransport?.close?.()).catch(() => {}).finally(() => this.agent.destroy()); this.emit('status', { connected: false, url: this.url }); return closing; }
}
