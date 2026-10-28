const { contextBridge, ipcRenderer } = require('electron');
const preferences = ipcRenderer.sendSync('preferences:read');
const identity=ipcRenderer.sendSync('identity:read');
contextBridge.exposeInMainWorld('stringChat', {
  isDesktop: true,
  hostedStatus:()=>ipcRenderer.invoke('hosted:status'),
  hostedConnect:value=>ipcRenderer.invoke('hosted:connect',value),
  hostedDisconnect:()=>ipcRenderer.invoke('hosted:disconnect'),
  hostedChooseCA:()=>ipcRenderer.invoke('hosted:choose-ca'),
  hostedDirectory:query=>ipcRenderer.invoke('hosted:directory',query),
  hostedFriendAction:value=>ipcRenderer.invoke('hosted:friend-action',value),
  hostedGroups:()=>ipcRenderer.invoke('hosted:groups'),
  enterHostedGroup:value=>ipcRenderer.invoke('hosted:enter-group',value),
  openGroupInvite:value=>ipcRenderer.invoke('room:open-invite',value),
  onHostedStatus:callback=>{const listener=(event,value)=>callback(value);ipcRenderer.on('hosted:status',listener);return()=>ipcRenderer.removeListener('hosted:status',listener);},
  onPushToTalk:callback=>ipcRenderer.on('ptt:state',(event,value)=>callback(value)),
  onPushToTalkError:callback=>ipcRenderer.on('ptt:error',(event,message)=>callback(message)),
  updateTray:value=>ipcRenderer.send('tray:state',value),
  exportDiagnostics:value=>ipcRenderer.invoke('diagnostics:export',value),
  shortcutStatus:()=>ipcRenderer.invoke('shortcuts:status'),
  suspendShortcuts:()=>ipcRenderer.invoke('shortcuts:suspend'),
  resumeShortcuts:()=>ipcRenderer.invoke('shortcuts:resume'),
  onShortcut:callback=>ipcRenderer.on('shortcuts:trigger',(event,type)=>callback(type)),
  onNotification:callback=>ipcRenderer.on('notification:open',(event,value)=>callback(value)),
  privateCallStart:value=>ipcRenderer.invoke('private-call:start',value),
  privateCallAccept:value=>ipcRenderer.invoke('private-call:accept',value),
  privateCallDecline:value=>ipcRenderer.invoke('private-call:decline',value),
  privateCallEnd:value=>ipcRenderer.invoke('private-call:end',value),
  privateCallSnapshot:()=>ipcRenderer.invoke('private-call:snapshot'),
  onPrivateCall:callback=>{const listener=(event,value)=>callback(value);ipcRenderer.on('private-call:event',listener);return()=>ipcRenderer.removeListener('private-call:event',listener);},
  directHistory:id=>ipcRenderer.invoke('direct:history',id),
  directRead:id=>ipcRenderer.invoke('direct:read',id),
  sendDirect:value=>ipcRenderer.invoke('direct:send',value),
  retryDirect:value=>ipcRenderer.invoke('direct:retry',value),
  editDirectMessage:value=>ipcRenderer.invoke('direct:edit',value),
  deleteDirectMessage:value=>ipcRenderer.invoke('direct:delete',value),
  reactDirectMessage:value=>ipcRenderer.invoke('direct:react',value),
  pinDirectMessage:value=>ipcRenderer.invoke('direct:pin',value),
  directTyping:value=>ipcRenderer.invoke('direct:typing',value),
  pendingDirectActions:value=>ipcRenderer.invoke('direct:pending',value),
  retryDirectAction:value=>ipcRenderer.invoke('direct:retry-action',value),
  openExternal:url=>ipcRenderer.invoke('external:open',url),
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
  ,manageGroup:value=>ipcRenderer.invoke('room:manage',value)
  ,groupMessageAction:value=>ipcRenderer.invoke('room:message-action',value)
  ,groupTyping:value=>ipcRenderer.invoke('room:typing',value)
  ,updateRoomMediaState:value=>ipcRenderer.invoke('room:media-state',value)
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
  ,blockFriend:id=>ipcRenderer.invoke('friends:block',id)
  ,unblockFriend:id=>ipcRenderer.invoke('friends:unblock',id)
  ,setPresence:value=>ipcRenderer.invoke('friends:presence',value)
  ,inviteFriend:id=>ipcRenderer.invoke('friends:invite',id)
  ,onFriends:callback=>ipcRenderer.on('friends:change',(event,value)=>callback(value))
  ,onFriendNotice:callback=>ipcRenderer.on('friends:notice',(event,value)=>callback(value))
  ,onFriendLink:callback=>ipcRenderer.on('friends:link',(event,value)=>callback(value))
});
