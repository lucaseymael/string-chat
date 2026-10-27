const $ = id => document.getElementById(id);
let sources = [], screenMode = true, selected = null;
function render() {
  $('picker-sources').replaceChildren();
  const visible = sources.filter(source => source.screen === screenMode);
  if (!visible.length) { const p = document.createElement('p'); p.className = 'small-note'; p.textContent = 'Nenhuma janela disponível. Abra uma janela e tente novamente.'; $('picker-sources').append(p); }
  for (const source of visible) {
    const button = document.createElement('button'); button.className = 'picker-source'; button.classList.toggle('chosen', selected === source.id); button.setAttribute('aria-pressed', String(selected === source.id));
    const thumbnail = document.createElement('img'); thumbnail.src = source.thumbnail; thumbnail.alt = ''; button.append(thumbnail);
    const label = document.createElement('span'); label.textContent = source.name; button.append(label);
    button.onclick = () => { selected = source.id; $('share-source').disabled = false; $('source-label').textContent = source.name; render(); };
    button.ondblclick = () => window.stringChat.chooseSource(source.id);
    $('picker-sources').append(button);
  }
}
function setMode(value) { screenMode = value; selected = null; $('share-source').disabled = true; $('screens-tab').classList.toggle('active', value); $('windows-tab').classList.toggle('active', !value); $('source-label').textContent = value ? 'Selecione uma tela.' : 'Selecione uma janela.'; render(); }
$('screens-tab').onclick = () => setMode(true); $('windows-tab').onclick = () => setMode(false);
$('cancel-source').onclick = () => window.stringChat.cancelCapture();
$('share-source').onclick = () => { if (selected) window.stringChat.chooseSource(selected); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.stringChat.cancelCapture(); });
window.stringChat.getSources().then(value => { sources = value; render(); }).catch(() => { $('picker-sources').textContent = 'Não foi possível listar as telas. Feche e tente novamente.'; });
