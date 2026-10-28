// Builds the macOS helper (on macOS), bundles both extensions and writes dist/*.vsix.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (process.platform === 'darwin') {
  run('sh', ['packages/notifier/native/darwin/build.sh']);
} else {
  console.log('Skipping the macOS helper build (not on macOS).');
}
run(process.execPath, ['scripts/build.mjs', '--production']);

fs.mkdirSync(dist, { recursive: true });
const vsce = path.join(root, 'node_modules', '.bin', 'vsce');
for (const [pkg, out] of [['notifier', 'cc-beacon-notifier.vsix'], ['core', 'cc-beacon-core.vsix']]) {
  run(vsce, ['package', '--no-dependencies', '--skip-license', '--allow-missing-repository', '--out', path.join(dist, out)],
    path.join(root, 'packages', pkg));
}
console.log(`\nWrote ${path.join(dist, 'cc-beacon-notifier.vsix')} and ${path.join(dist, 'cc-beacon-core.vsix')}`);
