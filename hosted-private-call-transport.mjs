import { createDecipheriv, randomBytes } from 'node:crypto';
import { verifyHostedSignature } from './hosted-service.mjs';

const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const terminal = new Set(['end', 'decline']);

/** Short-lived encrypted RPC. A server queue acknowledgement never confirms a call. */
export class HostedPrivateCallTransport {
  constructor({ client, friends, privateCalls = friends?.privateCalls, timeoutMs = 28000 }) {
    if (!client || !friends || !privateCalls) throw Error('Configuração da chamada hospedada inválida.');
    Object.assign(this, { client, friends, privateCalls }); this.timeoutMs = Math.max(50, Math.min(28000, timeoutMs));
    this.pending = new Map(); this.replies = new Map(); this.receiving = new Map(); this.closed = false;
  }
  contact(id) {
    if (this.closed) throw Error('O transporte da chamada foi encerrado.');
    const value = this.friends.verified(id);
    if (value.hostedServer !== this.client.url || !value.sharedKey) throw Error('O amigo não está disponível neste servidor.');
    return { ...value };
  }
  outgoing(contact, packet) {
    if (!packet || typeof packet.d !== 'string' || packet.d.length > 16000) throw Error('Sinalização da chamada inválida.');
    const n = Buffer.from(packet.n || '', 'base64url'), t = Buffer.from(packet.t || '', 'base64url');
    if (n.length !== 12 || t.length !== 16) throw Error('Sinalização da chamada inválida.');
    const cipher = createDecipheriv('aes-256-gcm', this.privateCalls._key(contact), n); cipher.setAuthTag(t);
    const value = JSON.parse(Buffer.concat([cipher.update(Buffer.from(packet.d, 'base64url')), cipher.final()]).toString('utf8'));
    if (value.fromId !== this.friends.id || value.toId !== contact.id || !validId(value.callId) || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce || '') || Math.abs(Date.now() - value.time) > 60000 || !['offer', 'accept', 'connected', ...terminal].includes(value.kind)) throw Error('Sinalização da chamada inválida.');
    return value;
  }
  verify(item) {
    const payload = verifyHostedSignature(item.envelope, 'stringchat-hosted-mail-v1'), contact = this.contact(item.fromId);
    if (item.envelope.id !== contact.id || item.envelope.identity !== contact.identity || payload.fromId !== contact.id || payload.toId !== this.friends.id || payload.id !== item.id || !validId(item.id) || payload.transportType !== 'private-call' || !['request', 'reply'].includes(payload.direction) || payload.direction === 'reply' && !validId(payload.replyTo) || !Number.isFinite(payload.createdAt) || !Number.isFinite(payload.expiresAt) || payload.expiresAt > payload.createdAt + 35000 || payload.createdAt > Date.now() + 5000) throw Error('A identidade da chamada não pôde ser confirmada.');
    return { payload, contact };
  }
  request(endpoint, envelope) {
    let contact, command;
    try { if (envelope?.type !== 'private-call' || envelope.fromId !== this.friends.id) throw Error('Sinalização da chamada inválida.'); contact = this.contact(endpoint.id); command = this.outgoing(contact, envelope.packet); } catch (error) { return Promise.reject(error); }
    const id = randomBytes(16).toString('hex'), createdAt = Date.now(), expiresAt = Math.min(createdAt + 30000, command.kind === 'offer' ? command.expiresAt : Infinity);
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) return Promise.reject(Error('O convite da chamada expirou.'));
    return new Promise((resolve, reject) => {
      const record = { id, contact, command, resolve, reject, expiresAt, terminal: terminal.has(command.kind), queued: false };
      this.pending.set(id, record);
      record.timer = setTimeout(() => { if (!this.pending.delete(id)) return; reject(Error('O amigo não confirmou a chamada a tempo.')); if (!record.terminal) this.client.cancelMailbox([id]).catch(() => {}); }, Math.min(this.timeoutMs, record.terminal ? 2500 : Infinity, expiresAt - createdAt)); record.timer.unref?.();
      (async () => {
        if (record.terminal) {
          const previous = [...this.pending.values()].filter(value => value !== record && value.contact.id === contact.id && value.command.callId === command.callId && !value.terminal);
          for (const value of previous) { this.pending.delete(value.id); clearTimeout(value.timer); value.reject(Error('A chamada foi encerrada.')); }
          if (previous.length) await this.client.cancelMailbox(previous.map(value => value.id));
        }
        await this.client.queueEnvelope({ toId: contact.id, id, packet: envelope.packet, transportType: 'private-call', createdAt, expiresAt }); record.queued = true;
        if (!this.pending.has(id) && !record.terminal) await this.client.cancelMailbox([id]);
      })().catch(error => { if (this.pending.delete(id)) { clearTimeout(record.timer); reject(error); } });
    });
  }
  async receive(item) {
    const key = item.fromId + ':' + item.id;
    if (this.receiving.has(key)) return this.receiving.get(key);
    const task = this._receive(item); this.receiving.set(key, task);
    try { return await task; } finally { this.receiving.delete(key); }
  }
  async _receive(item) {
    const { payload, contact } = this.verify(item);
    if (payload.direction !== 'request') throw Error('Direção da chamada inválida.');
    if (payload.expiresAt <= Date.now()) { await this.client.ack([item]); return; }
    for (const [key, value] of this.replies) if (value.expiresAt <= Date.now()) this.replies.delete(key);
    const key = contact.id + ':' + item.id;
    let cached = this.replies.get(key);
    if (!cached) {
      if (this.replies.size >= 512) throw Error('Muitas solicitações de chamada.');
      let command; try { command = this.privateCalls._open(contact, payload.packet); } catch { await this.client.ack([item]); return; }
      let response;
      try { response = await this.privateCalls.receive({ type: 'private-call', fromId: contact.id, packet: payload.packet }); }
      catch { response = this.privateCalls._reply(contact, command, { kind: 'ended', reason: 'failed' }); }
      if (this.contact(contact.id).sharedKey !== contact.sharedKey || response?.type !== 'private-call-reply' || response.fromId !== this.friends.id) throw Error('A chamada mudou durante a confirmação.');
      cached = { id: randomBytes(16).toString('hex'), packet: response.packet, expiresAt: payload.expiresAt }; this.replies.set(key, cached);
    }
    if (cached.expiresAt > Date.now()) await this.client.queueEnvelope({ toId: contact.id, id: cached.id, packet: cached.packet, direction: 'reply', replyTo: item.id, transportType: 'private-call', expiresAt: cached.expiresAt });
    await this.client.ack([item]);
  }
  async tryReceipt(item) {
    const { payload, contact } = this.verify(item);
    if (payload.direction !== 'reply') throw Error('Direção da confirmação inválida.');
    const record = this.pending.get(payload.replyTo);
    if (!record || payload.expiresAt <= Date.now()) { await this.client.ack([item]); return false; }
    if (record.contact.id !== contact.id || record.contact.identity !== contact.identity || record.contact.sharedKey !== contact.sharedKey) throw Error('A identidade da confirmação mudou.');
    const decoded = this.privateCalls._open(contact, payload.packet);
    if (decoded.callId !== record.command.callId || decoded.nonce !== record.command.nonce) throw Error('Confirmação de outra chamada.');
    await this.client.ack([item]);
    if (!this.pending.delete(record.id)) return false;
    clearTimeout(record.timer); record.resolve({ type: 'private-call-reply', fromId: contact.id, packet: payload.packet }); return true;
  }
  close() {
    if (this.closed) return Promise.resolve(); this.closed = true;
    const ids = [];
    for (const record of this.pending.values()) { clearTimeout(record.timer); record.reject(Error('O transporte da chamada foi encerrado.')); if (!record.terminal) ids.push(record.id); }
    this.pending.clear(); this.replies.clear();
    return ids.length ? this.client.cancelMailbox(ids).catch(() => {}) : Promise.resolve();
  }
}
