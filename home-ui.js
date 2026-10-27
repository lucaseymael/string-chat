import {avatarContent} from './profile.js';
import {getVoiceState} from './voice-state.js';
const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imageTypes=['image/png','image/jpeg','image/webp','image/gif'];
const emojiList=['😀','😂','🤣','😊','😍','😎','🤔','😭','🥳','👀','💀','👍','👎','👏','❤️','💚','🔥','✨','🎉','💯','✅','🎮','🎧','🍕'];

export function setupHome({toast,sounds,onHome,onCreate,onJoin,onGroup,onCallControl,openImage,getSelf}){
  const $=id=>document.getElementById(id);let snapshot={contacts:[],id:window.stringChat.identity.id},selected=null,active=false,loadEpoch=0,sending=false,fileBusy=false,closed=false;
  const urls=new Map();let urlBytes=0;const histories=new Map();
  const contact=id=>snapshot.contacts.find(c=>c.id===id);
  function showError(error){$('direct-error').textContent=error.message||String(error);}
  function cleanupImages(){for(const value of urls.values())URL.revokeObjectURL(value.url);urls.clear();urlBytes=0;}
  function sidebar(){
    const friends=snapshot.contacts.filter(c=>c.status==='friend');
    $('home-direct-list').innerHTML=friends.length?friends.map(friend=>`<button class="direct-contact ${friend.id===selected?'active':''}" data-direct="${safe(friend.id)}"><span class="avatar">${avatarContent(friend,safe)}</span><span><strong>${safe(friend.name)}</strong><small>${friend.online?'Online':'Offline'}</small></span>${friend.unread?`<b class="unread-count">${friend.unread>99?'99+':friend.unread}</b>`:''}</button>`).join(''):'<p class="home-sidebar-empty">Suas conversas aparecem aqui quando você adicionar amigos.</p>';
    $('home-direct-list').querySelectorAll('[data-direct]').forEach(button=>button.onclick=()=>openConversation(button.dataset.direct));
    const unread=friends.reduce((sum,friend)=>sum+(friend.unread||0),0);$('home-unread').textContent=unread>99?'99+':unread;$('home-unread').hidden=!unread;
  }
  function renderFriends(){
    const friends=snapshot.contacts.filter(c=>c.status==='friend');
    $('home-friend-count').textContent=`${friends.length} ${friends.length===1?'amigo':'amigos'} · ${friends.filter(c=>c.online).length} online`;
    $('home-friends-grid').innerHTML=friends.length?friends.map(friend=>`<article class="home-friend" data-home-friend="${safe(friend.id)}"><span class="avatar">${avatarContent(friend,safe)}</span><div><strong>${safe(friend.name)}</strong><p><span class="presence-dot ${friend.online?'online':''}"></span>${friend.online?'Online':'Offline'}</p>${friend.lastMessage?`<small>${safe(friend.lastMessage.text.slice(0,90))}</small>`:''}</div><button class="button small primary" data-open-direct="${safe(friend.id)}">Conversar${friend.unread?` <b class="unread-count">${friend.unread}</b>`:''}</button></article>`).join(''):'<div class="home-empty-friends"><span class="home-empty-symbol">✦</span><h3>O próximo papo começa com um amigo.</h3><p>Adicione alguém para conversar em privado. Crie um grupo quando quiser reunir a galera.</p><button class="button primary" id="home-empty-add">Adicionar amigo</button></div>';
    $('home-empty-add')?.addEventListener('click',addFriend);
    $('home-friends-grid').querySelectorAll('[data-open-direct]').forEach(button=>button.onclick=()=>openConversation(button.dataset.openDirect));
  }
  function updateHeader(){const friend=contact(selected);if(active){$('room-title').textContent=friend?friend.name:'Amigos';document.querySelector('.room-heading>svg use').setAttribute('href','#i-chat');document.querySelector('.room-subtitle').textContent=friend?'Conversa privada':'Seu espaço para encontrar a galera.';}$('direct-name').textContent=friend?.name||'Conversa privada';$('direct-presence').textContent=friend?(friend.online?'Online · conversa direta entre vocês':'Offline · suas mensagens ficam salvas neste PC'):'';$('direct-peer-avatar').innerHTML=avatarContent(friend,safe);}
  function refresh(){if(closed)return;sidebar();renderFriends();updateHeader();if(selected&&!contact(selected)){selected=null;showFriends();}}
  function addFriend(){$('friends-button').click();}
  function showFriends(){selected=null;active=true;onHome();$('home-friends-page').hidden=false;$('direct-page').hidden=true;$('home-section-title').textContent='Mensagens diretas';refresh();}
  async function openConversation(id){
    const friend=contact(id);if(friend?.status!=='friend'){toast('Aceite a amizade antes de conversar em privado.');return;}
    selected=id;active=true;onHome();$('home-friends-page').hidden=true;$('direct-page').hidden=false;$('direct-error').textContent='';$('direct-file-status').textContent='';$('home-section-title').textContent='Mensagens diretas';sidebar();updateHeader();
    const epoch=++loadEpoch;renderMessages(histories.get(id)||[],true);try{const messages=await window.stringChat.directHistory(id);histories.set(id,messages);if(epoch===loadEpoch&&selected===id){renderMessages(messages,true);if(document.hasFocus())await window.stringChat.directRead(id);}}catch(error){if(epoch===loadEpoch)showError(error);}
    $('direct-input').focus();
  }
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);hydrate(entry.target);}}, {root:$('direct-messages'),rootMargin:'200px'});
  function renderMessages(messages,forceBottom=false){
    const list=$('direct-messages');const bottom=forceBottom||list.scrollHeight-list.scrollTop-list.clientHeight<80;const oldTop=list.scrollTop;observer.disconnect();list.replaceChildren();
    if(!messages.length){const empty=document.createElement('div');empty.className='direct-empty';empty.innerHTML='<h3>Só vocês dois.</h3><p>Mande uma mensagem para começar. Esta conversa é independente dos grupos.</p>';list.append(empty);}
    for(const item of messages){
      const own=item.authorId===snapshot.id,person=own?getSelf():contact(item.friendId);const row=document.createElement('article');row.className='message direct-message';row.dataset.message=item.id;row.dataset.status=item.status;
      const time=new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(item.time);
      row.innerHTML=`<span class="avatar">${avatarContent(person,safe)}</span><div><div class="message-heading"><strong>${safe(person?.name||'Amigo')}${own?' (você)':''}</strong><time>${time}</time></div>${item.text?`<p>${safe(item.text)}</p>`:''}<div class="direct-delivery">${own?(item.status==='delivered'?'Entregue':item.status==='sending'?'Enviando…':'Não entregue'):'Mensagem privada'}${own&&item.status==='failed'?`<button class="text-button direct-retry" data-retry="${safe(item.id)}">Tentar novamente</button>`:''}</div></div>`;
      if(item.attachment){const file=item.attachment,card=document.createElement('div');card.className='message-attachment';card.dataset.image=String(imageTypes.includes(file.mime));card.dataset.file=file.id;card.dataset.friend=item.friendId;
        if(imageTypes.includes(file.mime)){const placeholder=document.createElement('span');placeholder.className='attachment-preview';placeholder.textContent=file.mime==='image/gif'?'Carregando GIF…':'Carregando imagem…';card.append(placeholder);}
        const caption=document.createElement('div');caption.className='attachment-caption';const label=document.createElement('span');label.textContent=`${file.name} · ${(file.size/1024).toFixed(0)} KB`;const save=document.createElement('button');save.className='text-button';save.textContent='Salvar';save.onclick=()=>window.stringChat.saveDirectFile({friendId:item.friendId,id:file.id}).catch(showError);caption.append(label,save);card.append(caption);row.lastElementChild.insertBefore(card,row.querySelector('.direct-delivery'));observer.observe(card);
      }
      list.append(row);
    }
    list.querySelectorAll('[data-retry]').forEach(button=>button.onclick=async()=>{button.disabled=true;$('direct-error').textContent='';try{await window.stringChat.retryDirect({friendId:selected,id:button.dataset.retry});}catch(error){showError(error);}finally{button.disabled=false;}});
    list.scrollTop=bottom?list.scrollHeight:oldTop;
  }
  async function hydrate(card){if(card.dataset.image!=='true')return;const friendId=card.dataset.friend,id=card.dataset.file,key=friendId+':'+id;
    try{let cached=urls.get(key);if(!cached){const file=await window.stringChat.getDirectFile({friendId,id});if(closed)return;if(!imageTypes.includes(file.mime))throw Error('Arquivo incompatível.');const data=new Uint8Array(file.data);cached={url:URL.createObjectURL(new Blob([data],{type:file.mime})),size:data.byteLength};urls.set(key,cached);urlBytes+=cached.size;while(urlBytes>32*1024*1024&&urls.size>1){const [oldId,old]=urls.entries().next().value;URL.revokeObjectURL(old.url);urls.delete(oldId);urlBytes-=old.size;}}
      if(!card.isConnected)return;const list=$('direct-messages'),follow=list.scrollHeight-list.scrollTop-list.clientHeight<80;const image=document.createElement('img');image.className='chat-image';image.onload=()=>{if(follow&&card.isConnected&&selected===friendId)list.scrollTop=list.scrollHeight;};image.src=cached.url;image.alt=card.querySelector('.attachment-caption span').textContent;const button=document.createElement('button');button.type='button';button.className='attachment-open';button.setAttribute('aria-label','Abrir imagem: '+image.alt);button.append(image);button.onclick=()=>openImage(id,{getFile:()=>window.stringChat.getDirectFile({friendId,id}),saveFile:()=>window.stringChat.saveDirectFile({friendId,id})});card.querySelector('.attachment-preview')?.replaceWith(button);
    }catch(error){const placeholder=card.querySelector('.attachment-preview');if(placeholder){placeholder.textContent='Imagem indisponível. Clique para tentar novamente.';placeholder.onclick=()=>hydrate(card);}}
  }
  async function sendFile(file){
    if(!file||!selected||fileBusy||sending)return;if(file.size<1||file.size>8*1024*1024){showError(Error('Escolha um arquivo de até 8 MB.'));return;}
    const friendId=selected;fileBusy=true;$('direct-error').textContent='';$('direct-file-status').textContent=`Enviando ${file.name}…`;
    try{await window.stringChat.sendDirectFile({friendId,name:file.name,data:new Uint8Array(await file.arrayBuffer())});if(selected===friendId)$('direct-file-status').textContent='Arquivo entregue.';}catch(error){if(selected===friendId){showError(error);$('direct-file-status').textContent='Arquivo não entregue. Use Tentar novamente.';}}finally{fileBusy=false;$('direct-file-input').value='';}
  }
  $('direct-form').onsubmit=async event=>{event.preventDefault();const input=$('direct-input'),text=input.value.trim();if(!selected||!text||sending||fileBusy)return;const friendId=selected;sending=true;input.value='';$('direct-error').textContent='';
    try{await window.stringChat.sendDirect({friendId,text});}catch(error){if(selected===friendId)showError(error);}finally{sending=false;}
  };
  $('home-friends-button').onclick=showFriends;$('home-add-friend').onclick=addFriend;$('home-create-group').onclick=onCreate;$('home-join-group').onclick=onJoin;
  $('home-group-button').onclick=onGroup;$('home-call-return').onclick=onGroup;$('direct-back').onclick=showFriends;
  $('home-call-dock').querySelectorAll('[data-call-control]').forEach(button=>button.onclick=()=>onCallControl(button.dataset.callControl));
  $('direct-attach').onclick=()=>{$('direct-file-input').accept='';$('direct-file-input').click();};$('direct-gif').onclick=()=>{$('direct-file-input').accept='image/gif';$('direct-file-input').click();};$('direct-file-input').onchange=event=>sendFile(event.target.files[0]);
  $('direct-page').addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});$('direct-page').addEventListener('drop',event=>{if(event.dataTransfer.files.length){event.preventDefault();sendFile(event.dataTransfer.files[0]);}});
  $('direct-input').addEventListener('paste',event=>{if(event.clipboardData.files.length){event.preventDefault();sendFile(event.clipboardData.files[0]);}});
  for(const emoji of emojiList){const button=document.createElement('button');button.type='button';button.textContent=emoji;button.setAttribute('aria-label',emoji);button.onclick=()=>{const input=$('direct-input');input.setRangeText(emoji,input.selectionStart,input.selectionEnd,'end');$('direct-emojis').hidden=true;input.focus();};$('direct-emojis').append(button);}
  $('direct-emoji').onclick=()=>{$('direct-emojis').hidden=!$('direct-emojis').hidden;};document.addEventListener('click',event=>{if(!event.target.closest('#direct-emojis')&&!event.target.closest('#direct-emoji'))$('direct-emojis').hidden=true;});
  window.stringChat.onFriends(value=>{snapshot=value;refresh();});
  window.stringChat.onDirectMessage(message=>{
    if(closed)return;let messages=histories.get(message.friendId)||[];const index=messages.findIndex(m=>m.id===message.id);if(index>=0)messages[index]=message;else messages.push(message);histories.set(message.friendId,messages.slice(-200));
    if(selected===message.friendId){renderMessages(histories.get(selected));if(active&&document.hasFocus())window.stringChat.directRead(selected).catch(()=>{});}
    if(message.authorId!==snapshot.id){sounds.play('message');if(!active||selected!==message.friendId||!document.hasFocus())toast(`Mensagem privada de ${contact(message.friendId)?.name||'um amigo'}.`);}
  });
  window.addEventListener('focus',()=>{if(active&&selected)window.stringChat.directRead(selected).catch(()=>{});});
  window.addEventListener('pagehide',()=>{closed=true;observer.disconnect();cleanupImages();});
  window.stringChat.getFriends().then(value=>{snapshot=value;refresh();}).catch(showError);
  showFriends();
  return{showFriends,openConversation,setActive(value){active=value;updateHeader();if(active&&selected&&document.hasFocus())window.stringChat.directRead(selected).catch(()=>{});},updateSession(session){
    $('home-group-button').hidden=!session.active;$('home-group-button').textContent=session.active?`Voltar para ${session.group}`:'';$('home-call-dock').hidden=!session.active||!session.voice;
    $('home-call-name').textContent=session.voice?`${session.voice} · ${session.group}`:'';
    const state=getVoiceState(session);$('home-call-heading').textContent=session.deafened?state.label:'Você continua na chamada';$('home-call-heading').title=state.label+' · '+state.hearing;
    const hearing=$('home-call-dock').querySelector('[data-call-control=deafen]');hearing.innerHTML=`<svg aria-hidden="true"><use href="#i-${session.deafened?'headphones-off':'headphones'}"/></svg>`;hearing.setAttribute('aria-pressed',String(session.deafened));hearing.setAttribute('aria-label',session.deafened?'Reativar áudio recebido':'Silenciar áudio recebido');hearing.title=hearing.getAttribute('aria-label');hearing.classList.toggle('voice-deafened',session.deafened);
    const mic=$('home-call-dock').querySelector('[data-call-control=mic]');mic.textContent=session.deafened?'Microfone pausado':session.mic?'Mutar microfone':'Ligar microfone';mic.setAttribute('aria-pressed',String(session.mic));
    $('home-welcome-name').textContent=getSelf().name;updateHeader();
  }};
}
