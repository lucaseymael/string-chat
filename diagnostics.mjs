export function makeDiagnostics({version,electron,chrome,osRelease,shortcuts,media={}}){
  const number=value=>Number.isFinite(value)?Math.max(0,value):null;
  const capture={};for(const key of['width','height','fps','audioQueueMs','audioUnderruns','audioDroppedMs','peak','sendVolume'])capture[key]=number(media.capture?.[key]);
  capture.screenActive=media.capture?.screenActive===true;capture.audioTrackLive=media.capture?.audioTrackLive===true;capture.soundEnabled=media.capture?.soundEnabled===true;
  const peers=(Array.isArray(media.peers)?media.peers:[]).slice(0,5).map((peer,index)=>{const out={peer:index+1};for(const key of['up','down','widthOut','heightOut','widthIn','heightIn','fpsOut','fpsIn','rtt','loss','audioJitterMs','videoJitterMs','encoderMs','availableUpload'])out[key]=number(peer[key]);out.codec=['H264','VP8','VP9','AV1'].includes(peer.codec)?peer.codec:null;out.limitation=['none','cpu','bandwidth','other'].includes(peer.limitation)?peer.limitation:null;return out;});
  return{product:'String Chat',version,electron,chrome,createdAt:new Date().toISOString(),windowsVersion:osRelease,secureApplicationAudioSupported:Number(osRelease.split('.')[2])>=20348,shortcutsRegistered:shortcuts?.registered||{},capture,peers,privacy:'Sem mensagens, nomes de amigos, convites, senhas ou endereços IP.'};
}
