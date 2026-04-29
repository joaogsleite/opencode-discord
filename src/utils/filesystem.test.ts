import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSafePath, listDirectory, inferLanguage } from './filesystem.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('resolveSafePath', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('resolves relative path within project root', () => {
    const result = resolveSafePath('/project', 'src/index.ts');
    expect(result).toBe('/project/src/index.ts');
  });

  it('throws on path traversal with ../', () => {
    expect(() => resolveSafePath('/project', '../etc/passwd')).toThrow();
  });

  it('throws on absolute path outside project', () => {
    expect(() => resolveSafePath('/project', '/etc/passwd')).toThrow();
  });

  it('handles empty relative path as project root', () => {
    const result = resolveSafePath('/project', '');
    expect(result).toBe('/project');
  });

  it('handles nested ../ that stays within project', () => {
    const result = resolveSafePath('/project', 'src/../lib/utils.ts');
    expect(result).toBe('/project/lib/utils.ts');
  });

  it('rejects a symlink inside the project root that resolves outside', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-test-'));
    const projectRoot = path.join(tmpDir, 'project');
    const outsideRoot = path.join(tmpDir, 'outside');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret');
    fs.symlinkSync(outsideRoot, path.join(projectRoot, 'linked-outside'));

    expect(() => resolveSafePath(projectRoot, 'linked-outside/secret.txt')).toThrow();
  });

  it('accepts a symlink inside the project root that resolves inside', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-test-'));
    const projectRoot = path.join(tmpDir, 'project');
    const targetRoot = path.join(projectRoot, 'actual');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(targetRoot);
    fs.writeFileSync(path.join(targetRoot, 'note.txt'), 'note');
    fs.symlinkSync(targetRoot, path.join(projectRoot, 'linked-inside'));

    expect(resolveSafePath(projectRoot, 'linked-inside/note.txt')).toBe(fs.realpathSync.native(path.join(targetRoot, 'note.txt')));
  });
});

describe('listDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
    fs.writeFileSync(path.join(tmpDir, '.hidden'), 'content');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists directory contents with trailing / for directories', async () => {
    const entries = await listDirectory(tmpDir);
    expect(entries).toContain('subdir/');
    expect(entries).toContain('file.ts');
    expect(entries).toContain('.hidden');
  });

  it('sorts directories first, then files', async () => {
    const entries = await listDirectory(tmpDir);
    const dirIdx = entries.indexOf('subdir/');
    const fileIdx = entries.indexOf('file.ts');
    expect(dirIdx).toBeLessThan(fileIdx);
  });
});

describe('inferLanguage', () => {
  it('infers typescript from .ts', () => {
    expect(inferLanguage('file.ts')).toBe('typescript');
  });

  it('infers javascript from .js', () => {
    expect(inferLanguage('file.js')).toBe('javascript');
  });

  it('infers json from .json', () => {
    expect(inferLanguage('file.json')).toBe('json');
  });

  it('returns empty string for unknown extension', () => {
    expect(inferLanguage('file.xyz')).toBe('');
  });
});
