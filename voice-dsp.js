// Local voice activity gate with gain and peak limiting.
export function normalizeVoiceSettings(value = {}) {
  const number = (key, fallback, min, max) => Number.isFinite(value[key]) ? Math.max(min, Math.min(max, value[key])) : fallback;
  return {
    micDeviceId: typeof value.micDeviceId === 'string' ? value.micDeviceId.slice(0, 250) : '',
    micGain: number('micGain', 100, 0, 200),
    voiceGate: value.voiceGate !== false, voiceAutoThreshold: value.voiceAutoThreshold !== false,
    voiceThreshold: number('voiceThreshold', -52, -75, -15),
    micHighPass: value.micHighPass !== false, micAutoGain: value.micAutoGain !== false,
  };
}
export class VoiceGate {
  constructor(rate = 48000) {
    this.rate = rate; this.floor = -72; this.envelope = 0; this.hold = 0;
    this.probability = null; this.vadAge = rate; this.configure({});
    this.stats = { inputDb: -100, outputDb: -100, thresholdDb: -58, speaking: false, clipped: false };
  }
  configure(settings) { this.settings = normalizeVoiceSettings(settings); }
  voice(probability) { if (Number.isFinite(probability)) { this.probability = Math.max(0, Math.min(1, probability)); this.vadAge = 0; } }
  process(input, output) {
    const n = output.length; let squares = 0;
    for (let i = 0; i < n; i++) squares += (input[i] || 0) ** 2;
    const db = Math.max(-100, 10 * Math.log10(squares / Math.max(1, n) + 1e-12));
    this.vadAge += n;
    const neural = this.vadAge < this.rate * 0.2 && this.probability !== null;
    // Estimate only quiet/non-speech frames. A sustained speaker must not raise the noise floor.
    if (this.hold === 0 && (neural ? this.probability < 0.15 : db < this.floor + 12)) {
      const alpha = Math.min(1, n / (this.rate * 2)); this.floor += (db - this.floor) * alpha;
      this.floor = Math.max(-85, Math.min(-40, this.floor));
    }
    const threshold = this.settings.voiceAutoThreshold ? Math.max(-58, Math.min(-32, this.floor + 10)) : this.settings.voiceThreshold;
    const detected = db >= threshold - (this.hold > 0 ? 4 : 0) && (!neural || this.probability >= 0.2);
    if (detected) this.hold = Math.round(this.rate * 0.22);
    else this.hold = Math.max(0, this.hold - n);
    const target = !this.settings.voiceGate || this.hold > 0 ? 1 : 0;
    const coefficient = 1 - Math.exp(-1 / (this.rate * (target ? 0.003 : 0.08)));
    let outSquares = 0, clipped = false;
    for (let i = 0; i < n; i++) {
      this.envelope += (target - this.envelope) * coefficient;
      let value = (input[i] || 0) * this.envelope * this.settings.micGain / 100;
      if (Math.abs(value) > 0.9) { clipped = true; value = Math.sign(value) * (0.9 + 0.08 * Math.tanh((Math.abs(value) - 0.9) / 0.08)); }
      output[i] = value; outSquares += value * value;
    }
    this.stats = { inputDb: db, outputDb: Math.max(-100, 10 * Math.log10(outSquares / Math.max(1, n) + 1e-12)), thresholdDb: threshold, speaking: target === 1 && db > threshold - 4 && this.settings.micGain > 0, clipped, probability: neural ? this.probability : null };
    return output;
  }
}
