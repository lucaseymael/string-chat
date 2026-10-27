import { MeshCall, iceConfig } from './rtc.js';
import { Microphone } from './microphone.js';
import { SystemAudio } from './system-audio.js';
import { AppSounds } from './sounds.js';
import {setupFriends}from'./friends-ui.js';
import {setupHome} from './home-ui.js';
import {setupShortcuts} from './shortcuts-ui.js';
import {cleanAvatar,avatarContent,prepareAvatar} from './profile.js';

const $ = id => document.getElementById(id);
const defaults = { name: 'Você', bitrate: 25, fps: 60, resolution: 1080, contentHint: 'motion', noiseMode: 'rnnoise', echoCancellation: true, screenSound: true,screenVolume:100, network: 'lan', iceUrl: '', iceUser: '', icePassword: '' };
let stored = {};
try { stored = window.stringChat?.readSettings() || JSON.parse(localStorage.getItem('stringchat-settings') || '{}') || {}; } catch { /* Storage may be disabled. */ }
const settings = {
  ...defaults,closeToTray:stored.closeToTray===true,theme:stored.theme==='light'?'light':'dark',muteShortcut:typeof stored.muteShortcut==='string'?stored.muteShortcut:'Control+Shift+M',deafenShortcut:typeof stored.deafenShortcut==='string'?stored.deafenShortcut:'Control+Shift+D', avatar:cleanAvatar(stored.avatar),cameraDeviceId:typeof stored.cameraDeviceId==='string'?stored.cameraDeviceId:'', name: typeof stored.name === 'string' ? stored.name.slice(0, 32) || 'Você' : defaults.name,
  bitrate: Number.isFinite(stored.bitrate) ? Math.min(50, Math.max(8, stored.bitrate)) : 25,
  fps: stored.fps === 30 ? 30 : 60, resolution: stored.resolution === 720 ? 720 : 1080,
  contentHint: stored.contentHint === 'detail' ? 'detail' : 'motion', echoCancellation: stored.echoCancellation !== false,
  noiseMode: ['standard', 'off'].includes(stored.noiseMode) ? stored.noiseMode : 'rnnoise',
  screenSound: stored.screenSound !== false,streamPriority:stored.streamPriority==='fluid'?'fluid':'resolution',
  screenVolume:Number.isFinite(stored.screenVolume)?Math.max(0,Math.min(200,stored.screenVolume)):100,
  soundsEnabled:stored.soundsEnabled!==false,soundVolume:Number.isFinite(stored.soundVolume)?Math.max(0,Math.min(100,stored.soundVolume)):35,
  network: ['lan', 'custom'].includes(stored.network) ? stored.network : 'internet',
  iceUrl: typeof stored.iceUrl === 'string' ? stored.iceUrl : '', iceUser: typeof stored.iceUser === 'string' ? stored.iceUser : ''
};
const call = new MeshCall(settings);
const callPeople=document.createElement('div');callPeople.className='call-people';callPeople.hidden=true;$('screen-stage').insertBefore(callPeople,document.querySelector('.stage-footnote'));
const sounds=new AppSounds(()=>settings);
document.addEventListener('click',event=>{if(event.target.closest('button')&&!event.target.closest('button').disabled)sounds.play('click');});
let viewMode='home',home=null,shortcutUI=null,groupWasActive=false;
const tiles = new Map(), audioElements = new Map();
const streamVolumes=new Map(),channelMessages=new Map();let selectedTextChannel='text-geral';
const attachmentUrls=new Map();let attachmentBytes=0,uploadBusy=false;
const attachmentObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){attachmentObserver.unobserve(entry.target);hydrateAttachment(entry.target);}}, {root:$('messages'),rootMargin:'200px'});
let currentOffer = null, sharingBusy = false, micBusy = false, connectingBusy = false, sessionEpoch = 0, statsBusy = false;
let lastChat = 0, currentStats = [], hasMessages = false;
const smallScreen = matchMedia('(max-width:950px)');
let chatVisible = !smallScreen.matches;
let microphone = null, microphonePromise = null;
let systemAudio = null, screenAudioLabel = '',audioRecovery=null,audioFailures=0,audioRecoveryBusy=false,lastAudioError='';
let pendingShare = null;
let cameraBusy=false,cameraEpoch=0,draftAvatar=settings.avatar,avatarBusy=false;
let viewerUrl=null,viewerId=null,viewerSave=null,viewerEpoch=0,pageClosing=false;
const colors = ['#bdcde3','#c7d0e4','#d8cadc','#bfd5df','#d5d4e1'];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const safe = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => (name.trim().split(/\s+/).map(w => [...w][0]).slice(0, 2).join('') || '?').toUpperCase();
const colorFor = id => colors[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length];

function toast(text, error = false) {
  const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = text;
  $('toast-region').append(node);
  while ($('toast-region').children.length > 3) $('toast-region').firstElementChild.remove();
  setTimeout(() => node.remove(), error ? 9000 : 5000);
}
function userError(error) {
  if (error.name === 'NotAllowedError') return 'Permissão não concedida. Autorize o microfone ou a câmera nas permissões do Windows, ou selecione uma tela para compartilhar.';
  if (error.name === 'NotFoundError') return 'Dispositivo não encontrado. Conecte o microfone ou a webcam e tente novamente.';
  if (error.name === 'NotReadableError') return 'O dispositivo está indisponível. Confira se outro aplicativo está usando o microfone, a webcam ou a captura.';
  if (error.name === 'OverconstrainedError') return 'Seu dispositivo não aceitou a qualidade solicitada. Tente reduzir a resolução ou os FPS.';
  return error.message || 'Não foi possível concluir. Tente novamente.';
}
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));

