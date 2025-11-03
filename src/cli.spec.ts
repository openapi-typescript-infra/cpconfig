import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            cpconfig: {
              files: {
                'secrets/.env': { contents: 'SECRET=1' },
                'config/app.json': { contents: '{"flag":true}' },
              },
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
      await expect(readFile(path.join(cwd, 'config/app.json'), 'utf8')).resolves.toBe('{"flag":true}');

      const gitignore = await readFile(path.join(cwd, '.gitignore'), 'utf8');
      expect(gitignore).toContain('secrets/.env');
      expect(gitignore).toContain('config/app.json');

      expect(stdout.toString()).toMatch(/cpconfig apply/);
    });
  });

  test('supports dry runs without writing files', async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify(
          {
            ...packageTemplate,
            config: {
              cpconfig: {
                'generated.txt': { contents: 'dry' },
              },
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
      expect(stderr.toString()).toMatch(/No cpconfig definition/);
    });
  });
});

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
