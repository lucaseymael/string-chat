import {EventEmitter} from 'node:events';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {HostedClient,normalizeHostedUrl} from './hosted-client.mjs';
import {HostedMessages} from './hosted-messages.mjs';
import {HostedPrivateCallTransport} from './hosted-private-call-transport.mjs';
import {HostedRoomClient} from './hosted-room-client.mjs';

// Account secrets stay in the Node process. Only connection status crosses IPC.
export class HostedIntegration extends EventEmitter {
  constructor({path,friends,rooms,privateCalls}){
    super();Object.assign(this,{path,friends,rooms,privateCalls});this.config={url:'',autoConnect:false,caPem:''};this.client=null;this.error='';this.busy=false;this.closed=false;
    const lanRequest=friends.request.bind(friends);
    friends.request=(endpoint,envelope,command)=>endpoint?.hostedServer?this.requireClient(endpoint.hostedServer).request(endpoint,envelope,command):lanRequest(endpoint,envelope);
    friends.direct.request=(endpoint,envelope,command)=>friends.request(endpoint,envelope,command);
    this.presenceListener=()=>{if(!this.client?.connected)return;const next=JSON.stringify({presence:this.friends.presence,name:this.friends.getName(),avatar:this.friends.getAvatar()});if(next===this.lastPresence)return;this.lastPresence=next;this.client.setPresence({...this.friends.presence,name:this.friends.getName(),avatar:this.friends.getAvatar()}).catch(error=>{if(!this.closed){this.error=error.message;this.changed();}});};
    friends.on('change',this.presenceListener);
  }
  async load(){try{const raw=JSON.parse(await readFile(this.path,'utf8'));this.config={url:raw.url?normalizeHostedUrl(raw.url):'',autoConnect:raw.autoConnect===true,caPem:this.validateCA(raw.caPem||'')};}catch(error){if(error.code!=='ENOENT')this.error='A configuração do servidor está inválida e foi preservada.';}this.changed();}
  validateCA(value){if(value==='')return'';if(typeof value!=='string'||Buffer.byteLength(value)>1024*1024||!/-----BEGIN CERTIFICATE-----/.test(value)||/PRIVATE KEY/.test(value))throw Error('Selecione um certificado público PEM válido.');const certificate=new X509Certificate(value);if(Date.parse(certificate.validTo)<Date.now())throw Error('O certificado selecionado está vencido.');return value;}
  status(){return{connected:this.client?.connected===true,url:this.client?.url||this.config.url,autoConnect:this.config.autoConnect,caFingerprint:this.config.caPem?new X509Certificate(this.config.caPem).fingerprint256:'',error:this.error};}
  changed(){this.emit('status',this.status());}
  async save(){await mkdir(dirname(this.path),{recursive:true});await writeFile(this.path+'.tmp',JSON.stringify(this.config),{mode:0o600});await rename(this.path+'.tmp',this.path);}
  requireIdle(){if(this.rooms.mode||this.privateCalls.snapshot())throw Error('Encerre a chamada ou saia do grupo antes de alterar a conexão do servidor.');}
  requireClient(url){if(!this.client?.connected||url&&this.client.url!==url)throw Error('Conecte-se ao servidor deste amigo nas configurações.');return this.client;}
  async connect({url=this.config.url,registrationToken='',autoConnect=this.config.autoConnect}={}){
    if(this.busy)throw Error('Aguarde a conexão atual.');this.requireIdle();if(typeof registrationToken!=='string'||registrationToken.length>512)throw Error('Token inválido.');url=normalizeHostedUrl(url);this.busy=true;
    let trial;
    try{
      // Stop old polls first: two servers must never race to modify one contact list.
      await this.client?.close();this.client=null;this.rooms.setHosted(null);
      trial=new HostedClient({url,friends:this.friends,registrationToken,caPem:this.config.caPem||undefined});
      trial.on('warning',value=>{if(this.client!==trial)return;this.error=value.message;this.changed();});
      await trial.connect();if(this.closed)throw Error('O aplicativo foi encerrado.');
      this.client=trial;const messages=new HostedMessages({client:trial,friends:this.friends}),calls=new HostedPrivateCallTransport({client:trial,friends:this.friends,privateCalls:this.privateCalls});
      trial.directTransport=messages;trial.extraTransport=calls;messages.extraTransport=calls;
      this.rooms.setHosted(new HostedRoomClient({client:trial}));this.config={...this.config,url,autoConnect:autoConnect===true};this.error='';this.lastPresence=JSON.stringify({presence:this.friends.presence,name:this.friends.getName(),avatar:this.friends.getAvatar()});
      await this.save();trial.startPolling();this.changed();return this.status();
    }catch(error){await trial?.close();if(this.client===trial)this.client=null;if(!this.rooms.mode)this.rooms.setHosted(null);this.error=error.message;this.changed();throw error;}finally{this.busy=false;}
  }
  async autoConnect(){if(this.config.autoConnect&&this.config.url)await this.connect().catch(()=>{});}
  async disconnect(){if(this.busy)throw Error('Aguarde a conexão atual.');this.requireIdle();await this.client?.close();this.client=null;this.rooms.setHosted(null);for(const contact of this.friends.contacts.values())if(contact.hostedServer){Object.assign(contact,{online:false,presence:'offline',group:null,statusText:''});}this.friends.changed();this.error='';this.changed();return this.status();}
  async chooseCA(pem){this.requireIdle();if(this.client?.connected)throw Error('Desconecte do servidor antes de alterar o certificado.');this.config.caPem=this.validateCA(pem);await this.save();this.changed();return this.status();}
  directory(query){return this.requireClient().directory(query);}
  friendAction({action,id}){return this.requireClient().friendAction(action,id);}
  actionForContact(action,id){const contact=this.friends.contacts.get(id);return contact?.hostedServer?this.requireClient(contact.hostedServer).friendAction(action,id):this.friends[action](id);}
  async close(){this.closed=true;this.friends.off('change',this.presenceListener);await this.client?.close();this.client=null;}
}
