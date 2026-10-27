import {access,cp,mkdir,readdir,lstat,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
const files=['preferences.json','friends.json','group.json','private-messages.json'];
export async function migrateProfile(legacy,target){
  if(legacy===target)return false;
  const pending=join(target,'profile-import.pending');let resuming=false;try{await access(pending);resuming=true;}catch{}
  if(!resuming)for(const file of files)try{await access(join(target,file));return false;}catch{}
  try{await access(legacy);}catch{return false;}
  const stage=target+'.importing';let stageExists=false;try{const stat=await lstat(stage);stageExists=true;if(stat.isSymbolicLink())throw Error('Pasta de importação inválida.');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stageExists){let marker;try{marker=JSON.parse(await readFile(join(stage,'import-owner.json'),'utf8'));}catch{throw Error('A pasta de importação já existe e foi preservada.');}if(marker.product!=='String Chat')throw Error('Pasta de importação desconhecida.');}
  await mkdir(stage,{recursive:true});await writeFile(join(stage,'import-owner.json'),JSON.stringify({product:'String Chat'}));await mkdir(target,{recursive:true});await writeFile(pending,'String Chat profile import');
  for(const name of [...files,'media','private-media']){const source=join(legacy,name);try{const stat=await lstat(source);if(stat.isSymbolicLink())continue;await cp(source,join(stage,name),{recursive:true,force:true,filter:async p=>!(await lstat(p)).isSymbolicLink()});}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(const entry of await readdir(stage))if(entry!=='import-owner.json')await cp(join(stage,entry),join(target,entry),{recursive:true,force:true});
  await writeFile(join(target,'profile-import.json'),JSON.stringify({imported:true,time:Date.now()}));await unlink(pending);
  if(resolve(stage)!==resolve(target)+'.importing'||dirname(resolve(stage))!==dirname(resolve(target)))throw Error('Pasta de importação inválida.');await rm(stage,{recursive:true});return true;
}
