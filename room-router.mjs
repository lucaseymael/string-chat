import {EventEmitter} from 'node:events';
import {parseHostedInvite} from './hosted-room-client.mjs';

// One media room at a time, regardless of where its signaling lives.
export class RoomRouter extends EventEmitter {
  constructor({local}){super();this.local=local;this.current=local;this.hosted=null;this.hint=null;this.pending=false;this.attach(local);}
  attach(backend){backend.on('event',event=>{if(this.current===backend)this.emit('event',event);});}
  setHosted(backend){if(this.mode)throw Error('Saia da sala atual antes de trocar de servidor.');this.hosted=backend;if(backend)this.attach(backend);if(this.current!==this.local)this.current=this.local;this.hint=null;}
  prepareFriend(contact){if(this.mode)return;this.hint=contact?.hostedServer||null;if(this.hint&&(!this.hosted?.client.connected||this.hosted.client.url!==this.hint))throw Error('Conecte-se ao servidor deste amigo antes de ligar.');this.current=this.hint?this.hosted:this.local;}
  get mode(){return this.current.mode||(this.pending?'connecting':null);}
  get room(){return this.current.room;}
  get clients(){return this.current.clients;}
  get info(){return this.current.info;}
  get currentInvite(){return this.current.currentInvite;}
  get privateCallsVersion(){return this.current.privateCallsVersion;}
  privateIdentity(){return this.current.privateIdentity();}
  choose(backend){if(this.mode)throw Error('Saia da sala atual antes de abrir outra.');if(!backend)throw Error('Conecte-se ao servidor nas configurações primeiro.');this.current=backend;return backend;}
  async opening(backend,method,value){const target=this.choose(backend);this.pending=true;try{return await target[method](value);}finally{this.pending=false;}}
  create(value){return this.opening(value?.address==='hosted'||value?.transient&&this.hint?this.hosted:this.local,'create',value);}
  join(value){let hosted=false;try{hosted=new URL(String(value?.invite)).hostname==='server';}catch{}if(hosted){const target=parseHostedInvite(value.invite);if(!this.hosted?.client.connected||target.serverUrl!==this.hosted.client.url)throw Error('Conecte-se ao servidor deste convite nas configurações.');}return this.opening(hosted?this.hosted:this.local,'join',value);}
  enter(id){return this.opening(this.hosted,'enter',id);}
  list(){return this.hosted?.client.connected?this.hosted.list():Promise.resolve({groups:[]});}
  poll(){return this.current.poll?.();}
  leave(){this.hint=null;return this.current.leave();}
  setName(...args){return this.current.setName(...args);}
  voice(...args){return this.current.voice(...args);}
  createChannel(...args){return this.current.createChannel(...args);}
  manage(...args){return this.current.manage(...args);}
  messageAction(...args){return this.current.messageAction(...args);}
  typing(...args){return this.current.typing(...args);}
  mediaState(...args){return this.current.mediaState(...args);}
  chat(...args){return this.current.chat(...args);}
  sendAttachment(...args){return this.current.sendAttachment(...args);}
  getAttachment(...args){return this.current.getAttachment(...args);}
  signal(...args){return this.current.signal(...args);}
}
