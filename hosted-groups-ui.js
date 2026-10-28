const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;

/** Lists remembered server memberships. Joining always requires an explicit click. */
export function setupHostedGroups({container='#home-friends-page',toast=()=>{},onEnter,getConnected,isHomeVisible}={}){
  const api=window.stringChat,parent=typeof container==='string'?document.querySelector(container):container;
  if(!parent)throw Error('A página inicial não está disponível.');
  if(!document.getElementById('hosted-groups-style')){const link=document.createElement('link');link.id='hosted-groups-style';link.rel='stylesheet';link.href='./hosted-groups.css';document.head.append(link);}
  const section=document.createElement('section');section.className='hosted-groups';section.setAttribute('aria-label','Seus grupos no servidor');
  section.innerHTML='<header class="hosted-groups-heading"><div><span class="hosted-groups-eyebrow">SEU PONTO DE ENCONTRO</span><h3>Grupos no servidor</h3></div><button class="button small hosted-groups-refresh" type="button" aria-label="Atualizar grupos no servidor">Atualizar</button></header><p class="hosted-groups-note">Volte para seus grupos quando quiser. Você escolhe quando entrar.</p><p class="hosted-groups-status" role="status"></p><div class="hosted-groups-list"></div>';
  parent.append(section);
  const status=section.querySelector('.hosted-groups-status'),list=section.querySelector('.hosted-groups-list'),reload=section.querySelector('.hosted-groups-refresh'),app=document.querySelector('.app');
  let connected=getConnected?.()===true,closed=false,epoch=0,pending=null,entering=null,groups=[],loadError='';
  const visible=()=>!document.hidden&&(isHomeVisible?isHomeVisible():!parent.hidden&&(!app||app.classList.contains('home-view')));
  const connection=()=>typeof getConnected==='function'?getConnected()===true:connected;
  function render(){
    if(closed)return;list.replaceChildren();reload.disabled=!connection()||!!pending||!!entering;
    if(!connection()){status.textContent='Conecte-se ao servidor para ver seus grupos.';return;}
    if(pending&&!groups.length){status.textContent='Buscando seus grupos…';return;}
    status.textContent=loadError||(groups.length?'':'Você ainda não entrou em grupos neste servidor. Use um convite ou crie seu primeiro grupo.');
    for(const group of groups){
      const row=document.createElement('article');row.className='hosted-group-card';row.dataset.groupId=group.id;
      const avatar=document.createElement('span');avatar.className='hosted-group-avatar';avatar.setAttribute('aria-hidden','true');avatar.textContent=Array.from(group.name)[0]?.toLocaleUpperCase()||'#';
      const body=document.createElement('div');body.className='hosted-group-body';const title=document.createElement('h4');title.textContent=group.name;const description=document.createElement('p');description.textContent=group.description||'Um espaço para conversar e reunir a galera.';const members=document.createElement('span');members.className='hosted-group-members';members.textContent=`${group.members} ${group.members===1?'membro':'membros'} · ${group.online} online`;body.append(title,description,members);
      const button=document.createElement('button');button.type='button';button.className='button primary small hosted-group-enter';button.textContent=entering===group.id?'Entrando…':'Entrar';button.disabled=!!entering;button.setAttribute('aria-label',`Entrar no grupo ${group.name}`);button.onclick=()=>enter(group.id);row.append(avatar,body,button);list.append(row);
    }
  }
  async function enter(id){
    if(closed||entering||!connection()||!groups.some(group=>group.id===id))return;
    entering=id;render();try{
      if(typeof onEnter==='function')await onEnter(id);else await api.enterHostedGroup({id});
    }catch(error){if(!closed)toast(error.message||'Não foi possível entrar no grupo.');}finally{if(!closed){entering=null;render();}}
  }
  function refresh(){
    if(closed||!connection()||!visible())return Promise.resolve([]);if(pending)return pending;
    const generation=++epoch;loadError='';
    pending=(async()=>{
      try{const result=await Promise.resolve().then(()=>api.hostedGroups());if(closed||generation!==epoch||!connection())return[];const seen=new Set();groups=(Array.isArray(result?.groups)?result.groups:[]).filter(group=>validId(group?.id)&&!seen.has(group.id)&&seen.add(group.id)).slice(0,200).map(group=>({id:group.id,name:String(group.name||'Grupo sem nome').slice(0,80),description:String(group.description||'').slice(0,240),members:count(group.members),online:count(group.online)}));return groups.slice();}
      catch(error){if(!closed&&generation===epoch){loadError=error.message||'Não foi possível carregar os grupos.';toast(loadError);}return[];}
      finally{if(generation===epoch){pending=null;render();}}
    })();render();return pending;
  }
  function setConnected(value){const next=value===true;if(next===connected){if(next&&visible())refresh();return;}connected=next;epoch++;pending=null;groups=[];loadError='';render();if(next&&visible())refresh();}
  reload.onclick=refresh;
  const unsubscribe=api.onHostedStatus?.(value=>{if(typeof value?.connected==='boolean')setConnected(value.connected);});
  const observer=new MutationObserver(records=>{if(records.some(record=>record.target===parent||record.target===app)&&visible()&&connection())refresh();});
  if(app)observer.observe(app,{attributes:true,subtree:true,attributeFilter:['class','hidden']});else observer.observe(parent,{attributes:true,attributeFilter:['hidden']});
  const onVisibility=()=>{if(visible()&&connection())refresh();};document.addEventListener('visibilitychange',onVisibility);
  const timer=setInterval(()=>{if(visible()&&connection())refresh();},10000);
  render();if(connection()&&visible())refresh();
  return{refresh,setConnected,element:section,snapshot:()=>({connected:connection(),groups:groups.slice(),entering}),dispose(){if(closed)return;closed=true;epoch++;clearInterval(timer);observer.disconnect();unsubscribe?.();document.removeEventListener('visibilitychange',onVisibility);section.remove();}};
}
