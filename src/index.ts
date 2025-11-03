import { promises as fs } from 'fs';
import * as path from 'path';

const MANAGED_COMMENT = '# Managed by cpconfig';

export type ConfigEntry = {
  /**
   * Desired file contents, or a synchronous factory that returns the desired contents.
   */
  contents: string | (() => string);
  /**
   * When false, the file will not be added to the managed .gitignore block.
   */
  gitignore?: boolean;
  /**
   * Optional POSIX file mode applied when creating a new file.
   */
  mode?: number;
};

export type ConfigMap = Record<string, ConfigEntry>;

export type SyncOptions = {
  /**
   * Root directory where config files are written. Defaults to process.cwd().
   */
  rootDir?: string;
  /**
   * Computes the actions without touching the file system when true.
   */
  dryRun?: boolean;
  /**
   * Encoding used for reading and writing files.
   */
  encoding?: BufferEncoding;
  /**
   * Custom location for the .gitignore file. Relative paths resolve from rootDir.
   */
  gitignorePath?: string;
};

export type FileAction = 'created' | 'updated' | 'unchanged';

export type FileSyncResult = {
  /**
   * Path relative to the chosen root directory.
   */
  path: string;
  /**
   * Fully resolved file path on disk.
   */
  absolutePath: string;
  /**
   * The performed action.
   */
  action: FileAction;
  /**
   * Content matched the requested value, so no change was required.
   */
  skipped: boolean;
  /**
   * True when the file is managed within the generated .gitignore block.
   */
  gitignored: boolean;
};

export type GitignoreResult = {
  /**
   * Resolved path to the .gitignore file that was considered.
   */
  path: string;
  /**
   * Indicates if the file would be modified (or was modified when not in dry run).
   */
  updated: boolean;
  /**
   * Entries that were newly added to the managed block.
   */
  added: string[];
  /**
   * Entries that were removed from the managed block because they are no longer supplied.
   */
  removed: string[];
  /**
   * True when there were no entries to manage, so the file was left untouched.
   */
  skipped: boolean;
};

export type SyncResult = {
  /**
   * Resolved root directory used for all file operations.
   */
  rootDir: string;
  /**
   * Per-file action report.
   */
  files: FileSyncResult[];
  /**
   * Status of the managed .gitignore block.
   */
  gitignore: GitignoreResult;
};

type NormalizedConfigFile = {
  relativePath: string;
  absolutePath: string;
  contents: string;
  gitignoreEntry: string | null;
  mode?: number;
};

/**
 * Synchronises config files with the file system and keeps a dedicated block in .gitignore in sync.
 */
export async function syncConfigs(
  files: ConfigMap,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const encoding: BufferEncoding = options.encoding ?? 'utf8';
  const gitignorePath = resolveGitignorePath(rootDir, options.gitignorePath);
  const dryRun = options.dryRun ?? false;

  const normalizedFiles = normalizeFiles(files, rootDir);

  const fileResults: FileSyncResult[] = [];

  for (const file of normalizedFiles) {
    const { action } = await syncFile(file, { dryRun, encoding });

    fileResults.push({
      path: file.relativePath,
      absolutePath: file.absolutePath,
      action,
      skipped: action === 'unchanged',
      gitignored: Boolean(file.gitignoreEntry),
    });
  }

  const gitignoreEntries = normalizedFiles
    .map((file) => file.gitignoreEntry)
    .filter((entry): entry is string => Boolean(entry));

  const gitignoreResult = await syncGitignore({
    rootDir,
    gitignorePath,
    entries: gitignoreEntries,
    encoding,
    dryRun,
  });

  return {
    rootDir,
    files: fileResults,
    gitignore: gitignoreResult,
  };
}

function resolveGitignorePath(rootDir: string, customPath?: string) {
  if (!customPath) {
    return path.join(rootDir, '.gitignore');
  }

  if (path.isAbsolute(customPath)) {
    return customPath;
  }

  return path.resolve(rootDir, customPath);
}

function normalizeFiles(files: ConfigMap, rootDir: string): NormalizedConfigFile[] {
  const seen = new Set<string>();

  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new TypeError('Expected an object map of files to synchronise');
  }

  return Object.entries(files).map(([rawPath, entry], index) => {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new Error(`Config file at index ${index} is missing a valid path`);
    }

    if (!isPlainObject(entry) || !('contents' in entry)) {
      throw new Error(`Config for "${rawPath}" must be an object with a contents property`);
    }

    if (path.isAbsolute(rawPath)) {
      throw new Error(`Config file path "${rawPath}" must be relative to the root directory`);
    }

    const absolutePath = path.resolve(rootDir, rawPath);
    const relativePath = path.relative(rootDir, absolutePath);

    if (
      relativePath.startsWith('..') ||
      relativePath.split(path.sep).some((segment) => segment === '..')
    ) {
      throw new Error(
        `Config file path "${rawPath}" must reside within the root directory "${rootDir}"`,
      );
    }

    const normalizedRelative = normalizeRelativePath(relativePath);

    if (seen.has(normalizedRelative)) {
      throw new Error(`Duplicate config file definition for path "${normalizedRelative}"`);
    }

    seen.add(normalizedRelative);

    const contents = resolveContents(entry.contents, rawPath);

    return {
      absolutePath,
      relativePath: normalizedRelative,
      contents,
      gitignoreEntry: entry.gitignore === false ? null : normalizedRelative,
      mode: entry.mode,
    } satisfies NormalizedConfigFile;
  });
}

