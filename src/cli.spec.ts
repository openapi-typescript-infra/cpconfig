import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from './cli';

const packageTemplate = {
  name: 'cpconfig-fixture',
  version: '0.0.0-test',
};

describe('cli', () => {
  test('applies configuration sourced from package.json', async () => {
    await withTempDir(async (cwd) => {
      const modulePath = path.join(cwd, 'cpconfig.config.mjs');

      await writeFile(
        modulePath,
        `export default {\n  files: {\n    'secrets/.env': { contents: 'SECRET=1' },\n    'config/app.json': { contents: '{"flag":true}' }\n  }\n};\n`,
      );

      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: './cpconfig.config.mjs',
            },
          },
          null,
          2,
        ),
      );

      const stdout = createBuffer();
      const stderr = createBuffer();

      const exitCode = await runCli([], { cwd, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe('');

      await expect(readFile(path.join(cwd, 'secrets/.env'), 'utf8')).resolves.toBe('SECRET=1');
      await expect(readFile(path.join(cwd, 'config/app.json'), 'utf8')).resolves.toBe(
        '{"flag":true}',
      );

      const gitignore = await readFile(path.join(cwd, '.gitignore'), 'utf8');
      expect(gitignore).toContain('/secrets/.env');
      expect(gitignore).toContain('/config/app.json');

      expect(stdout.toString()).toMatch(/cpconfig apply/);
    });
  });

  test('loads configuration from a referenced module', async () => {
    await withTempDir(async (cwd) => {
      const modulePath = path.join(cwd, 'cpconfig.config.mjs');

      await writeFile(
        modulePath,
        `export default {\n  files: {\n    'module-output.txt': { contents: 'from module' }\n  }\n};\n`,
      );

      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: './cpconfig.config.mjs',
            },
          },
          null,
          2,
        ),
      );

      const stdout = createBuffer();
      const stderr = createBuffer();

      const exitCode = await runCli([], { cwd, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe('');

      await expect(readFile(path.join(cwd, 'module-output.txt'), 'utf8')).resolves.toBe(
        'from module',
      );
      const gitignore = await readFile(path.join(cwd, '.gitignore'), 'utf8');
      expect(gitignore).toContain('/module-output.txt');
      expect(stdout.toString()).toContain('cpconfig apply');
      expect(stdout.toString()).toContain('cpconfig.config.mjs');
    });
  });

  test('loads configuration from a TypeScript module when runtime support is available', async () => {
    await withTempDir(async (cwd) => {
      await linkLocalModule(cwd, 'tsx');

      const modulePath = path.join(cwd, 'cpconfig.config.ts');

      await writeFile(
        modulePath,
        `export default {\n  files: {\n    'ts-output.txt': { contents: 'from typescript' }\n  }\n};\n`,
      );

      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: './cpconfig.config.ts',
            },
          },
          null,
          2,
        ),
      );

      const stdout = createBuffer();
      const stderr = createBuffer();

      const exitCode = await runCli([], { cwd, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe('');

      await expect(readFile(path.join(cwd, 'ts-output.txt'), 'utf8')).resolves.toBe(
        'from typescript',
      );

      const gitignore = await readFile(path.join(cwd, '.gitignore'), 'utf8');
      expect(gitignore).toContain('/ts-output.txt');
    });
  });

  test('supports config modules exporting factories', async () => {
    await withTempDir(async (cwd) => {
      const modulePath = path.join(cwd, 'cpconfig.factory.mjs');

      await writeFile(
        modulePath,
        `export default async function buildConfig(config, options) {\n  await Promise.resolve();\n  return {\n    files: {\n      'factory.txt': { contents: JSON.stringify({ config, options }) }\n    },\n    options: {\n      gitignorePath: config?.output ?? 'generated.ignore'\n    }\n  };\n}\n`,
      );

      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: './cpconfig.factory.mjs',
              output: 'generated.ignore',
              feature: 'enabled',
            },
          },
          null,
          2,
        ),
      );

      const stdout = createBuffer();
      const stderr = createBuffer();

      const exitCode = await runCli(['--json'], { cwd, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe('');

      const fileContents = await readFile(path.join(cwd, 'factory.txt'), 'utf8');
      const deserialised = JSON.parse(fileContents) as {
        config: Record<string, unknown>;
        options: { args: string[] };
      };

      expect(deserialised.config.config).toMatchObject({
        cpconfig: './cpconfig.factory.mjs',
        feature: 'enabled',
        output: 'generated.ignore',
      });
      expect(deserialised.options.args).toEqual(['--json']);

      const gitignore = await readFile(path.join(cwd, 'generated.ignore'), 'utf8');
      expect(gitignore).toContain('/factory.txt');
      const stdoutJson = JSON.parse(stdout.toString()) as {
        gitignore: { path: string };
      };
      expect(stdoutJson.gitignore.path).toContain('generated.ignore');
    });
  });

  test('supports dry runs without writing files', async () => {
    await withTempDir(async (cwd) => {
      const modulePath = path.join(cwd, 'cpconfig.dry.mjs');

      await writeFile(
        modulePath,
        `export default {\n  files: {\n    'generated.txt': { contents: 'dry' }\n  }\n};\n`,
      );

      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: './cpconfig.dry.mjs',
            },
          },
          null,
          2,
        ),
      );

      const stdout = createBuffer();
      const stderr = createBuffer();

      const exitCode = await runCli(['--dry-run'], { cwd, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toBe('');
      expect(stdout.toString()).toMatch(/dry run/);

      await expect(readFile(path.join(cwd, 'generated.txt'), 'utf8')).rejects.toThrow();
      await expect(readFile(path.join(cwd, '.gitignore'), 'utf8')).rejects.toThrow();
    });
  });

  test('emits helpful errors when configuration is missing', async () => {
    await withTempDir(async (cwd) => {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify(packageTemplate, null, 2));
      const stderr = createBuffer();

      const exitCode = await runCli([], { cwd, stderr, stdout: createBuffer() });

      expect(exitCode).toBe(1);
      expect(stderr.toString()).toMatch(
        /Expected config\.cpconfig to reference a module using a string/,
      );
    });
  });

  test('warns when an existing file is missing the configured sentinel', async () => {
    await withTempDir(async (cwd) => {
      const modulePath = path.join(cwd, 'cpconfig.sentinel.mjs');

      await writeFile(
        modulePath,
        `export default {\n  files: {\n    'managed.txt': { contents: '// sentinel\\nmanaged=true\\n', sentinel: '// sentinel' }\n  }\n};\n`,
      );

      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: './cpconfig.sentinel.mjs',
            },
          },
          null,
          2,
        ),
      );

      const existingPath = path.join(cwd, 'managed.txt');
      await writeFile(existingPath, 'managed=false\n', 'utf8');

      const stdout = createBuffer();
      const stderr = createBuffer();

      const exitCode = await runCli([], { cwd, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.toString()).toMatch(/Not overwriting "managed.txt"/);

      await expect(readFile(existingPath, 'utf8')).resolves.toBe('managed=false\n');
      await expect(readFile(path.join(cwd, '.gitignore'), 'utf8')).rejects.toThrow();
      expect(stdout.toString()).toContain('managed.txt (unmanaged)');
    });
  });

  test('emits helpful errors when config.cpconfig is not a string', async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: { invalid: true },
            },
          },
          null,
          2,
        ),
      );

      const stderr = createBuffer();
      const exitCode = await runCli([], { cwd, stderr, stdout: createBuffer() });

      expect(exitCode).toBe(1);
      expect(stderr.toString()).toMatch(
        /Expected config\.cpconfig to be a non-empty string module specifier/,
      );
    });
  });
});

async function linkLocalModule(cwd: string, moduleName: string): Promise<void> {
  const source = path.join(process.cwd(), 'node_modules', moduleName);
  const destinationDir = path.join(cwd, 'node_modules');
  const destination = path.join(destinationDir, moduleName);

  await mkdir(destinationDir, { recursive: true });

  try {
    await symlink(source, destination, 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return;
    }
    if (code === 'ENOENT') {
      throw new Error(`Module ${moduleName} is not installed under node_modules`);
    }
    throw error;
  }
}

async function withTempDir<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cpconfig-cli-'));

  try {
    await mkdir(cwd, { recursive: true });
    return await callback(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function createBuffer() {
  const chunks: Array<string> = [];
  return {
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
    toString() {
      return chunks.join('');
    },
  };
}
