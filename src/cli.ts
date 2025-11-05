#!/usr/bin/env node
import { promises as fs, readFileSync } from 'node:fs';
import ModuleConstructor, { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  syncConfigs,
  type ConfigMap,
  type ConfigEntry,
  type SyncOptions,
  type SyncResult,
} from './index';

const TYPE_SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.cts', '.mts']);

type TypeScriptModule = typeof import('typescript');

type TypeScriptSupportState = {
  mode: 'require' | 'import';
  source: string;
};

let cachedTypeScriptSupport: TypeScriptSupportState | undefined;
let manualTypeScriptHookInstalled = false;

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
  const cliArgs = [...args];
  const flags = parseFlags(args);

  if (flags.helpRequested) {
    stdout.write(buildHelpMessage());
    return 0;
  }

  try {
    const loaded = await loadConfig({ cwd, flags, cliArgs });
    const options: SyncOptions = {
      ...loaded.options,
    };

    if (flags.rootDir) {
      options.rootDir = path.resolve(loaded.packageDir, flags.rootDir);
    } else if (!options.rootDir) {
      options.rootDir = loaded.packageDir;
    }

    if (flags.gitignorePath) {
      options.gitignorePath = path.resolve(
        options.rootDir ?? loaded.packageDir,
        flags.gitignorePath,
      );
    }

    if (flags.dryRun) {
      options.dryRun = true;
    }

    const result = await syncConfigs(loaded.files, options);

    for (const file of result.files) {
      if (file.warning) {
        stderr.write(`cpconfig: warning: ${file.warning}\n`);
      }
    }

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
  cliArgs: readonly string[];
};

async function loadConfig({ cwd, flags, cliArgs }: LoadConfigInput): Promise<LoadedConfig> {
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
  const pkg = (await readJsonFile(packageJsonPath)) as PackageJson;

  if (pkg.cpconfig !== undefined) {
    throw new Error(
      `Invalid cpconfig definition in ${packageJsonPath}. Move the value to config.cpconfig as a string module specifier.`,
    );
  }

  const packageConfigValue = pkg.config;

  if (!isPlainObject(packageConfigValue)) {
    throw new Error(
      `Invalid cpconfig definition in ${packageJsonPath}. Expected config.cpconfig to reference a module using a string.`,
    );
  }

  const moduleSpecifier = packageConfigValue.cpconfig;

  if (typeof moduleSpecifier !== 'string' || moduleSpecifier.trim().length === 0) {
    throw new Error(
      `Invalid cpconfig definition in ${packageJsonPath}. Expected config.cpconfig to be a non-empty string module specifier.`,
    );
  }

  const { parsed, source } = await loadConfigModule({
    specifier: moduleSpecifier,
    packageDir,
    origin: packageJsonPath,
    packageConfig: packageConfigValue,
    cliArgs,
  });

  return {
    ...parsed,
    packageDir,
    source,
  };
}

type PackageJson = {
  cpconfig?: unknown;
  config?: Record<string, unknown>;
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

  throw new Error(
    `Invalid cpconfig definition in ${source}. Expected an object of files or { files, options }.`,
  );
}

type LoadConfigModuleInput = {
  specifier: string;
  packageDir: string;
  origin: string;
  packageConfig: Record<string, unknown>;
  cliArgs: readonly string[];
};

