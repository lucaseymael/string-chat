export const DEFAULT_SHORTCUTS={mute:'Control+Shift+M',deafen:'Control+Shift+D'};
export function normalizeShortcut(value){
  if(typeof value!=='string'||value.length>90)throw Error('Atalho inválido.');if(!value.trim())return'';
  const parts=value.split('+'),key=parts.pop(),modifiers=['Control','Alt','Shift','Super'].filter(mod=>parts.includes(mod));
  if(parts.length!==modifiers.length||new Set(parts).size!==parts.length||!/^([A-Z0-9]|F([1-9]|1\d|2[0-4])|Space|Home|End|PageUp|PageDown|Insert|Delete)$/.test(key)||(!modifiers.some(m=>m!=='Shift')&&!/^F([6-9]|1\d|2[0-4])$/.test(key)))throw Error('Use Ctrl, Alt ou Win junto de uma tecla, ou uma tecla de F6 a F24.');
  return[...modifiers,key].join('+');
}
export class Shortcuts{
  constructor(driver,trigger){this.driver=driver;this.trigger=trigger;this.current={...DEFAULT_SHORTCUTS};this.status={};}
  apply(value,{strict=false}={}){
    const next={mute:normalizeShortcut(value.mute??DEFAULT_SHORTCUTS.mute),deafen:normalizeShortcut(value.deafen??DEFAULT_SHORTCUTS.deafen)};
    if(next.mute&&next.mute===next.deafen)throw Error('Escolha atalhos diferentes para microfone e áudio recebido.');
    const previous=this.current;for(const key of Object.values(previous))if(key)this.driver.unregister(key);
    const status={};for(const[name,key]of Object.entries(next)){try{status[name]=!key||this.driver.register(key,()=>this.trigger(name));}catch{status[name]=false;}}
    if(strict&&Object.values(status).includes(false)){for(const key of Object.values(next))if(key)this.driver.unregister(key);for(const[name,key]of Object.entries(previous))if(key)this.driver.register(key,()=>this.trigger(name));throw Error('Um desses atalhos já está em uso em outro programa. Escolha outra combinação.');}
    this.current=next;this.status=status;return this.snapshot();
  }
  snapshot(){return{keys:{...this.current},registered:{...this.status}};}
  suspend(){for(const key of Object.values(this.current))if(key)this.driver.unregister(key);}
  resume(){return this.apply(this.current);}
  close(){for(const key of Object.values(this.current))if(key)this.driver.unregister(key);}
}
