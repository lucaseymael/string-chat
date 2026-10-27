export function shortcutFromEvent(event){
  const modifiers=[];if(event.ctrlKey)modifiers.push('Control');if(event.altKey)modifiers.push('Alt');if(event.shiftKey)modifiers.push('Shift');if(event.metaKey)modifiers.push('Super');
  let key=/^Key[A-Z]$/.test(event.code)?event.code.slice(3):/^Digit\d$/.test(event.code)?event.code.slice(5):event.code;
  if(['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight'].includes(key))return null;
  return[...modifiers,key].join('+');
}
export function setupShortcuts({settings,onTrigger}){
  const $=id=>document.getElementById(id);let recording=null,last={};
  function trigger(type){if(recording||Date.now()-(last[type]||0)<180)return;last[type]=Date.now();onTrigger(type);}
  for(const type of['mute','deafen']){
    $('bind-'+type).onclick=async()=>{await window.stringChat.suspendShortcuts();recording=type;$('shortcut-'+type).value='Pressione as teclas…';$('bind-'+type).textContent='Esc para cancelar';};
    $('clear-'+type).onclick=()=>{$('shortcut-'+type).dataset.key='';$('shortcut-'+type).value='Desativado';};
  }
  document.addEventListener('keydown',event=>{
    if(recording){event.preventDefault();event.stopImmediatePropagation();if(event.code==='Escape'){recording=null;window.stringChat.resumeShortcuts();render();return;}const key=shortcutFromEvent(event);if(!key)return;$('shortcut-'+recording).dataset.key=key;$('shortcut-'+recording).value=display(key);$('bind-'+recording).textContent='Definir';recording=null;window.stringChat.resumeShortcuts();return;}
    if(event.repeat)return;const key=shortcutFromEvent(event);for(const type of['mute','deafen'])if(key&&key===settings[type+'Shortcut']){event.preventDefault();trigger(type);}
  },true);
  window.stringChat.onShortcut(trigger);
  $('settings-dialog').addEventListener('close',()=>{recording=null;window.stringChat.resumeShortcuts();});
  function display(key){return key?key.replaceAll('Control','Ctrl').replaceAll('Super','Win').replaceAll('+',' + '):'Desativado';}
  async function render(){recording=null;for(const type of['mute','deafen']){$('shortcut-'+type).dataset.key=settings[type+'Shortcut'];$('shortcut-'+type).value=display(settings[type+'Shortcut']);$('bind-'+type).textContent='Definir';}try{const state=await window.stringChat.shortcutStatus();$('shortcuts-status').textContent=Object.values(state.registered).includes(false)?'Há um atalho em uso por outro programa. Defina outra combinação.':'Os atalhos funcionam também com o String Chat em segundo plano.';}catch{}}
  return{render,values:()=>({muteShortcut:$('shortcut-mute').dataset.key,deafenShortcut:$('shortcut-deafen').dataset.key})};
}
