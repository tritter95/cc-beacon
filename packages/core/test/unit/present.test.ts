import { describe, expect, it } from 'vitest';
import { cleanText, formatDuration, present, projectLabel } from '../../src/attention/present';

const settings = { includeMessage: true, maxChars: 140 };

describe('present', () => {
  it('titles approvals with the tool in the subtitle', () => {
    expect(present({ kind: 'needs-input', reason: 'permission', toolName: 'Bash', detail: 'Run tests' }, 'app', settings)).toEqual({
      title: 'Claude needs approval',
      subtitle: 'app · Bash',
      body: 'Run tests',
    });
  });

  it('titles questions, elicitations, failures and reminders', () => {
    expect(present({ kind: 'needs-input', reason: 'question' }, 'app', settings).title).toBe('Claude has a question');
    expect(present({ kind: 'needs-input', reason: 'elicitation' }, 'app', settings).title).toBe('Claude needs input');
    expect(present({ kind: 'failed', reason: 'error' }, 'app', settings).title).toBe('Claude stopped with an error');
    expect(present({ kind: 'reminder', reason: 'idle' }, 'app', settings).title).toBe('Claude is waiting for you');
  });

  it('includes the turn duration, or flags a question', () => {
    expect(present({ kind: 'completed', reason: 'turn-complete', turnMs: 252_000 }, 'app', settings).title).toBe('Claude finished after 4m 12s');
    expect(present({ kind: 'completed', reason: 'turn-complete' }, 'app', settings).title).toBe('Claude finished');
    expect(present({ kind: 'completed', reason: 'turn-complete', endsWithQuestion: true, turnMs: 9000 }, 'app', settings).title).toBe(
      'Claude has a question',
    );
  });

  it('drops the body when message previews are off', () => {
    expect(present({ kind: 'completed', reason: 'turn-complete', detail: 'secret' }, 'app', { includeMessage: false, maxChars: 140 }).body).toBeUndefined();
  });
});

describe('cleanText', () => {
  it('strips Markdown and collapses whitespace', () => {
    expect(cleanText('## Done\n\n- **Fixed** the `parser`\n- See [docs](http://x)', 200)).toBe('Done Fixed the parser See docs');
  });

  it('truncates with an ellipsis within the limit', () => {
    const out = cleanText('a'.repeat(300), 140);
    expect(out).toHaveLength(140);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [999, '1s'],
    [45_000, '45s'],
    [252_000, '4m 12s'],
    [3_780_000, '1h 3m'],
  ])('%i ms → %s', (ms, out) => expect(formatDuration(ms)).toBe(out));
});

describe('projectLabel', () => {
  it('prefers the matched folder, then the cwd', () => {
    expect(projectLabel('/Users/t/code/app', '/Users/t/code/app/src')).toBe('app');
    expect(projectLabel(undefined, '/tmp/scratch')).toBe('scratch');
    expect(projectLabel(undefined, undefined)).toBe('Claude Code');
  });
});