function participantMarkup(member, self = false, status = '') {
  return `<div class="participant-card${self ? ' self' : ''}" data-member="${safe(member.id)}"><span class="participant-mic">${icon(member.mic ? 'mic' : 'mic-off')}</span><span class="avatar">${avatarContent(member,safe)}</span><div class="participant-name">${safe(member.name)}${self ? ' <span>(você)</span>' : ''}</div><span class="participant-status">${safe(status || (member.screen ? 'Compartilhando tela' : member.deafened ? 'Áudio silenciado' : member.mic ? 'Microfone ligado' : 'Microfone desligado'))}</span></div>`;
}
function render() {
  if(pageClosing)return;
  window.stringChat.updateTray({inCall:call.active&&!!call.voiceChannelId,mic:call.meta.mic,deafened:call.deafened});
  const name = call.meta.name;
  $('self-name').textContent = name; $('self-avatar').innerHTML = avatarContent(call.meta,safe);
  $('self-status').textContent = !call.active ? 'Disponível' : call.deafened ? 'Áudio silenciado' : call.meta.mic ? 'Microfone ligado' : 'Microfone desligado';
  const voice=call.room?.channels?.find(c=>c.id===call.voiceChannelId);
  $('room-title').textContent = viewMode==='text'?`# ${call.room?.channels?.find(c=>c.id===selectedTextChannel)?.name||'geral'}`:voice?.name || (call.active?'Escolha um canal de voz':'Seu grupo');
  $('group-title').textContent=call.room?.name||'Seu grupo, sua galera.';
  $('group-subtitle').textContent=call.active?`${1+call.peers.size} pessoas no grupo`:'Crie um grupo ou entre por convite.';
  $('leave-group-button').hidden=!call.externalSignal;
  $('participant-count').textContent = String(1 + call.connected.filter(p=>p.meta.voiceChannelId===call.voiceChannelId).length).padStart(2, '0');
  const members = [...call.peers.values()].filter(p => (p.admitted || p.pc.connectionState !== 'new' && p.pc.signalingState === 'stable') && (!call.externalSignal || p.meta.voiceChannelId===call.voiceChannelId));
  $('participants').innerHTML = participantMarkup(call.meta, true) + members.map(peer => participantMarkup({ ...peer.meta, id: peer.id, name: peer.name }, false, peer.admitted ? '' : 'Conectando…')).join('') + `<button class="participant-card participant-invite" id="participant-invite"><span class="invite-plus">${icon('plus')}</span>Tem lugar pra mais um.</button>`;
  $('participant-invite')?.addEventListener('click', () => openConnect('invite'));
  if(!call.active){$('participants').replaceChildren();$('participant-count').textContent='00';}
  renderGroupChannels();
  document.querySelectorAll('[data-member]').forEach(node => { const avatar = node.querySelector('.avatar'); avatar.style.backgroundColor = colorFor(node.dataset.member); });
  $('quality-resolution').innerHTML = `${settings.resolution}<span>p</span>`;
  $('quality-fps').textContent = `${settings.fps} FPS`; $('quality-bitrate').textContent = `${settings.bitrate} Mbps`;
  $('mic-button').innerHTML = icon(call.meta.mic ? 'mic' : 'mic-off');
  $('mic-button').setAttribute('aria-pressed', String(call.meta.mic));
  $('mic-button').setAttribute('aria-label', call.micOn ? 'Desligar microfone' : 'Ligar microfone');
  $('mic-button').title = `${call.micOn ? 'Desligar' : 'Ligar'} microfone${settings.muteShortcut?' ('+settings.muteShortcut.replaceAll('Control','Ctrl').replaceAll('Super','Win')+')':''}`;
  $('deafen-button').setAttribute('aria-pressed', String(call.deafened));
  $('deafen-button').setAttribute('aria-label', call.deafened ? 'Reativar áudio recebido' : 'Silenciar áudio recebido');
  $('deafen-button').title = (call.deafened ? 'Reativar áudio recebido' : 'Silenciar áudio recebido')+(settings.deafenShortcut?' ('+settings.deafenShortcut.replaceAll('Control','Ctrl').replaceAll('Super','Win')+')':'');
  $('camera-button').classList.toggle('camera-on',!!call.camera);
  $('camera-button').setAttribute('aria-pressed',String(!!call.camera));
  $('camera-button').setAttribute('aria-label',call.camera?'Desligar câmera':'Ligar câmera');
  $('camera-button').title=call.camera?'Desligar câmera':'Ligar câmera';
  $('camera-button').disabled=cameraBusy;
  $('share-button').classList.toggle('sharing', !!call.screen);
  $('share-button').innerHTML = icon('screen') + `<span>${call.screen ? 'Parar transmissão' : 'Compartilhar tela'}</span>`;
  $('share-button').disabled = sharingBusy; $('stage-share').disabled = sharingBusy;
  $('call-status-title').textContent = call.networkStatus==='reconnecting'?'Reconectando ao grupo…':call.connected.length ? 'Conectado por P2P' : call.active ? 'Grupo aberto' : 'Tudo pronto';
  $('call-status-detail').textContent = call.connected.length ? `${call.connected.length} ${call.connected.length === 1 ? 'amigo conectado' : 'amigos conectados'}` : call.active ? 'Aguardando sua galera' : 'Crie um convite para começar';
  $('connection-badge').innerHTML = '<span class="green-dot"></span> ' + (settings.network === 'lan' ? 'P2P · LAN / VPN' : 'P2P · DIRETO');
  const screenCount = (call.screen ? 1 : 0) + call.connected.filter(p => p.meta.screen).length;
  $('stage-state').textContent = screenCount ? `${screenCount === 1 ? 'TRANSMISSÃO' : 'TRANSMISSÕES'} AO VIVO` : call.connected.length ? 'BOA COMPANHIA, CONEXÃO DIRETA' : 'SEU ESPAÇO, SEM LIMITES';
  $('leave-button').disabled = !call.active && !call.mic && !call.screen && !call.camera;
  renderStreams(); updateDuration();
  home?.updateSession({active:call.active,group:call.room?.name,voice:voice?.name,mic:call.meta.mic});
  $('room-nav').classList.toggle('selected',call.active&&viewMode!=='home');$('home-button').classList.toggle('selected',viewMode==='home');
  $('toggle-chat').hidden=viewMode==='home';$('invite-button').innerHTML=icon('plus')+(call.active?'Convidar amigos':'Criar grupo');
}
function renderGroupChannels() {
  const channels=call.active?call.room?.channels||[]:[];
  if(!call.active){$('text-channels').replaceChildren();$('voice-channels').replaceChildren();return;}
  if(!channels.some(c=>c.id===selectedTextChannel&&c.kind==='text')){selectedTextChannel=channels.find(c=>c.kind==='text')?.id||'text-geral';call.textChannelId=selectedTextChannel;renderChatChannel();}
  $('text-channels').innerHTML=channels.filter(c=>c.kind==='text').map(c=>`<button class="channel group-channel ${c.id===selectedTextChannel?'active':''}" data-text-channel="${safe(c.id)}"><span class="hash-mark">#</span><span>${safe(c.name)}</span></button>`).join('');
  const people=[call.meta,...[...call.peers.values()].map(p=>({...p.meta,id:p.id,name:p.name}))];
  $('voice-channels').innerHTML=channels.filter(c=>c.kind==='voice').map(c=>`<button class="channel group-channel ${c.id===call.voiceChannelId?'active':''}" data-voice-channel="${safe(c.id)}">${icon('headphones')}<span>${safe(c.name)}</span><small>${people.filter(p=>p.voiceChannelId===c.id).length}</small></button><div class="channel-members">${people.filter(p=>p.voiceChannelId===c.id).map(p=>`<div class="sidebar-person"><span class="avatar">${avatarContent(p,safe)}</span><span>${safe(p.name)}</span>${icon(p.mic?'mic':'mic-off')}</div>`).join('')}</div>`).join('');
  document.querySelectorAll('[data-text-channel]').forEach(button=>button.onclick=()=>{selectedTextChannel=button.dataset.textChannel;call.textChannelId=selectedTextChannel;renderChatChannel();setViewMode('text');render();});
  document.querySelectorAll('[data-voice-channel]').forEach(button=>button.onclick=async()=>{try{if(button.dataset.voiceChannel!==call.voiceChannelId)await call.changeVoiceChannel(button.dataset.voiceChannel);setViewMode('voice');render();}catch(error){toast(userError(error),true);}});
  document.querySelector('.chat-header h2').textContent=`# ${channels.find(c=>c.id===selectedTextChannel)?.name||'geral'}`;
}
function setViewMode(mode){viewMode=mode;document.querySelector('.app').classList.toggle('text-view',mode==='text');document.querySelector('.app').classList.toggle('home-view',mode==='home');setChatVisible(mode==='text');home?.setActive(mode==='home');if(mode!=='home'){document.querySelector('.room-heading>svg use').setAttribute('href','#i-headphones');document.querySelector('.room-subtitle').textContent='O rolê é por aqui.';}}

