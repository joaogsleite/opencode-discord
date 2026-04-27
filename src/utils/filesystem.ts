import * as fs from 'node:fs';
import * as path from 'node:path';
import { BotError, ErrorCode } from './errors.js';

/**
 * Resolve a relative path safely within a project root.
 * @param projectRoot - Absolute path to the project root.
 * @param relativePath - User-provided relative path.
 * @returns Resolved absolute path guaranteed to be within projectRoot.
 * @throws BotError with PATH_ESCAPE if path escapes project root.
 */
export function resolveSafePath(projectRoot: string, relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath || '.');
  const normalizedRoot = path.resolve(projectRoot);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new BotError(ErrorCode.PATH_ESCAPE, `Path escapes project root: ${relativePath}`, {
      projectRoot,
      relativePath,
      resolved,
    });
  }

  return resolved;
}

/**
 * List directory contents with trailing / for directories.
 * @param dirPath - Absolute path to directory.
 * @returns Sorted array: directories first with trailing /, then files.
 */
export async function listDirectory(dirPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name + '/');
    } else {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  return [...dirs, ...files];
}

/** Language extension mapping for syntax highlighting. */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.css': 'css',
  '.html': 'html',
  '.sql': 'sql',
  '.toml': 'toml',
  '.xml': 'xml',
  '.diff': 'diff',
};

/**
 * Infer syntax highlighting language from file extension.
 * @param filePath - File path or name.
 * @returns Language identifier for fenced code blocks, or empty string.
 */
export function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? '';
}
