const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reactionChoices=['👍','❤️','😂','🎉','👀','🔥','😮','😢'];

// Parse only a small, bounded formatting vocabulary. Raw HTML is always text.
export function formatMessage(value){
  const text=String(value||'').slice(0,4000),tokens=[];
  let html=safe(text).replace(/```([^\n`]{0,30})\n?([\s\S]*?)```|`([^`\n]+)`/g,(_,language,block,inline)=>{
    const code=block===undefined?`<code>${inline}</code>`:`<pre><code>${block}</code></pre>`;
    return `\u0000${tokens.push(code)-1}\u0000`;
  });
  html=html.replace(/\*\*([^\n]+?)\*\*/g,'<strong>$1</strong>').replace(/__([^\n]+?)__/g,'<u>$1</u>').replace(/~~([^\n]+?)~~/g,'<s>$1</s>').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g,'$1<em>$2</em>').replace(/\|\|([^\n]+?)\|\|/g,'<button class="message-spoiler" type="button" aria-label="Revelar spoiler">$1</button>');
  html=html.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  // Code tokens are expanded last, so markup inside code never becomes controls.
  return html.replace(/\u0000(\d+)\u0000/g,(_,index)=>tokens[Number(index)]||'');
}

function button(text,action,run){const node=document.createElement('button');node.type='button';node.className='message-tool';node.textContent=text;node.dataset.messageAction=action;node.onclick=run;return node;}
function actionDialog({title,value='',label='Mensagem',confirm='Salvar',danger=false,submit}){
  const dialog=document.createElement('dialog');dialog.className='message-action-dialog';
  const heading=document.createElement('h2');heading.textContent=title;dialog.append(heading);
  const form=document.createElement('form'),field=document.createElement('textarea'),error=document.createElement('p');field.value=value;field.maxLength=2000;field.rows=4;field.setAttribute('aria-label',label);
  if(!danger)form.append(field);else{const note=document.createElement('p');note.textContent='Esta mensagem será removida para os participantes da conversa.';form.append(note);}
  error.className='dialog-error';error.setAttribute('role','alert');form.append(error);
  const actions=document.createElement('div');actions.className='dialog-actions';const cancel=button('Cancelar','cancel',()=>dialog.close()),save=button(confirm,'confirm',()=>{});save.type='submit';save.className='button '+(danger?'danger':'primary');cancel.className='button';actions.append(cancel,save);form.append(actions);dialog.append(form);
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;error.textContent='';try{if(!danger&&!field.value.trim())throw Error('Escreva uma mensagem.');await submit(field.value);dialog.close();}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();if(!danger){field.focus();field.setSelectionRange(field.value.length,field.value.length);}else cancel.focus();
}

