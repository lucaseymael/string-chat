export class PlaybackMixer {
  constructor(settings, warn) { this.settings=settings;this.warn=warn;this.context=null;this.nodes=new Map();this.output='';this.duckUntil=0;this.lastWarning=0; }
  ensure() { if(!this.context){try{this.context=new AudioContext({latencyHint:'interactive',sinkId:this.settings.audioOutputDevice||''});this.output=this.settings.audioOutputDevice||'';}catch{this.context=new AudioContext({latencyHint:'interactive'});this.warn('Saída indisponível; usando o dispositivo padrão.');}}this.context.resume().catch(()=>{});return this.context; }
  async setOutput(id='') {
    const context=this.ensure();
    if(typeof context.setSinkId!=='function'){if(id)throw Error('Esta saída de áudio não é suportada neste Windows.');return;}
    await context.setSinkId(id);this.output=id;
  }
  node(element,kind,id) {
    const track=element.srcObject?.getAudioTracks().find(t=>t.readyState==='live');if(!track){this.remove(element);return null;}
    let node=this.nodes.get(element);if(node){if(node.track!==track){node.source.disconnect();node.source=this.ensure().createMediaStreamSource(new MediaStream([track]));node.source.connect(node.delay);node.track=track;}return node;}
    const context=this.ensure(),source=context.createMediaStreamSource(new MediaStream([track])),delay=context.createDelay(1),pan=context.createPanner(),gain=context.createGain();
    pan.panningModel='HRTF';pan.distanceModel='inverse';pan.refDistance=1;pan.rolloffFactor=0;pan.positionZ.value=-1;
    gain.gain.value=0;source.connect(delay).connect(gain).connect(context.destination);
    node={source,delay,pan,gain,kind,id,element,track,muted:false};this.nodes.set(element,node);return node;
  }
  position(node,pan=0){
    const spatial=node.kind==='voice'&&this.settings.spatialAudio;
    if(node.spatial!==spatial){node.delay.disconnect();node.pan.disconnect();node.delay.connect(spatial?node.pan:node.gain);if(spatial)node.pan.connect(node.gain);node.spatial=spatial;}
    const time=this.context.currentTime;node.pan.positionX.setTargetAtTime(node.kind==='voice'&&this.settings.spatialAudio?Math.max(-1,Math.min(1,pan)):0,time,0.03);
    node.pan.positionZ.setTargetAtTime(node.kind==='voice'&&this.settings.spatialAudio?-1:0,time,0.03);
  }
  apply(element,kind,id,pan=0,muted=false) {
    // Only this graph plays received audio. The HTML element remains a muted video renderer.
    element.muted=true;
    try {
      const node=this.node(element,kind,id);if(!node)return null;const time=this.context.currentTime;node.muted=muted;
      node.delay.delayTime.setTargetAtTime(kind==='screen'?Math.max(0,this.settings.avOffsetMs||0)/1000:0,time,0.015);
      this.position(node,pan);
      this.updateGain(node,performance.now()<this.duckUntil);return node;
    } catch(e) { if(Date.now()-this.lastWarning>15000){this.lastWarning=Date.now();this.warn('Não foi possível aplicar o processamento da saída: '+e.message);}return null; }
  }
  updateGain(node,duck,deafened=false) {
    const factor=node.kind==='screen'&&duck&&this.settings.duckingEnabled?1-this.settings.duckingAmount/100:1;
    const target=node.muted||deafened?0:node.element.volume*factor;
    const time=this.context.currentTime;
    // Do not reset an in-progress fade every UI tick.
    if(node.target===undefined){node.target=target;node.gain.gain.setValueAtTime(target,time);}
    else if(node.target!==target){node.target=target;node.gain.gain.setTargetAtTime(target,time,target===0?0.003:target<1?0.035:0.25);}
  }
  tick(speaking,deafened) {
    if(speaking)this.duckUntil=performance.now()+350;
    for(const[element,node]of this.nodes){
      if(!element.isConnected){this.remove(element);continue;}
      this.updateGain(node,performance.now()<this.duckUntil,deafened);
    }
  }
  async deviceChanged() {
    const id=this.settings.audioOutputDevice||'';if(!id)return;
    const devices=await navigator.mediaDevices.enumerateDevices();
    const next=devices.some(d=>d.kind==='audiooutput'&&d.deviceId===id)?id:'';
    if(next!==this.output){await this.setOutput(next);if(!next)this.warn('A saída foi desconectada. O áudio está usando o dispositivo padrão.');}
  }
  remove(element){const n=this.nodes.get(element);if(!n)return;n.source.disconnect();n.delay.disconnect();n.pan.disconnect();n.gain.disconnect();this.nodes.delete(element);}
  close() { for(const element of this.nodes.keys())this.remove(element);this.context?.close().catch(()=>{}); }
}

// Optional display-only frame delay. The receiver's encoded media is never modified.
export class VideoDelay {
  constructor(video,tile){this.video=video;this.tile=tile;this.delay=0;this.queue=[];this.busy=false;this.closed=false;this.bytes=0;this.canvas=document.createElement('canvas');this.canvas.className='delayed-video';this.canvas.hidden=true;tile.insertBefore(this.canvas,video);this.ctx=this.canvas.getContext('2d');this.loop=()=>this.present();}
  setDelay(ms){ms=Math.max(0,Math.min(300,ms));if(ms===this.delay)return;this.delay=ms;this.clear();this.canvas.hidden=!ms;this.video.classList.toggle('video-delayed',!!ms);if(ms)this.capture();}
  capture(){
    if(this.closed||!this.delay)return;
    this.frameId=this.video.requestVideoFrameCallback(()=>{this.capture();if(this.busy||this.video.readyState<2||document.hidden)return;this.busy=true;
      const due=performance.now()+this.delay,generation=this.generation;
      createImageBitmap(this.video).then(frame=>{if(this.closed||!this.delay||generation!==this.generation){frame.close();return;}const bytes=frame.width*frame.height*4;
        // Retain frames already waiting for presentation; dropping them can starve a long delay.
        if(this.bytes+bytes>96*1024*1024||this.queue.length>=20){frame.close();return;}
        this.queue.push({frame,due,bytes});this.bytes+=bytes;
      }).catch(()=>{}).finally(()=>{this.busy=false;});
    });
    if(!this.animation)this.animation=requestAnimationFrame(this.loop);
  }
  present(){this.animation=null;if(this.closed||!this.delay)return;let selected;
    while(this.queue.length&&this.queue[0].due<=performance.now()){if(selected)selected.frame.close();selected=this.queue.shift();this.bytes-=selected.bytes;}
    if(selected){if(this.canvas.width!==selected.frame.width||this.canvas.height!==selected.frame.height){this.canvas.width=selected.frame.width;this.canvas.height=selected.frame.height;}this.ctx.drawImage(selected.frame,0,0);selected.frame.close();}
    this.animation=requestAnimationFrame(this.loop);
  }
  clear(){this.generation=(this.generation||0)+1;if(this.frameId!==undefined)this.video.cancelVideoFrameCallback(this.frameId);cancelAnimationFrame(this.animation);this.animation=null;for(const q of this.queue)q.frame.close();this.queue=[];this.bytes=0;}
  close(){this.closed=true;this.clear();this.canvas.remove();this.video.classList.remove('video-delayed');}
}
