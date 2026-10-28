import { describe, expect, it } from 'vitest';
import { isWithin, normalizePath, styleFor } from '../../src/routing/pathNormalize';

const mac = styleFor('darwin');
const win = styleFor('win32');
const linux = styleFor('linux');

describe('normalizePath', () => {
  it('folds case on macOS and Windows but not Linux', () => {
    expect(normalizePath('/Users/Todd/Code', mac)).toBe('/users/todd/code');
    expect(normalizePath('/home/Todd/Code', linux)).toBe('/home/Todd/Code');
  });

  it('removes trailing and doubled slashes', () => {
    expect(normalizePath('/a//b/c/', mac)).toBe('/a/b/c');
    expect(normalizePath('/', mac)).toBe('/');
  });

  it('maps Windows spellings to one form', () => {
    expect(normalizePath('C:\\Users\\Todd\\app\\', win)).toBe('c:/users/todd/app');
    expect(normalizePath('/mnt/c/Users/Todd/app', win)).toBe('c:/users/todd/app');
    expect(normalizePath('/c/Users/Todd/app', win)).toBe('c:/users/todd/app');
    expect(normalizePath('C:\\', win)).toBe('c:/');
    expect(normalizePath('\\\\server\\share\\dir', win)).toBe('//server/share/dir');
  });
});

describe('isWithin', () => {
  it('matches the folder itself and its children only', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b')).toBe(true);
    expect(isWithin('/a/bc', '/a/b')).toBe(false);
    expect(isWithin('c:/x', 'c:/')).toBe(true);
  });
});
