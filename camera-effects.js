export class CameraBlur extends EventTarget {
  constructor(stream){super();this.raw=stream;this.closed=false;this.busy=false;this.frames=0;this.video=document.createElement('video');this.video.muted=true;this.video.playsInline=true;this.video.srcObject=stream;this.output=document.createElement('canvas');this.foreground=document.createElement('canvas');this.mask=document.createElement('canvas');}
  async start(){
    try{
      await this.video.play();if(this.closed)throw Error('Câmera cancelada.');
      this.output.width=this.video.videoWidth||1280;this.output.height=this.video.videoHeight||720;this.foreground.width=this.output.width;this.foreground.height=this.output.height;
      this.ctx=this.output.getContext('2d');this.fg=this.foreground.getContext('2d');this.maskCtx=this.mask.getContext('2d');
      // Initialize with the entire frame blurred: never show an unprocessed background while loading.
      this.ctx.filter='blur(16px)';this.ctx.drawImage(this.video,-16,-16,this.output.width+32,this.output.height+32);this.ctx.filter='none';
      this.worker=new Worker('./camera-worker.js');
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('O desfoque demorou para iniciar. A câmera anterior foi preservada.')),20000);this.cancelStart=()=>{clearTimeout(timer);reject(Error('Câmera cancelada.'));};
        this.worker.onmessage=({data})=>{if(data.type==='ready'){clearTimeout(timer);resolve();}else if(data.type==='error'){clearTimeout(timer);reject(Error(data.message));}};
        this.worker.onerror=()=>{clearTimeout(timer);reject(Error('O processamento local da câmera não iniciou.'));};this.worker.postMessage({type:'init'});
      });
      this.cancelStart=null;if(this.closed)throw Error('Câmera cancelada.');
      this.worker.onmessage=({data})=>{if(data.type==='frame'){try{if(!this.closed)this.draw(data);}finally{data.frame.close();this.busy=false;}}else if(data.type==='error'){this.busy=false;this.dispatchEvent(new CustomEvent('error',{detail:data.message}));}};
      this.worker.onerror=()=>this.dispatchEvent(new CustomEvent('error',{detail:'O desfoque local parou.'}));
      this.stream=this.output.captureStream(30);this.track=this.stream.getVideoTracks()[0];this.track.contentHint='motion';this.capture();return this.track;
    }catch(e){this.close();throw e;}
  }
  capture(){if(this.closed)return;this.frameId=this.video.requestVideoFrameCallback(()=>{this.capture();if(this.busy)return;this.busy=true;createImageBitmap(this.video).then(frame=>{if(this.closed){frame.close();return;}this.worker.postMessage({type:'frame',frame,time:performance.now()},[frame]);}).catch(()=>{this.busy=false;});});}
  draw(data){
    if(this.mask.width!==data.width||this.mask.height!==data.height){this.mask.width=data.width;this.mask.height=data.height;}
    const pixels=this.maskCtx.createImageData(data.width,data.height);
    for(let i=0;i<data.mask.length;i++){pixels.data[i*4]=255;pixels.data[i*4+1]=255;pixels.data[i*4+2]=255;pixels.data[i*4+3]=data.mask[i]?255:0;}
    this.maskCtx.putImageData(pixels,0,0);
    const w=this.output.width,h=this.output.height;
    this.fg.globalCompositeOperation='source-over';this.fg.clearRect(0,0,w,h);this.fg.drawImage(data.frame,0,0,w,h);
    this.fg.globalCompositeOperation='destination-in';this.fg.filter='blur(2px)';this.fg.drawImage(this.mask,0,0,w,h);this.fg.filter='none';this.fg.globalCompositeOperation='source-over';
    this.ctx.filter='blur(16px)';this.ctx.drawImage(data.frame,-16,-16,w+32,h+32);this.ctx.filter='none';this.ctx.drawImage(this.foreground,0,0);this.frames++;
  }
  close(){if(this.closed)return;this.closed=true;this.cancelStart?.();this.cancelStart=null;if(this.frameId!==undefined)this.video.cancelVideoFrameCallback(this.frameId);this.video.pause();this.video.srcObject=null;this.worker?.postMessage({type:'close'});this.worker?.terminate();this.track?.stop();this.raw.getTracks().forEach(t=>t.stop());this.output.width=this.output.height=this.foreground.width=this.foreground.height=this.mask.width=this.mask.height=1;}
}
