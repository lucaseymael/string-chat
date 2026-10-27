import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './native.mjs';
let count = 0;
for (const directory of ['', 'scripts', 'tests']) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
    const path = join(root, directory, entry.name);
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
}
console.log(`Sintaxe válida: ${count} módulos.`);
