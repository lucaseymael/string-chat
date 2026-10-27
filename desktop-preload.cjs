const { contextBridge, ipcRenderer } = require('electron');
const preferences = ipcRenderer.sendSync('preferences:read');
const identity=ipcRenderer.sendSync('identity:read');
contextBridge.exposeInMainWorld('stringChat', {
  isDesktop: true,
  onPushToTalk:callback=>ipcRenderer.on('ptt:state',(event,value)=>callback(value)),
  onPushToTalkError:callback=>ipcRenderer.on('ptt:error',(event,message)=>callback(message)),
  updateTray:value=>ipcRenderer.send('tray:state',value),
  exportDiagnostics:value=>ipcRenderer.invoke('diagnostics:export',value),
  shortcutStatus:()=>ipcRenderer.invoke('shortcuts:status'),
  suspendShortcuts:()=>ipcRenderer.invoke('shortcuts:suspend'),
  resumeShortcuts:()=>ipcRenderer.invoke('shortcuts:resume'),
  onShortcut:callback=>ipcRenderer.on('shortcuts:trigger',(event,type)=>callback(type)),
  directHistory:id=>ipcRenderer.invoke('direct:history',id),
  directRead:id=>ipcRenderer.invoke('direct:read',id),
  sendDirect:value=>ipcRenderer.invoke('direct:send',value),
  retryDirect:value=>ipcRenderer.invoke('direct:retry',value),
  sendDirectFile:value=>ipcRenderer.invoke('direct:upload',value),
  getDirectFile:value=>ipcRenderer.invoke('direct:file',value),
  saveDirectFile:value=>ipcRenderer.invoke('direct:save-file',value),
  onDirectMessage:callback=>ipcRenderer.on('direct:message',(event,value)=>callback(value)),
  authorizeCamera:()=>ipcRenderer.invoke('camera:authorize'),
  identity,
  readSettings: () => preferences,
  saveSettings: value => ipcRenderer.invoke('preferences:save', value),
  getSources: () => ipcRenderer.invoke('capture:sources'),
  chooseSource: id => ipcRenderer.invoke('capture:choose', id),
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),
  openLicenses: () => ipcRenderer.invoke('licenses:open')
  ,getNetworkInterfaces:()=>ipcRenderer.invoke('room:interfaces')
  ,createRoom:value=>ipcRenderer.invoke('room:create',value)
  ,joinRoom:value=>ipcRenderer.invoke('room:join',value)
  ,sendRoomSignal:value=>ipcRenderer.invoke('room:signal',value)
  ,leaveRoom:()=>ipcRenderer.invoke('room:leave')
  ,changeVoiceChannel:value=>ipcRenderer.invoke('room:voice',value)
  ,createChannel:value=>ipcRenderer.invoke('room:channel',value)
  ,sendGroupChat:value=>ipcRenderer.invoke('room:chat',value)
  ,sendAttachment:value=>ipcRenderer.invoke('room:upload',value)
  ,getAttachment:id=>ipcRenderer.invoke('room:file',id)
  ,saveAttachment:id=>ipcRenderer.invoke('room:save-file',id)
  ,onRoomEvent:callback=>{ipcRenderer.on('room:event',(event,value)=>callback(value));}
  ,onInvite:callback=>{ipcRenderer.on('room:invite',(event,value)=>callback(value));}
  ,getFriends:()=>ipcRenderer.invoke('friends:get')
  ,refreshFriends:()=>ipcRenderer.invoke('friends:refresh')
  ,addFriend:code=>ipcRenderer.invoke('friends:add',code)
  ,acceptFriend:id=>ipcRenderer.invoke('friends:accept',id)
  ,removeFriend:id=>ipcRenderer.invoke('friends:remove',id)
  ,inviteFriend:id=>ipcRenderer.invoke('friends:invite',id)
  ,onFriends:callback=>ipcRenderer.on('friends:change',(event,value)=>callback(value))
  ,onFriendNotice:callback=>ipcRenderer.on('friends:notice',(event,value)=>callback(value))
  ,onFriendLink:callback=>ipcRenderer.on('friends:link',(event,value)=>callback(value))
});
