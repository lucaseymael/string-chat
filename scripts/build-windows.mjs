import { cp, mkdir, rename, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { root, compile } from './native.mjs';
import { rcedit } from 'rcedit';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Gere o pacote em Windows x64.');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error('Use uma versão numérica x.y.z.');
for (const name of ['native/InstallSupport.cs', 'native/Installer.cs', 'native/Maintenance.cs']) {
  const source = await readFile(join(root, name), 'utf8');
  if (!source.includes(name.endsWith('InstallSupport.cs') ? `Version="${pkg.version}"` : `AssemblyVersion("${pkg.version}.0")`)) throw Error(`Atualize a versão também em ${name}.`);
}
const runtime = join(root, 'node_modules/electron/dist');
const runtimeVersion = (await readFile(join(runtime, 'version'), 'utf8')).trim().replace(/^v/, '');
if (runtimeVersion !== pkg.devDependencies.electron) throw Error('Runtime Electron não corresponde ao package.json. Execute npm ci.');
const dist = join(root, 'dist'), output = join(dist, 'StringChat-Desktop');
// Only this fixed build directory is replaced; installed versions and profiles are never touched.
if (!resolve(output).startsWith(resolve(dist) + sep)) throw Error('Destino inválido.');
await mkdir(dist, { recursive: true });
await rm(output, { recursive: true, force: true });
await cp(runtime, output, { recursive: true });
await rename(join(output, 'electron.exe'), join(output, 'StringChat.exe'));
await rm(join(output, 'resources/default_app.asar'), { force: true });
const app = join(output, 'resources/app');
await mkdir(join(app, 'native'), { recursive: true });
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:js|mjs|cjs|css|html)$/.test(entry.name)) await cp(join(root, entry.name), join(app, entry.name));
}
for (const name of ['icon.svg', 'icon.png', 'icon.ico', 'package.json', 'vendor']) await cp(join(root, name), join(app, name), { recursive: true });
compile(join(app, 'native/AudioLoopback.exe'), ['native/AudioLoopback.cs']);
compile(join(output, 'StringChatMaintenance.exe'), ['native/Maintenance.cs', 'native/InstallSupport.cs'], { gui: true, icon: true });
await rcedit(join(output, 'StringChat.exe'), {
  icon: join(root, 'icon.ico'), 'file-version': pkg.version, 'product-version': pkg.version,
  'version-string': { FileDescription: 'String Chat', ProductName: 'String Chat' },
});
await cp(join(root, 'docs/COMO-USAR.md'), join(output, 'COMO-USAR.md'));
await writeFile(join(output, 'LEIA-ME.txt'), `String Chat ${pkg.version}\r\nAbra StringChat.exe e mantenha todos os arquivos desta pasta juntos.\r\nVeja COMO-USAR.md. O Radmin deve estar conectado antes de entrar em grupos.\r\n`);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Link inesperado no pacote.');
    if (entry.isDirectory()) await walk(path);
    else files.push({ path: path.slice(output.length + 1).split(sep).join('/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
}
await walk(output);
await writeFile(join(output, 'package-manifest.json'), JSON.stringify({ product: 'String Chat', version: pkg.version, files }, null, 2));
const packaged = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/package-windows.ps1')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (packaged.error) throw packaged.error;
if (packaged.status !== 0) throw Error('Falha ao gerar instalador.');
console.log(`String Chat ${pkg.version}: setup, ZIP e hashes disponíveis em dist/.`);
