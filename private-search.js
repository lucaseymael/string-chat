const normalize=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');

export function searchPrivateHistory(messages,query){
  const terms=normalize(String(query??'').slice(0,200)).trim().split(/\s+/).filter(Boolean);
  if(!terms.length)return messages;
  return messages.filter(message=>!message.deleted&&terms.every(term=>normalize(`${message.text||''}\n${message.attachment?.name||''}`).includes(term)));
}

/** Local search only: terms and results never leave this renderer. */
export function setupPrivateSearch({page,before,onQuery,isActive=()=>!page.hidden}){
  const bar=document.createElement('div');bar.className='direct-search';
  const label=document.createElement('label');label.className='sr-only';label.htmlFor='direct-search-input';label.textContent='Buscar no histórico privado carregado';
  const input=document.createElement('input');input.type='search';input.id='direct-search-input';input.placeholder='Buscar mensagens ou arquivos nesta conversa';input.maxLength=200;input.autocomplete='off';input.setAttribute('aria-describedby','direct-search-count');
  const count=document.createElement('span');count.id='direct-search-count';count.className='direct-search-count';count.setAttribute('role','status');
  const clear=document.createElement('button');clear.type='button';clear.className='text-button direct-search-clear';clear.textContent='Limpar';clear.hidden=true;clear.onclick=()=>{input.value='';change();input.focus();};
  bar.append(label,input,clear,count);page.insertBefore(bar,before);
  function change(){clear.hidden=!input.value;onQuery(input.value);}
  input.addEventListener('input',change);input.addEventListener('keydown',event=>{if(event.key==='Escape'&&input.value){event.preventDefault();event.stopPropagation();input.value='';change();}});
  const shortcut=event=>{if(isActive()&&(event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='f'){event.preventDefault();input.focus();input.select();}};
  document.addEventListener('keydown',shortcut);
  return{query:()=>input.value,reset(){input.value='';clear.hidden=true;count.textContent='';},results(shown,total){count.textContent=input.value.trim()?`${shown} ${shown===1?'resultado':'resultados'} · ${total} mensagens carregadas`:'';},dispose(){document.removeEventListener('keydown',shortcut);bar.remove();}};
}
