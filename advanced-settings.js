import { normalizeShortcut } from './shortcuts.mjs';
export function normalizeAdvancedSettings(value = {}) {
  const num = (key, fallback, min, max) => Number.isFinite(value[key]) ? Math.max(min, Math.min(max, value[key])) : fallback;
  let pttShortcut; try { pttShortcut = normalizeShortcut(value.pttShortcut || 'F8') || 'F8'; } catch { pttShortcut = 'F8'; }
  return { voiceInputMode: value.voiceInputMode === 'ptt' ? 'ptt' : 'activity', pttShortcut,
    warnMuted: value.warnMuted !== false, duckingEnabled: value.duckingEnabled === true,
    duckingAmount: num('duckingAmount', 70, 0, 95), spatialAudio: value.spatialAudio === true,
    audioOutputDevice: typeof value.audioOutputDevice === 'string' ? value.audioOutputDevice.slice(0, 250) : '',
    playbackBuffer: ['balanced', 'stable'].includes(value.playbackBuffer) ? value.playbackBuffer : 'low',
    avOffsetMs: num('avOffsetMs', 0, -300, 300), cameraBlur: value.cameraBlur === true,
  };
}
export const QUALITY_PROFILES = {
  source: { label: 'Qualidade da origem', height: 1080, fps: 60, bitrate: 50000000 },
  high: { label: '1080p · até 60 fps', height: 1080, fps: 60, bitrate: 50000000 },
  medium: { label: '720p · até 30 fps', height: 720, fps: 30, bitrate: 6000000 },
  low: { label: '480p · até 30 fps', height: 480, fps: 30, bitrate: 2500000 },
  audio: { label: 'Somente áudio', height: 480, fps: 30, bitrate: 2500000 },
};
export function screenEncoding(settings, profile = 'source', height = settings.resolution) {
  const choice = Object.hasOwn(QUALITY_PROFILES,profile)?QUALITY_PROFILES[profile]:QUALITY_PROFILES.source;
  return { active: profile !== 'audio', maxBitrate: Math.min(settings.bitrate * 1000000, choice.bitrate),
    maxFramerate: Math.min(settings.fps, choice.fps), scaleResolutionDownBy: profile === 'source' || profile === 'high' ? 1 : Math.max(1, height / choice.height) };
}
export function pushToTalkKeys(shortcut) {
  const normalized = normalizeShortcut(shortcut), parts = normalized.split('+'), key = parts.pop();
  const codes = { Control: 17, Shift: 16, Alt: 18, Super: 91, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, Delete: 46 };
  const value = /^F\d+$/.test(key) ? 111 + Number(key.slice(1)) : codes[key] ?? key.charCodeAt(0);
  if (!normalized || !Number.isInteger(value) || value < 1 || value > 255) throw Error('Escolha uma tecla válida para falar.');
  return [...parts.map(p => codes[p]), value];
}
