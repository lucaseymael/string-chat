import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';

const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const MAX_FILE=8*1024*1024,CHUNK=24*1024;
function mime(data){if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(data[0]===255&&data[1]===216&&data[2]===255)return'image/jpeg';if(/^GIF8[79]a$/.test(data.subarray(0,6).toString()))return'image/gif';if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return'image/webp';return'application/octet-stream';}
function filename(value){return String(value||'arquivo').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,120)||'arquivo';}

// Private chat has a separate store and an authenticated key for each friendship.
// The room creator and other friends never receive private-chat packets.
export class DirectMessages {
  constructor({path,getIdentity,getContact,request,onChange,onMessage}){
    Object.assign(this,{path,getIdentity,getContact,request,onChange,onMessage});this.uploads=new Map();this.busy=new Set();this.rates=new Map();
    let saved;try{saved=JSON.parse(readFileSync(path,'utf8'));}catch{saved={};}
    this.messages=(Array.isArray(saved.messages)?saved.messages:[]).filter(m=>validId(m.id)&&validId(m.friendId)&&validId(m.authorId)&&typeof m.text==='string'&&m.text.length<=2000&&Number.isFinite(m.time)).slice(-2000).map(m=>({...m,status:m.status==='sending'?'failed':m.status}));
    this.unreadCounts=new Map(Object.entries(saved.unread||{}).filter(([id,n])=>validId(id)&&Number.isInteger(n)&&n>0));
    this.mediaDir=join(dirname(path),'private-media');
  }
  contact(id){const contact=this.getContact(id);if(!validId(id)||contact?.status!=='friend')throw new Error('Aceite a amizade antes de conversar em privado.');return contact;}
  key(contact){const own=this.getIdentity();const pair=[own,{id:contact.id,key:contact.key}].sort((a,b)=>a.id.localeCompare(b.id));return Buffer.from(hkdfSync('sha256',Buffer.concat(pair.map(p=>Buffer.from(p.key,'base64url'))),Buffer.from(pair.map(p=>p.id).join(':')),Buffer.from('string-chat:private:v1'),32));}
  seal(contact,payload){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(contact),nonce);const data=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);return{n:nonce.toString('base64url'),d:data.toString('base64url'),t:cipher.getAuthTag().toString('base64url')};}
  open(contact,packet){if(typeof packet?.d!=='string'||packet.d.length>65000||typeof packet.n!=='string'||typeof packet.t!=='string')throw new Error('Mensagem privada inválida.');const nonce=Buffer.from(packet.n,'base64url'),tag=Buffer.from(packet.t,'base64url');if(nonce.length!==12||tag.length!==16)throw new Error('Mensagem privada inválida.');const decipher=createDecipheriv('aes-256-gcm',this.key(contact),nonce);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(Buffer.from(packet.d,'base64url')),decipher.final()]).toString('utf8'));}
  filePath(id,friendId){if(!validId(id)||!validId(friendId))throw new Error('Arquivo inválido.');return join(this.mediaDir,friendId+'-'+id+'.bin');}
  persist(){
    const counts=new Map();for(let i=this.messages.length-1;i>=0;i--){const m=this.messages[i];const count=(counts.get(m.friendId)||0)+1;counts.set(m.friendId,count);if(count>200)this.deleteAt(i);}
    let size=this.messages.reduce((sum,m)=>sum+(m.attachment?.size||0),0);while(this.messages.length>2000||size>128*1024*1024){size-=this.messages[0]?.attachment?.size||0;this.deleteAt(0);}
    mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify({messages:this.messages,unread:Object.fromEntries(this.unreadCounts)}));renameSync(this.path+'.tmp',this.path);
  }
  deleteAt(index){const[m]=this.messages.splice(index,1);if(m?.attachment)try{unlinkSync(this.filePath(m.attachment.id,m.friendId));}catch{}}
  publish(message){this.persist();this.onChange();this.onMessage({...message});}
  summary(id){const last=this.messages.filter(m=>m.friendId===id).at(-1);return{unread:this.unreadCounts.get(id)||0,lastMessage:last?{text:last.attachment?last.attachment.name:last.text,time:last.time,status:last.status,authorId:last.authorId}:null};}
  history(id){this.contact(id);return this.messages.filter(m=>m.friendId===id).map(m=>({...m}));}
  markRead(id){this.contact(id);if(this.unreadCounts.delete(id)){this.persist();this.onChange();}return true;}
  find(friendId,id){return this.messages.find(m=>m.friendId===friendId&&m.id===id);}
  storeIncoming(contact,message,data=null){
    const existing=this.find(contact.id,message.id);if(existing){if(existing.authorId!==contact.id)throw new Error('Identificação já usada.');return existing;}
    if(data){mkdirSync(this.mediaDir,{recursive:true});writeFileSync(this.filePath(message.id,contact.id),data);}
    const item={...message,friendId:contact.id,authorId:contact.id,status:'received'};this.messages.push(item);this.unreadCounts.set(contact.id,(this.unreadCounts.get(contact.id)||0)+1);this.publish(item);return item;
  }
  rate(id){const now=Date.now();let rate=this.rates.get(id);if(!rate||now-rate.time>1000){rate={time:now,count:0};this.rates.set(id,rate);}if(++rate.count>400)throw new Error('Muitas mensagens. Aguarde um instante.');}
  async receive(envelope){
    const contact=this.contact(envelope.fromId);this.rate(contact.id);const command=this.open(contact,envelope.packet);
    if(!validId(command?.id))throw new Error('Mensagem privada inválida.');
    let reply={ok:true,id:command.id};
    if(command.kind==='text'){
      if(typeof command.text!=='string'||!command.text.trim()||command.text.length>2000||!Number.isFinite(command.time)||command.time<0||command.time>Date.now()+60000)throw new Error('Mensagem privada inválida.');
      this.storeIncoming(contact,{id:command.id,text:command.text.trim(),time:command.time});
    }else if(command.kind==='file-begin'){
      const done=this.find(contact.id,command.id);if(done){if(done.authorId!==contact.id)throw new Error('Identificação já usada.');reply.done=true;}
      else{
        if(this.uploads.size>=4||!Number.isInteger(command.size)||command.size<1||command.size>MAX_FILE)throw new Error('O limite por arquivo é 8 MB. Aguarde os envios atuais.');
        const key=contact.id+':'+command.id;const old=this.uploads.get(key);if(old)clearTimeout(old.timer);
        const upload={id:command.id,size:command.size,name:filename(command.name),chunks:new Map(),received:0,time:Date.now()};upload.timer=setTimeout(()=>this.uploads.delete(key),120000);upload.timer.unref();this.uploads.set(key,upload);
      }
    }else if(command.kind==='file-chunk'){
      const upload=this.uploads.get(contact.id+':'+command.id);if(!upload||!Number.isInteger(command.index)||command.index<0||command.index>=Math.ceil(upload.size/CHUNK)||typeof command.data!=='string'||command.data.length>32768)throw new Error('Envio expirado. Tente novamente.');
      const data=Buffer.from(command.data,'base64');const expected=Math.min(CHUNK,upload.size-command.index*CHUNK);if(data.length!==expected)throw new Error('Pedaço de arquivo inválido.');
      if(!upload.chunks.has(command.index)){upload.chunks.set(command.index,data);upload.received+=data.length;}
    }else if(command.kind==='file-end'){
      const key=contact.id+':'+command.id,upload=this.uploads.get(key);if(!upload||upload.received!==upload.size)throw new Error('Arquivo incompleto. Tente novamente.');
      const data=Buffer.concat([...upload.chunks.entries()].sort(([a],[b])=>a-b).map(([,bytes])=>bytes));
      this.storeIncoming(contact,{id:upload.id,text:'',time:upload.time,attachment:{id:upload.id,name:upload.name,size:data.length,mime:mime(data)}},data);clearTimeout(upload.timer);this.uploads.delete(key);
    }else throw new Error('Atualize o String Chat nos dois computadores.');
    return{type:'direct-reply',fromId:this.getIdentity().id,packet:this.seal(contact,reply)};
  }
  async command(contact,payload){const reply=await this.request(contact,{type:'direct',fromId:this.getIdentity().id,packet:this.seal(contact,payload)});if(reply?.error)throw new Error(reply.error==='Mensagem inválida.'?'Seu amigo precisa atualizar para o String Chat 1.4.':reply.error);if(reply?.type!=='direct-reply'||reply.fromId!==contact.id)throw new Error('O amigo não confirmou a mensagem. Atualizem os dois programas.');const result=this.open(contact,reply.packet);if(!result.ok||result.id!==payload.id)throw new Error('A mensagem não foi confirmada.');return result;}
  async sendText({friendId,text}){const contact=this.contact(friendId);if(typeof text!=='string'||!text.trim()||text.length>2000)throw new Error('Escreva uma mensagem de até 2.000 caracteres.');const item={id:randomBytes(16).toString('hex'),friendId,authorId:this.getIdentity().id,text:text.trim(),time:Date.now(),status:'sending'};this.messages.push(item);this.publish(item);return this.deliver(contact,item);}
  async sendFile({friendId,name,data}){const contact=this.contact(friendId);data=Buffer.from(data);if(!data.length||data.length>MAX_FILE)throw new Error('Escolha um arquivo de até 8 MB.');const id=randomBytes(16).toString('hex');mkdirSync(this.mediaDir,{recursive:true});writeFileSync(this.filePath(id,friendId),data);const item={id,friendId,authorId:this.getIdentity().id,text:'',time:Date.now(),status:'sending',attachment:{id,name:filename(name),size:data.length,mime:mime(data)}};this.messages.push(item);this.publish(item);return this.deliver(contact,item);}
  async retry({friendId,id}){const contact=this.contact(friendId),item=this.find(friendId,id);if(!item||item.authorId!==this.getIdentity().id||item.status!=='failed')throw new Error('Mensagem indisponível para reenvio.');item.status='sending';this.publish(item);return this.deliver(contact,item);}
  async deliver(contact,item){
    if(this.busy.has(item.friendId)) {item.status='failed';this.publish(item);throw new Error('Aguarde o envio anterior para este amigo.');}this.busy.add(item.friendId);
    try{
      if(item.attachment){const data=readFileSync(this.filePath(item.id,item.friendId));const begin=await this.command(contact,{kind:'file-begin',id:item.id,name:item.attachment.name,size:data.length});if(!begin.done){for(let start=0;start<data.length;start+=CHUNK*4){await Promise.all([0,1,2,3].map(offset=>start+offset*CHUNK).filter(pos=>pos<data.length).map(pos=>this.command(contact,{kind:'file-chunk',id:item.id,index:pos/CHUNK,data:data.subarray(pos,pos+CHUNK).toString('base64')})));}await this.command(contact,{kind:'file-end',id:item.id});}}
      else await this.command(contact,{kind:'text',id:item.id,text:item.text,time:item.time});
      item.status='delivered';contact.online=true;this.publish(item);return{...item};
    }catch(error){item.status='failed';this.publish(item);throw error;}finally{this.busy.delete(item.friendId);}
  }
  getFile({friendId,id}){this.contact(friendId);const item=this.find(friendId,id);if(!item?.attachment)throw new Error('Arquivo privado não encontrado.');const data=readFileSync(this.filePath(item.attachment.id,friendId));if(data.length!==item.attachment.size||data.length>MAX_FILE)throw new Error('Arquivo inválido.');return{...item.attachment,mime:mime(data),data};}
  close(){for(const upload of this.uploads.values())clearTimeout(upload.timer);this.uploads.clear();}
}
