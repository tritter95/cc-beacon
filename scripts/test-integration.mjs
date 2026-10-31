// Runs the integration test (phase1-plan M7) in a downloaded VS Code, cached in .vscode-test/.
// HOME, the VS Code profile and the hub port all point into a throwaway sandbox, so your own
// ~/.claude, ~/.cc-beacon and VS Code are never touched. The sandbox is kept when the test fails.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'packages/core/test/integration');
const out = path.join(dir, 'dist');

// 1. Core's bundle, then the tests, the stub Notifier, and hookConfig for writing the sandbox's hooks.
//    The esbuild settings match scripts/build.mjs.
execFileSync(process.execPath, ['scripts/build.mjs', '--only=core'], { cwd: root, stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
const bundle = (options) =>
  esbuild.build({
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    mainFields: ['module', 'main'],
    sourcemap: 'linked',
    logLevel: 'warning',
    ...options,
  });
const tests = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f));
await Promise.all([
  bundle({ entryPoints: tests, outdir: out }),
  bundle({ entryPoints: [path.join(dir, 'stub-notifier/extension.ts')], outfile: path.join(dir, 'stub-notifier/dist/extension.js') }),
  bundle({ entryPoints: ['packages/core/src/claude/hookConfig.ts'], outfile: path.join(out, 'hookConfig.cjs'), sourcemap: false }),
]);

// 2. A free port for the hub, so a CC Beacon running in your own VS Code keeps its port.
const port = await new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// 3. The sandbox. VS Code puts its IPC socket in the profile directory, and macOS caps socket paths
//    at 104 bytes, so the base must be short.
const base = os.tmpdir().length <= 60 ? os.tmpdir() : '/tmp';
const sandbox = fs.mkdtempSync(path.join(base, 'ccb-it-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const { withHooks } = createRequire(import.meta.url)(path.join(out, 'hookConfig.cjs'));
const hooks = withHooks('', port);
if ('error' in hooks) throw new Error(hooks.error);
write(path.join(sandbox, 'home/.claude/settings.json'), hooks.text);
const settings = {
  'ccBeacon.port': port,
  // Alert through the Notifier whether or not the test window has focus.
  'ccBeacon.osNotifications.when': 'always',
  // A replayed turn is far quicker than the recorded one.
  'ccBeacon.completed.minTurnSeconds': 0,
  'workbench.startupEditor': 'none',
  // Keeps the built-in chat from filling the test output.
  'chat.disableAIFeatures': true,
};
write(path.join(sandbox, 'profile/User/settings.json'), JSON.stringify(settings, null, 2));
fs.mkdirSync(path.join(sandbox, 'project'));

// 4. Run it. VS Code passes its environment on to the extension host, so drop the variables of any
//    Claude Code session this was started from.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CC_BEACON_)/.test(k)));
env.CC_BEACON_IT_SANDBOX = sandbox;
const cli = path.join(root, 'node_modules/@vscode/test-cli/out/bin.mjs');
const result = spawnSync(process.execPath, [cli, '--config', path.join(dir, 'vscode-test.config.mjs')], { cwd: root, stdio: 'inherit', env });

if (result.status === 0) {
  fs.rmSync(sandbox, { recursive: true, force: true });
} else {
  console.error(`\nThe integration test failed. Its sandbox is kept: ${sandbox}`);
  console.error(`Core's log is under ${path.join(sandbox, 'profile/logs')}, in window1/exthost/output_logging_*/.`);
}
process.exit(result.status ?? 1);
