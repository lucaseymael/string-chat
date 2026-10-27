export function cleanVoicePreferences(value) {
  let input; try { input = typeof value === 'string' ? JSON.parse(value.slice(0, 12000)) : value; } catch { input = {}; }
  const result = {};
  for (const [id, p] of Object.entries(input || {}).slice(0, 64)) {
    if (!/^[a-f0-9]{32}$/.test(id) || !p || typeof p !== 'object') continue;
    result[id] = { volume: Number.isFinite(p.volume) ? Math.max(0, Math.min(100, p.volume)) : 100, muted: p.muted === true };
  }
  return result;
}
export function setupCallExtras({ call, settings, audioElements, toast }) {
  const prefs = cleanVoicePreferences(settings.voicePreferences), meters = new Map(); let context, saveTimer;
  const pref = id => prefs[id] || { volume: 100, muted: false };
  function persist() {
    clearTimeout(saveTimer); saveTimer = setTimeout(async () => {
      settings.voicePreferences = JSON.stringify(cleanVoicePreferences(prefs));
      const { icePassword, ...saved } = settings;
      try { await window.stringChat.saveSettings(saved); } catch { toast('Não foi possível salvar o volume dos participantes.', true); }
    }, 250);
  }
  function audio(id, element) { element.volume = pref(id).volume / 100; return pref(id).muted; }
  function controls() {
    for (const node of document.querySelectorAll('.participant-card[data-member]')) {
      const id = node.dataset.member; if (id === call.id || !call.peers.has(id) || node.querySelector('.person-audio-controls')) continue;
      const box = document.createElement('div'); box.className = 'person-audio-controls';
      const button = document.createElement('button'); button.type = 'button';
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.max = 100; slider.value = pref(id).volume; slider.setAttribute('aria-label', 'Volume da voz de ' + call.peers.get(id).name);
      const value = document.createElement('output'); value.textContent = slider.value + '%';
      const refresh = () => { button.textContent = pref(id).muted ? 'Ouvir' : 'Silenciar'; button.setAttribute('aria-pressed', String(pref(id).muted)); };
      button.onclick = event => { event.stopPropagation(); prefs[id] = { ...pref(id), muted: !pref(id).muted }; const el = audioElements.get(id); if (el) el.muted = call.deafened || !call.voiceChannelId || call.peers.get(id)?.meta.voiceChannelId !== call.voiceChannelId || pref(id).muted; refresh(); persist(); };
      slider.oninput = event => { event.stopPropagation(); prefs[id] = { ...pref(id), volume: Number(slider.value) }; value.textContent = slider.value + '%'; const el = audioElements.get(id); if (el) el.volume = pref(id).volume / 100; persist(); };
      box.addEventListener('click', event => event.stopPropagation()); box.append(button, slider, value); node.append(box); refresh();
    }
  }
  function tick() {
    const disconnect = meter => { meter.source.disconnect(); meter.analyser.disconnect(); meter.silence.disconnect(); };
    for (const [id, meter] of meters) if (!call.peers.has(id) || call.peers.get(id).tracks.get(0)?.id !== meter.track || call.peers.get(id).meta.voiceChannelId !== call.voiceChannelId) { disconnect(meter); meters.delete(id); }
    if (!call.active || !call.voiceChannelId) { for (const m of meters.values()) disconnect(m); meters.clear(); if (context) context.close().catch(() => {}); context = null; return; }
    for (const peer of call.peers.values()) {
      const track = peer.tracks.get(0); if (!peer.admitted || !track || track.readyState === 'ended' || peer.meta.voiceChannelId !== call.voiceChannelId) continue;
      if (!meters.has(peer.id)) {
        try {
          context ||= new AudioContext({ latencyHint: 'interactive' }); context.resume().catch(() => {});
          const source = context.createMediaStreamSource(new MediaStream([track])), analyser = context.createAnalyser(); analyser.fftSize = 256;
          const silence = context.createGain(); silence.gain.value = 0; source.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
          meters.set(peer.id, { source, analyser, silence, data: new Float32Array(256), track: track.id });
        } catch { continue; }
      }
      const m = meters.get(peer.id); m.analyser.getFloatTimeDomainData(m.data); const rms = Math.sqrt(m.data.reduce((s, v) => s + v * v, 0) / m.data.length);
      for (const node of document.querySelectorAll(`[data-member="${peer.id}"]`)) node.classList.toggle('speaking', peer.meta.mic && rms > 0.008);
    }
  }
  return { audio, controls, tick };
}
export function setupHistorySearch(list, label) {
  const bar = document.createElement('div'); bar.className = 'message-search';
  const input = document.createElement('input'); input.type = 'search'; input.maxLength = 200; input.placeholder = label; input.setAttribute('aria-label', label);
  const count = document.createElement('output'); count.setAttribute('aria-live', 'polite');
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'text-button'; clear.textContent = 'Limpar';
  bar.append(input, count, clear);
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  function apply() {
    if (bar.parentNode !== list) list.prepend(bar);
    const query = normalize(input.value.trim()); let found = 0; const rows = list.querySelectorAll('.message');
    for (const row of rows) { row.hidden = !!query && !normalize(row.textContent).includes(query); if (!row.hidden) found++; }
    const message = query ? `${found}/${rows.length}` : '';
    if (count.textContent !== message) count.textContent = message;
  }
  input.addEventListener('input', apply); clear.onclick = () => { input.value = ''; apply(); input.focus(); };
  input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); clear.click(); } });
  const observer = new MutationObserver(apply); observer.observe(list, { childList: true, subtree: true }); apply();
  return { focus: () => { input.focus(); input.select(); }, list };
}
