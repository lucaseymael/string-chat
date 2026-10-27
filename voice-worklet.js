import { VoiceGate } from './voice-dsp.js';
class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.gate = new VoiceGate(sampleRate); this.gate.configure(options.processorOptions || {}); this.frames = 0; this.closed = false;
    this.inputMode=options.processorOptions?.voiceInputMode||'activity';this.processed=0;this.pttUntil=0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'settings') {this.gate.configure(data.value);this.inputMode=data.value.voiceInputMode||'activity';}
      if (data?.type === 'ptt') this.pttUntil=data.down?this.processed+sampleRate*Math.max(0,Math.min(800,data.leaseMs||0))/1000:0;
      if (data?.type === 'vad') this.gate.voice(data.probability);
      if (data === 'destroy') this.closed = true;
    };
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const output = outputs[0]?.[0]; if (!output) return true;
    this.gate.process(inputs[0]?.[0] || [], output);
    this.processed+=output.length;if(this.inputMode==='ptt'&&this.processed>=this.pttUntil)output.fill(0);
    if ((this.frames += output.length) >= sampleRate / 20) { this.frames = 0; this.port.postMessage(this.gate.stats); }
    return true;
  }
}
registerProcessor('stringchat-voice', VoiceProcessor);
