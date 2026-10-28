import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { release } from 'node:os';
import { randomBytes } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/media-policy.js',['media-policy.js','text/javascript; charset=utf-8']],
  ['/shortcuts-ui.js',['shortcuts-ui.js','text/javascript; charset=utf-8']],
  ['/shortcuts.mjs',['shortcuts.mjs','text/javascript; charset=utf-8']],
  ['/home-ui.js', ['home-ui.js', 'text/javascript; charset=utf-8']],
  ['/private-search.js',['private-search.js','text/javascript; charset=utf-8']],
  ['/private-conversation.css',['private-conversation.css','text/css; charset=utf-8']],
  ['/home.css', ['home.css', 'text/css; charset=utf-8']],
  ['/profile.js', ['profile.js', 'text/javascript; charset=utf-8']],
  ['/sounds.js', ['sounds.js', 'text/javascript; charset=utf-8']],
  ['/friends-ui.js', ['friends-ui.js', 'text/javascript; charset=utf-8']],
  ['/rtc.js', ['rtc.js', 'text/javascript; charset=utf-8']],
  ['/microphone.js', ['microphone.js', 'text/javascript; charset=utf-8']],
  ...['voice-dsp.js','voice-worklet.js','voice-ui.js','call-extras.js','voice-state.js','advanced-settings.js','advanced-ui.js','advanced-call.js','playback.js','camera-worker.js','camera-effects.js','rtc-controls.js'].map(name=>['/'+name,[name,'text/javascript; charset=utf-8']]),
  ['/voice-ui.css',['voice-ui.css','text/css; charset=utf-8']],
  ['/system-audio.js', ['system-audio.js', 'text/javascript; charset=utf-8']],
  ['/system-audio-worklet.js', ['system-audio-worklet.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/theme.css',['theme.css','text/css; charset=utf-8']],
  ['/appearance.css',['appearance.css','text/css; charset=utf-8']],
  ['/collaboration.css',['collaboration.css','text/css; charset=utf-8']],
  ['/message-ui.js',['message-ui.js','text/javascript; charset=utf-8']],
  ['/hosted-settings-ui.js',['hosted-settings-ui.js','text/javascript; charset=utf-8']],
  ['/hosted-settings.css',['hosted-settings.css','text/css; charset=utf-8']],
  ['/hosted-groups-ui.js',['hosted-groups-ui.js','text/javascript; charset=utf-8']],
  ['/hosted-groups.css',['hosted-groups.css','text/css; charset=utf-8']],
  ['/group-view.js',['group-view.js','text/javascript; charset=utf-8']],
  ['/notifications-ui.js',['notifications-ui.js','text/javascript; charset=utf-8']],
  ['/group-management-ui.js',['group-management-ui.js','text/javascript; charset=utf-8']],
  ['/group-management.css',['group-management.css','text/css; charset=utf-8']],
  ['/private-call-ui.js',['private-call-ui.js','text/javascript; charset=utf-8']],
  ['/private-call.css',['private-call.css','text/css; charset=utf-8']],
  ['/theme-dark.css',['theme-dark.css','text/css; charset=utf-8']],
  ['/theme-boot.js',['theme-boot.js','text/javascript; charset=utf-8']],
  ['/media-ui.css', ['media-ui.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/picker.html', ['picker.html', 'text/html; charset=utf-8']],
  ['/picker.js', ['picker.js', 'text/javascript; charset=utf-8']],
  ['/vendor/rnnoise-worklet.js', ['vendor/rnnoise-worklet.js', 'text/javascript; charset=utf-8']],
  ['/vendor/rnnoise.wasm', ['vendor/rnnoise.wasm', 'application/wasm']],
  ['/vendor/rnnoise_simd.wasm', ['vendor/rnnoise_simd.wasm', 'application/wasm']],
  ...['vision_bundle.js','wasm/vision_wasm_internal.js','wasm/vision_wasm_internal.wasm','wasm/vision_wasm_module_internal.js','wasm/vision_wasm_module_internal.wasm','wasm/vision_wasm_nosimd_internal.js','wasm/vision_wasm_nosimd_internal.wasm','selfie_segmenter.tflite'].map(name=>['/vendor/mediapipe/'+name,['vendor/mediapipe/'+name,name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream']]),
  ['/licenses', ['vendor/THIRD-PARTY-LICENSES.txt', 'text/plain; charset=utf-8']]
]);
export async function startLocalServer({ desktopPid = null, port = 0 } = {}) {
const sessionToken = randomBytes(32).toString('hex');
let audioCapture = null;
const helperPath = join(root, 'native', 'AudioLoopback.exe');
const nativeSupported = () => process.platform === 'win32' && Number(release().split('.')[2]) >= 20348 && Number.isInteger(desktopPid) && desktopPid > 0 && existsSync(helperPath);
function stopAudio() { if (audioCapture) { audioCapture.stdin.end(); audioCapture.kill(); audioCapture = null; } }
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function serveSystemAudio(req, res) {
  const expectedOrigin = `http://${req.headers.host}`;
  if (req.headers.origin !== expectedOrigin || req.headers['x-stringchat-session'] !== sessionToken || req.headers['sec-fetch-site'] !== 'same-origin') { json(res, 403, { error: 'Acesso permitido somente pelo aplicativo local.' }); return; }
  if (!nativeSupported()) { json(res, 409, { error: 'Abra o StringChat.exe na janela própria em um Windows compatível para compartilhar som sem incluir a call.' }); return; }
  if (audioCapture) { json(res, 409, { error: 'Já existe uma captura de som nesta sessão.' }); return; }
  const browserPid = desktopPid;
  const child = spawn(helperPath, ['--exclude', String(browserPid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  audioCapture = child; let pending = Buffer.alloc(0), ready = false, diagnostic = '';
  const timer = setTimeout(() => { if (!ready) { json(res, 503, { error: 'O Windows não iniciou a separação do áudio. A tela continuará sem som.' }); cleanup(); } }, 12000);
  function cleanup() { clearTimeout(timer); if (audioCapture === child) audioCapture = null; child.stdin.end(); child.kill(); }
  res.on('close', cleanup);
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(0, 1000); });
  child.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'Componente nativo de áudio indisponível.' }); else res.end(); cleanup(); });
  child.on('exit', () => {
    clearTimeout(timer); if (audioCapture === child) audioCapture = null;
    if (!res.headersSent) json(res, 503, { error: `Não foi possível excluir a call da captura. ${diagnostic.trim()}` });
    else res.end();
  });
  const onHeader = chunk => {
    pending = Buffer.concat([pending, chunk]); const newline = pending.indexOf(10);
    if (newline < 0) { if (pending.length > 2048) { json(res, 503, { error: 'Resposta inválida do componente de áudio.' }); cleanup(); } return; }
    let metadata;
    try { metadata = JSON.parse(pending.subarray(0, newline).toString()); } catch { cleanup(); return; }
    if (metadata.ready !== true || metadata.excludedPid !== browserPid || metadata.sampleRate !== 48000 || metadata.channels !== 2 || metadata.format !== 's16le') { json(res, 503, { error: 'A exclusão de áudio da chamada não foi confirmada.' }); cleanup(); return; }
    ready = true; clearTimeout(timer); child.stdout.removeListener('data', onHeader);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-StringChat-Audio': 's16le-48000-stereo-exclude-call', 'X-Content-Type-Options': 'nosniff' });
    if (pending.length > newline + 1) res.write(pending.subarray(newline + 1));
    child.stdout.pipe(res);
  };
  child.stdout.on('data', onHeader);
}
const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403).end(); return; }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/session' && req.method === 'GET') {const build=Number(release().split('.')[2]);const nativeAudioReason=build<20348?'Este Windows não oferece a captura de aplicativos que exclui a chamada. O som seguro exige Windows 11 ou build 20348+.':!existsSync(helperPath)?'O componente de áudio não foi encontrado. Execute o setup para reparar a instalação.':'A separação de áudio exige o programa StringChat.exe em um Windows compatível.';json(res, 200, { token: sessionToken, nativeAudio: nativeSupported(),nativeAudioReason }); return; }
  if (pathname === '/api/system-audio' && req.method === 'POST') { serveSystemAudio(req, res); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  const entry = files.get(pathname);
  if (!entry) { res.writeHead(404).end('Nao encontrado'); return; }
  try {
    const bytes = await readFile(join(root, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1], 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)'
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(500).end('Nao foi possivel ler o aplicativo.'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
let closed = false;
return {
  url: `http://127.0.0.1:${server.address().port}`,
  close() { if (closed) return; closed = true; stopAudio(); server.closeAllConnections(); server.close(); }
};
}
