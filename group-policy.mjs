import {createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify,diffieHellman,hkdfSync} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';

export const GROUP_PERMISSIONS=['read','send','react','connect','manageChannels','managePermissions','manageGroup','manageMessages','moderateMembers'];
export const validGroupId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const safeKey=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const text=(value,max)=>String(value??'').trim().slice(0,max);
export const defaultRoles=()=>[
 {id:'member',name:'Membro',color:'#91a9c9',position:0,permissions:['read','send','react','connect']},
 {id:'admin',name:'Administrador',color:'#91baff',position:100,permissions:[...GROUP_PERMISSIONS]},
];
export function cleanChannelRules(input){
 const result={};if(!input||typeof input!=='object'||Array.isArray(input))return result;
 for(const[roleId,rules]of Object.entries(input).slice(0,32)){if(!safeKey(roleId)||!rules||typeof rules!=='object')continue;const values={};for(const key of['read','send','react','connect'])if(typeof rules[key]==='boolean')values[key]=rules[key];result[roleId]=values;}
 return result;
}
export function normalizeGroup(room,ownerId){
 const roles=defaultRoles(),seen=new Set(roles.map(r=>r.id));
 for(const raw of(Array.isArray(room.roles)?room.roles:[]).slice(0,24)){if(!safeKey(raw?.id)||seen.has(raw.id))continue;seen.add(raw.id);roles.push({id:raw.id,name:text(raw.name,32)||'Cargo',color:/^#[a-f0-9]{6}$/i.test(raw.color||'')?raw.color:'#91a9c9',position:Math.max(1,Math.min(90,Number(raw.position)||1)),permissions:[...new Set((Array.isArray(raw.permissions)?raw.permissions:[]).filter(p=>GROUP_PERMISSIONS.includes(p)))]});}
 const categories=[],categoryIds=new Set();for(const raw of(Array.isArray(room.categories)?room.categories:[]).slice(0,24)){if(!safeKey(raw?.id)||categoryIds.has(raw.id))continue;categoryIds.add(raw.id);categories.push({id:raw.id,name:text(raw.name,40)||'Categoria'});}
 const channels=[],channelIds=new Set();for(const raw of(Array.isArray(room.channels)?room.channels:[]).slice(0,24)){if(!safeKey(raw?.id)||channelIds.has(raw.id)||!['text','voice'].includes(raw.kind))continue;channelIds.add(raw.id);channels.push({id:raw.id,kind:raw.kind,name:text(raw.name,32)||'Canal',description:text(raw.description,240),categoryId:categoryIds.has(raw.categoryId)?raw.categoryId:null,slowmode:Math.max(0,Math.min(21600,Math.floor(Number(raw.slowmode)||0))),permissions:cleanChannelRules(raw.permissions)});}
 if(!channels.some(c=>c.kind==='text'))channels.unshift({id:'text-geral',kind:'text',name:'geral',description:'',categoryId:null,slowmode:0,permissions:{}});
 if(!channels.some(c=>c.kind==='voice'))channels.push({id:'voice-lobby',kind:'voice',name:'Lobby',description:'',categoryId:null,slowmode:0,permissions:{}});
 const memberships={};for(const[id,raw]of Object.entries(room.memberships||{}).slice(0,512)){if(!validGroupId(id)||!raw||typeof raw!=='object')continue;memberships[id]={roleIds:[...new Set(['member',...(Array.isArray(raw.roleIds)?raw.roleIds:[]).filter(id=>seen.has(id))])],nickname:text(raw.nickname,32),timeoutUntil:Math.max(0,Math.min(Date.now()+28*86400000,Number(raw.timeoutUntil)||0)),serverMuted:id!==ownerId&&raw.serverMuted===true,serverDeafened:id!==ownerId&&raw.serverDeafened===true};}
 const bans=[];for(const raw of(Array.isArray(room.bans)?room.bans:[]).slice(0,512))if(validGroupId(raw?.id)&&raw.id!==ownerId&&!bans.some(b=>b.id===raw.id))bans.push({id:raw.id,reason:text(raw.reason,160),time:Number(raw.time)||Date.now()});
 return{id:room.id,kind:room.kind==='direct'?'direct':'group',...(room.kind==='direct'&&validGroupId(room.callId)?{callId:room.callId}:{}),name:text(room.name,40)||'Grupo',description:text(room.description,240),ownerId,revision:Math.max(0,Math.floor(Number(room.revision)||0)),categories,channels,roles,memberships,bans};
}
export function groupRoles(room,id){const roles=room.memberships[id]?.roleIds||['member'];return room.roles.filter(role=>role.id==='member'||roles.includes(role.id));}
export function groupRank(room,id){return id===room.ownerId?Infinity:Math.max(0,...groupRoles(room,id).map(r=>r.position));}
export function hasGroupPermission(room,id,permission,channel=null){
 if(id===room.ownerId)return true;if(room.bans.some(b=>b.id===id))return false;
 if((room.memberships[id]?.timeoutUntil||0)>Date.now()&&['send','react','connect'].includes(permission))return false;
 const roles=groupRoles(room,id);if(roles.some(r=>r.id==='admin'))return true;
 let allowed=roles.some(r=>r.permissions.includes(permission));
 if(channel&&['read','send','react','connect'].includes(permission))for(const role of[...roles].sort((a,b)=>a.position-b.position)){const rule=channel.permissions?.[role.id];if(typeof rule?.[permission]==='boolean')allowed=rule[permission];}
 if(channel&&permission!=='read'&&!hasGroupPermission(room,id,'read',channel))return false;
 return allowed;
}
export function assertGroupPermission(room,id,permission,channel=null){if(!hasGroupPermission(room,id,permission,channel))throw Error('Você não tem permissão para esta ação.');}
export function assertModerationTarget(room,actorId,targetId){assertGroupPermission(room,actorId,'moderateMembers');if(!validGroupId(targetId)||targetId===actorId||targetId===room.ownerId||groupRank(room,targetId)>=groupRank(room,actorId))throw Error('Este membro não pode ser moderado por você.');}

// Domain-separated keys bind returning members to the key first admitted by this group.
// Display names are user-supplied: first contact remains trust on first use.
export function loadGroupIdentity(statePath){
 const path=statePath?statePath+'.identity.json':null;let saved;
 if(path)try{saved=JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('A identidade do grupo está inválida e foi preservada.');}
 let privateKey,publicKey;
 if(saved){try{privateKey=createPrivateKey({key:Buffer.from(saved.privateKey,'base64url'),format:'der',type:'pkcs8'});if(privateKey.asymmetricKeyType!=='ed25519')throw Error();publicKey=createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64url');if(publicKey!==saved.publicKey)throw Error();}catch{throw Error('A identidade do grupo está inválida e foi preservada.');}}
 else{const pair=generateKeyPairSync('ed25519');privateKey=pair.privateKey;publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64url');saved={version:1,privateKey:privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'),publicKey,hosts:{}};}
 const hosts={};for(const[id,key]of Object.entries(saved.hosts||{}).slice(-256))if(validGroupId(id)&&typeof key==='string'&&key.length<128)hosts[id]=key;
 const identity={privateKey,publicKey,hosts,persist(){if(!path)return;mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify({...saved,hosts:this.hosts}),{mode:0o600});renameSync(path+'.tmp',path);}};identity.persist();return identity;
}
export function groupSignature(identity,fields){return sign(null,Buffer.from(['stringchat-group-v2',...fields].join('\n')),identity.privateKey).toString('base64url');}
export function verifyGroupSignature(publicKey,fields,signature){try{if(typeof publicKey!=='string'||publicKey.length>128||typeof signature!=='string'||signature.length>128)return false;const key=createPublicKey({key:Buffer.from(publicKey,'base64url'),format:'der',type:'spki'});return key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(['stringchat-group-v2',...fields].join('\n')),key,Buffer.from(signature,'base64url'));}catch{return false;}}
export function groupEphemeral(){const pair=generateKeyPairSync('x25519');return{privateKey:pair.privateKey,publicKey:pair.publicKey.export({format:'der',type:'spki'}).toString('base64url')};}
export function groupSessionKey(ephemeral,remotePublicKey,token,fields){const key=createPublicKey({key:Buffer.from(remotePublicKey,'base64url'),format:'der',type:'spki'});if(key.asymmetricKeyType!=='x25519')throw Error('Chave de conexão inválida.');return Buffer.from(hkdfSync('sha256',diffieHellman({privateKey:ephemeral.privateKey,publicKey:key}),Buffer.from(token,'base64url'),Buffer.from(['stringchat-group-session-v2',...fields].join('\n')),32));}