function setMedia(element, tracks) {
  const available = tracks.filter(track => track && track.readyState !== 'ended');
  const ids = available.map(track => track.id).join(',');
  if (element.dataset.tracks === ids) return;
  element.dataset.tracks = ids; element.srcObject = available.length ? new MediaStream(available) : null;
  if (available.length) element.play().catch(() => { if (element.tagName === 'VIDEO') showPlayButton(element); });
}
function showPlayButton(video) {
  const tile = video.closest('.stream-tile'); if (!tile || tile.querySelector('.video-play-button')) return;
  const button = document.createElement('button'); button.className = 'video-play-button'; button.textContent = 'Clique para reproduzir a transmissão';
  button.addEventListener('click', async () => { try { await video.play(); button.remove(); } catch (error) { toast(userError(error), true); } }); tile.append(button);
}
function renderStreams() {
  if(pageClosing)return;
  const active = [];
  if (call.screen) active.push({ kind:'screen',id: call.id, name: `${call.meta.name} · Sua tela`, video: call.screen, audio: null, self: true });
  if(call.camera)active.push({kind:'camera',id:`${call.id}-camera`,peerId:call.id,name:`${call.meta.name} · Sua câmera`,video:call.camera,audio:null,self:true});
  for (const peer of call.peers.values()) {
    const sameVoice=!call.externalSignal || call.voiceChannelId && peer.meta.voiceChannelId===call.voiceChannelId;
    if (peer.admitted && peer.meta.screen && sameVoice) active.push({ kind:'screen',id: peer.id, name: `${peer.name} · Tela`, video: peer.tracks.get(1), audio: peer.meta.screenAudio ? peer.tracks.get(2) : null, self: false });
    if(peer.admitted&&peer.meta.camera&&sameVoice)active.push({kind:'camera',id:`${peer.id}-camera`,peerId:peer.id,name:`${peer.name} · Câmera`,video:peer.tracks.get(3),audio:null,self:false});
    const mic = peer.tracks.get(0);
    if (mic && peer.admitted) {
      if (!audioElements.has(peer.id)) {
        const element = document.createElement('audio'); element.autoplay = true; element.hidden = true;
        document.body.append(element); audioElements.set(peer.id, element);
      }
      const element = audioElements.get(peer.id); element.muted = call.deafened || !sameVoice; setMedia(element, [mic]);
    }
  }
  for (const [id, element] of audioElements) if (!call.peers.has(id)) { element.srcObject = null; element.remove(); audioElements.delete(id); }
  for (const [id, tile] of tiles) if (!active.some(item => item.id === id)) { tile.querySelector('video').srcObject = null; clearTimeout(tile.controlsTimer);tile.remove(); tiles.delete(id); }
  for (const item of active) {
    if (!tiles.has(item.id)) {
      const tile = document.createElement('article'); tile.className = 'stream-tile'; tile.dataset.id = item.id;tile.dataset.kind=item.kind;tile.dataset.peer=item.peerId||item.id;
      tile.innerHTML = `<video autoplay playsinline></video><div class="stream-label">${icon(item.kind==='camera'?'camera':'screen')}<span class="stream-owner"></span><span class="stream-quality"></span>${item.kind==='camera'?'':item.self?'<span class="preview-muted">Prévia sem som</span>':`<label class="stream-volume-label">${icon('volume')}<input class="stream-volume" type="range" min="0" max="100" value="${streamVolumes.get(item.id)??100}" aria-label="Volume desta transmissão"><output>${streamVolumes.get(item.id)??100}%</output></label>`}<button class="icon-button stream-fullscreen" title="Ampliar transmissão" aria-label="Ampliar transmissão">${icon('expand')}</button></div>`;
      tile.querySelector('.stream-volume')?.addEventListener('input',event=>{const value=Number(event.target.value);streamVolumes.set(item.id,value);tile.querySelector('video').volume=value/100;tile.querySelector('.stream-volume-label output').value=`${value}%`;renderStreams();});
      tile.querySelector('.stream-fullscreen').addEventListener('click', () => toggleFullscreen(tile));
      tile.querySelector('video').addEventListener('playing', () => tile.querySelector('.video-play-button')?.remove());
      installStreamControls(tile);
      tiles.set(item.id, tile); $('streams').append(tile);
    }
    const tile = tiles.get(item.id), video = tile.querySelector('video');
    if(item.kind==='screen'){const hasAudio=item.self?!!call.screenAudio:!!item.audio;let status=tile.querySelector('.stream-audio-status');if(!status){status=document.createElement('span');status.className='stream-audio-status';tile.querySelector('.stream-label').insertBefore(status,tile.querySelector('.stream-fullscreen'));}const sourceVolume=item.self?settings.screenVolume:call.peers.get(item.id)?.meta.screenAudioVolume;status.textContent=hasAudio?(sourceVolume===0?'Volume enviado em 0%':!item.self&&call.deafened?'Áudio recebido silenciado':!item.self&&streamVolumes.get(item.id)===0?'Transmissão silenciada':item.self?'Som dos apps ativo':'Som ativo'):'Sem áudio da tela';status.classList.toggle('audio-missing',!hasAudio);status.title=hasAudio?'Áudio da transmissão separado das vozes':item.self?lastAudioError||'Ative o som ou clique em Recuperar áudio.':'Quem transmite precisa ativar ou recuperar o som.';if(item.self){let retry=tile.querySelector('.recover-screen-audio');if(!retry){retry=document.createElement('button');retry.className='button small recover-screen-audio';retry.textContent='Recuperar áudio';retry.onclick=()=>recoverScreenAudio(true);tile.querySelector('.stream-label').insertBefore(retry,tile.querySelector('.stream-fullscreen'));}retry.hidden=hasAudio;}}
    video.muted = item.self || item.kind==='camera' || call.deafened;video.classList.toggle('camera-preview',item.self&&item.kind==='camera');
    video.volume=(streamVolumes.get(item.id)??100)/100;
    tile.querySelector('.stream-label>span').textContent = item.name;
    tile.querySelector('.stream-quality').textContent = item.kind==='camera'?'720p · até 30 fps':item.self ? captureLabel() : remoteQuality(item.id);
    setMedia(video, [item.video, item.audio]);
  }
  $('screen-stage').classList.toggle('media-active',active.length>0);
  $('empty-stage').hidden = active.length > 0 || call.active&&!!call.voiceChannelId; $('streams').hidden = !active.length;
  callPeople.hidden=active.length>0||!call.active||!call.voiceChannelId;
  if(!callPeople.hidden){const people=[call.meta,...call.connected.filter(peer=>peer.meta.voiceChannelId===call.voiceChannelId).map(peer=>({...peer.meta,name:peer.name}))];callPeople.innerHTML=people.map(person=>`<article class="voice-person"><span class="avatar">${avatarContent(person,safe)}</span><strong>${safe(person.name)}</strong><span>${person.mic?'Microfone ligado':'Microfone desligado'}</span></article>`).join('');}
}
function captureLabel() {
  if (!call.screen) return '';
  const { width, height, frameRate } = call.screen.getSettings();
  return `${width || '—'}×${height || '—'} · ${frameRate ? Math.round(frameRate) : '—'} fps`;
}
function remoteQuality(id) {
  const stat = currentStats.find(s => s.id === id);
  return stat?.widthIn ? `${stat.widthIn}×${stat.heightIn} · ${stat.fpsIn ?? '—'} fps` : 'Recebendo…';
}
function updateDuration() {
  if (!call.startedAt) { $('room-duration').textContent = 'Pronto quando você estiver.'; return; }
  const elapsed = Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000));
  $('room-duration').textContent = `Na sala há ${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
}
function addMessage(message) {
  const channelId=message.channelId||selectedTextChannel;let list=channelMessages.get(channelId);if(!list){list=[];channelMessages.set(channelId,list);}
  if(list.some(item=>item.id===message.id))return;list.push(message);if(list.length>200)list.shift();
  if(channelId===selectedTextChannel)appendMessage(message);
  if(!message.self&&!message.history)sounds.play('message');
}
function appendMessage(message) {
  if (!hasMessages) { $('messages').replaceChildren(); hasMessages = true; }
  const node = document.createElement('div'); node.className = 'message';node.dataset.author=message.authorId||'';
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(message.time);
  node.innerHTML = `<span class="avatar">${avatarContent(messagePerson(message),safe)}</span><div><div class="message-heading"><strong>${safe(message.name)}${message.self ? ' (você)' : ''}</strong><time>${time}</time></div><p>${safe(message.text)}</p></div>`;
  if(message.attachment){const attachment=message.attachment;const card=document.createElement('div');card.className='message-attachment';card.dataset.attachmentId=attachment.id;card.dataset.mime=attachment.mime;const imageTypes=['image/png','image/jpeg','image/webp','image/gif'];card.dataset.image=String(imageTypes.includes(attachment.mime));if(imageTypes.includes(attachment.mime)){const placeholder=document.createElement('span');placeholder.className='attachment-preview';placeholder.textContent=attachment.mime==='image/gif'?'Carregando GIF…':'Carregando imagem…';card.append(placeholder);}const footer=document.createElement('div');footer.className='attachment-caption';const name=document.createElement('span');name.textContent=`${attachment.name} · ${(attachment.size/1024).toFixed(0)} KB`;const save=document.createElement('button');save.className='text-button';save.textContent='Salvar';save.onclick=()=>window.stringChat.saveAttachment(attachment.id).catch(error=>toast(userError(error),true));footer.append(name,save);card.append(footer);node.lastElementChild.append(card);attachmentObserver.observe(card);}
  $('messages').append(node); trimMessages(); $('messages').scrollTop = $('messages').scrollHeight;
  if (!message.self && !chatVisible) $('toggle-chat').title = 'Nova mensagem na conversa';
}
function systemMessage(text) {
  if (!hasMessages) return;
  const node = document.createElement('div'); node.className = 'system-message'; node.textContent = text;
  $('messages').append(node); trimMessages(); $('messages').scrollTop = $('messages').scrollHeight;
}
function trimMessages() { while ($('messages').children.length > 300) $('messages').firstElementChild.remove(); }
const emptyChat = $('messages').innerHTML;
function renderChatChannel() { $('messages').innerHTML=emptyChat;hasMessages=false;for(const item of channelMessages.get(selectedTextChannel)||[])appendMessage(item);const channel=call.room?.channels?.find(c=>c.id===selectedTextChannel);document.querySelector('.chat-header h2').textContent=`# ${channel?.name||'geral'}`; }
function resetChat() { channelMessages.clear();renderChatChannel();$('chat-input').value=''; }
async function hydrateAttachment(card){
  if(card.dataset.image!=='true')return;const id=card.dataset.attachmentId;
  try{let cached=attachmentUrls.get(id);if(!cached){const file=await window.stringChat.getAttachment(id);const data=new Uint8Array(file.data);if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.mime))throw new Error('Este arquivo não é uma imagem compatível.');const url=URL.createObjectURL(new Blob([data],{type:file.mime}));cached={url,size:data.byteLength};attachmentUrls.set(id,cached);attachmentBytes+=cached.size;while(attachmentBytes>32*1024*1024&&attachmentUrls.size>1){const [oldId,old]=attachmentUrls.entries().next().value;URL.revokeObjectURL(old.url);attachmentBytes-=old.size;attachmentUrls.delete(oldId);}}
    if(!card.isConnected)return;const image=document.createElement('img');image.className='chat-image';image.src=cached.url;image.alt=card.querySelector('.attachment-caption span').textContent;image.loading='lazy';const open=document.createElement('button');open.type='button';open.className='attachment-open';open.setAttribute('aria-label','Abrir imagem: '+image.alt);open.append(image);open.onclick=()=>openImageViewer(id);card.querySelector('.attachment-preview')?.replaceWith(open);
  }catch(error){const placeholder=card.querySelector('.attachment-preview');if(placeholder){placeholder.textContent='Imagem indisponível. Clique para tentar novamente.';placeholder.onclick=()=>hydrateAttachment(card);}}
}
async function uploadFile(file){
  if(!file||uploadBusy)return;if(!call.externalSignal){toast('Entre em um grupo para enviar arquivos.',true);return;}if(file.size<1||file.size>8*1024*1024){toast('Escolha um arquivo de até 8 MB.',true);return;}
  uploadBusy=true;$('upload-status').textContent=`Enviando ${file.name}…`;
  try{await window.stringChat.sendAttachment({channelId:selectedTextChannel,name:file.name,data:new Uint8Array(await file.arrayBuffer())});$('upload-status').textContent='Arquivo enviado.';}
  catch(error){$('upload-status').textContent='Envio não concluído.';toast(userError(error),true);}finally{uploadBusy=false;$('attachment-input').value='';setTimeout(()=>{$('upload-status').textContent='';},5000);}
}

