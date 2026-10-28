// Installs both VSIX files into local VS Code: Notifier first, then Core.
// Also removes the Phase 0 probe, which would fight Core over CC_BEACON_WINDOW.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = process.env.CODE_CLI || 'code';
const vsix = (name) => path.join(root, 'dist', name);

for (const f of ['cc-beacon-notifier.vsix', 'cc-beacon-core.vsix']) {
  if (!fs.existsSync(vsix(f))) {
    console.error(`Missing ${vsix(f)}. Run npm run package first.`);
    process.exit(1);
  }
}

const installed = execFileSync(code, ['--list-extensions'], { encoding: 'utf8' }).split('\n');
if (installed.includes('phase0.ccb-probe')) {
  console.log('Uninstalling the Phase 0 probe (phase0.ccb-probe)...');
  execFileSync(code, ['--uninstall-extension', 'phase0.ccb-probe'], { stdio: 'inherit' });
}
for (const f of ['cc-beacon-notifier.vsix', 'cc-beacon-core.vsix']) {
  execFileSync(code, ['--install-extension', vsix(f), '--force'], { stdio: 'inherit' });
}

console.log(`
Installed. Reload open VS Code windows (Developer: Reload Window) to pick up the new version.

Remote windows (SSH, WSL, Dev Containers): the Notifier is already installed locally.
Install Core on each remote host by running this in that window's integrated terminal:
  code --install-extension ${vsix('cc-beacon-core.vsix')}
(copy the file to the remote host first if the path isn't visible there)`);
