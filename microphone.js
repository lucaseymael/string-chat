// RNNoise runs in a local AudioWorklet. No microphone audio is uploaded for processing.
let wasmPromise;
async function loadWasm() {
  if (!wasmPromise) wasmPromise = (async () => {
    const response = await fetch('./vendor/rnnoise_simd.wasm');
    if (!response.ok) throw new Error('Não foi possível carregar o filtro neural local.');
    const simd = await response.arrayBuffer();
    if (WebAssembly.validate(simd)) return simd;
    const scalar = await fetch('./vendor/rnnoise.wasm');
    if (!scalar.ok) throw new Error('Filtro RNNoise indisponível.');
    return scalar.arrayBuffer();
  })().catch(error => { wasmPromise = null; throw error; });
  return wasmPromise;
}

export class Microphone extends EventTarget {
  constructor() {
    super(); this.context = null; this.raw = null; this.track = null; this.source = null;
    this.neural = null; this.neuralReady = null; this.destination = null; this.analyser = null;
    this.monitor = null; this.mode = null; this.closed = false; this.monitoring = false;
  }
  get live() { return !!this.raw?.getAudioTracks().some(track => track.readyState === 'live') && this.track?.readyState === 'live'; }
  async open(settings) {
    try {
      this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await this.context.resume();
      if (this.closed) throw new Error('Microfone cancelado.');
      this.raw = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        sampleRate: 48000, channelCount: 1, autoGainControl: true,
        echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseMode === 'standard'
      } });
      if (this.closed) { this.raw.getTracks().forEach(track => track.stop()); throw new Error('Microfone cancelado.'); }
      this.source = this.context.createMediaStreamSource(this.raw);
      this.destination = this.context.createMediaStreamDestination();
      this.destination.channelCount = 1; this.destination.channelCountMode = 'explicit';
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256;
      this.analyser.connect(this.destination);
      this.monitor = this.context.createGain(); this.monitor.gain.value = 0.55;
      this.track = this.destination.stream.getAudioTracks()[0]; this.track.enabled = false;
      this.raw.getAudioTracks()[0].addEventListener('ended', () => this.dispatchEvent(new Event('ended')));
      this.context.onstatechange = () => this.dispatchEvent(new Event('statechange'));
      await this.configure(settings);
      return this;
    } catch (error) { this.close(); throw error; }
  }
  async configure(settings) {
    if (!this.raw || this.closed) throw new Error('Microfone indisponível.');
    if (settings.noiseMode === 'rnnoise') await this.ensureNeural();
    if (this.closed) throw new Error('Microfone cancelado.');
    await this.raw.getAudioTracks()[0].applyConstraints({ echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseMode === 'standard', autoGainControl: true });
    this.source.disconnect(); this.neural?.disconnect();
    if (settings.noiseMode === 'rnnoise') { this.source.connect(this.neural); this.neural.connect(this.analyser); }
    else this.source.connect(this.analyser);
    this.mode = settings.noiseMode; this.dispatchEvent(new Event('statechange'));
  }
  async ensureNeural() {
    if (this.neuralReady) return this.neuralReady;
    this.neuralReady = (async () => {
      if (this.context.sampleRate !== 48000) throw new Error('RNNoise precisa de áudio em 48 kHz.');
      const wasmBinary = await loadWasm();
      if (this.closed) throw new Error('Microfone cancelado.');
      await this.context.audioWorklet.addModule('./vendor/rnnoise-worklet.js');
      if (this.closed) throw new Error('Microfone cancelado.');
      this.neural = new AudioWorkletNode(this.context, '@sapphi-red/web-noise-suppressor/rnnoise', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        processorOptions: { maxChannels: 1, wasmBinary }
      });
      this.neural.addEventListener('processorerror', () => {
        this.dispatchEvent(new CustomEvent('error', { detail: 'O filtro neural parou. Desligue e ligue o microfone ou selecione a supressão padrão.' }));
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('O filtro neural demorou demais para iniciar. Selecione o modo padrão e tente novamente.')), 10000);
        this.neural.port.onmessage = event => {
          if (event.data?.type === 'ready') { clearTimeout(timer); resolve(); }
          if (event.data?.type === 'error') { clearTimeout(timer); reject(new Error('Não foi possível iniciar o RNNoise. Use a supressão padrão neste navegador.')); }
        };
      });
    })();
    return this.neuralReady;
  }
  setMonitor(enabled) {
    if (!this.context || this.closed) return;
    this.monitor.disconnect();
    try { this.analyser.disconnect(this.monitor); } catch { /* Not connected. */ }
    if (enabled) { this.analyser.connect(this.monitor); this.monitor.connect(this.context.destination); this.context.resume().catch(() => {}); }
    this.monitoring = enabled;
  }
  get level() {
    if (!this.analyser || this.closed) return 0;
    const values = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(values);
    let squares = 0; for (const value of values) squares += value * value;
    return Math.sqrt(squares / values.length);
  }
  close() {
    if (this.closed) return; this.closed = true; this.monitoring = false;
    this.raw?.getTracks().forEach(track => track.stop()); this.track?.stop();
    this.source?.disconnect(); this.analyser?.disconnect(); this.monitor?.disconnect();
    this.neural?.port.postMessage('destroy'); this.neural?.disconnect();
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
  }
}