export function setupMessageTools({list,input,form,getMessages,getSelf,onEdit,onDelete,onReact,onPin,onTyping,onRetryAction,canDelete=message=>message.authorId===getSelf(),canPin=()=>true,toast,getName=message=>message.name||'Mensagem'}){
  let replyTo=null,typingAt=0,typingStopped=0,typingTimer,typingStartTimer,typingExpires,filter='all';const people=new Map();
  const reply=document.createElement('div');reply.className='composer-reply';reply.hidden=true;form.prepend(reply);
  const typing=document.createElement('div');typing.className='typing-indicator';typing.setAttribute('role','status');form.prepend(typing);
  const toolbar=document.createElement('div');toolbar.className='conversation-tools';
  const pinned=button('Fixadas','pins',()=>{filter=filter==='pins'?'all':'pins';pinned.setAttribute('aria-pressed',String(filter==='pins'));applyFilter();});pinned.setAttribute('aria-pressed','false');toolbar.append(pinned);list.insertAdjacentElement('beforebegin',toolbar);
  const applyFilter=()=>{for(const row of list.querySelectorAll('.message[data-message]')){const message=getMessages().find(m=>m.id===row.dataset.message);row.classList.toggle('message-filtered',filter==='pins'&&!message?.pinned);}};
  const resetReply=()=>{replyTo=null;reply.hidden=true;reply.replaceChildren();};
  function setReply(message){replyTo=message.id;reply.replaceChildren();const label=document.createElement('span');label.textContent='Respondendo a '+getName(message)+': '+(message.deleted?'Mensagem removida':message.text||'Anexo').slice(0,100);reply.append(label,button('Cancelar','cancel-reply',resetReply));reply.hidden=false;input.focus();}
  async function run(fn){try{await fn();}catch(e){toast(e.message,true);}}
  function decorate(row,message){
    row.dataset.message=message.id;row.dataset.searchText=[getName(message),message.deleted?'Mensagem removida':message.text,message.attachment?.name].join(' ');row.classList.toggle('message-deleted',!!message.deleted);
    const body=row.children[1];if(!body)return;
    let content=body.querySelector('p');if(!content&&message.deleted){content=document.createElement('p');body.append(content);}if(content){content.classList.add('message-text');content.innerHTML=message.deleted?'Mensagem removida':formatMessage(message.text);}
    if(message.deleted){body.querySelector('.message-attachment')?.remove();body.querySelector('.direct-delivery')?.remove();}
    if(message.editedAt&&!message.deleted){const edited=document.createElement('span');edited.className='message-edited';edited.textContent='editada';edited.title=new Date(message.editedAt).toLocaleString();body.querySelector('.message-heading')?.append(edited);}
    if(message.replyTo){const original=getMessages().find(m=>m.id===message.replyTo),reference=button('↳ '+(original?getName(original)+': '+(original.deleted?'Mensagem removida':original.text||'Anexo'):'Mensagem anterior'),'jump-reply',()=>{const target=[...list.querySelectorAll('[data-message]')].find(n=>n.dataset.message===message.replyTo);if(target){target.scrollIntoView({block:'center',behavior:'smooth'});target.classList.add('message-highlight');setTimeout(()=>target.classList.remove('message-highlight'),1600);}else toast('A mensagem original não está mais no histórico carregado.');});reference.className='reply-reference';body.prepend(reference);}
    if(message.pinned&&!message.deleted){const pin=document.createElement('span');pin.className='message-pin';pin.textContent='Fixada';body.prepend(pin);}
    for(const spoiler of body.querySelectorAll('.message-spoiler'))spoiler.onclick=()=>{spoiler.classList.toggle('revealed');spoiler.setAttribute('aria-pressed',String(spoiler.classList.contains('revealed')));};
    if(!message.deleted){
      const reactions=document.createElement('div');reactions.className='message-reactions';
      for(const entry of reactionEntries(message.reactions)){const active=entry.users.includes(getSelf()),reaction=button(entry.emoji+' '+entry.users.length,'reaction',()=>run(()=>onReact(message,entry.emoji,!active)));reaction.dataset.emoji=entry.emoji;reaction.setAttribute('aria-pressed',String(active));reactions.append(reaction);}body.append(reactions);
      const tools=document.createElement('div');tools.className='message-tools';tools.setAttribute('aria-label','Ações da mensagem');tools.append(button('Responder','reply',()=>setReply(message)));
      const choose=button('Reagir','react',()=>{let picker=tools.querySelector('.reaction-picker');if(picker){picker.remove();return;}picker=document.createElement('span');picker.className='reaction-picker';for(const emoji of reactionChoices)picker.append(button(emoji,'choose-reaction',()=>{picker.remove();run(()=>onReact(message,emoji,true));}));tools.append(picker);});tools.append(choose);
      if(canPin(message))tools.append(button(message.pinned?'Desafixar':'Fixar','pin',()=>run(()=>onPin(message,!message.pinned))));
      if(message.authorId===getSelf()&&message.text)tools.append(button('Editar','edit',()=>actionDialog({title:'Editar mensagem',value:message.text,submit:text=>onEdit(message,text)})));
      if(canDelete(message))tools.append(button('Excluir','delete',()=>actionDialog({title:'Excluir mensagem?',danger:true,confirm:'Excluir',submit:()=>onDelete(message)})));
      tools.append(button('Copiar','copy',()=>run(()=>navigator.clipboard.writeText(message.text||''))));body.append(tools);
    }
    if(!message.deleted&&window.stringChat?.openGroupInvite)for(const invite of [...new Set((message.text||'').match(/stringchat:\/\/(?:join\?|server\/join\?)[^\s<>"']+/g)||[])].slice(0,3)){const join=button('Entrar no grupo','join-group',()=>run(()=>window.stringChat.openGroupInvite(invite)));join.classList.add('message-group-invite');body.append(join);}
    if(onRetryAction&&message.authorId===getSelf())for(const pending of message.pendingActions||[]){const status=document.createElement('div');status.className='direct-delivery';status.textContent=pending.status==='failed'?'Alteração ainda não confirmada. ':pending.status==='queued'?'Aguardando entrega pelo servidor… ':'Confirmando alteração… ';if(pending.status==='failed')status.append(button('Tentar alteração novamente','retry-action',()=>run(()=>onRetryAction(message,pending.id))));body.append(status);}
    row.classList.toggle('message-filtered',filter==='pins'&&!message.pinned);
  }
  function stopTyping(){clearTimeout(typingTimer);clearTimeout(typingStartTimer);typingAt=0;typingStopped=Date.now();if(onTyping)Promise.resolve(onTyping(false)).catch(()=>{});}
  function startTyping(){if(!onTyping||!input.value.trim())return;const now=Date.now(),wait=Math.max(0,600-(now-typingStopped),typingAt?2200-(now-typingAt):0);clearTimeout(typingStartTimer);if(wait>0){typingStartTimer=setTimeout(startTyping,wait);return;}typingAt=now;Promise.resolve(onTyping(true)).catch(()=>{});}
  input.addEventListener('input',()=>{if(!onTyping)return;if(!input.value.trim()){stopTyping();return;}startTyping();clearTimeout(typingTimer);typingTimer=setTimeout(stopTyping,3200);});input.addEventListener('blur',stopTyping);
  input.addEventListener('keydown',event=>{if(event.key==='Escape'){resetReply();return;}if(event.key==='ArrowUp'&&!input.value){const own=[...getMessages()].reverse().find(m=>m.authorId===getSelf()&&!m.deleted&&m.text);if(own){event.preventDefault();actionDialog({title:'Editar última mensagem',value:own.text,submit:text=>onEdit(own,text)});}}});
  function renderTyping(){const now=Date.now();for(const[id,person]of people)if(person.until<now)people.delete(id);typing.textContent=people.size?[...people.values()].map(p=>p.name).slice(0,3).join(', ')+(people.size===1?' está digitando…':' estão digitando…'):'';clearTimeout(typingExpires);if(people.size)typingExpires=setTimeout(renderTyping,500);}
  window.addEventListener('pagehide',()=>{clearTimeout(typingTimer);clearTimeout(typingStartTimer);clearTimeout(typingExpires);});
  return{decorate,replyId:()=>replyTo,sent(){resetReply();stopTyping();},reset(){resetReply();people.clear();renderTyping();filter='all';pinned.setAttribute('aria-pressed','false');},typing({id,name,active}){if(id===getSelf())return;if(active)people.set(id,{name:String(name||'Alguém').slice(0,32),until:Date.now()+6000});else people.delete(id);renderTyping();}};
}

export function reactionEntries(value){
  if(Array.isArray(value))return value.filter(r=>typeof r?.emoji==='string'&&Array.isArray(r.users||r.memberIds)).map(r=>({emoji:r.emoji,users:r.users||r.memberIds}));
  return Object.entries(value||{}).filter(([,users])=>Array.isArray(users)).map(([emoji,users])=>({emoji,users}));
}
