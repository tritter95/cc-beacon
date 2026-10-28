// Bundles both extensions with esbuild.
// Usage: node scripts/build.mjs [--watch] [--production] [--only=core|notifier]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const entries = [
  { pkg: 'core', in: 'packages/core/src/extension.ts', out: 'packages/core/dist/extension.js' },
  { pkg: 'core', in: 'packages/core/src/claude/uninstall.ts', out: 'packages/core/dist/uninstall.js' },
  { pkg: 'notifier', in: 'packages/notifier/src/extension.ts', out: 'packages/notifier/dist/extension.js' },
].filter((e) => !only || e.pkg === only);

const contexts = await Promise.all(
  entries.map((e) =>
    esbuild.context({
      absWorkingDir: root,
      entryPoints: [e.in],
      outfile: e.out,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
      // jsonc-parser's UMD entry ("main") requires './impl/format' at runtime, which esbuild can't
      // follow; its ESM entry ("module") bundles cleanly.
      mainFields: ['module', 'main'],
      sourcemap: production ? false : 'linked',
      minify: false,
      logLevel: 'info',
    }),
  ),
);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  // A relative require left in a bundle means a dependency wasn't bundled and the extension
  // will fail to activate (this happened with jsonc-parser's UMD build).
  for (const e of entries) {
    const code = fs.readFileSync(path.join(root, e.out), 'utf8');
    const m = /\brequire\d*\(\s*["']\.{1,2}\//.exec(code);
    if (m) {
      console.error(`${e.out}: unbundled relative require at offset ${m.index}`);
      process.exit(1);
    }
  }
}
