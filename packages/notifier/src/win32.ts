// Windows toasts come in Phase 1b, after the Windows run (docs/phase1-plan.md §9).
import type { NotifierPlatform } from './platform';
import { UnavailableNotifier } from './unavailable';

export function createWin32Notifier(): NotifierPlatform {
  return new UnavailableNotifier('Windows notifications arrive in Phase 1b');
}
