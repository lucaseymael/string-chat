import{readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{join,resolve,sep}from'node:path';
export async function verifyInstallation(directory){
  const manifest=JSON.parse(await readFile(join(directory,'package-manifest.json'),'utf8'));if(manifest.product!=='String Chat'||!Array.isArray(manifest.files)||manifest.files.length<10)throw Error('Pacote inválido.');
  for(const file of manifest.files){const target=resolve(directory,file.path);if(!target.startsWith(resolve(directory)+sep)||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Caminho inválido.');const hash=createHash('sha256').update(await readFile(target)).digest('hex');if(hash!==file.sha256)throw Error('Arquivo incompleto: '+file.path);}
  return manifest.version;
}
