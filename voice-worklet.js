import { VoiceGate } from './voice-dsp.js';
class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.gate = new VoiceGate(sampleRate); this.gate.configure(options.processorOptions || {}); this.frames = 0; this.closed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'settings') this.gate.configure(data.value);
      if (data?.type === 'vad') this.gate.voice(data.probability);
      if (data === 'destroy') this.closed = true;
    };
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const output = outputs[0]?.[0]; if (!output) return true;
    this.gate.process(inputs[0]?.[0] || [], output);
    if ((this.frames += output.length) >= sampleRate / 20) { this.frames = 0; this.port.postMessage(this.gate.stats); }
    return true;
  }
}
registerProcessor('stringchat-voice', VoiceProcessor);
