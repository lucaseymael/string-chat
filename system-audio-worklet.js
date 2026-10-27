class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.capacity = 8192; this.left = new Float32Array(this.capacity); this.right = new Float32Array(this.capacity);
    this.read = 0; this.write = 0; this.available = 0; this.playing = false; this.closed = false;this.samples=0;this.dropped=0;this.peak=0;this.underruns=0;
    this.port.onmessage = event => {
      if (event.data === 'stop') { this.closed = true; return; }
      if (!(event.data instanceof ArrayBuffer)) return;
      const pcm = new Int16Array(event.data);
      const start=Math.max(0,pcm.length-7680);this.dropped+=start/2;
      for (let i = start; i + 1 < pcm.length; i += 2) {
        if (this.available === this.capacity) { this.read = (this.read + 1) % this.capacity; this.available--;this.dropped++; }
        this.left[this.write] = pcm[i] / 32768; this.right[this.write] = pcm[i + 1] / 32768;
        this.write = (this.write + 1) % this.capacity; this.available++;
      }
      // Limit accumulated delay instead of allowing stale audio to build up.
      if (this.available > 3840) {this.dropped+=this.available-960; this.read = (this.write + this.capacity - 960) % this.capacity; this.available = 960; }
    };
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const [left, right] = outputs[0];
    left.fill(0);right?.fill(0);
    if (!this.playing && this.available >= 960) this.playing = true;
    this.samples+=left.length;if(this.samples>=24000){this.port.postMessage({bufferMs:this.available/48,peak:this.peak,droppedMs:this.dropped/48,underruns:this.underruns});this.samples=0;this.peak=0;}
    if (!this.playing) return true;
    for (let i = 0; i < left.length; i++) {
      if (!this.available) { this.playing = false;this.underruns++; break; }
      left[i] = this.left[this.read]; if (right) right[i] = this.right[this.read];
      this.peak=Math.max(this.peak,Math.abs(left[i]),Math.abs(right?.[i]||0));
      this.read = (this.read + 1) % this.capacity; this.available--;
    }
    return true;
  }
}
registerProcessor('stringchat-system-audio', SystemAudioProcessor);
