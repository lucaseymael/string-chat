const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve('.'), apps = [], errors = [], checks = [];
async function check(name, run) { await run(); checks.push(name); console.log('PASS', name); }
async function start(name) {
  const profile = path.join(root, '.test-results', `voice-state-${name}-${Date.now()}`); await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ name, soundsEnabled: false, network: 'lan', theme: 'dark', muteShortcut: '', deafenShortcut: '' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.STRINGCHAT_TEST_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe');
  const args = [...(process.env.STRINGCHAT_TEST_EXECUTABLE ? [] : [root]), `--profile=${profile}`, '--use-fake-device-for-media-stream'];
  const app = await electron.launch({ executablePath, args, env, timeout: 30000 }); apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  await page.locator('#home-button').waitFor();
  await page.evaluate(async () => { const { Microphone } = await import('./microphone.js'); const open = Microphone.prototype.open; Microphone.prototype.open = async function(...args) { window.qaMic = this; return open.apply(this, args); }; });
  return { app, page };
}
async function join(person, invite) { await person.page.locator('#join-rail').click(); await person.page.locator('#group-invite-input').fill(invite); await person.page.locator('#join-group-button').click(); await person.page.locator('#connect-dialog').waitFor({ state: 'hidden' }); }
async function state(person, id, expected) {
  for (const selector of [`#participants [data-member="${id}"] .member-voice-state`, `#voice-channels [data-voice-member="${id}"] .member-voice-state`, `.call-people [data-member="${id}"] .member-voice-state`]) {
    await person.page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.dataset.voiceState === expected, { selector, expected });
  }
}
(async () => {
  const a = await start('QA A'), b = await start('QA B'); let invite;
  await a.page.locator('#invite-button').click(); await a.page.locator('#room-network option').first().waitFor({ state: 'attached' }); await a.page.locator('#generate-invite').click(); await a.page.locator('#connect-dialog').waitFor({ state: 'hidden' });
  invite = await a.page.locator('#group-invite').inputValue(); await join(b, invite);
  const id = await a.page.evaluate(() => window.stringChat.identity.id);
  await check('Muted microphone remains distinct from disabled call audio', async () => { await state(b, id, 'muted'); assert.equal(await b.page.locator(`#participants [data-member="${id}"] use[href="#i-headphones-off"]`).count(), 0); });
  await check('Microphone activation and mute propagate to cards and channel list', async () => { await a.page.locator('#mic-button').click(); await state(b, id, 'active'); await a.page.locator('#mic-button').click(); await state(b, id, 'muted'); });
  await check('Full deafen displays both crossed icons and pauses the outgoing microphone', async () => {
    await a.page.locator('#mic-button').click(); await state(b, id, 'active'); await a.page.locator('#deafen-button').click(); await state(b, id, 'deafened'); await state(a, id, 'deafened');
    assert.equal(await a.page.evaluate(() => window.qaMic.track.enabled), false);
    assert.equal(await b.page.locator(`#participants [data-member="${id}"] use[href="#i-mic-off"]`).count(), 1);
    assert.equal(await b.page.locator(`#participants [data-member="${id}"] use[href="#i-headphones-off"]`).count(), 1);
    assert.match(await b.page.locator(`#participants [data-member="${id}"] .member-voice-state`).getAttribute('aria-label'), /Não está ouvindo/);
  });
  const c = await start('QA C');
  await check('A late participant receives the existing full-deafen state', async () => { await join(c, invite); await c.page.waitForFunction(() => document.querySelector('#participant-count').textContent === '03'); await state(c, id, 'deafened'); });
  await check('The call dock in private/home view exposes full deafen and restores prior microphone state', async () => {
    await a.page.locator('#home-button').click(); await a.page.locator('#home-call-dock').waitFor();
    assert.match(await a.page.locator('#home-call-heading').textContent(), /Microfone e áudio silenciados/);
    const button = a.page.locator('#home-call-dock [data-call-control=deafen]'); assert.equal(await button.getAttribute('aria-pressed'), 'true');
    await button.click(); await state(b, id, 'active'); assert.equal(await a.page.evaluate(() => window.qaMic.track.enabled), true);
    await a.page.locator('#home-call-dock [data-call-control=mic]').click(); await state(b, id, 'muted');
    await button.click(); await state(b, id, 'deafened'); await button.click(); await state(b, id, 'muted'); assert.equal(await a.page.evaluate(() => window.qaMic.track.enabled), false);
  });
  await check('Local listener mute does not advertise that the remote participant is deafened', async () => {
    await a.page.locator('#home-call-dock [data-call-control=mic]').click(); await state(b, id, 'active'); await state(c, id, 'active');
    await b.page.locator(`#participants [data-member="${id}"] .person-audio-controls button`).click(); await state(b, id, 'active'); await state(c, id, 'active');
  });
  await check('Deafen dock controls fit a small window and indicators remain visible', async () => {
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(950, 700));
    const button = a.page.locator('#home-call-dock [data-call-control=deafen]'); await button.click(); await state(b, id, 'deafened');
    assert(await button.isVisible()); const bounds = await button.boundingBox(); assert(bounds.y + bounds.height <= await a.page.evaluate(() => innerHeight));
    await b.page.screenshot({ path: path.join(root, '.test-results/voice-state-desktop.png') });
  });
  assert.deepEqual(errors, []); await fs.writeFile(path.join(root, '.test-results/voice-state-desktop-results.json'), JSON.stringify({ checks, errors, instances: 3, sameComputer: true }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { for (const app of apps.reverse()) await app.close().catch(() => {}); });
