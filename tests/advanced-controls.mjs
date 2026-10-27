import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {VoiceGate} from '../voice-dsp.js';
import {screenEncoding,normalizeAdvancedSettings,pushToTalkKeys} from '../advanced-settings.js';
import {handleMediaControl} from '../rtc-controls.js';

let Processor;
vm.runInNewContext((await readFile('voice-worklet.js','utf8')).replace(/^import[^\n]*\n/,''),{
 AudioWorkletProcessor:class{constructor(){this.port={postMessage(){}};}},sampleRate:48000,VoiceGate,Float32Array,Math,
 registerProcessor:(_,value)=>Processor=value,
});
const processor=new Processor({processorOptions:{voiceInputMode:'ptt',voiceGate:false}});
const input=Float32Array.from({length:128},(_,i)=>Math.sin(i*0.17)*0.2),output=new Float32Array(128);
const feed=()=>{processor.process([[input]],[[output]]);return output.some(v=>v!==0);};
assert.equal(feed(),false);processor.port.onmessage({data:{type:'ptt',down:true,leaseMs:100}});assert.equal(feed(),true);
for(let i=0;i<38;i++)feed();assert.equal(feed(),false);
console.log('PASS The audio-thread PTT lease expires into silence without UI timers or key events');
processor.port.onmessage({data:{type:'ptt',down:true,leaseMs:800}});assert.equal(feed(),true);processor.port.onmessage({data:{type:'ptt',down:false}});assert.equal(feed(),false);
processor.port.onmessage({data:{type:'settings',value:{voiceInputMode:'activity',voiceGate:false}}});assert.equal(feed(),true);
console.log('PASS Key release silences the worklet and activity mode can be restored');
assert.deepEqual(pushToTalkKeys('Control+Alt+Shift+F23'),[17,18,16,134]);assert.throws(()=>pushToTalkKeys('A'));
const value=normalizeAdvancedSettings({avOffsetMs:1000,duckingAmount:Infinity,pttShortcut:'Alt+Tab',cameraBlur:'yes'});assert.equal(value.avOffsetMs,300);assert.equal(value.duckingAmount,70);assert.equal(value.pttShortcut,'F8');assert.equal(value.cameraBlur,false);
assert.equal(screenEncoding({resolution:1080,bitrate:4,fps:60},'medium').maxBitrate,4000000);
console.log('PASS Settings and shortcuts reject unsafe input and viewer quality respects the sender bitrate cap');
const sent=[],peer={id:'a'.repeat(32),meta:{voiceChannelId:'voice-1'},slots:[]},call={screen:{},externalSignal:true,voiceChannelId:'voice-1',send:(_,message)=>sent.push(message),configurePeer:async()=>{throw Error('Encoding refused');}};
await handleMediaControl.call(call,peer,{type:'viewer-quality',profile:'arbitrary',requestId:'b'.repeat(36)});assert.equal(sent.length,0);
await handleMediaControl.call(call,peer,{type:'viewer-quality',profile:'__proto__',requestId:crypto.randomUUID()});assert.equal(sent.length,0);
peer.meta.voiceChannelId='voice-2';await handleMediaControl.call(call,peer,{type:'viewer-quality',profile:'low',requestId:crypto.randomUUID()});assert.match(sent.pop().error,/encerrada/);assert.equal(peer.viewerProfile,undefined);
console.log('PASS Unsupported quality and media controls from other voice channels do not change encodings');
peer.meta.voiceChannelId='voice-1';peer.viewerProfile='source';call.configurePeer=async(_,strict)=>{if(strict)throw Error('Encoding refused');};
await handleMediaControl.call(call,peer,{type:'viewer-quality',profile:'low',requestId:crypto.randomUUID()});assert.equal(peer.viewerProfile,'source');assert(sent.pop().error);
console.log('PASS A failed encoding change restores the earlier profile and returns a failure acknowledgement');
