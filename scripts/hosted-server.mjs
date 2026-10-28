import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HostedService } from '../hosted-service.mjs';
import { HostedGroups } from '../hosted-groups.mjs';

const args = process.argv.slice(2), options = {};
if (args.includes('--help')) {
  console.log('String Chat — servidor HTTPS\n\nnode scripts/hosted-server.mjs --data <pasta> --cert <fullchain.pem> --key <private-key.pem> [--host 127.0.0.1] [--port 8443] [--public-url https://chat.example.com]\n\nToken de cadastro: variável STRINGCHAT_REGISTRATION_TOKEN ou arquivo registration-token.txt dentro da pasta de dados. O token nunca é exibido nos logs. Certificado e chave são fornecidos pelo administrador. Use --public-url para fixar o endereço externo dos convites; sem isso, o endereço HTTPS usado pelo criador do grupo é validado e mantido.');
  process.exit(0);
}
for (let index = 0; index < args.length; index += 2) { if (!['--data', '--cert', '--key', '--host', '--port','--public-url'].includes(args[index]) || !args[index + 1]) throw new Error('Argumento inválido. Use --help.'); options[args[index].slice(2)] = args[index + 1]; }
const dataPath = options.data || process.env.STRINGCHAT_SERVER_DATA, certPath = options.cert || process.env.STRINGCHAT_TLS_CERT, keyPath = options.key || process.env.STRINGCHAT_TLS_KEY;
if (!dataPath || !certPath || !keyPath) throw new Error('Informe --data, --cert e --key. A pasta de dados deve ficar fora do repositório público.');
const directory = resolve(dataPath), port = Number(options.port || process.env.PORT || 8443), host = options.host || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta inválida.');
await mkdir(directory, { recursive: true, mode: 0o700 });
let token = process.env.STRINGCHAT_REGISTRATION_TOKEN;
if (!token) { const tokenPath = join(directory, 'registration-token.txt'); try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; token = randomBytes(32).toString('base64url'); await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); console.log('Token de cadastro criado em ' + tokenPath + '. Compartilhe somente com pessoas autorizadas.'); } }
const groups=new HostedGroups({statePath:join(directory,'groups.json'),publicUrl:options['public-url']||process.env.STRINGCHAT_PUBLIC_URL||''});
const server = new HostedService({ statePath: join(directory, 'state.json'), tls: { cert: await readFile(resolve(certPath)), key: await readFile(resolve(keyPath)) }, registrationToken: token,extensions:[groups] });
server.on('warning', value => console.error('Aviso do servidor:', value.code));
const address = await server.start({ host, port }); console.log('String Chat HTTPS ouvindo em ' + address.address + ':' + address.port + '. Dados: ' + directory);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await server.close(); process.exit(0); });
