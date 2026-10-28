import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {join,resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {verifyInstallation} from '../installation.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const directory=join(root,'.build','verify-'+version+'-'+Date.now()),unpacked=join(directory,'unpacked'),upgrade=join(directory,'installed'),checks=[];
assert(resolve(directory).startsWith(resolve(root,'.build')+sep));await mkdir(directory,{recursive:true});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const run=(file,args)=>{const result=spawnSync(file,args,{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:120000});assert.equal(result.status,0,[file,result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));};
const setup=join(root,'dist','StringChat-Setup-'+version+'.exe');
run(setup,['--unpack',unpacked]);assert.equal(await verifyInstallation(unpacked),version);
const manifest=JSON.parse(await readFile(join(unpacked,'package-manifest.json'),'utf8'));
for(const name of['native/PushToTalk.exe','native/AudioLoopback.exe','hosted-integration.mjs','room-router.mjs','private-search.js','hosted-groups-ui.js','vendor/rnnoise.wasm','vendor/mediapipe/selfie_segmenter.tflite'])assert(manifest.files.some(file=>file.path==='resources/app/'+name),name);
run(join(unpacked,'StringChat.exe'),['--verify-install','--profile='+join(directory,'verify-profile')]);checks.push('setup extraction, every manifest hash and native executable verification');
const previous=process.argv[2]?resolve(process.argv[2]):null;let previousVersion;
if(previous){run(previous,['--test-install',upgrade]);previousVersion=JSON.parse(await readFile(join(upgrade,'current.json'),'utf8')).version;assert.notEqual(previousVersion,version);}
await mkdir(join(upgrade,'personal-files'),{recursive:true});await writeFile(join(upgrade,'personal-files/keep.txt'),'preserve unknown files');
run(setup,['--test-install',upgrade]);assert.equal(JSON.parse(await readFile(join(upgrade,'current.json'),'utf8')).version,version);assert.equal(await verifyInstallation(join(upgrade,version)),version);assert.equal(await readFile(join(upgrade,'personal-files/keep.txt'),'utf8'),'preserve unknown files');checks.push('isolated install preserves unknown files and activates new version');
if(previousVersion){await assert.rejects(access(join(upgrade,previousVersion)));checks.push('recognized previous version '+previousVersion+' removed only after upgrade');}
run(setup,['--test-install',upgrade]);assert.equal(await verifyInstallation(join(upgrade,version)),version);checks.push('same-version repair validates all installed files');
await writeFile(join(root,'.test-results','package-'+version+'.json'),JSON.stringify({version,previousVersion,checks,manifestFiles:manifest.files.length,unpacked,upgrade},null,2));for(const check of checks)console.log('PASS '+check);
