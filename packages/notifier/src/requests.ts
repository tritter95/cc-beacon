// Core's requests cross extension hosts as JSON, so check their shape before using them.
import type { NotifyRequest, PlaySoundRequest, WithdrawRequest } from '../../shared/src/notifierApi';

const isString = (v: unknown): v is string => typeof v === 'string';
const optionalString = (v: unknown) => v === undefined || isString(v);

export function isNotifyRequest(v: unknown): v is NotifyRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return isString(r.id) && r.id !== '' && isString(r.threadId) && isString(r.title) && isString(r.clickUri)
    && optionalString(r.subtitle) && optionalString(r.body)
    && (r.sound === null || isString(r.sound))
    && (r.replaceThread === undefined || typeof r.replaceThread === 'boolean');
}

export function isWithdrawRequest(v: unknown): v is WithdrawRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (isString(r.id) && r.id !== '') || (isString(r.threadId) && r.threadId !== '');
}

export function isPlaySoundRequest(v: unknown): v is PlaySoundRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return isString(r.name) && typeof r.volume === 'number';
}
