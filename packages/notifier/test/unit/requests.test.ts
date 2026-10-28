import { describe, expect, it } from 'vitest';
import { isNotifyRequest, isPlaySoundRequest, isWithdrawRequest } from '../../src/requests';

describe('request validation', () => {
  const ok = { id: 'n', threadId: 't', title: 'T', clickUri: 'vscode://x', sound: null };
  it('accepts well-formed notify requests', () => {
    expect(isNotifyRequest(ok)).toBe(true);
    expect(isNotifyRequest({ ...ok, subtitle: 's', body: 'b', sound: 'Glass', replaceThread: true })).toBe(true);
  });
  it('rejects malformed notify requests', () => {
    expect(isNotifyRequest(undefined)).toBe(false);
    expect(isNotifyRequest({ ...ok, id: '' })).toBe(false);
    expect(isNotifyRequest({ ...ok, title: 3 })).toBe(false);
    expect(isNotifyRequest({ ...ok, sound: undefined })).toBe(false);
    expect(isNotifyRequest({ ...ok, body: {} })).toBe(false);
  });
  it('checks withdraw and sound requests', () => {
    expect(isWithdrawRequest({ id: 'n' })).toBe(true);
    expect(isWithdrawRequest({ threadId: 't' })).toBe(true);
    expect(isWithdrawRequest({ id: '' })).toBe(false);
    expect(isWithdrawRequest({})).toBe(false);
    expect(isPlaySoundRequest({ name: 'Glass', volume: 0.5 })).toBe(true);
    expect(isPlaySoundRequest({ name: 'Glass' })).toBe(false);
  });
});
