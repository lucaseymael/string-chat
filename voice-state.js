// These indicators describe the participant's own call controls, not a listener's local mute.
export function getVoiceState(member = {}) {
  const deafened = member.deafened === true;
  const micMuted = deafened || member.mic !== true;
  return {
    code: deafened ? 'deafened' : micMuted ? 'muted' : 'active',
    deafened, micMuted,
    label: deafened ? 'Microfone e áudio silenciados' : micMuted ? 'Microfone mutado' : 'Microfone ligado',
    hearing: deafened ? 'Não está ouvindo a chamada' : 'Áudio da chamada ativado',
  };
}
export function voiceStateMarkup(member) {
  const state = getVoiceState(member);
  const label = `${state.label} · ${state.hearing}`;
  return `<span class="member-voice-state" data-voice-state="${state.code}" role="img" aria-label="${label}" title="${label}"><svg class="voice-state-mic${state.micMuted ? ' is-muted' : ''}" aria-hidden="true"><use href="#i-${state.micMuted ? 'mic-off' : 'mic'}"/></svg><svg class="voice-state-hearing${state.deafened ? ' is-deafened' : ''}" aria-hidden="true"><use href="#i-${state.deafened ? 'headphones-off' : 'headphones'}"/></svg></span>`;
}