async function toggleMic() {
  if(!call.active||!call.voiceChannelId){toast('Entre em um canal de voz para ligar o microfone.');return;}
  if (micBusy) return; micBusy = true; $('mic-button').disabled = true;
  const epoch = sessionEpoch;
  try {
    if (call.mic && call.mic.readyState === 'live') {
      call.micOn = !call.micOn; if (call.micOn && call.deafened) call.deafened = false;
      call.announce(); return;
    }
    const processor = await ensureMicrophone();
    if (epoch !== sessionEpoch) return;
    call.micOn = true; call.deafened = false;
    await call.updateTracks({ mic: processor.track });
  } catch (error) { toast(userError(error), true); }
  finally { micBusy = false; $('mic-button').disabled = false; render(); }
}
async function ensureMicrophone() {
  if (microphone?.live) return microphone;
  if (microphonePromise) return microphonePromise;
  const epoch = sessionEpoch, processor = new Microphone(); microphone = processor;
  processor.addEventListener('error', event => {
    if (microphone === processor) { call.micOn = false; call.updateTracks({ mic: null }); processor.close(); microphone = null; }
    toast(event.detail, true); updateMicStatus();
  });
  processor.addEventListener('ended', () => {
    if (microphone !== processor) return;
    call.micOn = false; call.updateTracks({ mic: null }); processor.close(); microphone = null;
    toast('O microfone foi desconectado.', true); updateMicStatus();
  });
  processor.addEventListener('statechange', updateMicStatus);
  microphonePromise = processor.open(settings).then(async () => {
    if (epoch !== sessionEpoch) { processor.close(); throw new Error('Microfone cancelado.'); }
    await call.updateTracks({ mic: processor.track }); updateMicStatus(); return processor;
  }).catch(error => { if (microphone === processor) microphone = null; throw error; }).finally(() => { microphonePromise = null; });
  return microphonePromise;
}
function updateMicStatus() {
  const labels = { rnnoise: 'RNNoise neural ativo · 48 kHz', standard: 'Supressão padrão do navegador', off: 'Supressão de ruído desligada' };
  $('mic-processing-status').textContent = microphone?.live ? (microphone.context.state === 'running' ? labels[microphone.mode] || 'Iniciando filtro…' : 'Áudio suspenso pelo navegador') : 'O processamento acontece só no seu PC.';
  $('mic-test-button').innerHTML = icon('headphones') + (microphone?.monitoring ? 'Parar teste' : 'Ouvir teste');
}
function toggleDeafen() { call.deafened = !call.deafened; call.announce(); toast(call.deafened ? 'Áudio recebido silenciado e microfone pausado.' : 'Áudio recebido reativado.'); }

async function applyCaptureConstraints(track) {
  const width = settings.resolution === 1080 ? 1920 : 1280;
  await track.applyConstraints({ width: { ideal: width, max: width }, height: { ideal: settings.resolution, max: settings.resolution }, frameRate: { ideal: settings.fps, max: settings.fps } });
  track.contentHint = settings.contentHint;
}
async function toggleShare() {
  if(!call.active||!call.voiceChannelId){toast('Entre em um canal de voz para compartilhar a tela.');return;}
  if (sharingBusy) return;
  if (call.screen) { await stopSharing(); return; }
  sharingBusy = true; render();
  const epoch = sessionEpoch; let stream;
  // Resume the audio clock during the click; the native stream itself starts only after source consent.
  let audioCandidate = settings.screenSound ? new SystemAudio() : null;
  const pending = { audio: audioCandidate, stream: null }; pendingShare = pending;
  try {
    // Invoke the chooser directly in the click handler, before any await, to retain user activation.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: settings.resolution === 1080 ? 1920 : 1280 }, height: { ideal: settings.resolution }, frameRate: { ideal: settings.fps } },
      audio: settings.screenSound ? { restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false,
      // Never allow unfiltered system mix. Desktop sound uses native process exclusion instead.
      systemAudio: 'exclude', windowAudio: 'window', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
      preferCurrentTab: false
    });
    pending.stream = stream;
    if (epoch !== sessionEpoch) { stream.getTracks().forEach(track => track.stop()); return; }
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('O navegador não retornou uma tela. Selecione uma fonte e tente novamente.');
    let sourceEnded = false;
    track.addEventListener('ended', () => { sourceEnded = true; pending.audio?.stop(); if (call.screen === track) stopSharing(); });
    try { await applyCaptureConstraints(track); }
    catch (error) { toast(`A captura usará a qualidade disponível: ${userError(error)}`, true); track.contentHint = settings.contentHint; }
    if (epoch !== sessionEpoch || sourceEnded || track.readyState === 'ended') { stream.getTracks().forEach(t => t.stop()); return; }
    if (!call.active) call.startHost($('room-name').value);
    let audio = stream.getAudioTracks()[0] || null;
    const surface = track.getSettings().displaySurface;
    screenAudioLabel = '';
    const browserAudioSafe = !window.stringChat?.isDesktop && audio && (surface === 'browser' || audio.getSettings().restrictOwnAudio === true);
    if (browserAudioSafe && settings.screenSound) {
      screenAudioLabel = surface === 'browser' ? 'Som da aba selecionada' : 'Áudio com exclusão da própria call';
    } else {
      for (const audioTrack of stream.getAudioTracks()) audioTrack.stop(); audio = null;
      if (settings.screenSound && (window.stringChat?.isDesktop || ['monitor', 'window'].includes(surface))) {
        try {
          audio = await audioCandidate.start();
          if (epoch !== sessionEpoch || sourceEnded) { audioCandidate.stop(); stream.getTracks().forEach(t => t.stop()); return; }
          systemAudio = audioCandidate; audioCandidate = null; screenAudioLabel = 'Som dos aplicativos · call excluída pelo Windows';
          systemAudio.setVolume(settings.screenVolume/100);
          watchSystemAudio(systemAudio,track);
        } catch (error) {lastAudioError=userError(error);toast(`Não foi possível iniciar o som da tela. ${lastAudioError} Use Recuperar áudio.`, true);}
      }
    }
    if (epoch !== sessionEpoch || sourceEnded) { stream.getTracks().forEach(t => t.stop()); return; }
    if (audio) audio.addEventListener('ended', () => { if (call.screenAudio === audio) call.updateTracks({ screenAudio: null }); });
    await call.updateTracks({ screen: track, screenAudio: audio });
    toast(audio ? `Tela compartilhada. ${screenAudioLabel}.` : 'Tela compartilhada sem som dos aplicativos. O microfone continua separado.');
    if (!call.connected.length) toast('A prévia é local. Conecte um amigo para transmitir.');
  } catch (error) { stream?.getTracks().forEach(track => track.stop()); if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') toast(userError(error), true); }
  finally { audioCandidate?.stop(); if (pendingShare === pending) pendingShare = null; sharingBusy = false; render(); }
}
async function stopSharing() {
  clearTimeout(audioRecovery);audioRecovery=null;audioFailures=0;lastAudioError='';
  const tracks = [call.screen, call.screenAudio];
  await call.updateTracks({ screen: null, screenAudio: null });
  tracks.forEach(track => track?.stop()); render();
  systemAudio?.stop(); systemAudio = null; screenAudioLabel = '';
  pendingShare?.audio?.stop(); pendingShare?.stream?.getTracks().forEach(track => track.stop());
}
async function toggleFullscreen(element) {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await element.requestFullscreen(); }
  catch (error) { toast(userError(error), true); }
}

