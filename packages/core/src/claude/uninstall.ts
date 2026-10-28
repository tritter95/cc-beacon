// Runs as `vscode:uninstall` (plain Node, no vscode API) after CC Beacon is fully uninstalled:
// removes only our hook entries from ~/.claude/settings.json.
import { withoutHooks } from './hookConfig';
import { claudeSettingsPath, readSettings, writeSettings } from './settingsFile';

try {
  const file = claudeSettingsPath();
  const { text, exists } = readSettings(file);
  if (exists) {
    const result = withoutHooks(text);
    if ('error' in result) console.error(`CC Beacon: left ${file} unchanged: ${result.error}`);
    else if (result.changed) {
      writeSettings(file, result.text);
      console.log(`CC Beacon: removed ${result.removed} hook entries from ${file}`);
    }
  }
} catch (e) {
  console.error(`CC Beacon: couldn't remove hooks: ${String(e)}`);
}
