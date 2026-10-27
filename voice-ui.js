import { normalizeVoiceSettings } from './voice-dsp.js';
export function setupVoiceUI({ settings, getMicrophone, error }) {
  const $ = id => document.getElementById(id);
  const box = document.createElement('section'); box.className = 'voice-settings';
  box.innerHTML = `<h3>Voz e dispositivos</h3><label for="mic-device">Microfone de entrada</label><select id="mic-device"><option value="">Padrão do Windows</option></select><label for="mic-gain">Ganho do microfone <output id="mic-gain-value"></output></label><input id="mic-gain" type="range" min="0" max="200" step="5"><label class="voice-check"><input id="mic-high-pass" type="checkbox">Reduzir graves e vibrações</label><label class="voice-check"><input id="mic-auto-gain" type="checkbox">Ajustar volume automaticamente</label><label class="voice-check"><input id="voice-gate" type="checkbox">Transmitir quando detectar voz</label><label class="voice-check"><input id="voice-auto" type="checkbox">Sensibilidade automática</label><label for="voice-threshold">Sensibilidade manual <output id="voice-threshold-value"></output></label><input id="voice-threshold" type="range" min="-75" max="-15"><p class="small-note">Coloque o limiar acima do ruído e abaixo da sua voz mais baixa. Desative a detecção se alguma palavra estiver sendo cortada.</p><p id="voice-live-status" class="voice-live-status" role="status">Use Ouvir teste para conferir sua voz.</p>`;
  $('noise-mode').closest('form').insertBefore(box, $('noise-mode').previousElementSibling);
  function read() { return normalizeVoiceSettings({ micDeviceId: $('mic-device').value, micGain: Number($('mic-gain').value), voiceGate: $('voice-gate').checked, voiceAutoThreshold: $('voice-auto').checked, voiceThreshold: Number($('voice-threshold').value), micHighPass: $('mic-high-pass').checked, micAutoGain: $('mic-auto-gain').checked }); }
  function labels() {
    $('mic-gain-value').value = $('mic-gain').value + '%'; $('voice-threshold-value').value = $('voice-threshold').value + ' dB';
    $('voice-threshold').disabled = $('voice-auto').checked || !$('voice-gate').checked;
  }
  async function devices(selected = $('mic-device').value) {
    const values = await navigator.mediaDevices.enumerateDevices();
    $('mic-device').replaceChildren(new Option('Padrão do Windows', ''));
    for (const [index, device] of values.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default').entries()) $('mic-device').append(new Option(device.label || `Microfone ${index + 1}`, device.deviceId));
    if (selected && ![...$('mic-device').options].some(o => o.value === selected)) $('mic-device').append(new Option('Microfone salvo · desconectado', selected));
    $('mic-device').value = selected;
  }
  function render() {
    const s = normalizeVoiceSettings(settings);
    $('mic-gain').value = s.micGain; $('voice-threshold').value = s.voiceThreshold;
    $('voice-gate').checked = s.voiceGate; $('voice-auto').checked = s.voiceAutoThreshold;
    $('mic-high-pass').checked = s.micHighPass; $('mic-auto-gain').checked = s.micAutoGain;
    labels(); devices(s.micDeviceId).catch(error);
  }
  let previewTimer;
  box.addEventListener('input', () => { labels(); clearTimeout(previewTimer); previewTimer = setTimeout(async () => {
    const mic = getMicrophone(); if (!mic?.monitoring) return;
    try { await mic.configure({ ...settings, ...read(), noiseMode: $('noise-mode').value, echoCancellation: $('echo-cancellation').checked }); } catch (e) { error(e); }
  }, 100); });
  navigator.mediaDevices.addEventListener('devicechange', () => devices().catch(error));
  function tick() {
    if (!$('settings-dialog').open) return;
    const t = getMicrophone()?.telemetry;
    $('voice-live-status').textContent = t ? `${t.speaking ? 'Voz detectada' : 'Aguardando voz'} · entrada ${Math.round(t.inputDb)} dB · limiar ${Math.round(t.thresholdDb)} dB${t.clipped ? ' · reduza o ganho' : ''}` : 'Use Ouvir teste para conferir sua voz.';
  }
  return { read, render, tick, refresh: () => devices().catch(error) };
}
