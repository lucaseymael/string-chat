export const PRESENCE_STATUSES = Object.freeze(['online', 'idle', 'dnd', 'invisible']);

export function normalizePresence(value = {}, { strict = false } = {}) {
  if (strict && (!value || typeof value !== 'object' || !PRESENCE_STATUSES.includes(value.status))) throw new Error('Escolha um estado de presença válido.');
  if (strict && value.statusText !== undefined && typeof value.statusText !== 'string') throw new Error('O texto de status precisa ser um texto.');
  const status = PRESENCE_STATUSES.includes(value?.status) ? value.status : 'online';
  const statusText = typeof value?.statusText === 'string' ? value.statusText.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 128) : '';
  return { status, statusText };
}

export function publicPresence(value) {
  const own = normalizePresence(value);
  return own.status === 'invisible' ? { presence: 'offline', statusText: '' } : { presence: own.status, statusText: own.statusText };
}

export function remotePresence(value) {
  return { presence: ['online', 'idle', 'dnd'].includes(value?.presence) ? value.presence : 'offline', statusText: value?.presence === 'offline' ? '' : normalizePresence(value).statusText };
}
