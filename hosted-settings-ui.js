const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const labels = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', offline: 'Offline' };

function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function actionButton(label, action, run) { const node = element('button', 'button small', label); node.type = 'button'; node.dataset.hostedAction = action; node.onclick = run; return node; }

export function setupHostedSettings({ toast = () => {}, api = window.stringChat } = {}) {
  const form = document.getElementById('settings-form'), friendsDialog = document.getElementById('friends-dialog');
  if (!form || !friendsDialog) throw new Error('As configurações e o painel de amigos precisam estar disponíveis.');
  let status = { connected: false, url: '', autoConnect: false, caFingerprint: '' }, contacts = [], busy = false, busyMessage = '', directoryBusy = false, searchResults = [], epoch = 0, disposed = false, urlDirty = false, autoDirty = false;
  const settings = element('section', 'hosted-settings'); settings.id = 'hosted-settings';
  settings.innerHTML = '<div class="hosted-section-heading"><div><span class="eyebrow">CONEXÃO OPCIONAL</span><h3>Seu servidor, seus amigos.</h3></div><span id="hosted-connection-badge" class="hosted-status-badge">Desconectado</span></div><p class="small-note">Use um servidor próprio para encontrar amigos e entregar mensagens mesmo quando a outra pessoa estiver offline. O modo P2P continua disponível.</p><label for="hosted-url">Endereço HTTPS do servidor</label><input id="hosted-url" type="url" placeholder="https://chat.seu-dominio.com" autocomplete="url" maxlength="500"><label for="hosted-registration-token">Token para o primeiro cadastro</label><input id="hosted-registration-token" type="password" autocomplete="off" maxlength="512" placeholder="Fornecido por quem administra o servidor"><p class="small-note">Só é necessário para cadastrar uma identidade nova. O token não entra nas configurações salvas.</p><label class="hosted-check"><input id="hosted-auto-connect" type="checkbox">Conectar automaticamente ao abrir o programa</label><div class="hosted-settings-actions"><button id="hosted-connect" class="button primary small" type="button">Conectar</button><button id="hosted-disconnect" class="button small" type="button">Desconectar</button><button id="hosted-choose-ca" class="button small" type="button">Certificado de confiança</button></div><p id="hosted-ca-status" class="small-note"></p><p id="hosted-settings-status" class="hosted-inline-status" role="status"></p><p id="hosted-settings-error" class="dialog-error" role="alert"></p>';
  form.insertBefore(settings, form.querySelector('#settings-error') || form.querySelector('button[type=submit]'));

  const directory = element('section', 'hosted-directory'); directory.id = 'hosted-directory';
  directory.innerHTML = '<div class="hosted-section-heading"><div><span class="eyebrow">NO SEU SERVIDOR</span><h3>Encontre sua companhia.</h3></div><span id="hosted-directory-connection" class="hosted-status-badge">Desconectado</span></div><p id="hosted-directory-hint" class="small-note">Conecte um servidor nas configurações para pesquisar pessoas por aqui.</p><form id="hosted-search-form"><label for="hosted-search">Buscar no diretório</label><div class="hosted-search-row"><input id="hosted-search" type="search" maxlength="64" placeholder="Nome ou identificação do amigo" autocomplete="off"><button id="hosted-search-button" type="submit" class="button small">Buscar</button></div></form><p id="hosted-directory-error" class="dialog-error" role="alert"></p><p id="hosted-directory-state" class="small-note" role="status"></p><div id="hosted-pending-list" class="hosted-person-list"></div><div id="hosted-search-results" class="hosted-person-list"></div>';
  const list = friendsDialog.querySelector('#friends-list'); friendsDialog.insertBefore(directory, list?.previousElementSibling || list || null);
  const $ = id => document.getElementById(id);

  function render() {
    if (disposed) return;
    $('hosted-connection-badge').textContent = status.connected ? 'Conectado' : 'Desconectado'; $('hosted-connection-badge').dataset.connected = String(!!status.connected);
    $('hosted-directory-connection').textContent = status.connected ? 'Conectado' : 'Desconectado'; $('hosted-directory-connection').dataset.connected = String(!!status.connected);
    if (!urlDirty) $('hosted-url').value = status.url || '';
    if (!autoDirty) $('hosted-auto-connect').checked = !!status.autoConnect;
    $('hosted-connect').disabled = busy; $('hosted-disconnect').disabled = busy || !status.connected; $('hosted-choose-ca').disabled = busy;
    $('hosted-search').disabled = !status.connected || directoryBusy; $('hosted-search-button').disabled = !status.connected || directoryBusy;
    $('hosted-settings-status').textContent = busy ? busyMessage : status.connected ? 'Conectado a ' + status.url : status.url ? 'Servidor salvo: ' + status.url : 'O modo P2P segue disponível.';
    $('hosted-ca-status').textContent = status.caFingerprint ? 'Certificado de confiança selecionado · SHA-256 ' + status.caFingerprint : 'O certificado do servidor é verificado com as autoridades de confiança do sistema.';
    $('hosted-directory-hint').textContent = status.connected ? 'Pesquise as pessoas cadastradas em ' + status.url + '.' : 'Conecte um servidor nas configurações para pesquisar pessoas por aqui.';
    const pending = contacts.filter(person => person.hostedServer === status.url && ['incoming', 'outgoing'].includes(person.status));
    $('hosted-pending-list').replaceChildren();
    if (status.connected && pending.length) { $('hosted-pending-list').append(element('h4', '', 'Pedidos de amizade')); for (const person of pending) $('hosted-pending-list').append(personRow(person)); }
    $('hosted-search-results').replaceChildren();
    if (status.connected) for (const person of searchResults) $('hosted-search-results').append(personRow({ ...person, ...contacts.find(value => value.id === person.id && value.hostedServer === status.url) }));
  }

  function personRow(person) {
    const row = element('article', 'hosted-person'); row.dataset.hostedId = person.id;
    const avatar = element('span', 'hosted-person-avatar', String(person.name || 'Amigo').trim().split(/\s+/).slice(0, 2).map(value => value[0] || '').join('').toLocaleUpperCase()); avatar.setAttribute('aria-hidden', 'true');
    const info = element('div', 'hosted-person-info'), name = element('strong', '', String(person.name || 'Amigo').slice(0, 32)), detail = element('span', '', person.status === 'incoming' ? 'Quer ser seu amigo' : person.status === 'outgoing' ? 'Pedido enviado' : person.status === 'blocked' ? 'Bloqueado' : person.status === 'friend' ? labels[person.presence] || 'Amigo' : 'Perfil neste servidor');
    info.append(name, detail, element('small', 'hosted-person-id', person.id)); const actions = element('div', 'hosted-person-actions');
    const add = (label, action, primary = false) => { const button = actionButton(label, action, () => friendAction(action, person.id)); if (primary) button.classList.add('primary'); button.disabled = directoryBusy; actions.append(button); };
    if (person.status === 'incoming') add('Aceitar', 'accept', true);
    else if (person.status === 'blocked') add('Desbloquear', 'unblock');
    else if (!['outgoing', 'friend'].includes(person.status)) add('Adicionar', 'request', true);
    if (['friend', 'incoming', 'outgoing'].includes(person.status)) add(person.status === 'incoming' ? 'Recusar' : 'Remover', 'remove');
    if (person.status !== 'blocked') add('Bloquear', 'block');
    row.append(avatar, info, actions); return row;
  }

  async function loadContacts() { if (typeof api.getFriends === 'function') { const snapshot = await api.getFriends(); contacts = Array.isArray(snapshot.contacts) ? snapshot.contacts.filter(value => validId(value.id)) : []; } render(); }
  async function refresh() { const value = await api.hostedStatus(); if (disposed) return; applyStatus(value); await loadContacts(); return value; }
  function applyStatus(value) {
    if (!value || typeof value !== 'object') return;
    const previous = status.url; status = { ...status, connected: value.connected === true, url: typeof value.url === 'string' ? value.url.slice(0, 500) : status.url, autoConnect: value.autoConnect === true, caFingerprint: typeof value.caFingerprint === 'string' ? value.caFingerprint.slice(0, 128) : '' };
    if (!status.connected || previous !== status.url) { epoch++; searchResults = []; $('hosted-directory-state').textContent = ''; }
    if (value.error) $('hosted-settings-error').textContent = String(value.error).slice(0, 240); render();
  }
  async function connect() {
    if (busy) return; $('hosted-settings-error').textContent = '';
    let url; try { const parsed = new URL($('hosted-url').value.trim()); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw Error(); url = parsed.origin; } catch { $('hosted-settings-error').textContent = 'Informe um endereço HTTPS sem senha, caminho ou parâmetros.'; return; }
    const registrationToken = $('hosted-registration-token').value, autoConnect = $('hosted-auto-connect').checked; busy = true; busyMessage = 'Conectando ao seu servidor…'; render();
    try { const value = await api.hostedConnect({ url, registrationToken, autoConnect }); $('hosted-registration-token').value = ''; urlDirty = false; autoDirty = false; if (value) applyStatus(value); await refresh(); toast('Conectado ao seu servidor.'); }
    catch (error) { $('hosted-settings-error').textContent = error.message || 'Não foi possível conectar ao servidor.'; }
    finally { busy = false; render(); }
  }
  $('hosted-connect').onclick = connect;
  $('hosted-url').oninput = () => { urlDirty = true; };
  $('hosted-auto-connect').onchange = () => { autoDirty = true; };
  $('hosted-disconnect').onclick = async () => { if (busy) return; busy = true; busyMessage = 'Encerrando a conexão com o servidor…'; render(); $('hosted-settings-error').textContent = ''; try { await api.hostedDisconnect(); $('hosted-registration-token').value = ''; await refresh(); toast('Conexão com o servidor encerrada.'); } catch (error) { $('hosted-settings-error').textContent = error.message; } finally { busy = false; render(); } };
  $('hosted-choose-ca').onclick = async () => { if (busy) return; $('hosted-settings-error').textContent = ''; try { const value = await api.hostedChooseCA(); if (value?.caFingerprint) status.caFingerprint = value.caFingerprint; await refresh(); } catch (error) { $('hosted-settings-error').textContent = error.message; } };
  settings.addEventListener('keydown', event => { if (event.key === 'Enter' && ['hosted-url', 'hosted-registration-token'].includes(event.target.id)) { event.preventDefault(); connect(); } });
  document.getElementById('settings-dialog')?.addEventListener('close', () => { $('hosted-registration-token').value = ''; });
  $('hosted-search-form').onsubmit = async event => {
    event.preventDefault(); if (!status.connected || directoryBusy) return; const query = $('hosted-search').value.trim(); $('hosted-directory-error').textContent = '';
    if (query.length < 2) { $('hosted-directory-error').textContent = 'Digite pelo menos dois caracteres para buscar.'; return; }
    const requestEpoch = ++epoch; directoryBusy = true; render(); $('hosted-directory-state').textContent = 'Buscando pessoas…';
    try { const result = await api.hostedDirectory(query); if (disposed || requestEpoch !== epoch) return; const rows = Array.isArray(result) ? result : result?.accounts || result?.users || result?.results || []; searchResults = rows.filter(value => validId(value?.id)).slice(0, 20); $('hosted-directory-state').textContent = searchResults.length ? `${searchResults.length} ${searchResults.length === 1 ? 'perfil encontrado' : 'perfis encontrados'}.` : 'Nenhuma pessoa encontrada. Tente outro nome.'; }
    catch (error) { if (requestEpoch === epoch) { searchResults = []; $('hosted-directory-state').textContent = ''; $('hosted-directory-error').textContent = error.message; } }
    finally { directoryBusy = false; render(); }
  };
  async function friendAction(action, id) {
    if (!status.connected || directoryBusy || !validId(id)) return; directoryBusy = true; render(); $('hosted-directory-error').textContent = '';
    try { await api.hostedFriendAction({ action, id }); await loadContacts(); toast(action === 'request' ? 'Pedido de amizade enviado.' : action === 'accept' ? 'Amizade aceita.' : action === 'block' ? 'Pessoa bloqueada.' : action === 'unblock' ? 'Bloqueio removido. Envie um novo pedido para retomar a amizade.' : 'Contato removido.'); }
    catch (error) { $('hosted-directory-error').textContent = error.message; }
    finally { directoryBusy = false; render(); }
  }
  const unsubscriptions = [];
  if (typeof api.onHostedStatus === 'function') unsubscriptions.push(api.onHostedStatus(value => { if (!disposed) { applyStatus(value); loadContacts().catch(() => {}); } }));
  if (typeof api.onFriends === 'function') unsubscriptions.push(api.onFriends(value => { if (!disposed) { contacts = Array.isArray(value.contacts) ? value.contacts.filter(person => validId(person.id)) : []; render(); } }));
  refresh().catch(error => { $('hosted-settings-error').textContent = error.message; });
  return { refresh, render, close() { disposed = true; epoch++; for (const unsubscribe of unsubscriptions) if (typeof unsubscribe === 'function') unsubscribe(); } };
}
