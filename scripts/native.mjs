import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function compile(output, sources, { gui = false, icon = false, resource } = {}) {
  if (process.platform !== 'win32') throw Error('A compilação nativa exige Windows x64.');
  const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(compiler)) throw Error('Compilador C# do .NET Framework 4.x não encontrado.');
  const args = ['/nologo', '/platform:x64', '/optimize+', '/codepage:65001', `/target:${gui ? 'winexe' : 'exe'}`, `/out:${resolve(output)}`];
  if (gui) args.push(...['System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions', 'System.IO.Compression', 'System.IO.Compression.FileSystem'].map(name => `/r:${name}.dll`));
  if (icon) args.push(`/win32icon:${join(root, 'icon.ico')}`);
  if (resource) args.push(`/resource:${resolve(resource)},StringChat.Package.zip`);
  args.push(...sources.map(path => resolve(root, path)));
  const result = spawnSync(compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Falha ao compilar auxiliar nativo.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compile(join(root, 'native/AudioLoopback.exe'), ['native/AudioLoopback.cs']);
}
