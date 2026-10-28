import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const tests=process.argv.includes('--hosted')?['hosted-services.mjs','hosted-message-actions.mjs','hosted-private-calls.mjs','hosted-groups.mjs']:['friends-presence.mjs','private-message-actions.mjs','group-policy.mjs','group-message-actions.mjs','private-calls.mjs','room-router.mjs'];
for(const test of tests){const result=spawnSync(process.execPath,[join(root,'tests',test)],{cwd:root,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
