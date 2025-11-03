#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import {
  syncConfigs,
  type ConfigMap,
  type ConfigEntry,
  type SyncOptions,
  type SyncResult,
} from './index';

type CliRunOptions = {
  cwd?: string;
  stdout?: Pick<NodeJS.WritableStream, 'write'>;
  stderr?: Pick<NodeJS.WritableStream, 'write'>;
};

type CliFlags = {
  dryRun: boolean;
  json: boolean;
  rootDir?: string;
  gitignorePath?: string;
  configPath?: string;
  helpRequested: boolean;
};

type ConfigPayload = ConfigMap | {
  files: ConfigMap;
  options?: SyncOptions;
};

type LoadedConfig = {
  files: ConfigMap;
  options: SyncOptions;
  packageDir: string;
  source: string;
};

export async function runCli(
  args: string[] = process.argv.slice(2),
  { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr }: CliRunOptions = {},
): Promise<number> {
  const flags = parseFlags(args);

  if (flags.helpRequested) {
    stdout.write(buildHelpMessage());
    return 0;
  }

  try {
    const loaded = await loadConfig({ cwd, flags });
    const options: SyncOptions = {
      ...loaded.options,
    };

    if (flags.rootDir) {
      options.rootDir = path.resolve(loaded.packageDir, flags.rootDir);
    } else if (!options.rootDir) {
      options.rootDir = loaded.packageDir;
    }

    if (flags.gitignorePath) {
      options.gitignorePath = path.resolve(options.rootDir ?? loaded.packageDir, flags.gitignorePath);
    }

    if (flags.dryRun) {
      options.dryRun = true;
    }

    const result = await syncConfigs(loaded.files, options);

    if (flags.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(formatResult(result, flags, loaded));
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`cpconfig: ${message}\n`);
    return 1;
  }
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    json: false,
    helpRequested: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--dry-run':
      case '--dryRun':
        flags.dryRun = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--root':
      case '--root-dir': {
        const value = args[index + 1];
        if (!value) {
          throw new Error('Expected value after --root');
        }
        flags.rootDir = value;
        index += 1;
        break;
      }
      case '--gitignore':
      case '--gitignore-path': {
        const value = args[index + 1];
        if (!value) {
          throw new Error('Expected value after --gitignore');
        }
        flags.gitignorePath = value;
        index += 1;
        break;
      }
      case '--config': {
        const value = args[index + 1];
        if (!value) {
          throw new Error('Expected value after --config');
        }
        flags.configPath = value;
        index += 1;
        break;
      }
      case '--':
        // Ignore any remaining positional arguments (none are currently supported).
        index = args.length;
        break;
      case '--help':
      case '-h':
        flags.helpRequested = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return flags;
}

type LoadConfigInput = {
  cwd: string;
  flags: CliFlags;
};

async function loadConfig({ cwd, flags }: LoadConfigInput): Promise<LoadedConfig> {
  if (flags.configPath) {
    const filePath = path.resolve(cwd, flags.configPath);
    const payload = await readJsonFile(filePath);
    const parsed = parseConfigPayload(payload, filePath);
    return {
      ...parsed,
      packageDir: path.dirname(filePath),
      source: filePath,
    };
  }

  const { packageJsonPath, packageDir } = await findNearestPackageJson(cwd);
  const pkg = await readJsonFile(packageJsonPath) as PackageJson;

  const rawPayload = pkg.cpconfig ?? pkg.config?.cpconfig;

  if (!rawPayload) {
    throw new Error(`No cpconfig definition found in ${packageJsonPath}`);
  }

  const parsed = parseConfigPayload(rawPayload, packageJsonPath);

  return {
    ...parsed,
    packageDir,
    source: packageJsonPath,
  };
}

type PackageJson = {
  cpconfig?: ConfigPayload;
  config?: {
    cpconfig?: ConfigPayload;
  };
};

type ParsedConfig = {
  files: ConfigMap;
  options: SyncOptions;
};

function parseConfigPayload(payload: unknown, source: string): ParsedConfig {
  if (payload && typeof payload === 'object') {
    const potential = payload as { files?: unknown; options?: unknown };

    if (potential.files && isPlainObject(potential.files)) {
      const options = isPlainObject(potential.options) ? (potential.options as SyncOptions) : {};
      return { files: toConfigMap(potential.files as Record<string, unknown>, source), options };
    }

    if (!('files' in potential)) {
      return { files: toConfigMap(payload as Record<string, unknown>, source), options: {} };
    }
  }

  throw new Error(`Invalid cpconfig definition in ${source}. Expected an object of files or { files, options }.`);
}

function toConfigMap(value: Record<string, unknown>, source: string): ConfigMap {
  const entries: ConfigMap = {};

  for (const [filePath, rawEntry] of Object.entries(value)) {
    if (!isPlainObject(rawEntry) || !('contents' in rawEntry)) {
      throw new Error(
        `Invalid entry for "${filePath}" in ${source}. Each file must be an object with a contents property.`,
      );
    }

    entries[filePath] = rawEntry as ConfigEntry;
  }

  return entries;
}

async function findNearestPackageJson(startDir: string) {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, 'package.json');
    try {
      await fs.access(candidate);
      return { packageJsonPath: candidate, packageDir: current };
    } catch (error) {
      // Continue searching upwards.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(`Unable to locate package.json starting from ${startDir}`);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${filePath}: ${(error as Error).message}`);
  }
}

function formatResult(result: SyncResult, flags: CliFlags, loaded: LoadedConfig): string {
  const lines: string[] = [];
  const modeLabel = flags.dryRun ? 'dry run' : 'apply';
  lines.push(`cpconfig ${modeLabel} (${loaded.source})`);

  for (const file of result.files) {
    lines.push(formatFileLine(file));
  }

  const gitignoreSummary = result.gitignore.skipped
    ? 'gitignore: skipped (no entries)'
    : result.gitignore.updated
      ? `gitignore: updated (+${result.gitignore.added.length} / -${result.gitignore.removed.length})`
      : 'gitignore: unchanged';
  lines.push(gitignoreSummary);

  return `${lines.join('\n')}\n`;
}

function formatFileLine(file: SyncResult['files'][number]): string {
  const status = file.action.padEnd(8, ' ');
  const base = `${status} ${file.path}`;
  return file.gitignored ? `${base} (gitignored)` : base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]');
}

function buildHelpMessage(): string {
  return `Usage: cpconfig [options]\n\n` +
    `Options:\n` +
    `  --dry-run             Compute changes without writing files\n` +
    `  --json                Print the sync result as JSON\n` +
    `  --root <path>         Override the root directory used for file writes\n` +
    `  --gitignore <path>    Override the gitignore file path\n` +
    `  --config <path>       Load configuration from an explicit JSON file\n` +
    `  --help, -h            Show this message\n`;
}

const mainEntry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === mainEntry) {
  runCli().then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