async function loadConfigModule({
  specifier,
  packageDir,
  origin,
  packageConfig,
  cliArgs,
}: LoadConfigModuleInput) {
  const { resolvedPath, url } = resolveModuleSpecifier(specifier, packageDir);

  let imported: Record<string, unknown>;
  try {
    imported = await importResolvedModule({ resolvedPath, url, packageDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load cpconfig module "${specifier}" referenced from ${origin}: ${message}`,
    );
  }

  const exported = selectConfigExport(imported, resolvedPath);
  const payload = await unwrapConfigFactory(exported, resolvedPath, {
    packageConfig,
    cliArgs,
  });
  const parsed = parseConfigPayload(payload, resolvedPath);

  return { parsed, source: resolvedPath };
}

function resolveModuleSpecifier(
  specifier: string,
  packageDir: string,
): { resolvedPath: string; url: string } {
  if (specifier.startsWith('file:')) {
    const fileUrl = new URL(specifier);
    const resolvedPath = fileURLToPath(fileUrl);
    return { resolvedPath, url: fileUrl.href };
  }

  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const resolvedPath = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(packageDir, specifier);
    return { resolvedPath, url: pathToFileURL(resolvedPath).href };
  }

  const requireFromPkg = createRequire(path.join(packageDir, 'package.json'));
  try {
    const resolvedPath = requireFromPkg.resolve(specifier);
    return { resolvedPath, url: pathToFileURL(resolvedPath).href };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to resolve cpconfig module "${specifier}" from ${packageDir}: ${message}`,
    );
  }
}

async function importResolvedModule({
  resolvedPath,
  url,
  packageDir,
}: {
  resolvedPath: string;
  url: string;
  packageDir: string;
}): Promise<Record<string, unknown>> {
  if (!isTypeScriptModule(resolvedPath)) {
    return (await import(url)) as Record<string, unknown>;
  }

  const requireFromPkg = createRequire(path.join(packageDir, 'package.json'));
  const support = await ensureTypeScriptSupport(resolvedPath, requireFromPkg);

  if (support.mode === 'require') {
    try {
      return requireFromPkg(resolvedPath) as Record<string, unknown>;
    } catch (error) {
      if (isErrRequireEsm(error)) {
        return (await import(url)) as Record<string, unknown>;
      }
      throw error;
    }
  }

  return (await import(url)) as Record<string, unknown>;
}

function isTypeScriptModule(filePath: string): boolean {
  if (filePath.endsWith('.d.ts')) {
    return false;
  }

  const extension = path.extname(filePath).toLowerCase();
  return TYPE_SCRIPT_EXTENSIONS.has(extension);
}

type LoaderAttemptResult =
  | { status: 'loaded'; state: TypeScriptSupportState }
  | { status: 'missing' }
  | { status: 'failed'; message: string };

async function ensureTypeScriptSupport(
  modulePath: string,
  requireFromPkg: NodeJS.Require,
): Promise<TypeScriptSupportState> {
  if (cachedTypeScriptSupport) {
    return cachedTypeScriptSupport;
  }

  const missing: string[] = [];
  const errors: string[] = [];

  const candidates: Array<{ label: string; run: () => Promise<LoaderAttemptResult> }> = [
    {
      label: 'ts-node/register/transpile-only',
      run: () => registerCommonJsLoader(requireFromPkg, 'ts-node/register/transpile-only'),
    },
    {
      label: 'ts-node/register',
      run: () => registerCommonJsLoader(requireFromPkg, 'ts-node/register'),
    },
    {
      label: 'typescript',
      run: () => installManualTypeScriptHook(requireFromPkg),
    },
  ];

  for (const candidate of candidates) {
    const result = await candidate.run();

    if (result.status === 'loaded') {
      cachedTypeScriptSupport = result.state;
      return result.state;
    }

    if (result.status === 'missing') {
      missing.push(candidate.label);
      continue;
    }

    errors.push(`${candidate.label}: ${result.message}`);
  }

  const messageLines = [
    `Unable to load TypeScript configuration module at ${modulePath}.`,
    'Install one of "ts-node" or "typescript" in your project to enable TypeScript configs.',
  ];

  if (missing.length > 0) {
    messageLines.push(`Missing dependencies: ${missing.join(', ')}`);
  }

  if (errors.length > 0) {
    messageLines.push('Errors encountered while initialising TypeScript support:');
    for (const error of errors) {
      messageLines.push(`  - ${error}`);
    }
  }

  throw new Error(messageLines.join('\n'));
}

async function registerCommonJsLoader(
  requireFromPkg: NodeJS.Require,
  specifier: string,
): Promise<LoaderAttemptResult> {
  try {
    requireFromPkg(specifier);
    return { status: 'loaded', state: { mode: 'require', source: specifier } };
  } catch (error) {
    if (isModuleNotFoundError(error, specifier)) {
      return { status: 'missing' };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', message };
  }
}

async function installManualTypeScriptHook(
  requireFromPkg: NodeJS.Require,
): Promise<LoaderAttemptResult> {
  if (manualTypeScriptHookInstalled) {
    return { status: 'loaded', state: { mode: 'require', source: 'typescript' } };
  }

  let typescript: TypeScriptModule;
  try {
    typescript = requireFromPkg('typescript') as TypeScriptModule;
  } catch (error) {
    if (isModuleNotFoundError(error, 'typescript')) {
      return { status: 'missing' };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', message };
  }

  const extensions = (
    ModuleConstructor as unknown as {
      _extensions: Record<string, (module: NodeJS.Module, filename: string) => void>;
    }
  )._extensions;

  for (const extension of TYPE_SCRIPT_EXTENSIONS) {
    if (!extensions[extension]) {
      extensions[extension] = createTypeScriptExtensionHandler(typescript, extension);
    }
  }

  manualTypeScriptHookInstalled = true;
  return { status: 'loaded', state: { mode: 'require', source: 'typescript' } };
}

function createTypeScriptExtensionHandler(
  typescript: TypeScriptModule,
  extension: string,
): (module: NodeJS.Module, filename: string) => void {
  return (module, filename) => {
    const source = readFileSync(filename, 'utf8');
    const result = typescript.transpileModule(source, {
      compilerOptions: createTypeScriptTranspileOptions(typescript, extension),
      fileName: filename,
      reportDiagnostics: true,
    });

    if (result.diagnostics && result.diagnostics.length > 0) {
      const formatted = formatTypeScriptDiagnostics(typescript, result.diagnostics, filename);
      throw new Error(`Failed to compile ${filename}:\n${formatted}`);
    }

    const compiled = module as unknown as { _compile(code: string, filename: string): void };
    compiled._compile(result.outputText, filename);
  };
}

function createTypeScriptTranspileOptions(
  typescript: TypeScriptModule,
  extension: string,
): import('typescript').CompilerOptions {
  const options: import('typescript').CompilerOptions = {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
    esModuleInterop: true,
    sourceMap: false,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
  };

  if (extension === '.tsx') {
    options.jsx = typescript.JsxEmit.React;
  }

  return options;
}

function formatTypeScriptDiagnostics(
  typescript: TypeScriptModule,
  diagnostics: readonly import('typescript').Diagnostic[],
  filename: string,
): string {
  const host: import('typescript').FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => path.dirname(filename),
    getNewLine: () => '\n',
  };

  return typescript.formatDiagnostics(diagnostics, host);
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'MODULE_NOT_FOUND') {
    return false;
  }

  const message = (error as NodeJS.ErrnoException).message;
  if (typeof message !== 'string') {
    return false;
  }

  return message.includes(`'${specifier}'`);
}

function isErrRequireEsm(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in (error as Record<string, unknown>) &&
      (error as NodeJS.ErrnoException).code === 'ERR_REQUIRE_ESM',
  );
}

