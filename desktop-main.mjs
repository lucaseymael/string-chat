import { KeyMonitor } from './key-monitor.mjs';
import { normalizeAdvancedSettings } from './advanced-settings.js';
import { powerMonitor } from 'electron';
import { cleanVoicePreferences } from './call-extras.js';
import { normalizeVoiceSettings } from './voice-dsp.js';
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, dialog, session, globalShortcut, Tray, nativeTheme } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from './server.mjs';
import { RoomService,listInterfaces,parseInvite } from './room-service.mjs';
import {FriendsService,parseFriendLink}from'./friends-service.mjs';
import {cleanAvatar} from './profile.js';
import {Shortcuts,DEFAULT_SHORTCUTS} from './shortcuts.mjs';
import {verifyInstallation} from './installation.mjs';
import {makeDiagnostics} from './diagnostics.mjs';
import {release} from 'node:os';
const isAppLink=value=>typeof value==='string'&&/^(stringchat):\/\//.test(value);
let keyMonitor,shortcuts,tray,trayState={},hiddenToTray=false,trayNoticeShown=false,preparingUpdate=false,shuttingDown=false,shutdownCleaned=false;
function showMainWindow(){if(!mainWindow||mainWindow.isDestroyed())return;hiddenToTray=false;if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}
function refreshTray(){if(!tray||tray.isDestroyed())return;tray.setToolTip('String Chat'+(trayState.inCall?' · Em chamada':''));tray.setContextMenu(Menu.buildFromTemplate([{label:'Abrir String Chat',click:showMainWindow},{type:'separator'},{label:trayState.mic?'Mutar microfone':'Reativar microfone',enabled:!!trayState.inCall,click:()=>mainWindow?.webContents.send('shortcuts:trigger','mute')},{label:trayState.deafened?'Reativar áudio recebido':'Silenciar áudio recebido',enabled:!!trayState.inCall,click:()=>mainWindow?.webContents.send('shortcuts:trigger','deafen')},{type:'separator'},{label:'Sair do String Chat',click:()=>app.quit()}]));}
let cameraAuthorized=false;