function resolveContents(rawContents: ConfigEntry['contents'], filePath: string): string {
  if (typeof rawContents === 'string') {
    return rawContents;
  }

  if (typeof rawContents === 'function') {
    const value = rawContents();

    if (typeof value === 'string') {
      return value;
    }

    if (
      value &&
      typeof (value as unknown) === 'object' &&
      'then' in (value as Record<string, unknown>)
    ) {
      throw new Error(`Async contents are not supported for "${filePath}"`);
    }

    throw new Error(`Contents function for "${filePath}" must return a string`);
  }

  throw new Error(`Contents for "${filePath}" must be a string or a function`);
}

function normalizeRelativePath(relativePath: string): string {
  const posix = relativePath.split(path.sep).join('/');
  return posix.replace(/^\.\/(.*)/, '$1');
}

async function syncFile(
  file: NormalizedConfigFile,
  options: { dryRun: boolean; encoding: BufferEncoding },
): Promise<{ action: FileAction }> {
  const { dryRun, encoding } = options;

  let existing: string | null = null;
  try {
    existing = await fs.readFile(file.absolutePath, { encoding });
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (existing === file.contents) {
    return { action: 'unchanged' };
  }

  if (!dryRun) {
    await fs.mkdir(path.dirname(file.absolutePath), { recursive: true });
    await fs.writeFile(file.absolutePath, file.contents, {
      encoding,
      mode: file.mode,
    });
  }

  return { action: existing === null ? 'created' : 'updated' };
}

type GitignoreSyncOptions = {
  rootDir: string;
  gitignorePath: string;
  entries: string[];
  encoding: BufferEncoding;
  dryRun: boolean;
};

async function syncGitignore(options: GitignoreSyncOptions): Promise<GitignoreResult> {
  const { gitignorePath, entries, encoding, dryRun } = options;
  const uniqueEntries = uniqueNormalized(entries.map(normalizeGitignoreEntry)).filter(Boolean);

  if (uniqueEntries.length === 0) {
    return {
      path: gitignorePath,
      updated: false,
      added: [],
      removed: [],
      skipped: true,
    };
  }

  const current = await readFileIfPresent(gitignorePath, encoding);
  const { managedEntries, linesWithoutBlock } = extractManagedBlock(current ?? '');

  const existingBlock = managedEntries.map(normalizeGitignoreEntry).filter(Boolean);

  if (arraysEqual(existingBlock, uniqueEntries)) {
    return {
      path: gitignorePath,
      updated: false,
      added: [],
      removed: [],
      skipped: false,
    };
  }

  const added = uniqueEntries.filter((entry) => !existingBlock.includes(entry));
  const removed = existingBlock.filter((entry) => !uniqueEntries.includes(entry));

  const nextContent = buildGitignoreContent(linesWithoutBlock, uniqueEntries);

  if (!dryRun) {
    await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
    await fs.writeFile(gitignorePath, nextContent, { encoding });
  }

  return {
    path: gitignorePath,
    updated: true,
    added,
    removed,
    skipped: false,
  };
}

function normalizeGitignoreEntry(value: string): string {
  const trimmed = value.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return '';
  }

  return trimmed.replace(/^\.\//, '').replace(/\\/g, '/');
}

function uniqueNormalized(entries: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    result.push(entry);
  }

  return result;
}

async function readFileIfPresent(
  filePath: string,
  encoding: BufferEncoding,
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, { encoding });
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

type ManagedBlockExtraction = {
  managedEntries: string[];
  linesWithoutBlock: string[];
};

function extractManagedBlock(content: string): ManagedBlockExtraction {
  const lines = splitLines(content);

  const commentIndex = lines.findIndex((line) => line === MANAGED_COMMENT);

  if (commentIndex === -1) {
    return {
      managedEntries: [],
      linesWithoutBlock: trimTrailingEmptyLines(lines),
    };
  }

  let blockEnd = commentIndex + 1;

  while (blockEnd < lines.length) {
    const current = lines[blockEnd];
    if (current.trim() === '' || current.startsWith('#')) {
      break;
    }

    blockEnd += 1;
  }

  // Skip a single separating blank line when removing the block.
  if (blockEnd < lines.length && lines[blockEnd].trim() === '') {
    blockEnd += 1;
  }

  const managedEntries = lines
    .slice(commentIndex + 1, blockEnd)
    .filter((line) => line.trim() !== '');
  const before = lines.slice(0, commentIndex);
  const after = lines.slice(blockEnd);

  return {
    managedEntries,
    linesWithoutBlock: trimTrailingEmptyLines([...before, ...after]),
  };
}

function buildGitignoreContent(linesWithoutBlock: string[], managedEntries: string[]): string {
  const resultLines = [...trimTrailingEmptyLines(linesWithoutBlock)];

  if (managedEntries.length > 0) {
    if (resultLines.length > 0 && resultLines[resultLines.length - 1] !== '') {
      resultLines.push('');
    }

    resultLines.push(MANAGED_COMMENT, ...managedEntries);
  }

  const result = resultLines.join('\n');
  return result.length > 0 ? `${result}\n` : '';
}

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }

  const lines = content.split(/\r?\n/);

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const trimmed = [...lines];

  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') {
    trimmed.pop();
  }

  return trimmed;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