async function refreshNetworks(){const list=await window.stringChat.getNetworkInterfaces();$('room-network').replaceChildren();for(const item of list){const o=document.createElement('option');o.value=item.address;o.textContent=`${item.kind==='radmin'?'Radmin VPN':item.name} · ${item.address}`;$('room-network').append(o);}$('network-tip').textContent=list.some(x=>x.kind==='radmin')?'Radmin detectado. Os amigos devem estar na mesma rede do Radmin.':'Ligue o Radmin e atualize a lista, ou escolha uma rede LAN compartilhada.';}
async function openConnect(tab){if(tab==='invite'&&call.networkInfo?.invite){await copyText(call.networkInfo.invite);return;}$('connect-error').textContent='';setConnectTab(tab);showDialog('connect-dialog');if(tab==='invite'){try{await refreshNetworks();}catch(e){$('connect-error').textContent=userError(e);}}else if(!$('group-invite-input').value){try{const value=await navigator.clipboard.readText();if(/^(stringchat):\/\/join/.test(value.trim()))$('group-invite-input').value=value.trim();}catch{}}}
function setConnectTab(tab){$('invite-pane').hidden=tab!=='invite';$('join-pane').hidden=tab!=='join';$('invite-tab').classList.toggle('active',tab==='invite');$('join-tab').classList.toggle('active',tab==='join');}
async function connectAction(id,action){if(connectingBusy)return;connectingBusy=true;const b=$(id),previous=b.innerHTML;b.textContent='Conectando…';for(const key of ['generate-invite','join-group-button','invite-tab','join-tab'])$(key).disabled=true;$('connect-error').textContent='';try{await action();}catch(e){$('connect-error').textContent=userError(e);}finally{b.innerHTML=previous;for(const key of ['generate-invite','join-group-button','invite-tab','join-tab'])$(key).disabled=false;connectingBusy=false;render();}}
async function copyText(value){try{await navigator.clipboard.writeText(value);toast('Convite copiado. Um único link para todo o grupo.');}catch{$('group-invite').value=value;$('group-invite-wrap').hidden=false;setConnectTab('invite');showDialog('connect-dialog');$('group-invite').focus();$('group-invite').select();toast('Pressione Ctrl+C para copiar o convite.');}}
$('generate-invite').onclick=()=>connectAction('generate-invite',async()=>{const info=await call.hostNetwork($('room-name').value,$('room-network').value||undefined);$('group-invite').value=info.invite;$('group-invite-wrap').hidden=false;$('room-name').disabled=true;$('room-network').disabled=true;await copyText(info.invite);$('connect-dialog').close();});
$('join-group-button').onclick=()=>connectAction('join-group-button',async()=>{resetChat();await call.joinNetwork($('group-invite-input').value);$('connect-dialog').close();toast('Você entrou no grupo. Escolha um canal de voz ou texto.');});
$('copy-group-invite').onclick=()=>copyText($('group-invite').value);
$('invite-tab').onclick=async()=>{setConnectTab('invite');if(call.networkInfo?.invite){$('group-invite').value=call.networkInfo.invite;$('group-invite-wrap').hidden=false;}else await refreshNetworks();};
$('join-tab').onclick=()=>setConnectTab('join');$('refresh-networks').onclick=()=>refreshNetworks().catch(e=>toast(userError(e),true));
$('invite-button').addEventListener('click',()=>openConnect('invite'));
$('room-nav').addEventListener('click',()=>{if(call.active){setViewMode(call.voiceChannelId?'voice':'text');render();}else openConnect('invite');});
for(const id of ['join-button','join-rail'])$(id).addEventListener('click',()=>openConnect('join'));
function createChannelDialog(kind){if(!call.externalSignal){toast('Crie ou entre em um grupo primeiro.');return;}if(!call.isHost){toast('Peça ao criador do grupo para criar o canal.');return;}$('channel-kind').value=kind;$('channel-name').value='';$('channel-error').textContent='';showDialog('channel-dialog');}
$('add-text-channel').onclick=()=>createChannelDialog('text');$('add-voice-channel').onclick=()=>createChannelDialog('voice');
$('channel-form').addEventListener('submit',async event=>{event.preventDefault();try{await window.stringChat.createChannel({kind:$('channel-kind').value,name:$('channel-name').value});$('channel-dialog').close();}catch(e){$('channel-error').textContent=userError(e);}});
window.stringChat?.onInvite(async invite=>{if(call.active){toast('Você já está em um grupo. Saia antes de abrir outro convite.');return;}$('group-invite-input').value=invite;setConnectTab('join');showDialog('connect-dialog');await connectAction('join-group-button',async()=>{resetChat();await call.joinNetwork(invite);$('connect-dialog').close();toast('Bem-vindo ao grupo!');});});
setupFriends({toast,sounds,openConversation:id=>home?.openConversation(id),joinInvite:async invite=>{if(call.active){toast('Saia do grupo atual antes de entrar em outro.');return;}$('group-invite-input').value=invite;setConnectTab('join');showDialog('connect-dialog');await connectAction('join-group-button',async()=>{resetChat();await call.joinNetwork(invite);$('connect-dialog').close();});}});

