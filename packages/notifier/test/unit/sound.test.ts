import { describe, expect, it } from 'vitest';
import { afplayArgs, playSystemSound, systemSoundPath } from '../../src/sound';

describe('systemSoundPath', () => {
  const exists = (p: string) => p === '/System/Library/Sounds/Glass.aiff';
  it('resolves known names', () => {
    expect(systemSoundPath('Glass', exists)).toBe('/System/Library/Sounds/Glass.aiff');
  });
  it('rejects unknown and path-like names', () => {
    expect(systemSoundPath('Nope', exists)).toBeUndefined();
    expect(systemSoundPath('../Glass', exists)).toBeUndefined();
    expect(systemSoundPath('Glass.aiff', exists)).toBeUndefined();
    expect(systemSoundPath('', exists)).toBeUndefined();
  });
});

describe('afplayArgs', () => {
  it('clamps the volume', () => {
    expect(afplayArgs('/f', 0.6)).toEqual(['-v', '0.60', '/f']);
    expect(afplayArgs('/f', 7)).toEqual(['-v', '1.00', '/f']);
    expect(afplayArgs('/f', -1)).toEqual(['-v', '0.00', '/f']);
    expect(afplayArgs('/f', Number.NaN)).toEqual(['-v', '1.00', '/f']);
  });
});

describe('playSystemSound', () => {
  it('treats none as a silent success and rejects unknown names', async () => {
    expect(await playSystemSound({ name: 'none', volume: 1 })).toEqual({ ok: true });
    expect(await playSystemSound({ name: '../etc/passwd', volume: 1 })).toMatchObject({ ok: false });
  });
});
