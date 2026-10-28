import { describe, expect, it } from 'vitest';
import { OSASCRIPT_LINES, osascriptArgs } from '../../src/fallback';

const base = { id: 'n', threadId: 't', title: 'T', clickUri: 'vscode://x', sound: null };

describe('osascriptArgs', () => {
  it('passes text as run-handler arguments after --, never inside the script', () => {
    const evil = '" & (do shell script "touch /tmp/pwned") & "';
    const args = osascriptArgs({ ...base, title: evil, subtitle: '-x', body: 'line\nbreak', sound: 'Glass' });
    const dash = args.indexOf('--');
    expect(args.slice(dash + 1)).toEqual([evil, '-x', 'line\nbreak', 'Glass']);
    const script = args.slice(0, dash).filter((_, i) => i % 2 === 1);
    expect(script).toEqual(OSASCRIPT_LINES);
    expect(script.join('\n')).not.toContain('pwned');
  });

  it('sends empty strings for missing fields and drops unsafe or default sounds', () => {
    const tail = (sound: string | null) => osascriptArgs({ ...base, sound }).slice(-4);
    expect(tail(null)).toEqual(['T', '', '', '']);
    expect(tail('default')).toEqual(['T', '', '', '']);
    expect(tail('../x')).toEqual(['T', '', '', '']);
    expect(tail('Hero')).toEqual(['T', '', '', 'Hero']);
  });
});