function openSettings() {
  $('theme-choice').value=settings.theme;$('close-to-tray').checked=settings.closeToTray;
  shortcutUI?.render();
  draftAvatar=settings.avatar;renderProfilePreview();refreshCameraDevices().catch(()=>{});
  $('display-name').value = settings.name; $('stream-priority').value=settings.streamPriority;$('resolution').value = String(settings.resolution); $('framerate').value = String(settings.fps);
  $('bitrate').value = String(settings.bitrate); $('content-hint').value = settings.contentHint;
  $('echo-cancellation').checked = settings.echoCancellation; $('network-mode').value = settings.network;
  $('noise-mode').value = settings.noiseMode;
  $('screen-sound').checked = settings.screenSound;
  $('screen-volume').value=String(settings.screenVolume);$('screen-volume-value').value=`${settings.screenVolume}%`;
  $('sounds-enabled').checked=settings.soundsEnabled;$('sound-volume').value=String(settings.soundVolume);
  $('ice-url').value = settings.iceUrl; $('ice-user').value = settings.iceUser; $('ice-password').value = settings.icePassword;
  $('custom-ice-fields').hidden = settings.network !== 'custom'; $('settings-error').textContent = ''; updateBitrateLabel(); updateMicStatus(); showDialog('settings-dialog');
}
function updateBitrateLabel() {
  const rate = Number($('bitrate').value); $('bitrate-value').value = `${rate} Mbps`;
  const friends = Math.max(3, call.connected.length); $('bandwidth-note').textContent = `Com ${friends} amigos, até ${rate * friends} Mbps de upload + áudio e overhead. O limite não força tráfego constante.`;
}
for (const id of ['quality-button', 'settings-button', 'profile-button']) $(id).addEventListener('click', openSettings);
$('bitrate').addEventListener('input', updateBitrateLabel);
document.querySelectorAll('[data-bitrate]').forEach(button => button.addEventListener('click', () => { $('bitrate').value = button.dataset.bitrate; updateBitrateLabel(); }));
$('network-mode').addEventListener('change', () => { $('custom-ice-fields').hidden = $('network-mode').value !== 'custom'; });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const next = { avatar:draftAvatar,cameraDeviceId:$('camera-device').value,name: $('display-name').value.trim().slice(0, 32) || 'Você', resolution: Number($('resolution').value), fps: Number($('framerate').value), bitrate: Number($('bitrate').value), contentHint: $('content-hint').value, noiseMode: $('noise-mode').value, echoCancellation: $('echo-cancellation').checked, screenSound: $('screen-sound').checked, network: $('network-mode').value, iceUrl: $('ice-url').value.trim(), iceUser: $('ice-user').value, icePassword: $('ice-password').value };
  next.closeToTray=$('close-to-tray').checked;next.theme=$('theme-choice').value;next.streamPriority=$('stream-priority').value;next.screenVolume=Number($('screen-volume').value);next.soundsEnabled=$('sounds-enabled').checked;next.soundVolume=Number($('sound-volume').value);
  try {
    iceConfig(next);
    if (microphone?.live) await microphone.configure(next);
    if(call.camera&&next.cameraDeviceId!==settings.cameraDeviceId)await startCamera(next.cameraDeviceId);
    Object.assign(next,shortcutUI.values());
    const {icePassword:privatePassword,...toSave}={...settings,...next};await window.stringChat.saveSettings(toSave);
    Object.assign(settings, next);applyTheme(settings.theme);
    systemAudio?.setVolume(settings.screenVolume/100);
    if (!settings.screenSound && call.screenAudio) {
      const oldAudio = call.screenAudio; await call.updateTracks({ screenAudio: null }); oldAudio.stop(); systemAudio?.stop(); systemAudio = null; screenAudioLabel = '';
    }
    // TURN passwords stay in memory. Preferences were saved before applying UI state.
    if (call.screen) {
      try { await applyCaptureConstraints(call.screen); } catch (error) { toast(`Qualidade da captura mantida: ${userError(error)}`, true); }
    }
    if(settings.screenSound&&call.screen&&!call.screenAudio)await recoverScreenAudio(false);
    await call.updateTracks(); $('settings-dialog').close(); toast(`Qualidade configurada: ${settings.resolution}p · ${settings.fps} fps · até ${settings.bitrate} Mbps por amigo.`);
  } catch (error) { $('settings-error').textContent = userError(error); }
  finally { button.disabled = false; render(); }
});
$('screen-volume').addEventListener('input',()=>{$('screen-volume-value').value=`${$('screen-volume').value}%`;});
$('mic-test-button').addEventListener('click', async () => {
  const button = $('mic-test-button'); button.disabled = true;
  try {
    const processor = await ensureMicrophone();
    await processor.configure({ ...settings, noiseMode: $('noise-mode').value, echoCancellation: $('echo-cancellation').checked });
    processor.setMonitor(!processor.monitoring); updateMicStatus();
  } catch (error) { toast(userError(error), true); }
  finally { button.disabled = false; }
});
$('noise-mode').addEventListener('change', async () => {
  if (!microphone?.monitoring) return;
  try { await microphone.configure({ ...settings, noiseMode: $('noise-mode').value, echoCancellation: $('echo-cancellation').checked }); updateMicStatus(); }
  catch (error) { toast(userError(error), true); }
});
$('settings-dialog').addEventListener('close', async () => {
  microphone?.setMonitor(false);
  if (microphone?.live) { try { await microphone.configure(settings); } catch (error) { toast(userError(error), true); } }
  updateMicStatus();
});

function setChatVisible(value) { chatVisible = value; $('chat-panel').hidden = !value; $('toggle-chat').setAttribute('aria-pressed', String(value)); $('toggle-chat').title = value ? 'Ocultar conversa' : 'Mostrar conversa'; }
$('toggle-chat').addEventListener('click', () => setChatVisible(!chatVisible));
smallScreen.addEventListener('change', event => setChatVisible(!event.matches));
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); const input = $('chat-input'); if (!input.value.trim()) return;
  if (Date.now() - lastChat < 80) return;
  try { if (call.sendChat(input.value)) { input.value = ''; lastChat = Date.now(); } }
  catch (error) { toast(userError(error), true); }
});
$('camera-button').addEventListener('click',toggleCamera);
$('mic-button').addEventListener('click', toggleMic); $('deafen-button').addEventListener('click', toggleDeafen);
$('share-button').addEventListener('click', toggleShare); $('stage-share').addEventListener('click', toggleShare);
$('fullscreen-button').addEventListener('click', () => toggleFullscreen($('screen-stage')));
$('help-button').addEventListener('click', () => showDialog('help-dialog'));
$('stats-button').addEventListener('click', () => { renderStats(); showDialog('stats-dialog'); refreshStats(); });
function openLeaveGroup() {
  $('leave-message').textContent = call.isHost && call.connected.length ? 'Você criou esta sala. Ao sair, a sala será encerrada para todos os amigos.' : 'Você vai sair da chamada, desligar o microfone e encerrar a captura de tela.';
  showDialog('leave-dialog');
}
$('leave-group-button').onclick=openLeaveGroup;
$('leave-button').addEventListener('click',async()=>{
  const returnHome=viewMode==='home';
  if(call.externalSignal&&call.voiceChannelId){await stopSharing();await stopCamera();await call.changeVoiceChannel(null);call.micOn=false;microphone?.close();microphone=null;await call.updateTracks({mic:null});setViewMode(returnHome?'home':'text');sounds.play('leave');toast('Você saiu da voz e continua no grupo.');render();}
  else openLeaveGroup();
});
$('confirm-leave').addEventListener('click', () => {
  sessionEpoch++; call.leave(); cleanupSession(); $('leave-dialog').close(); toast('Você saiu da sala. Até o próximo rolê.');
});
function cleanupSession() {
  cameraEpoch++;$('image-viewer').close();
  call.camera?.stop();call.camera=null;
  currentOffer = null; currentStats = []; resetChat();
  for (const id of ['group-invite','group-invite-input']) $(id).value='';
  $('group-invite-wrap').hidden=true;$('room-name').disabled=false;$('room-network').disabled=false;
  microphone?.close(); microphone = null;
  systemAudio?.stop(); systemAudio = null; screenAudioLabel = '';
  pendingShare?.audio?.stop(); pendingShare?.stream?.getTracks().forEach(track => track.stop());
  for(const value of attachmentUrls.values())URL.revokeObjectURL(value.url);attachmentUrls.clear();attachmentBytes=0;
  render();
}
// Resume media in response to a real gesture when the browser blocked autoplay.
document.addEventListener('pointerdown', () => { for (const audio of audioElements.values()) if (audio.paused) audio.play().catch(() => {}); }, { passive: true });
// Native X / Alt+F4 must always close; session cleanup runs on pagehide and before-quit.
window.addEventListener('pagehide', () => {pageClosing=true;call.leave();});

call.addEventListener('change',()=>{if(call.active&&!groupWasActive)setViewMode('voice');else if(!call.active&&groupWasActive)setViewMode('home');groupWasActive=call.active;render();refreshMessageAvatars();});
call.addEventListener('tracks', renderStreams);
call.addEventListener('chat', event => addMessage(event.detail));
call.addEventListener('memberjoined', event => {
  if(call.connected.some(peer=>peer.name===event.detail&&peer.meta.voiceChannelId===call.voiceChannelId))sounds.play('join');
  toast(`${event.detail} conectou à sala.`); systemMessage(`${event.detail} chegou.`);
  if (!call.isHost && $('connect-dialog').open && !$('join-pane').hidden) $('connect-dialog').close();
});
call.addEventListener('memberleft', event => {systemMessage(event.detail);sounds.play('leave');});
call.addEventListener('voice-sound',event=>sounds.play(event.detail));
call.addEventListener('error', event => toast(event.detail, true));
call.addEventListener('ended', event => { sessionEpoch++; cleanupSession(); toast(event.detail, true); });
call.addEventListener('peerremoved', () => renderStreams());

