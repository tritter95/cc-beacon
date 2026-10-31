// @vscode/test-cli configuration for the integration test. scripts/test-integration.mjs builds the
// bundles, prepares the sandbox and passes its path in CC_BEACON_IT_SANDBOX.
import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = process.env.CC_BEACON_IT_SANDBOX;
if (!sandbox) throw new Error('Run the integration test with `npm run test:integration`: it prepares the sandbox.');

export default defineConfig({
  files: 'dist/**/*.test.js',
  version: 'stable',
  extensionDevelopmentPath: [path.resolve(here, '../..'), path.join(here, 'stub-notifier')],
  workspaceFolder: path.join(sandbox, 'project'),
  launchArgs: [
    `--user-data-dir=${path.join(sandbox, 'profile')}`,
    `--extensions-dir=${path.join(sandbox, 'extensions')}`,
    '--disable-extensions',
  ],
  env: { HOME: path.join(sandbox, 'home') },
  mocha: { ui: 'bdd', timeout: 20_000 },
});
