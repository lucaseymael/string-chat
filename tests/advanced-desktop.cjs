const { _electron: electron } = require('playwright-core');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
const root=path.resolve('.'),apps=[],errors=[],checks=[];let driver;const evidence={};
async function check(name,fn){await fn();checks.push(name);console.log('PASS',name);}
async function start(name){
 const profile=path.join(root,'.test-results',`advanced-${name}-${Date.now()}`);await fs.mkdir(profile,{recursive:true});
 await fs.writeFile(path.join(profile,'preferences.json'),JSON.stringify({name,soundsEnabled:false,network:'lan',muteShortcut:'',deafenShortcut:'',theme:'dark'}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({executablePath:process.env.STRINGCHAT_TEST_EXECUTABLE||path.join(root,'node_modules/electron/dist/electron.exe'),args:[...(process.env.STRINGCHAT_TEST_EXECUTABLE?[]:[root]),`--profile=${profile}`,'--use-fake-device-for-media-stream'],env,timeout:30000});apps.push(app);
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(name+': '+e.message));page.on('console',m=>{if(m.type()==='error'&&m.text()!=='INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')errors.push(name+': '+m.text());});await page.locator('#home-button').waitFor();
 await app.evaluate(({dialog})=>{const original=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>args.some(a=>a?.title==='Permitir webcam')?{response:0}:original(...args);});
 await page.evaluate(async()=>{
  const{AdvancedCall}=await import('./advanced-call.js'),{Microphone}=await import('./microphone.js'),{MeshCall}=await import('./rtc.js'),{CameraBlur}=await import('./camera-effects.js');
  const tick=AdvancedCall.prototype.tick;AdvancedCall.prototype.tick=function(...a){window.qaAdvanced=this;return tick.apply(this,a);};
  const open=Microphone.prototype.open;Microphone.prototype.open=async function(...a){window.qaMic=this;return open.apply(this,a);};
  const announce=MeshCall.prototype.announce;MeshCall.prototype.announce=function(...a){window.qaCall=this;return announce.apply(this,a);};
  const camera=CameraBlur.prototype.start;CameraBlur.prototype.start=async function(...a){window.qaBlur=this;return camera.apply(this,a);};
 });
 await page.waitForFunction(()=>!!window.qaAdvanced);await page.evaluate(()=>window.qaCall=window.qaAdvanced.call);return{app,page,profile};
}
async function settings(person,run){await person.page.locator('#profile-button').click();await run(person.page);await person.page.locator('#settings-form button[type=submit]').click();await person.page.locator('#settings-dialog').waitFor({state:'hidden'});}
async function join(person,invite){await person.page.locator('#join-rail').click();await person.page.locator('#group-invite-input').fill(invite);await person.page.locator('#join-group-button').click();await person.page.locator('#connect-dialog').waitFor({state:'hidden'});}
(async()=>{
 const a=await start('A'),b=await start('B'),c=await start('C');let invite,id;
 await check('Three desktop profiles connect without starting a microphone or webcam',async()=>{
  await a.page.locator('#invite-button').click();await a.page.locator('#room-network option').first().waitFor({state:'attached'});await a.page.locator('#generate-invite').click();await a.page.locator('#connect-dialog').waitFor({state:'hidden'});invite=await a.page.locator('#group-invite').inputValue();await join(b,invite);await join(c,invite);
  for(const p of[a,b,c])await p.page.waitForFunction(()=>document.querySelector('#participant-count').textContent==='03');
  id=await a.page.evaluate(()=>window.stringChat.identity.id);assert.equal(await a.page.evaluate(()=>!!window.qaMic),false);
 });
 await check('Real local MediaPipe model blurs webcam frames and stops every capture track',async()=>{
  await settings(a,p=>p.locator('#camera-blur').check());await a.page.locator('#camera-button').click();
  await a.page.waitForFunction(()=>window.qaBlur?.frames>=5,{},{timeout:30000});
  evidence.camera=await a.page.evaluate(()=>({frames:window.qaBlur.frames,width:window.qaBlur.output.width,height:window.qaBlur.output.height,localModel:true}));
  assert.equal(await a.page.evaluate(()=>window.qaCall.camera===window.qaBlur.track),true);
  await b.page.waitForFunction(()=>[...document.querySelectorAll('[data-kind=camera] video')].some(v=>v.videoWidth>0));
  await a.page.locator('#camera-button').click();assert.equal(await a.page.evaluate(()=>window.qaBlur.raw.getTracks().every(t=>t.readyState==='ended')&&window.qaBlur.track.readyState==='ended'&&window.qaBlur.closed),true);
 });
 await check('Dedicated global hold-to-talk works minimized and closes on key release',async()=>{
  const binary=path.join(root,'.test-results/PTT-driver.exe');const compile=spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/out:'+binary,path.join(root,'tests/ptt-driver.cs')],{windowsHide:true,encoding:'utf8'});assert.equal(compile.status,0,compile.stdout+compile.stderr);
  driver=spawn(binary,[],{windowsHide:true,stdio:['pipe','ignore','pipe']});driver.stdin.on('error',()=>{});
  await settings(a,async p=>{await p.locator('#voice-input-mode').selectOption('ptt');await p.locator('#ptt-shortcut').evaluate(el=>{el.value='F23';});});
  await a.page.waitForFunction(()=>window.qaMic?.live&&window.qaCall.micOn&&!window.qaCall.pttDown);
  // The helper deliberately ignores a key already held at startup; wait for a released-key heartbeat.
  await a.page.evaluate(()=>window.qaPttReadyAfter=performance.now()+260);
  await a.page.waitForFunction(()=>window.qaAdvanced.lastNative>=window.qaPttReadyAfter,null,{polling:30});
  await a.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());driver.stdin.write('down\n');
  await a.page.waitForFunction(()=>window.qaCall.pttDown&&window.qaMic.track.enabled,null,{polling:50});driver.stdin.write('up\n');await a.page.waitForFunction(()=>!window.qaCall.pttDown&&!window.qaMic.track.enabled,null,{polling:50});
  await a.app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].restore();BrowserWindow.getAllWindows()[0].show();});
 });
 await check('Native keyboard monitor failure closes PTT and requires a fresh key press',async()=>{
  driver.stdin.write('down\n');await a.page.waitForFunction(()=>window.qaCall.pttDown);
  await a.page.evaluate(()=>window.stringChat.suspendShortcuts());await a.page.waitForFunction(()=>!window.qaCall.pttDown&&!window.qaMic.track.enabled);
  await a.page.evaluate(()=>window.stringChat.resumeShortcuts());await a.page.waitForFunction(()=>performance.now()-window.qaAdvanced.lastNative<300);
  assert.equal(await a.page.evaluate(()=>window.qaCall.pttDown),false);driver.stdin.write('up\n');await new Promise(r=>setTimeout(r,350));driver.stdin.write('down\n');await a.page.waitForFunction(()=>window.qaCall.pttDown);driver.stdin.write('up\n');await a.page.waitForFunction(()=>!window.qaCall.pttDown);
 });
 await check('Speaking while manually muted warns locally without opening the outgoing track',async()=>{
  await settings(a,async p=>{await p.locator('#voice-input-mode').selectOption('activity');await p.locator('#warn-muted').check();});
  if(await a.page.evaluate(()=>window.qaCall.micOn))await a.page.locator('#mic-button').click();
  await a.page.evaluate(()=>{const advanced=window.qaAdvanced,mic=window.qaMic;advanced.speechSince=performance.now()-700;advanced.lastMutedWarning=-Infinity;mic.telemetry={...mic.telemetry,inputDb:-15,thresholdDb:-40,probability:0.95};mic.telemetryUpdated=performance.now();advanced.tick();});
  assert.equal(await a.page.evaluate(()=>window.qaMic.track.enabled),false);assert(await a.page.getByText('Você está falando com o microfone mutado.',{exact:true}).isVisible());
 });
 await check('Two viewers receive independent encodings and audio-only does not silence the screen sound',async()=>{
  await a.page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d');window.qaCanvasTimer=setInterval(()=>{ctx.fillStyle=`hsl(${performance.now()/20%360} 60% 40%)`;ctx.fillRect(0,0,1920,1080);ctx.fillStyle='white';ctx.fillRect(performance.now()/5%1800,100,100,100);},30);window.qaScreen=canvas.captureStream(30).getVideoTracks()[0];window.qaAudioContext=new AudioContext();const dest=window.qaAudioContext.createMediaStreamDestination(),tone=window.qaAudioContext.createOscillator(),quiet=window.qaAudioContext.createGain();quiet.gain.value=0.001;tone.connect(quiet).connect(dest);tone.start();window.qaTone=tone;await window.qaCall.updateTracks({screen:window.qaScreen,screenAudio:dest.stream.getAudioTracks()[0]});});
  for(const p of[b,c])await p.page.locator('.viewer-quality').waitFor();
  await b.page.locator('.viewer-quality').selectOption('medium');await c.page.locator('.viewer-quality').selectOption('low');
  await b.page.waitForFunction(()=>document.querySelector('.viewer-quality').value==='medium'&&!document.querySelector('.viewer-quality').disabled);
  await c.page.waitForFunction(()=>document.querySelector('.viewer-quality').value==='low'&&!document.querySelector('.viewer-quality').disabled);
  evidence.encodings=await a.page.evaluate(()=>[...window.qaCall.peers.values()].map(p=>({name:p.name,profile:p.viewerProfile,encoding:p.slots[1].sender.getParameters().encodings[0]})));
  const medium=evidence.encodings.find(p=>p.profile==='medium'),low=evidence.encodings.find(p=>p.profile==='low');assert(medium&&low);assert.equal(medium.encoding.maxBitrate,6000000);assert.equal(low.encoding.maxBitrate,2500000);assert.equal(low.encoding.scaleResolutionDownBy,2.25);
  await b.page.locator('.viewer-quality').selectOption('audio');
  await b.page.waitForFunction(()=>document.querySelector('.stream-tile').classList.contains('audio-only')).catch(async e=>{
   const snapshot=await b.page.evaluate(()=>JSON.stringify({select:document.querySelector('.viewer-quality')?.value,classes:document.querySelector('.stream-tile')?.className,pending:[...window.qaCall.peers.values()].map(p=>({name:p.name,viewing:p.viewingQuality,pending:p.qualityRequest?.profile})),toasts:[...document.querySelectorAll('[role=status]')].map(n=>n.textContent)}));
   console.log('QUALITY FAILURE',snapshot);throw e;
  });
  assert.equal(await a.page.evaluate(()=>[...window.qaCall.peers.values()].find(p=>p.viewerProfile==='audio').slots[1].sender.getParameters().encodings[0].active),false);
  assert.equal(await a.page.evaluate(()=>[...window.qaCall.peers.values()].find(p=>p.viewerProfile==='audio').slots[2].sender.track.readyState),'live');
  await b.page.locator('.viewer-quality').selectOption('source');await b.page.waitForFunction(()=>document.querySelector('.stream-tile video').videoWidth>0);
 });
 await check('Ducking preserves the viewer volume, spatial positioning and deafen mute the actual output graph',async()=>{
  evidence.audioRms=await b.page.evaluate(async()=>{const mixer=window.qaAdvanced.mixer,node=[...mixer.nodes.values()].find(n=>n.kind==='screen'),analyser=mixer.context.createAnalyser();analyser.fftSize=2048;node.gain.connect(analyser);await new Promise(r=>setTimeout(r,200));const data=new Float32Array(2048);analyser.getFloatTimeDomainData(data);node.gain.disconnect(analyser);return Math.sqrt(data.reduce((sum,v)=>sum+v*v,0)/data.length);});assert(evidence.audioRms>0.00001,'Screen audio is silent at the final playback graph: '+evidence.audioRms);
  await settings(b,async p=>{await p.locator('#ducking-enabled').check();await p.locator('#ducking-amount').fill('70');await p.locator('#spatial-audio').check();});
  const pan=b.page.locator(`#participants [data-member="${id}"] .voice-position`);await pan.fill('-65');await pan.dispatchEvent('input');
  await b.page.evaluate(()=>{const a=window.qaAdvanced,node=[...a.mixer.nodes.values()].find(n=>n.kind==='screen');node.element.volume=0.42;a.mixer.tick(true,false);});
  evidence.duck=await b.page.evaluate(()=>{const a=window.qaAdvanced,node=[...a.mixer.nodes.values()].find(n=>n.kind==='screen');return{target:node.target,volume:node.element.volume};});assert(Math.abs(evidence.duck.target-0.126)<0.0001);assert.equal(evidence.duck.volume,0.42);
  await b.page.waitForFunction(()=>[...window.qaAdvanced.mixer.nodes.values()].some(n=>n.kind==='voice'&&n.pan.positionX.value < -0.6));
  await b.page.locator('#deafen-button').click();await b.page.waitForFunction(()=>[...window.qaAdvanced.mixer.nodes.values()].every(n=>n.target===0));await b.page.locator('#deafen-button').click();
 });
 await check('Positive correction delays screen audio; negative correction queues and releases image frames',async()=>{
  await settings(b,async p=>{await p.locator('#av-offset').fill('100');await p.locator('#playback-buffer').selectOption('stable');});
  await b.page.waitForFunction(()=>[...window.qaAdvanced.mixer.nodes.values()].some(n=>n.kind==='screen'&&n.delay.delayTime.value>0.09));
  assert.equal(await b.page.evaluate(()=>[...window.qaCall.peers.values()][0].slots[1].receiver.jitterBufferTarget),160);
  await settings(b,p=>p.locator('#av-offset').fill('-100'));await b.page.waitForFunction(()=>[...window.qaAdvanced.tiles.values()].some(r=>r.delay.canvas.width===r.video.videoWidth&&r.video.videoWidth>100&&r.delay.bytes>0));
  evidence.videoDelay=await b.page.evaluate(()=>[...window.qaAdvanced.tiles.values()].map(r=>({delay:r.delay.delay,bytes:r.delay.bytes,width:r.delay.canvas.width})));
  await settings(b,p=>p.locator('#av-offset').fill('0'));assert.equal(await b.page.evaluate(()=>[...window.qaAdvanced.tiles.values()].every(r=>r.delay.bytes===0&&r.delay.canvas.hidden)),true);
 });
 await check('Output selection applies to the audio graph and unavailable devices fall back to Windows default',async()=>{
  await settings(b,async p=>{const options=await p.locator('#audio-output-device option').evaluateAll(o=>o.map(x=>x.value));evidence.outputs=options;const id=options.find(x=>x);if(id)await p.locator('#audio-output-device').selectOption(id);});
  const selected=JSON.parse(await fs.readFile(path.join(b.profile,'preferences.json'),'utf8')).audioOutputDevice;assert.equal(await b.page.evaluate(()=>window.qaAdvanced.mixer.context.sinkId),selected||'');
  await b.page.evaluate(async()=>{const mixer=window.qaAdvanced.mixer,previous=mixer.settings.audioOutputDevice;mixer.settings.audioOutputDevice='unplugged-test-output';try{await mixer.deviceChanged();}finally{mixer.settings.audioOutputDevice=previous;}});assert.equal(await b.page.evaluate(()=>window.qaAdvanced.mixer.context.sinkId),'');
 });
 await check('Video recovery retains screen/audio track identity and falls back to negotiated VP8',async()=>{
  const before=await a.page.evaluate(()=>[window.qaCall.screen.id,window.qaCall.screenAudio.id]);
  await b.page.locator('.recover-video').click();await b.page.waitForFunction(()=>[...window.qaCall.peers.values()].some(p=>p.videoRecoveryStatus==='Vídeo reconectado'));
  await new Promise(r=>setTimeout(r,6200));await b.page.locator('.recover-video').click();
  await a.page.waitForFunction(()=>[...window.qaCall.peers.values()].some(p=>p.videoRecoveries===2&&p.pc.signalingState==='stable'));
  assert.deepEqual(await a.page.evaluate(()=>[window.qaCall.screen.id,window.qaCall.screenAudio.id]),before);
  await a.page.waitForFunction(async()=>{for(const p of window.qaCall.peers.values())if(p.videoRecoveries===2){const stats=await p.pc.getStats();for(const r of stats.values())if(r.type==='outbound-rtp'&&r.kind==='video'&&stats.get(r.codecId)?.mimeType==='video/VP8')return true;}return false;});
 });
 await check('Controls remain inside a small window and fullscreen overlays the complete frame',async()=>{
  await b.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(950,700));await b.page.locator('.stream-tile').hover();await b.page.locator('.stream-fullscreen').click();await b.page.waitForFunction(()=>!!document.fullscreenElement);
  assert.equal(await b.page.locator('.stream-tile video').evaluate(v=>getComputedStyle(v).objectFit),'contain');await b.page.keyboard.press('Escape');await b.page.locator('#profile-button').click();await b.page.locator('#camera-blur').scrollIntoViewIfNeeded();assert(await b.page.locator('#camera-blur').isVisible());await b.page.screenshot({path:path.join(root,'.test-results/advanced-settings.png')});await b.page.locator('#settings-dialog .close-dialog').click();
 });
 await check('Leaving the group releases playback graphs and pending frame buffers',async()=>{
  await b.page.evaluate(()=>window.qaCall.leave());await b.page.waitForFunction(()=>window.qaAdvanced.mixer.nodes.size===0&&window.qaAdvanced.tiles.size===0);
  await a.page.evaluate(()=>{clearInterval(window.qaCanvasTimer);window.qaTone.stop();window.qaAudioContext.close();window.qaCall.leave();});
 });
 assert.deepEqual(errors,[]);const packaged=!!process.env.STRINGCHAT_TEST_EXECUTABLE,version=await a.app.evaluate(({app})=>app.getVersion());await fs.writeFile(path.join(root,packaged?'.test-results/advanced-results-packaged.json':'.test-results/advanced-results.json'),JSON.stringify({version,packaged,checks,evidence,errors,instances:3,sameComputer:true},null,2));
})().catch(async e=>{console.error(e);console.error('RENDERER ERRORS',JSON.stringify(errors));for(const app of apps)try{const p=await app.firstWindow();console.log('DEBUG',await p.evaluate(async()=>({videos:[...document.querySelectorAll('video')].map(v=>({w:v.videoWidth,state:v.readyState,paused:v.paused,error:v.error?.message,tracks:v.srcObject?.getTracks().map(t=>({kind:t.kind,state:t.readyState,muted:t.muted}))})),call:window.qaCall&&{mic:window.qaCall.meta.mic,screen:window.qaCall.meta.screen,peers:await Promise.all([...window.qaCall.peers.values()].map(async p=>({name:p.name,quality:p.viewerProfile,viewing:p.viewingQuality,state:p.pc.connectionState,signaling:p.pc.signalingState,stats:[...(await p.pc.getStats()).values()].filter(r=>['outbound-rtp','inbound-rtp'].includes(r.type)).map(r=>({type:r.type,kind:r.kind,frames:r.framesEncoded??r.framesDecoded,bytes:r.bytesSent??r.bytesReceived,w:r.frameWidth,h:r.frameHeight})),encoding:p.slots[1].sender.getParameters().encodings})))}})));}catch{}process.exitCode=1;}).finally(async()=>{if(driver){driver.stdin.end();}for(const app of apps.reverse())await app.close().catch(()=>{});});