const stateLabels = { new: 'Preparando', connecting: 'Conectando', connected: 'Conectado', disconnected: 'Reconectando', failed: 'Falhou', closed: 'Encerrado' };
const limitationLabels = { none: 'Sem limitação detectada', cpu: 'Limitado pelo processador', bandwidth: 'Limitado pela rede', other: 'Limitação do navegador' };
function renderStats() {
  $('capture-info').textContent = call.screen ? `Captura local: ${captureLabel()} · alvo de até ${settings.bitrate} Mbps por amigo. ${screenAudioLabel || 'Sem som dos aplicativos.'} ${call.connected.length ? '' : 'Prévia local, sem espectadores.'}` : `Nenhuma tela sendo capturada. Meta: ${settings.resolution}p · ${settings.fps} fps · ${settings.bitrate} Mbps por amigo.`;
  if (!currentStats.length) { $('stats-list').innerHTML = '<p class="small-note">Conecte um amigo para ver bitrate, latência, perda e resolução enviados e recebidos.</p>'; return; }
  $('stats-list').innerHTML = currentStats.map(stat => {
    const fields = [
      ['Upload total', `${stat.up.toFixed(2)} Mbps`], ['Download total', `${stat.down.toFixed(2)} Mbps`],
      ['Vídeo enviado', stat.widthOut ? `${stat.widthOut}×${stat.heightOut}` : '—'], ['FPS enviados', stat.fpsOut ?? '—'],
      ['Vídeo recebido', stat.widthIn ? `${stat.widthIn}×${stat.heightIn}` : '—'], ['FPS recebidos', stat.fpsIn ?? '—'],
      ['Latência de ida e volta', stat.rtt == null ? '—' : `${Math.round(stat.rtt)} ms`], ['Perda recebida acumulada', stat.loss == null ? '—' : `${stat.loss.toFixed(2)}%`],
      ['Codec de vídeo', stat.codec || '—'], ['Rota', stat.route || 'Verificando…'],
      ['Fila de áudio recebida',stat.audioJitterMs==null?'—':Math.round(stat.audioJitterMs)+' ms'],['Fila de vídeo recebida',stat.videoJitterMs==null?'—':Math.round(stat.videoJitterMs)+' ms'],['Tempo para codificar vídeo',stat.encoderMs==null?'—':stat.encoderMs.toFixed(1)+' ms'],['Upload estimado pela rede',stat.availableUpload==null?'—':stat.availableUpload.toFixed(1)+' Mbps']
    ];
    return `<article class="stats-peer"><h3>${safe(stat.name)} · ${stateLabels[stat.state] || safe(stat.state)}</h3><div class="stats-grid">${fields.map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${safe(value)}</strong></div>`).join('')}</div><p class="small-note">${limitationLabels[stat.limitation] || 'Aguardando envio de vídeo.'}</p></article>`;
  }).join('');
}
async function refreshStats() {
  if (statsBusy) return; statsBusy = true;
  try {
    currentStats = await call.readStats();
    if ($('stats-dialog').open){renderStats();if(call.screen&&systemAudio)$('capture-info').textContent+=` Fila local de áudio: ${Math.round(systemAudio.telemetry.bufferMs||0)} ms. ${systemAudio.telemetry.peak>0.0001?'Som detectado.':'Sem som detectado nos aplicativos neste momento.'}`;}
    for (const [id, tile] of tiles) tile.querySelector('.stream-quality').textContent = tile.dataset.kind==='camera'?'720p · até 30 fps':id === call.id ? captureLabel() : remoteQuality(id);
  } finally { statsBusy = false; }
}
setInterval(refreshStats, 2000); setInterval(updateDuration, 1000);
setInterval(() => {
  const level = microphone?.level || 0;
  if ($('settings-dialog').open) $('mic-level').value = Math.min(1, level * 8);
  document.querySelector(`[data-member="${call.id}"]`)?.classList.toggle('speaking', call.meta.mic && level > 0.012);
}, 150);
setChatVisible(chatVisible); render();
document.querySelector('a[href="/licenses"]')?.addEventListener('click', event => { if (window.stringChat?.isDesktop) { event.preventDefault(); window.stringChat.openLicenses(); } });
$('attach-button').onclick=()=>{$('attachment-input').accept='';$('attachment-input').click();};
$('gif-button').onclick=()=>{$('attachment-input').accept='image/gif';$('attachment-input').click();};
$('attachment-input').onchange=event=>uploadFile(event.target.files[0]);
$('chat-panel').addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});
$('chat-panel').addEventListener('drop',event=>{if(event.dataTransfer.files.length){event.preventDefault();uploadFile(event.dataTransfer.files[0]);}});
$('chat-input').addEventListener('paste',event=>{if(event.clipboardData.files.length){event.preventDefault();uploadFile(event.clipboardData.files[0]);}});
const emojis=['😀','😃','😄','😁','😂','🤣','😊','😍','🥰','😘','😎','🤔','😅','😢','😭','😡','🤯','😴','🥳','😈','👀','💀','🤡','👻','👍','👎','👏','🙌','🤝','🙏','❤️','💚','💜','💙','🔥','✨','🎉','💯','✅','❌','🎮','🎧','🎬','🎵','🚀','🍕','☕','🐱'];
for(const emoji of emojis){const button=document.createElement('button');button.type='button';button.textContent=emoji;button.setAttribute('aria-label',emoji);button.onclick=()=>{const input=$('chat-input');input.setRangeText(emoji,input.selectionStart,input.selectionEnd,'end');input.focus();$('emoji-menu').hidden=true;};$('emoji-menu').append(button);}
$('emoji-button').onclick=()=>{$('emoji-menu').hidden=!$('emoji-menu').hidden;};
document.addEventListener('click',event=>{if(!event.target.closest('#emoji-menu')&&!event.target.closest('#emoji-button'))$('emoji-menu').hidden=true;});
if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia || !window.RTCPeerConnection || !window.CompressionStream) {
  toast('Abra este app em http://localhost usando Chrome ou Edge atualizado para habilitar chamadas e captura de tela.', true);
}


function installStreamControls(tile){
  const reveal=()=>{clearTimeout(tile.controlsTimer);tile.classList.add('controls-visible');tile.controlsTimer=setTimeout(()=>{if(!tile.querySelector('.stream-label').matches(':hover'))tile.classList.remove('controls-visible');},2200);};
  tile.addEventListener('pointermove',reveal,{passive:true});tile.addEventListener('pointerdown',reveal,{passive:true});
  tile.addEventListener('pointerleave',()=>{clearTimeout(tile.controlsTimer);tile.classList.remove('controls-visible');});
  tile.addEventListener('focusin',reveal);tile.querySelector('.stream-label').addEventListener('pointerleave',reveal);reveal();
}
async function refreshCameraDevices(){
  const devices=await navigator.mediaDevices.enumerateDevices();const select=$('camera-device');const previous=select.value||settings.cameraDeviceId;
  select.replaceChildren(new Option('Câmera padrão do Windows',''));
  for(const [index,device]of devices.filter(d=>d.kind==='videoinput'&&d.deviceId).entries())select.append(new Option(device.label||`Webcam ${index+1}`,device.deviceId));
  select.value=[...select.options].some(o=>o.value===previous)?previous:'';
}
async function startCamera(deviceId=settings.cameraDeviceId){
  const epoch=++cameraEpoch,session=sessionEpoch;
  if(window.stringChat?.authorizeCamera&&!await window.stringChat.authorizeCamera())return false;
  if(epoch!==cameraEpoch||session!==sessionEpoch)return false;
  const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:30,max:30},...(deviceId?{deviceId:{exact:deviceId}}:{})}});
  const track=stream.getVideoTracks()[0];
  if(!track||epoch!==cameraEpoch||session!==sessionEpoch){stream.getTracks().forEach(t=>t.stop());return false;}
  track.contentHint='motion';const previous=call.camera;
  track.addEventListener('ended',()=>{if(call.camera===track){stopCamera();toast('A câmera foi desconectada.');}});
  try{await call.updateTracks({camera:track});previous?.stop();await refreshCameraDevices();return true;}
  catch(error){stream.getTracks().forEach(t=>t.stop());await call.updateTracks({camera:previous});throw error;}
}
async function stopCamera(){cameraEpoch++;const track=call.camera;await call.updateTracks({camera:null});track?.stop();render();}
async function toggleCamera(){
  if(cameraBusy)return;
  if(!call.active||!call.voiceChannelId){toast('Entre em um canal de voz para ligar a câmera.');return;}
  cameraBusy=true;render();
  try{if(call.camera)await stopCamera();else if(await startCamera())toast('Câmera ligada.');}
  catch(error){toast('Câmera: '+userError(error),true);}finally{cameraBusy=false;render();}
}
$('refresh-cameras').onclick=()=>refreshCameraDevices().catch(error=>toast(userError(error),true));
navigator.mediaDevices.addEventListener('devicechange',()=>{if($('settings-dialog').open)refreshCameraDevices().catch(()=>{});});
function renderProfilePreview(){$('profile-photo-preview').innerHTML=avatarContent({name:settings.name,avatar:draftAvatar},safe);$('remove-profile-photo').disabled=!draftAvatar;}
$('choose-profile-photo').onclick=()=>$('profile-photo-input').click();
$('remove-profile-photo').onclick=()=>{draftAvatar='';renderProfilePreview();};
$('profile-photo-input').onchange=async event=>{if(avatarBusy)return;const file=event.target.files[0];if(!file)return;avatarBusy=true;document.querySelector('#settings-form button[type=submit]').disabled=true;
  try{draftAvatar=await prepareAvatar(file);renderProfilePreview();}catch(error){toast(userError(error),true);}finally{avatarBusy=false;event.target.value='';document.querySelector('#settings-form button[type=submit]').disabled=false;}
};
function messagePerson(message){return message.authorId===call.id||message.self?call.meta:{name:message.name,avatar:call.peers.get(message.authorId)?.meta.avatar};}
function refreshMessageAvatars(){if(pageClosing)return;for(const node of $('messages').querySelectorAll('.message[data-author]')){const id=node.dataset.author;const person=id===call.id?call.meta:call.peers.get(id)?.meta;if(person)node.querySelector('.avatar').innerHTML=avatarContent(person,safe);}}
async function openImageViewer(id,source=null){
  if(document.fullscreenElement)await document.exitFullscreen();
  const epoch=++viewerEpoch;viewerId=id;viewerSave=source?.saveFile||(()=>window.stringChat.saveAttachment(id));if(viewerUrl)URL.revokeObjectURL(viewerUrl);viewerUrl=null;
  const photo=$('image-viewer-photo');photo.hidden=true;photo.removeAttribute('src');$('image-viewer-status').textContent='Carregando imagem…';$('image-viewer').classList.remove('zoomed');$('image-viewer-zoom').setAttribute('aria-pressed','false');$('image-viewer-zoom').textContent='Ampliar';showDialog('image-viewer');
  try{const file=await (source?.getFile?source.getFile():window.stringChat.getAttachment(id));if(epoch!==viewerEpoch||!$('image-viewer').open)return;
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.mime))throw new Error('Imagem incompatível.');
    viewerUrl=URL.createObjectURL(new Blob([new Uint8Array(file.data)],{type:file.mime}));photo.src=viewerUrl;photo.alt=file.name;$('image-viewer-name').textContent=file.name;photo.hidden=false;$('image-viewer-status').textContent='';
  }catch(error){if(epoch===viewerEpoch)$('image-viewer-status').textContent=userError(error);}
}
function toggleImageZoom(){const zoomed=$('image-viewer').classList.toggle('zoomed');$('image-viewer-zoom').setAttribute('aria-pressed',String(zoomed));$('image-viewer-zoom').textContent=zoomed?'Ajustar à tela':'Ampliar';}
$('image-viewer-zoom').onclick=toggleImageZoom;$('image-viewer-photo').onclick=toggleImageZoom;
$('image-viewer-save').onclick=()=>{if(viewerId&&viewerSave)viewerSave().catch(error=>toast(userError(error),true));};
$('image-viewer').addEventListener('click',event=>{if(event.target===$('image-viewer')||event.target.classList.contains('image-viewer-stage'))$('image-viewer').close();});
$('image-viewer').addEventListener('close',()=>{viewerEpoch++;viewerId=null;viewerSave=null;if(viewerUrl)URL.revokeObjectURL(viewerUrl);viewerUrl=null;$('image-viewer-photo').removeAttribute('src');});

// Start in the personal space; a group opens only after an explicit create/join.
home=setupHome({toast,sounds,getSelf:()=>call.meta,onHome:()=>{setViewMode('home');render();},onCreate:()=>openConnect('invite'),onJoin:()=>openConnect('join'),onGroup:()=>{if(call.active){setViewMode(call.voiceChannelId?'voice':'text');render();}},onCallControl:kind=>$(kind==='leave'?'leave-button':kind==='camera'?'camera-button':'mic-button').click(),openImage:openImageViewer});
$('home-button').onclick=()=>home.showFriends();document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();home.showFriends();});render();

function watchSystemAudio(instance,screen){instance.addEventListener('error',event=>{if(systemAudio!==instance||call.screen!==screen)return;lastAudioError=event.detail;systemAudio=null;screenAudioLabel='';call.updateTracks({screenAudio:null});instance.stop();if(audioFailures<2){audioFailures++;clearTimeout(audioRecovery);audioRecovery=setTimeout(()=>recoverScreenAudio(false),700);}else toast('O som da tela foi interrompido. Clique em Recuperar áudio.',true);});}
async function recoverScreenAudio(manual=false){
  const screen=call.screen;if(!screen||sharingBusy||audioRecoveryBusy)return;
  clearTimeout(audioRecovery);audioRecovery=null;if(manual){settings.screenSound=true;audioFailures=0;}if(!settings.screenSound)return;
  audioRecoveryBusy=true;const previous=systemAudio;systemAudio=null;previous?.stop();let instance;
  try{instance=new SystemAudio();const track=await instance.start();if(call.screen!==screen||!settings.screenSound){instance.stop();return;}systemAudio=instance;instance.setVolume(settings.screenVolume/100);screenAudioLabel='Som dos aplicativos · call excluída pelo Windows';lastAudioError='';watchSystemAudio(instance,screen);await call.updateTracks({screenAudio:track});if(manual){toast('Som da transmissão recuperado.');const {icePassword,...saved}=settings;window.stringChat.saveSettings(saved).catch(()=>{});}}
  catch(error){instance?.stop();if(call.screen!==screen)return;lastAudioError=userError(error);await call.updateTracks({screenAudio:null});if(!manual&&audioFailures<2){audioFailures++;audioRecovery=setTimeout(()=>recoverScreenAudio(false),1200);}else toast('Áudio indisponível: '+lastAudioError,true);}
  finally{audioRecoveryBusy=false;}
}

shortcutUI=setupShortcuts({settings,onTrigger:type=>{if(type==='mute')toggleMic();else toggleDeafen();}});

function applyTheme(theme){document.documentElement.dataset.theme=theme;document.getElementById('dark-theme').disabled=theme==='light';}applyTheme(settings.theme);

$('export-diagnostics').onclick=async()=>{const track=call.screen?.getSettings()||{},audio=systemAudio?.telemetry||{};try{const saved=await window.stringChat.exportDiagnostics({capture:{width:track.width,height:track.height,fps:track.frameRate,screenActive:!!call.screen,audioTrackLive:call.screenAudio?.readyState==='live',soundEnabled:settings.screenSound,sendVolume:settings.screenVolume,audioQueueMs:audio.bufferMs,audioUnderruns:audio.underruns,audioDroppedMs:audio.droppedMs,peak:audio.peak},peers:currentStats.map(({up,down,widthOut,heightOut,widthIn,heightIn,fpsOut,fpsIn,rtt,loss,audioJitterMs,videoJitterMs,encoderMs,availableUpload,codec,limitation})=>({up,down,widthOut,heightOut,widthIn,heightIn,fpsOut,fpsIn,rtt,loss,audioJitterMs,videoJitterMs,encoderMs,availableUpload,codec,limitation}))});if(saved)toast('Diagnóstico salvo. Você pode enviar esse arquivo ao relatar um problema.');}catch(error){toast(userError(error),true);}};
