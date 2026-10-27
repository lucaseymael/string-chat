export class AppSounds {
  constructor(preferences){this.preferences=preferences;this.context=null;this.lastMessage=0;}
  play(kind){
    const settings=this.preferences();if(settings.soundsEnabled===false)return;
    if(kind==='message'&&Date.now()-this.lastMessage<400)return;
    if(kind==='message')this.lastMessage=Date.now();
    try{
      if(!this.context){try{this.context=new AudioContext({sinkId:settings.audioOutputDevice||''});}catch{this.context=new AudioContext();}}this.context.resume().catch(()=>{});
      const patterns={click:[[740,0,.025]],join:[[440,0,.09],[660,.08,.11]],leave:[[540,0,.08],[340,.08,.12]],message:[[880,0,.07],[1100,.07,.1]],success:[[600,0,.08],[800,.07,.12]]};
      const level=Math.max(0,Math.min(1,(settings.soundVolume??35)/100))*.07;
      for(const [frequency,delay,duration]of patterns[kind]||patterns.click){const osc=this.context.createOscillator(),gain=this.context.createGain();const start=this.context.currentTime+delay;osc.type='sine';osc.frequency.value=frequency;gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(kind==='click'?level*.35:level,start+.005);gain.gain.exponentialRampToValueAtTime(.00001,start+duration);osc.connect(gain).connect(this.context.destination);osc.start(start);osc.stop(start+duration+.01);osc.onended=()=>{osc.disconnect();gain.disconnect();};}
    }catch{}
  }
}
