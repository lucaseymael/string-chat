import { spawn } from 'node:child_process';
import { normalizeAdvancedSettings, pushToTalkKeys } from './advanced-settings.js';
export class KeyMonitor {
  constructor(binary, onState, onError) { this.binary=binary;this.onState=onState;this.onError=onError;this.settings={};this.active=false;this.suspended=false;this.child=null;this.key=''; }
  configure(settings) { this.settings=normalizeAdvancedSettings(settings);this.refresh(); }
  setActive(active) { this.active=!!active;this.refresh(); }
  suspend() { this.suspended=true;this.stop(); }
  resume() { this.suspended=false;this.refresh(); }
  refresh() {
    const enabled=this.active&&!this.suspended&&this.settings.voiceInputMode==='ptt';
    const key=enabled?this.settings.pttShortcut:'';
    if(this.child&&key===this.key)return;
    this.stop();if(!key)return;this.key=key;
    if(process.platform!=='win32'){this.onError('Pressionar para falar global exige Windows.');return;}
    let child;try{child=spawn(this.binary,[String(process.pid),pushToTalkKeys(key).join(',')],{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{this.onError('O monitor da tecla não iniciou. Repare o app pelo setup.');return;}
    this.child=child;child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});let pending='';
    child.stdout.on('data',bytes=>{pending+=bytes.toString();if(pending.length>2048){this.stop();return;}let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const value=JSON.parse(line);if(this.child===child)this.onState({down:value.down===true});}catch{this.stop();}}});
    child.on('error',()=>{if(this.child===child){this.child=null;this.onState({down:false});this.onError('O monitor da tecla não iniciou. Repare o app pelo setup.');}});
    child.on('exit',()=>{if(this.child===child){this.child=null;this.onState({down:false});}});
  }
  stop() { const child=this.child;this.child=null;this.key='';this.onState({down:false});if(child){child.stdin.end();child.kill();} }
}
