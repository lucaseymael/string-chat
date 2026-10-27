import { QUALITY_PROFILES } from './advanced-settings.js';
import { prepareVideoCodecs } from './media-policy.js';
const emit=(call,type,detail)=>call.dispatchEvent(new CustomEvent(type,{detail}));
const together=(call,peer)=>!call.externalSignal||!!call.voiceChannelId&&peer.meta.voiceChannelId===call.voiceChannelId;
export function requestViewerQuality(id,profile){
  const peer=this.peers.get(id);if(!peer?.admitted||!peer.meta.screen||!together(this,peer)||!Object.hasOwn(QUALITY_PROFILES,profile))return Promise.reject(Error('Transmissão indisponível.'));
  if(peer.qualityRequest)return Promise.reject(Error('Aguarde a confirmação da qualidade anterior.'));
  const requestId=crypto.randomUUID();
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{peer.qualityRequest=null;reject(Error('O transmissor não confirmou. Atualize os dois apps para ajustar a qualidade.'));},4000);peer.qualityRequest={requestId,profile,resolve,reject,timer};if(!this.send(peer,{type:'viewer-quality',profile,requestId})){clearTimeout(timer);peer.qualityRequest=null;reject(Error('A conexão está ocupada. Tente novamente.'));}});
}
export function requestVideoRecovery(id,manual=false){
  const peer=this.peers.get(id);if(!peer?.admitted||!peer.meta.screen||!together(this,peer)||Date.now()-(peer.lastRequestedRecovery||0)<6000)return false;
  peer.lastRequestedRecovery=Date.now();peer.videoRecoveryStatus='Recuperação solicitada';
  return this.send(peer,{type:'video-recover',manual:!!manual});
}
export async function handleMediaControl(peer,message){
  if(message.type==='viewer-quality'){
    if(!Object.hasOwn(QUALITY_PROFILES,message.profile)||!/^[-a-f0-9]{36}$/.test(message.requestId||''))return true;
    const now=Date.now();if(now-(peer.qualityWindow||0)>2000){peer.qualityWindow=now;peer.qualityChanges=0;}
    let error='';if(!this.screen||!together(this,peer))error='A transmissão foi encerrada.';else if((peer.qualityChanges||0)>=10)error='Muitas alterações seguidas. Aguarde dois segundos.';
    if(!error)peer.qualityChanges=(peer.qualityChanges||0)+1;
    if(!error){peer.lastQuality=Date.now();const previous=peer.viewerProfile;peer.viewerProfile=message.profile;try{await this.configurePeer(peer,true);}catch{peer.viewerProfile=previous;await this.configurePeer(peer);error='Não foi possível aplicar essa qualidade.';}}
    this.send(peer,{type:'viewer-quality-ack',profile:message.profile,requestId:message.requestId,error});return true;
  }
  if(message.type==='viewer-quality-ack'){
    const pending=peer.qualityRequest;if(!pending||pending.requestId!==message.requestId||pending.profile!==message.profile)return true;
    clearTimeout(pending.timer);peer.qualityRequest=null;if(message.error)pending.reject(Error(String(message.error).slice(0,160)));else{peer.viewingQuality=message.profile;pending.resolve(message.profile);emit(this,'change');}return true;
  }
  if(message.type==='video-recover'){
    const now=Date.now();if(!this.screen||!together(this,peer)||now-(peer.lastVideoRecovery||0)<6000)return true;
    if(now-(peer.videoRecoveryWindow||0)>60000){peer.videoRecoveryWindow=now;peer.videoRecoveries=0;}
    if((peer.videoRecoveries||0)>=2)return true;peer.lastVideoRecovery=now;peer.videoRecoveries=(peer.videoRecoveries||0)+1;
    const track=this.screen,sender=peer.slots[1]?.sender;if(!sender||track.readyState!=='live')return true;
    try{
      await sender.replaceTrack(null);
      if(this.screen!==track||track.readyState!=='live'||!together(this,peer))return true;
      await sender.replaceTrack(track);await this.configurePeer(peer);
      if(peer.videoRecoveries>1&&peer.pc.signalingState==='stable'){
        const revision=peer.offerRevision||0;peer.makingOffer=true;
        try{prepareVideoCodecs(peer.slots[1],true);const offer=await peer.pc.createOffer();if(revision===(peer.offerRevision||0)&&peer.pc.signalingState==='stable'){await peer.pc.setLocalDescription(offer);this.route(peer.id,{desc:peer.pc.localDescription.toJSON()});}}
        finally{peer.makingOffer=false;}
      }
      this.send(peer,{type:'video-recovery-status',ok:true});
    }catch{this.send(peer,{type:'video-recovery-status',ok:false});}
    return true;
  }
  if(message.type==='video-recovery-status'){peer.videoRecoveryStatus=message.ok?'Vídeo reconectado':'Recuperação incompleta; tente novamente';emit(this,'change');return true;}
  return false;
}
export function applyPlaybackBuffer(mode=this.settings.playbackBuffer){
  const target=mode==='stable'?160:mode==='balanced'?80:null;
  for(const peer of this.peers.values())for(const[index,slot]of peer.slots.entries())try{if('jitterBufferTarget'in slot.receiver)slot.receiver.jitterBufferTarget=target??(index===0?20:40);}catch{}
}
