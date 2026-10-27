export class SystemAudio extends EventTarget {
  constructor() {
    super(); this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.context.resume().catch(() => {}); this.controller = new AbortController();
    this.track = null; this.closed = false; this.node = null;this.telemetry={bufferMs:0,peak:0,droppedMs:0,underruns:0};
  }
  async start() {
    const session = await (await fetch('./api/session', { signal: this.controller.signal })).json();
    if (!session.nativeAudio) throw new Error(session.nativeAudioReason||'Separação de áudio indisponível neste Windows. Abra pelo StringChat.exe.');
    await this.context.resume();if(this.context.state!=='running')throw new Error('O áudio está suspenso. Clique em Recuperar áudio.');
    await this.context.audioWorklet.addModule('./system-audio-worklet.js');
    if (this.closed) throw new Error('Captura cancelada.');
    const response = await fetch('./api/system-audio', { method: 'POST', headers: { 'X-StringChat-Session': session.token }, signal: this.controller.signal });
    if (!response.ok) { const message = await response.json(); throw new Error(message.error || 'Separação de áudio indisponível.'); }
    if (response.headers.get('X-StringChat-Audio') !== 's16le-48000-stereo-exclude-call') throw new Error('O Windows não confirmou a exclusão do áudio da call.');
    this.node = new AudioWorkletNode(this.context, 'stringchat-system-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage=event=>{this.telemetry=event.data;this.dispatchEvent(new CustomEvent('level',{detail:event.data}));};
    const destination = this.context.createMediaStreamDestination(); this.gain=this.context.createGain();this.node.connect(this.gain);this.gain.connect(destination);
    this.track = destination.stream.getAudioTracks()[0];
    this.read(response.body).catch(error => {
      if (!this.closed) { this.dispatchEvent(new CustomEvent('error', { detail: error.message || 'A captura de som dos aplicativos foi interrompida.' })); this.stop(); }
    });
    return this.track;
  }
  setVolume(value){if(this.gain)this.gain.gain.setTargetAtTime(Math.max(0,Math.min(2,value)),this.context.currentTime,0.02);}
  async read(body) {
    const reader = body.getReader(); let leftover = new Uint8Array(0);
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) throw new Error('O componente de áudio foi encerrado. A transmissão continua sem som dos aplicativos.');
        const joined = new Uint8Array(leftover.length + value.length); joined.set(leftover); joined.set(value, leftover.length);
        const length = joined.length - joined.length % 4;
        if (length) { const buffer = joined.slice(0, length).buffer; this.node.port.postMessage(buffer, [buffer]); }
        leftover = joined.slice(length);
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  stop() {
    if (this.closed) return; this.closed = true; this.controller.abort(); this.track?.stop();
    this.node?.port.postMessage('stop'); this.node?.disconnect(); this.context.close().catch(() => {});
  }
}
