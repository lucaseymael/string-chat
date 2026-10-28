import {avatarContent} from './profile.js';
export function setupFriends({toast,sounds,joinInvite,openConversation}){
 const $=id=>document.getElementById(id);let snapshot={contacts:[],code:''};const invitations=[];
 const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={online:'Disponível',idle:'Ausente',dnd:'Não perturbe',invisible:'Invisível',offline:'Offline'};
 async function action(fn){try{await fn();}catch(error){$('friends-error').textContent=error.message;toast(error.message,true);}}
 const presence=document.createElement('section');presence.className='presence-select';
 presence.innerHTML='<label for="presence-choice">Sua presença</label><select id="presence-choice"><option value="online">Disponível</option><option value="idle">Ausente</option><option value="dnd">Não perturbe</option><option value="invisible">Invisível</option></select><input id="presence-text" maxlength="128" aria-label="Seu texto de status" placeholder="O que você está fazendo?"><button id="save-presence" type="button" class="button small">Salvar presença</button>';
 $('friends-dialog').querySelector('.dialog-heading').insertAdjacentElement('afterend',presence);
 $('save-presence').onclick=()=>action(async()=>{await window.stringChat.setPresence({status:$('presence-choice').value,statusText:$('presence-text').value});toast('Sua presença foi atualizada.');});
 function render(){
  $('my-friend-code').value=snapshot.code||'Ligue sua rede e clique em Atualizar.';
  if(!presence.contains(document.activeElement)){$('presence-choice').value=snapshot.presence?.status||'online';$('presence-text').value=snapshot.presence?.statusText||'';}
  const pending=snapshot.contacts.filter(c=>c.status==='incoming').length+invitations.length;
  $('friends-button').setAttribute('title',pending?`Amigos · ${pending} novidades`:'Amigos');$('friend-badge').textContent=pending||'';$('friend-badge').hidden=!pending;
  $('friends-list').innerHTML=snapshot.contacts.length?snapshot.contacts.map(friend=>{
   const state=friend.status==='incoming'?'Quer ser seu amigo':friend.status==='outgoing'?'Pedido enviado':friend.status==='blocked'?'Bloqueado':friend.needsVerification?'Revalidar amizade':labels[friend.presence]||'Offline';
   return `<article class="friend-card" data-friend="${safe(friend.id)}"><span class="avatar">${avatarContent(friend,safe)}</span><div class="friend-info"><strong>${safe(friend.name)}</strong><span>${safe(state)}${friend.group?.name?' · '+safe(friend.group.name):''}</span>${friend.statusText?'<small>'+safe(friend.statusText)+'</small>':''}${friend.needsVerification?'<small class="friend-verification">Peça o código atualizado para confirmar esta amizade.</small>':''}${friend.identityFingerprint?'<small title="Identidade desta amizade">Identidade '+safe(friend.identityFingerprint.slice(0,12))+'</small>':''}</div><div class="friend-actions">${friend.status==='blocked'?'<button class="button small" data-action="unblock">Desbloquear</button>':friend.status==='incoming'?'<button class="button small" data-action="accept">Aceitar</button>':friend.status==='friend'?`<button class="button primary small" data-action="message">Mensagem</button>${friend.group?.invite?'<button class="button small" data-action="join">Entrar</button>':''}${friend.needsVerification?'':'<button class="button small" data-action="invite">Convidar</button>'}`:''}${friend.status!=='blocked'?'<button class="button small" data-action="block">Bloquear</button>':''}<button class="icon-button" data-action="remove" title="Remover ou recusar" aria-label="Remover ou recusar">×</button></div></article>`;
  }).join(''):'<div class="friends-empty"><p>Sua lista começa com um convite.</p><span>Envie seu código para um amigo ou cole o dele acima.</span></div>';
  $('friend-invites').innerHTML=invitations.map((item,index)=>`<div class="friend-invitation"><span><strong>${safe(item.name)}</strong> convidou você para um grupo.</span><button class="button primary small" data-join-invite="${index}">Entrar</button><button class="icon-button" data-remove-invite="${index}" aria-label="Recusar convite">×</button></div>`).join('');
  for(const button of document.querySelectorAll('[data-friend] [data-action]'))button.onclick=()=>action(async()=>{
   const id=button.closest('[data-friend]').dataset.friend,friend=snapshot.contacts.find(c=>c.id===id);switch(button.dataset.action){
    case'message':$('friends-dialog').close();openConversation(id);break;
    case'accept':await window.stringChat.acceptFriend(id);sounds.play('success');break;
    case'remove':await window.stringChat.removeFriend(id);break;
    case'block':await window.stringChat.blockFriend(id);toast('Pessoa bloqueada.');break;
    case'unblock':await window.stringChat.unblockFriend(id);toast('Bloqueio removido. Adicione o código novamente para retomar a amizade.');break;
    case'invite':await window.stringChat.inviteFriend(id);toast('Convite enviado para seu amigo.');break;
    case'join':$('friends-dialog').close();await joinInvite(friend.group.invite);break;
   }
  });
  for(const button of document.querySelectorAll('[data-join-invite]'))button.onclick=()=>action(async()=>{const item=invitations.splice(Number(button.dataset.joinInvite),1)[0];render();$('friends-dialog').close();await joinInvite(item.invite);});
  for(const button of document.querySelectorAll('[data-remove-invite]'))button.onclick=()=>{invitations.splice(Number(button.dataset.removeInvite),1);render();};
 }
 async function refresh(){snapshot=await window.stringChat.refreshFriends();render();}
 $('friends-button').onclick=()=>{if(!$('friends-dialog').open)$('friends-dialog').showModal();$('friends-error').textContent='';action(refresh);};
 $('refresh-friends').onclick=()=>action(refresh);
 $('copy-friend-code').onclick=()=>action(async()=>{if(!snapshot.code)throw new Error('Ligue sua rede e atualize a lista.');await navigator.clipboard.writeText(snapshot.code);toast('Seu código de amigo foi copiado.');});
 $('add-friend-form').onsubmit=event=>{event.preventDefault();action(async()=>{await window.stringChat.addFriend($('friend-code-input').value);$('friend-code-input').value='';toast('Pedido de amizade enviado.');});};
 window.stringChat.onFriends(value=>{snapshot=value;render();});
 window.stringChat.onFriendNotice(notice=>{if(notice.kind==='group-invite'){invitations.push(notice);if(invitations.length>10)invitations.shift();if(!notice.silent)toast(`${notice.name} convidou você para um grupo. Abra Amigos para entrar.`);}else if(!notice.silent)toast(notice.kind==='friend-request'?`${notice.name} enviou um pedido de amizade.`:`${notice.name} aceitou sua amizade.`);if(!notice.silent)sounds.play('message');render();});
 window.stringChat.onFriendLink(code=>{if(!$('friends-dialog').open)$('friends-dialog').showModal();$('friend-code-input').value=code;action(async()=>{await window.stringChat.addFriend(code);$('friend-code-input').value='';toast('Pedido de amizade enviado.');});});
 window.stringChat.getFriends().then(value=>{snapshot=value;render();}).catch(()=>{});
}
