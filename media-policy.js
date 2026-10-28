export function configureReceiver(receiver,index,mode){try{if('jitterBufferTarget'in receiver)receiver.jitterBufferTarget=mode==='stable'?160:mode==='balanced'?80:index===0?20:40;}catch{/* Optional browser capability. */}}
export function prepareVideoCodecs(slot,fallback=false){
  if(slot.receiver.track.kind!=='video'||typeof slot.setCodecPreferences!=='function')return;
  try{const codecs=RTCRtpReceiver.getCapabilities('video')?.codecs||[];const priority=codec=>{const type=codec.mimeType.toLowerCase();return type==='video/h264'?(fallback?1:0):type==='video/vp8'?(fallback?0:1):type==='video/vp9'?2:type==='video/av1'?3:4;};slot.setCodecPreferences([...codecs].sort((a,b)=>priority(a)-priority(b)));}catch{/* Default negotiation remains available. */}
}
// Receiver buffering is configured by ontrack and the explicit playback preference.
// Adopting negotiated senders must preserve that preference.
export function associateMedia(peer){peer.mediaStreams||=[new MediaStream(),new MediaStream(),new MediaStream()];peer.slots.forEach((slot,index)=>{slot.sender.setStreams(peer.mediaStreams[index===0?0:index===3?2:1]);prepareVideoCodecs(slot);});}
