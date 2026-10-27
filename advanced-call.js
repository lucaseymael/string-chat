import { PlaybackMixer, VideoDelay } from './playback.js';
import { QUALITY_PROFILES } from './advanced-settings.js';
export class AdvancedCall {
  constructor({call,settings,getMicrophone,ensureMicrophone,callExtras,toast,sounds}) {
    Object.assign(this,{call,settings,getMicrophone,ensureMicrophone,callExtras,toast,sounds});
    this.mixer=new PlaybackMixer(settings,message=>toast(message,true));this.tiles=new Map();this.armKey='';this.lastNative=0;this.requireRelease=true;this.speechSince=0;this.lastMutedWarning=-Infinity;
    window.stringChat.onPushToTalk(value=>this.nativeState(value));
    window.stringChat.onPushToTalkError(message=>{this.nativeState({down:false});toast(message,true);});
    navigator.mediaDevices.addEventListener('devicechange',()=>this.devicesChanged().catch(e=>toast(e.message,true)));
    window.addEventListener('pagehide',()=>{this.getMicrophone()?.setPushToTalk(false);this.mixer.close();for(const item of this.tiles.values()){item.delay.close();item.video.cancelVideoFrameCallback(item.callback);}});
  }
  nativeState(value) {
    this.lastNative=performance.now();if(!value.down)this.requireRelease=false;
    const down=value.down===true&&!this.requireRelease&&this.settings.voiceInputMode==='ptt'&&this.call.active&&!!this.call.voiceChannelId&&!this.call.deafened;
    this.call.setPushToTalk(down);this.getMicrophone()?.setPushToTalk(down,800);
  }
  observe() {
    const key=this.call.active&&this.call.voiceChannelId?`${this.call.id}:${this.call.voiceChannelId}:${this.settings.voiceInputMode}`:'';
    if(key===this.armKey)return;this.armKey=key;this.requireRelease=true;this.call.setPushToTalk(false);this.getMicrophone()?.setPushToTalk(false);
    if(key&&this.settings.voiceInputMode==='ptt'&&!this.call.deafened){this.call.micOn=true;
      this.ensureMicrophone().then(mic=>{if(this.armKey!==key)return;const remaining=Math.max(0,800-(performance.now()-this.lastNative));mic.setPushToTalk(this.call.pttDown,remaining);this.call.announce();}).catch(e=>{this.call.micOn=false;this.call.announce();this.toast(e.message,true);});
    }
  }
  async applySettings(next) {
    if(this.mixer.context||next.audioOutputDevice)await this.mixer.setOutput(next.audioOutputDevice||'');
    for(const context of[this.getMicrophone()?.context,this.sounds.context])if(context&&typeof context.setSinkId==='function')await context.setSinkId(next.audioOutputDevice||'');
    this.call.applyPlaybackBuffer(next.playbackBuffer);
  }
  async devicesChanged(){
    await this.mixer.deviceChanged();const id=this.settings.audioOutputDevice||'';
    const devices=await navigator.mediaDevices.enumerateDevices(),sink=devices.some(d=>d.kind==='audiooutput'&&d.deviceId===id)?id:'';
    for(const context of[this.getMicrophone()?.context,this.sounds.context])if(context&&context.state!=='closed'&&typeof context.setSinkId==='function')await context.setSinkId(sink);
  }
  voice(element,id,muted) { this.mixer.apply(element,'voice',id,this.callExtras.pan(id),muted); }
  tile(tile,item) {
    if(item.self||item.kind!=='screen')return;
    const video=tile.querySelector('video');if(item.audio)this.mixer.apply(video,'screen',item.id,0,this.call.deafened);else this.mixer.remove(video);
    let record=this.tiles.get(tile);
    if(!record){
      record={video,item,delay:new VideoDelay(video,tile),lastFrame:performance.now(),lastRecovery:0,retries:0};this.tiles.set(tile,record);
      const frame=()=>{record.callback=video.requestVideoFrameCallback(()=>{record.lastFrame=performance.now();record.retries=0;frame();});};frame();
      const select=document.createElement('select');select.className='viewer-quality';select.setAttribute('aria-label','Qualidade desta transmissão');
      for(const[key,profile]of Object.entries(QUALITY_PROFILES))select.append(new Option(profile.label,key));
      select.onchange=async()=>{const requested=select.value;select.disabled=true;try{await this.call.requestViewerQuality(item.id,requested);}catch(e){this.toast(e.message,true);}finally{select.disabled=false;select.value=this.call.peers.get(item.id)?.viewingQuality||'source';}};
      const recover=document.createElement('button');recover.type='button';recover.className='button small recover-video';recover.textContent='Recuperar vídeo';recover.onclick=()=>{if(this.call.requestVideoRecovery(item.id,true)){record.lastRecovery=performance.now();this.toast('Recuperando vídeo sem interromper a voz.');}else this.toast('Aguarde alguns segundos antes de tentar novamente.');};
      const label=tile.querySelector('.stream-label'),full=tile.querySelector('.stream-fullscreen');label.insertBefore(select,full);label.insertBefore(recover,full);
      video.addEventListener('error',()=>this.call.requestVideoRecovery(item.id));
    }
    record.delay.setDelay(Math.max(0,-(this.settings.avOffsetMs||0)));
    const peer=this.call.peers.get(item.id),quality=peer?.viewingQuality||'source';tile.classList.toggle('audio-only',quality==='audio');
    tile.querySelector('.viewer-quality').value=quality;
    if(quality==='audio')tile.querySelector('.stream-quality').textContent='Somente áudio';
    tile.querySelector('.recover-video').title=peer?.videoRecoveryStatus||'Reconectar o vídeo; a voz e o áudio da tela continuam separados.';
  }
  tick() {
    const now=performance.now(),mic=this.getMicrophone(),t=mic?.telemetry;
    if(this.settings.voiceInputMode==='ptt'&&now-this.lastNative>800){this.call.setPushToTalk(false);mic?.setPushToTalk(false);}
    const audibleSpeech=this.callExtras.speaking()||!!(this.call.meta.mic&&t?.speaking);
    this.mixer.tick(audibleSpeech,this.call.deafened);
    for(const node of this.mixer.nodes.values())if(node.kind==='voice')this.mixer.position(node,this.callExtras.pan(node.id));
    const warning=this.settings.warnMuted&&this.settings.voiceInputMode!=='ptt'&&this.call.active&&this.call.voiceChannelId&&!this.call.micOn&&!this.call.deafened&&mic?.live&&mic.context.state==='running'&&now-(mic.telemetryUpdated||0)<1000&&t&&t.inputDb>Math.max(-45,t.thresholdDb)&&(t.probability===null||t.probability>0.6);
    if(warning){this.speechSince ||= now;if(now-this.speechSince>650&&now-this.lastMutedWarning>15000){this.lastMutedWarning=now;this.toast('Você está falando com o microfone mutado.');this.sounds.play('message');}}else this.speechSince=0;
    for(const[tile,record]of this.tiles){
      if(!tile.isConnected){record.delay.close();record.video.cancelVideoFrameCallback(record.callback);this.tiles.delete(tile);continue;}
      const peer=this.call.peers.get(record.item.id);
      if(document.hidden||record.video.paused||peer?.viewingQuality==='audio'||!peer?.meta.screen){record.lastFrame=now;continue;}
      if(now-record.lastFrame>12000&&now-record.lastRecovery>15000&&record.retries<2){if(this.call.requestVideoRecovery(record.item.id)){record.lastRecovery=now;record.retries++;}}
    }
  }
}
