// Path comparison for cwd → workspace folder matching. Workspace folders are realpath'd when a
// window registers (phase1-plan D16); this only normalizes spelling.

export interface PathStyle {
  /** Compare case-insensitively (macOS and Windows default file systems). */
  caseInsensitive: boolean;
  /** Windows host: backslashes, drive letters, /mnt/c and Git Bash /c/ forms. */
  windows: boolean;
}

export function styleFor(platform: NodeJS.Platform): PathStyle {
  return { caseInsensitive: platform === 'darwin' || platform === 'win32', windows: platform === 'win32' };
}

export function normalizePath(p: string, style: PathStyle): string {
  let s = p.trim();
  if (style.windows) {
    s = s.replace(/\\/g, '/');
    // WSL (/mnt/c/...) and Git Bash (/c/...) spellings of C:\...
    const m = /^\/(?:mnt\/)?([a-zA-Z])(\/|$)(.*)$/.exec(s);
    if (m) s = `${m[1]}:/${m[3]}`;
  }
  const unc = style.windows && s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = `/${s}`;
  if (s.length > 1 && s.endsWith('/') && !/^[a-zA-Z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return style.caseInsensitive ? s.toLowerCase() : s;
}

/** True if child is parent or inside it. Both must already be normalized. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}