const root = dirname(fileURLToPath(import.meta.url));
app.setName('String Chat');
if (process.platform === 'win32') app.setAppUserModelId('com.stringchat.desktop');
const profileArgument = process.argv.find(value => value.startsWith('--profile='));
if (profileArgument) app.setPath('userData', profileArgument.slice('--profile='.length));
else app.setPath('userData',join(app.getPath('appData'),'StringChat'));
if(process.argv.includes('--verify-install')){try{await verifyInstallation(dirname(process.execPath));app.exit(0);}catch{app.exit(1);}}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features','WebRtcHideLocalIpsWithMdns');
let mainWindow, pickerWindow, localServer, pendingCapture, settings = {}, preferencesPath, rooms, friends;
let pendingInvite=process.argv.find(value=>isAppLink(value))||null;
const sourceMap = new Map();
function deliverLink(link){const url=new URL(link);if(url.hostname==='friend'){parseFriendLink(link);mainWindow.webContents.send('friends:link',link);}else{parseInvite(link);mainWindow.webContents.send('room:invite',link);}}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else if(process.argv.includes('--prepare-update')) app.quit();
else {
  app.on('second-instance', (event,argv) => { if(argv.includes('--prepare-update')){preparingUpdate=true;app.quit();return;} if (mainWindow) { showMainWindow(); const invite=argv.find(value=>isAppLink(value)); if(invite) { try {deliverLink(invite);} catch{} } } });
  app.on('open-url',(event,invite)=>{event.preventDefault();try{if(mainWindow)deliverLink(invite);else pendingInvite=invite;}catch{}});
  app.whenReady().then(start).catch(error => {if(shuttingDown||mainWindow?.isDestroyed())return;dialog.showErrorBox('String Chat — não foi possível iniciar', error.message);app.quit();});
}
function trusted(event, window = mainWindow) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}
function finishCapture(id) {
  const callback = pendingCapture; pendingCapture = null;
  const source = sourceMap.get(id); sourceMap.clear();
  // Audio is captured separately by WASAPI, excluding this entire app process tree.
  if (callback) callback(source ? { video: source } : null);
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
}
async function start() {
  Menu.setApplicationMenu(null);
  shortcuts=new Shortcuts(globalShortcut,type=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('shortcuts:trigger',type);});
  preferencesPath = join(app.getPath('userData'), 'preferences.json');
  try { settings = JSON.parse(await readFile(preferencesPath, 'utf8')); } catch { settings = {}; }
  nativeTheme.themeSource=settings.theme==='light'?'light':'dark';
  keyMonitor=new KeyMonitor(join(root,'native/PushToTalk.exe'),value=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('ptt:state',value);},message=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('ptt:error',message);});keyMonitor.configure(settings);
  powerMonitor.on('suspend',()=>keyMonitor.suspend());powerMonitor.on('lock-screen',()=>keyMonitor.suspend());powerMonitor.on('resume',()=>keyMonitor.resume());powerMonitor.on('unlock-screen',()=>keyMonitor.resume());
  shortcuts.apply({mute:settings.muteShortcut??DEFAULT_SHORTCUTS.mute,deafen:settings.deafenShortcut??DEFAULT_SHORTCUTS.deafen});
  localServer = await startLocalServer({ desktopPid: process.pid });
  rooms=new RoomService({statePath:join(app.getPath('userData'),'group.json')});
  friends=new FriendsService({path:join(app.getPath('userData'),'friends.json'),getName:()=>settings.name||'Amigo',getAvatar:()=>cleanAvatar(settings.avatar),getGroup:()=>{const invite=rooms.info?.invite||rooms.currentInvite;return invite?{name:rooms.room?.name||'Grupo',invite}:null;}});
  friends.on('change',snapshot=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('friends:change',snapshot);});
  friends.on('direct-message',message=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('direct:message',message);});
  friends.on('notice',notice=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('friends:notice',notice);});
  friends.start().catch(()=>{});
  rooms.on('event',event=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('room:event',event);});
  if(!profileArgument) app.setAsDefaultProtocolClient('stringchat');
  const origin = localServer.url;
  const sameOrigin = value => { try { return new URL(value).origin === origin; } catch { return false; } };
  // No external pages receive media, clipboard, capture or preload privileges.
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return !(permission==='media' && details?.mediaType==='video' && !cameraAuthorized) && webContents === mainWindow?.webContents && sameOrigin(requestingOrigin) && ['media', 'speaker-selection', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = webContents === mainWindow?.webContents && webContents.getURL().startsWith(origin + '/') && ['media', 'speaker-selection', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
    callback(allowed && !(permission === 'media' && details.mediaTypes?.includes('video') && !cameraAuthorized));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!mainWindow || request.frame !== mainWindow.webContents.mainFrame || !sameOrigin(request.securityOrigin) || !request.userGesture || pendingCapture) { console.error('Display capture denied', request.securityOrigin, request.userGesture); callback(null); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 440, height: 248 }, fetchWindowIcons: true });
      sourceMap.clear();
      for (const source of sources) if (source.name !== 'String Chat — escolher o que compartilhar') sourceMap.set(source.id, source);
      pendingCapture = callback;
      pickerWindow = new BrowserWindow({ title: 'String Chat — escolher o que compartilhar', width: 900, height: 660, minWidth: 600, minHeight: 450, parent: mainWindow, modal: true, show: false, backgroundColor: '#edf2f9', autoHideMenuBar: true, icon: join(root, 'icon.ico'), webPreferences: { preload: join(root, 'desktop-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } });
      pickerWindow.once('ready-to-show', () => pickerWindow?.show());
      pickerWindow.once('closed', () => { pickerWindow = null; if (pendingCapture) finishCapture(null); });
      pickerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      pickerWindow.webContents.on('will-navigate', event => event.preventDefault());
      await pickerWindow.loadURL(origin + '/picker.html');
    } catch (error) { console.error('Display capture unavailable:', error.message); if (pendingCapture) finishCapture(null); else callback(null); }
  });
  ipcMain.on('preferences:read', event => { event.returnValue = trusted(event)||trusted(event,pickerWindow) ? settings : {}; });
  ipcMain.on('tray:state',(event,value)=>{if(!trusted(event)||!value)return;trayState={inCall:value.inCall===true,mic:value.mic===true,deafened:value.deafened===true};keyMonitor.setActive(trayState.inCall);refreshTray();});
  ipcMain.on('identity:read',event=>{event.returnValue=trusted(event)?{id:friends.id}:null;});
  ipcMain.handle('preferences:save', async (event, value) => {
    if (!trusted(event) || !value || typeof value !== 'object') throw new Error('Preferências inválidas.');
    const allowed = ['closeToTray','theme','name','muteShortcut','deafenShortcut', 'cameraDeviceId', 'bitrate', 'fps', 'resolution', 'contentHint', 'streamPriority', 'noiseMode', 'echoCancellation', 'screenSound','screenVolume','soundsEnabled','soundVolume', 'network', 'iceUrl', 'iceUser'];
    const nextSettings = Object.fromEntries(allowed.filter(key => typeof value[key] === 'string' || typeof value[key] === 'number' || typeof value[key] === 'boolean').map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 250) : value[key]]));
    Object.assign(nextSettings,normalizeVoiceSettings(value),normalizeAdvancedSettings(value));nextSettings.voicePreferences=JSON.stringify(cleanVoicePreferences(value.voicePreferences));
    const previous=settings;const oldShortcuts=shortcuts.current;
    const nextKeys={mute:value.muteShortcut??DEFAULT_SHORTCUTS.mute,deafen:value.deafenShortcut??DEFAULT_SHORTCUTS.deafen};
    if(nextSettings.voiceInputMode==='ptt'&&[nextKeys.mute,nextKeys.deafen].includes(nextSettings.pttShortcut))throw Error('Escolha uma tecla de PTT diferente dos atalhos de mutar e silenciar áudio.');
    const changed=nextKeys.mute!==(settings.muteShortcut??DEFAULT_SHORTCUTS.mute)||nextKeys.deafen!==(settings.deafenShortcut??DEFAULT_SHORTCUTS.deafen);
    shortcuts.apply(nextKeys,{strict:changed});
    settings=nextSettings;settings.muteShortcut=shortcuts.current.mute;settings.deafenShortcut=shortcuts.current.deafen;
    settings.avatar=cleanAvatar(value.avatar);
    rooms.setName(settings.name,settings.avatar);
    friends.changed();friends.refresh().catch(()=>{});
    await mkdir(dirname(preferencesPath), { recursive: true });
    try{await writeFile(preferencesPath+'.tmp',JSON.stringify(settings));await rename(preferencesPath+'.tmp',preferencesPath);}catch(error){settings=previous;shortcuts.apply(oldShortcuts);throw error;}nativeTheme.themeSource=settings.theme==='light'?'light':'dark';keyMonitor.configure(settings);return true;
  });
  const roomAction=(name,fn)=>ipcMain.handle(name,(event,value)=>{if(!trusted(event))throw new Error('Acesso inválido.');return fn(value);});
  roomAction('diagnostics:export',async media=>{const report=makeDiagnostics({version:app.getVersion(),electron:process.versions.electron,chrome:process.versions.chrome,osRelease:release(),shortcuts:shortcuts.snapshot(),media});const result=await dialog.showSaveDialog(mainWindow,{title:'Salvar diagnóstico do String Chat',defaultPath:'StringChat-diagnostico.json',filters:[{name:'Diagnóstico JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return false;await writeFile(result.filePath,JSON.stringify(report,null,2));return true;});
  roomAction('shortcuts:status',()=>shortcuts.snapshot());
  roomAction('shortcuts:suspend',()=>{shortcuts.suspend();keyMonitor.suspend();return true;});
  roomAction('shortcuts:resume',()=>{keyMonitor.resume();return shortcuts.resume();});
  roomAction('camera:authorize',async()=>{
    if(cameraAuthorized)return true;
    const result=await dialog.showMessageBox(mainWindow,{type:'question',title:'Permitir webcam',message:'Permitir que o String Chat use sua câmera?',detail:'A webcam só é ligada pelo botão de câmera. A imagem é enviada às pessoas no seu canal de voz. Você pode desligar a qualquer momento.',buttons:['Permitir câmera','Cancelar'],defaultId:1,cancelId:1,noLink:true});
    cameraAuthorized=result.response===0;return cameraAuthorized;
  });
  roomAction('room:interfaces',()=>listInterfaces());
  roomAction('room:create',value=>rooms.create(value));
  roomAction('room:join',value=>rooms.join(value));
  roomAction('room:signal',value=>rooms.signal(value));
  roomAction('room:leave',()=>rooms.leave());
  roomAction('room:voice',value=>rooms.voice(value));
  roomAction('room:channel',value=>rooms.createChannel(value));
  roomAction('room:chat',value=>rooms.chat(value));
  roomAction('room:upload',value=>rooms.sendAttachment(value));
  roomAction('room:file',id=>rooms.getAttachment(id));
  roomAction('room:save-file',async id=>{const file=await rooms.getAttachment(id);const result=await dialog.showSaveDialog(mainWindow,{title:'Salvar arquivo do grupo',defaultPath:file.name});if(!result.canceled&&result.filePath){await writeFile(result.filePath,file.data);return true;}return false;});
  roomAction('direct:history',id=>friends.direct.history(id));
  roomAction('direct:read',id=>friends.direct.markRead(id));
  roomAction('direct:send',value=>friends.direct.sendText(value));
  roomAction('direct:retry',value=>friends.direct.retry(value));
  roomAction('direct:upload',value=>friends.direct.sendFile(value));
  roomAction('direct:file',value=>friends.direct.getFile(value));
  roomAction('direct:save-file',async value=>{const file=friends.direct.getFile(value);const result=await dialog.showSaveDialog(mainWindow,{title:'Salvar arquivo privado',defaultPath:file.name});if(!result.canceled&&result.filePath){await writeFile(result.filePath,file.data);return true;}return false;});
  roomAction('friends:get',()=>friends.snapshot());
  roomAction('friends:refresh',async()=>{if(!friends.server)await friends.start();await friends.refresh();return friends.snapshot();});
  roomAction('friends:add',code=>friends.add(code));
  roomAction('friends:accept',id=>friends.accept(id));
  roomAction('friends:remove',id=>friends.remove(id));
  roomAction('friends:invite',id=>friends.invite(id));
  ipcMain.handle('capture:sources', event => {
    if (!trusted(event, pickerWindow)) throw new Error('Seletor indisponível.');
    return [...sourceMap.values()].map(source => ({ id: source.id, name: source.name, screen: source.id.startsWith('screen:'), thumbnail: source.thumbnail.toDataURL(), icon: source.appIcon?.toDataURL() || null }));
  });
  ipcMain.handle('capture:choose', (event, id) => { if (trusted(event, pickerWindow) && sourceMap.has(id)) finishCapture(id); });
  ipcMain.handle('capture:cancel', event => { if (trusted(event, pickerWindow)) finishCapture(null); });
  ipcMain.handle('licenses:open', event => {
    if (!trusted(event)) return;
    const window = new BrowserWindow({ title: 'String Chat — licenças', width: 900, height: 700, parent: mainWindow, backgroundColor: '#171919', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.loadURL(origin + '/licenses');
  });
  mainWindow = new BrowserWindow({ title: 'String Chat', width: 1440, height: 960, minWidth: 900, minHeight: 650, show: false, backgroundColor: '#edf2f9', autoHideMenuBar: true, icon: join(root, 'icon.ico'), webPreferences: { preload: join(root, 'desktop-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  mainWindow.webContents.on('will-prevent-unload',event=>event.preventDefault());
  tray=new Tray(join(root,'icon.ico'));tray.on('double-click',showMainWindow);tray.on('click',showMainWindow);tray.on('balloon-click',showMainWindow);refreshTray();
  mainWindow.on('close',event=>{if(settings.closeToTray===true&&!shuttingDown&&tray&&!tray.isDestroyed()){event.preventDefault();hiddenToTray=true;mainWindow.hide();if(!trayNoticeShown){trayNoticeShown=true;tray.displayBalloon({title:'String Chat continua aberto',content:'O programa está na bandeja do Windows. Para encerrar, clique com o botão direito no ícone e escolha Sair.',iconType:'info'});}return;}shuttingDown=true;});
  mainWindow.once('ready-to-show', () => {if(!shuttingDown&&!hiddenToTray&&!mainWindow.isDestroyed())mainWindow.show();});
  mainWindow.webContents.setWebRTCIPHandlingPolicy('default');
  mainWindow.webContents.once('did-finish-load',()=>{if(pendingInvite){try{deliverLink(pendingInvite);}catch{} pendingInvite=null;}});
  mainWindow.webContents.on('page-title-updated', event => { event.preventDefault(); mainWindow.setTitle('String Chat'); });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', () => { localServer.close(); app.quit(); });
  mainWindow.on('closed', () => { finishCapture(null); mainWindow = null; app.quit(); });
  await mainWindow.loadURL(origin + '/');
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {shuttingDown=true;if(shutdownCleaned)return;shutdownCleaned=true;tray?.destroy();finishCapture(null);shortcuts?.close();keyMonitor?.stop();friends?.close();rooms?.leave();localServer?.close();});
