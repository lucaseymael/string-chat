import {spawnSync} from 'node:child_process';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';

export async function testTLS(directory){
  await mkdir(directory,{recursive:true});let keytool=process.env.STRINGCHAT_TEST_KEYTOOL||'keytool';
  if(!process.env.STRINGCHAT_TEST_KEYTOOL&&spawnSync(keytool,['-help'],{windowsHide:true,stdio:'ignore'}).error?.code==='ENOENT'&&process.platform==='win32'){
    const base=join(homedir(),'AppData/Local/Programs/REA'),folders=await readdir(base).catch(()=>[]),jdk=folders.find(name=>name.startsWith('jdk-'));if(jdk)keytool=join(base,jdk,'bin/keytool.exe');
  }
  const store=join(directory,'localhost.p12'),cert=join(directory,'localhost.crt'),password='isolated-test-certificate';
  for(const args of[['-genkeypair','-alias','local-test','-keyalg','RSA','-keysize','2048','-validity','2','-dname','CN=localhost','-ext','SAN=dns:localhost,ip:127.0.0.1','-keystore',store,'-storetype','PKCS12','-storepass',password],['-exportcert','-rfc','-alias','local-test','-keystore',store,'-storepass',password,'-file',cert]]){
    const result=spawnSync(keytool,args,{windowsHide:true,encoding:'utf8'});if(result.error)throw Error('Os testes HTTPS precisam do keytool no PATH ou STRINGCHAT_TEST_KEYTOOL.');if(result.status!==0)throw Error(result.stderr);
  }
  return{caPem:await readFile(cert,'utf8'),tls:{pfx:await readFile(store),passphrase:password}};
}
