import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './native.mjs';
await mkdir(join(root, '.test-results'), { recursive: true });
const tests = process.argv.includes('--network') ? ['private-services.mjs', 'group-services.mjs'] : ['audio-shortcuts.mjs', 'voice-dsp.mjs', 'voice-state.mjs'];
for (const test of tests) {
  const result = spawnSync(process.execPath, [join(root, 'tests', test)], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
