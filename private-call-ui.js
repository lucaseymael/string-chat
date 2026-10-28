const phases=new Set(['outgoing','incoming','connecting','active','ended']);
const rank=phase=>phase==='incoming'||phase==='outgoing'?1:phase==='connecting'?2:phase==='active'?3:4;
const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const endLabels={declined:'O amigo recusou a chamada.',busy:'O amigo já está em outra chamada ou grupo.',timeout:'A chamada não foi atendida.',cancelled:'Chamada cancelada.',failed:'Não foi possível conectar a chamada.',blocked:'A chamada foi encerrada porque a amizade não está disponível.',disconnected:'A conexão da chamada foi encerrada.',closed:'Chamada encerrada.',ended:'Chamada encerrada.'};

/** Own call controls and consent dialog. Media capture stays in the app's onPhase callback. */
export function setupPrivateCallUI({getSelectedFriend,onPhase=()=>{},toast=()=>{}}){
  const api=window.stringChat,header=document.querySelector('.direct-header');
  if(!header||typeof getSelectedFriend!=='function')throw Error('A área de conversas privadas não está disponível.');
  if(!document.getElementById('private-call-style')){const link=document.createElement('link');link.id='private-call-style';link.rel='stylesheet';link.href='./private-call.css';document.head.append(link);}
  const controls=document.createElement('div');controls.className='private-call-tools';controls.setAttribute('aria-label','Chamadas privadas');
  controls.innerHTML=`<button type="button" class="button small private-call-voice" title="Iniciar chamada de voz" aria-label="Iniciar chamada privada de voz">${icon('phone')}<span>Voz</span></button><button type="button" class="button small private-call-video" title="Iniciar chamada de vídeo" aria-label="Iniciar chamada privada de vídeo">${icon('camera')}<span>Vídeo</span></button><button type="button" class="button small private-call-open" hidden aria-label="Ver chamada privada">${icon('phone')}<span>Em chamada</span></button>`;
  header.append(controls);
  const voice=controls.querySelector('.private-call-voice'),video=controls.querySelector('.private-call-video'),open=controls.querySelector('.private-call-open');
  const dialog=document.createElement('dialog');dialog.className='private-call-dialog';dialog.setAttribute('aria-labelledby','private-call-title');dialog.setAttribute('aria-describedby','private-call-description');
  dialog.innerHTML=`<button type="button" class="icon-button private-call-dismiss" title="Fechar" aria-label="Fechar chamada">${icon('close')}</button><div class="private-call-halo"><span class="private-call-avatar" aria-hidden="true"></span></div><span class="private-call-badge"></span><h2 id="private-call-title"></h2><p id="private-call-description"></p><p class="private-call-error" role="alert"></p><div class="private-call-actions"><button type="button" class="button danger private-call-reject"></button><button type="button" class="button primary private-call-accept"></button><button type="button" class="button private-call-continue" hidden>Continuar na chamada</button></div>`;
  document.body.append(dialog);
  const avatar=dialog.querySelector('.private-call-avatar'),title=dialog.querySelector('h2'),description=dialog.querySelector('#private-call-description'),badge=dialog.querySelector('.private-call-badge'),error=dialog.querySelector('.private-call-error'),reject=dialog.querySelector('.private-call-reject'),accept=dialog.querySelector('.private-call-accept'),keep=dialog.querySelector('.private-call-continue'),dismiss=dialog.querySelector('.private-call-dismiss');
  let state=null,working=false,ending=false,disposed=false,renderKey='',lastSelected='',observer;const seen=new Map(),recent=[];
  const selected=()=>{let value;try{value=getSelectedFriend();}catch{return null;}return typeof value==='string'?{id:value}:value;};
  const selectedId=()=>selected()?.id||null;
  const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
  function person(){
    avatar.replaceChildren();const source=state?.avatar;
    if(typeof source==='string'&&source.length<100000&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source)){const image=document.createElement('img');image.src=source;image.alt='';avatar.append(image);}
    else avatar.textContent=String(state?.name||'Amigo').trim().split(/\s+/).slice(0,2).map(part=>part[0]||'').join('').toUpperCase();
  }
  function showDialog(){if(!disposed&&!dialog.open){try{dialog.showModal();}catch{dialog.show();}}}
  function render(){
    if(disposed)return;
    const friend=selected(),available=validId(friend?.id)&&friend.status!=='blocked'&&friend.needsVerification!==true;
    const same=!!state&&state.friendId===friend?.id&&state.phase!=='ended',active=!!state&&state.phase!=='ended';
    voice.hidden=video.hidden=same;open.hidden=!same;
    voice.disabled=video.disabled=working||!available||active;open.disabled=working;
    const name=String(friend?.name||'amigo').slice(0,80);voice.title=`Iniciar chamada de voz com ${name}`;video.title=`Iniciar chamada de vídeo com ${name}`;
    const key=state?`${state.callId}:${state.phase}:${state.name}:${state.mode}:${working}:${ending}`:'none';if(key===renderKey)return;renderKey=key;
    if(!state||state.phase==='ended'){if(dialog.open)dialog.close();return;}
    dialog.dataset.phase=state.phase;person();setText(error,'');const camera=state.mode==='video';
    setText(badge,camera?'CHAMADA DE VÍDEO':'CHAMADA DE VOZ');setText(title,state.name||'Amigo');
    accept.hidden=state.phase!=='incoming';keep.hidden=state.phase!=='active';
    setText(accept,camera?'Atender com vídeo':'Atender');
    setText(reject,state.phase==='incoming'?'Recusar':state.phase==='active'?'Encerrar chamada':'Cancelar');
    if(state.phase==='incoming')setText(description,camera?'Quer conversar por vídeo? A câmera e o microfone só serão solicitados depois que você aceitar.':'Quer conversar? O microfone só será solicitado depois que você atender.');
    else if(state.phase==='outgoing')setText(description,'Esperando seu amigo atender. A câmera e o microfone continuam desligados durante o toque.');
    else if(state.phase==='connecting')setText(description,'Conectando vocês em uma chamada privada.');
    else setText(description,camera?'Vocês estão em uma chamada privada de vídeo.':'Vocês estão em uma chamada privada de voz.');
    accept.disabled=working||ending;reject.disabled=dismiss.disabled=ending;
    if(state.phase==='active'){if(dialog.open)dialog.close();}
    else showDialog();
  }
  function refresh(){const id=selectedId();if(id!==lastSelected){lastSelected=id;renderKey='';}render();}
  async function perform(run){
    if(working||disposed)return;working=true;render();
    try{const result=await run();if(result&&typeof result==='object'&&phases.has(result.phase))handleEvent(result);return result;}
    catch(reason){const message=String(reason?.message||reason||'Não foi possível concluir a chamada.').slice(0,240);setText(error,message);toast(message,true);}
    finally{working=false;renderKey='';render();}
  }
  function start(mode){const friendId=selectedId();if(!validId(friendId)){toast('Escolha um amigo para iniciar uma chamada.',true);return;}return perform(()=>api.privateCallStart({friendId,mode}));}
  async function stop(){
    if(!state||ending||disposed)return;const value={callId:state.callId},incoming=state.phase==='incoming';ending=true;renderKey='';render();
    try{const result=await(incoming?api.privateCallDecline(value):api.privateCallEnd(value));if(result&&phases.has(result.phase))handleEvent(result);return result;}
    catch(reason){toast(String(reason?.message||reason).slice(0,240),true);}
    finally{ending=false;renderKey='';render();}
  }
  function handleEvent(value){
    if(disposed||!value||!validId(value.callId)||!validId(value.friendId)||!phases.has(value.phase))return;
    const previous=seen.get(value.callId),nextRank=rank(value.phase);if(previous&&nextRank<previous.rank)return;
    if(state&&state.callId!==value.callId&&state.phase!=='ended'&&value.phase==='ended')return;
    const fingerprint=[value.phase,value.friendId,value.name,value.mode,value.expiresAt,value.reason].join(':');
    if(previous?.fingerprint===fingerprint)return;
    seen.set(value.callId,{rank:nextRank,fingerprint});while(seen.size>64)seen.delete(seen.keys().next().value);
    state={...value,name:String(value.name||'Amigo').slice(0,80)};renderKey='';render();
    try{Promise.resolve(onPhase(state)).catch(reason=>toast(String(reason?.message||reason).slice(0,240),true));}catch(reason){toast(String(reason?.message||reason).slice(0,240),true);}
    if(state.phase==='ended'){
      recent.unshift({callId:state.callId,friendId:state.friendId,name:state.name,mode:state.mode,reason:state.reason||'ended',time:Date.now()});if(recent.length>12)recent.length=12;
      toast(endLabels[state.reason]||endLabels.ended,state.reason==='failed');
    }
  }
  voice.onclick=()=>start('voice');video.onclick=()=>start('video');open.onclick=()=>showDialog();accept.onclick=()=>state&&perform(()=>api.privateCallAccept({callId:state.callId}));reject.onclick=stop;keep.onclick=()=>dialog.close();
  dismiss.onclick=()=>state?.phase==='active'?dialog.close():stop();
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(state?.phase==='active')dialog.close();else stop();});
  const subscription=typeof api.onPrivateCall==='function'?api.onPrivateCall(handleEvent):null;
  observer=new MutationObserver(refresh);observer.observe(header,{childList:true,subtree:true});refresh();
  function dispose(){if(disposed)return;disposed=true;observer.disconnect();if(typeof subscription==='function')subscription();dialog.remove();controls.remove();window.removeEventListener('pagehide',dispose);}
  window.addEventListener('pagehide',dispose,{once:true});
  return{handleEvent,refresh,startVoice:()=>start('voice'),startVideo:()=>start('video'),recent:()=>recent.map(value=>({...value})),snapshot:()=>state?{...state}:null,dispose};
}