function selectConfigExport(imported: Record<string, unknown>, resolvedPath: string): unknown {
  if ('default' in imported && imported.default !== undefined) {
    return imported.default;
  }

  if ('config' in imported && imported.config !== undefined) {
    return imported.config;
  }

  if ('files' in imported || 'options' in imported) {
    return imported;
  }

  throw new Error(
    `No usable export found in ${resolvedPath}. Expected a default export, "config", or an object containing files.`,
  );
}

async function unwrapConfigFactory(
  exported: unknown,
  resolvedPath: string,
  context: { packageConfig: Record<string, unknown>; cliArgs: readonly string[] },
): Promise<unknown> {
  if (typeof exported === 'function') {
    try {
      const result = (
        exported as (config: Record<string, unknown>, cliArgs: readonly string[]) => unknown
      )(context.packageConfig, context.cliArgs);
      if (isPromiseLike(result)) {
        return await result;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cpconfig factory in ${resolvedPath} threw an error: ${message}`);
    }
  }

  if (isPromiseLike(exported)) {
    return await exported;
  }

  return exported;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value && typeof value === 'object' && 'then' in (value as Record<string, unknown>),
  );
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
    } catch {
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
  if (!file.managed) {
    return `${base} (unmanaged)`;
  }
  return file.gitignored ? `${base} (gitignored)` : base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.prototype.toString.call(value) === '[object Object]',
  );
}

function buildHelpMessage(): string {
  return (
    `Usage: cpconfig [options]\n\n` +
    `Options:\n` +
    `  --dry-run             Compute changes without writing files\n` +
    `  --json                Print the sync result as JSON\n` +
    `  --root <path>         Override the root directory used for file writes\n` +
    `  --gitignore <path>    Override the gitignore file path\n` +
    `  --config <path>       Load configuration from an explicit JSON file\n` +
    `  --help, -h            Show this message\n`
  );
}

const mainEntry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === mainEntry) {
  runCli().then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
