import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { syncConfigs } from './index.js';

describe('syncConfigs', () => {
  test('creates files and manages gitignore', async () => {
    await withTempDir(async (rootDir) => {
      const result = await syncConfigs(
        {
          'env/.env.local': {
            contents: 'TOKEN=secret',
          },
          '.secrets.yml': {
            contents: 'aws_access_key_id: example',
          },
        },
        { rootDir },
      );

      expect(result.files.map(({ action }) => action)).toEqual(['created', 'created']);
      expect(result.gitignore.updated).toBe(true);
      expect(result.gitignore.added).toEqual(['/env/.env.local', '/.secrets.yml']);

      await expect(readFile(path.join(rootDir, 'env/.env.local'), 'utf8')).resolves.toBe(
        'TOKEN=secret',
      );
      await expect(readFile(path.join(rootDir, '.secrets.yml'), 'utf8')).resolves.toBe(
        'aws_access_key_id: example',
      );

      const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('# Managed by cpconfig');
      expect(gitignore).toContain('/env/.env.local');
      expect(gitignore).toContain('/.secrets.yml');
    });
  });

  test('manages gitignore entries for dot directories', async () => {
    await withTempDir(async (rootDir) => {
      const result = await syncConfigs(
        {
          '.github/actionlint.yml': {
            contents: 'name: actionlint\n',
          },
        },
        { rootDir },
      );

      expect(result.gitignore.updated).toBe(true);
      expect(result.gitignore.added).toEqual(['/.github/actionlint.yml']);

      const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('/.github/actionlint.yml');
    });
  });

  test('is idempotent when rerun with same definitions', async () => {
    await withTempDir(async (rootDir) => {
      const files = {
        'config.json': { contents: '{"name":"first"}' },
        'nested/settings.yml': { contents: 'enabled: true' },
      };

      await syncConfigs(files, { rootDir });
      const result = await syncConfigs(files, { rootDir });

      expect(result.files.every(({ action }) => action === 'unchanged')).toBe(true);
      expect(result.gitignore.updated).toBe(false);
      expect(result.gitignore.added).toEqual([]);
      expect(result.gitignore.removed).toEqual([]);
    });
  });

  test('updates file contents and prunes gitignore entries', async () => {
    await withTempDir(async (rootDir) => {
      await syncConfigs(
        {
          'config/a.json': { contents: '{"name":"a"}' },
          'config/b.json': { contents: '{"name":"b"}' },
        },
        { rootDir },
      );

      const result = await syncConfigs(
        { 'config/a.json': { contents: '{"name":"updated"}' } },
        { rootDir },
      );

      expect(result.files).toEqual([
        expect.objectContaining({ path: 'config/a.json', action: 'updated' }),
      ]);
      expect(result.gitignore.updated).toBe(true);
      expect(result.gitignore.added).toEqual([]);
      expect(result.gitignore.removed).toEqual(['/config/b.json']);

      const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('/config/a.json');
      expect(gitignore).not.toContain('/config/b.json');
    });
  });

  test('dry run reports actions without writing files', async () => {
    await withTempDir(async (rootDir) => {
      const result = await syncConfigs(
        {
          'config/app.json': { contents: '{"dry":true}' },
        },
        {
          rootDir,
          dryRun: true,
        },
      );

      expect(result.files).toEqual([
        expect.objectContaining({ path: 'config/app.json', action: 'created' }),
      ]);
      expect(result.gitignore.updated).toBe(true);
      expect(result.gitignore.skipped).toBe(false);

      await expect(readFile(path.join(rootDir, 'config/app.json'), 'utf8')).rejects.toThrowError();
      await expect(readFile(path.join(rootDir, '.gitignore'), 'utf8')).rejects.toThrowError();
    });
  });

  test('respects gitignore: false flag', async () => {
    await withTempDir(async (rootDir) => {
      await syncConfigs(
        {
          'visible.log': { contents: 'visible', gitignore: false },
          'secret.log': { contents: 'secret' },
        },
        { rootDir },
      );

      const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('/secret.log');
      expect(gitignore).not.toContain('/visible.log');
    });
  });

  test('rejects paths that escape the configured root directory', async () => {
    await withTempDir(async (rootDir) => {
      await expect(
        syncConfigs(
          {
            '../outside.txt': { contents: 'nope' },
          },
          { rootDir },
        ),
      ).rejects.toThrowError(/must reside within the root directory/);

      await expect(
        syncConfigs(
          {
            [path.join(rootDir, 'absolute.txt')]: { contents: 'absolute' },
          },
          { rootDir },
        ),
      ).rejects.toThrowError(/must be relative to the root directory/);
    });
  });

  test('supports functional contents', async () => {
    await withTempDir(async (rootDir) => {
      let invocations = 0;

      await syncConfigs(
        {
          'dynamic.txt': {
            contents: () => {
              invocations += 1;
              return `value-${invocations}`;
            },
          },
        },
        { rootDir },
      );

      await expect(readFile(path.join(rootDir, 'dynamic.txt'), 'utf8')).resolves.toBe('value-1');

      const result = await syncConfigs(
        {
          'dynamic.txt': {
            contents: () => {
              invocations += 1;
              return `value-${invocations}`;
            },
          },
        },
        { rootDir },
      );

      expect(result.files[0]?.action).toBe('updated');
      await expect(readFile(path.join(rootDir, 'dynamic.txt'), 'utf8')).resolves.toBe('value-2');
    });
  });

  test('requires declared sentinels to appear in contents', async () => {
    await withTempDir(async (rootDir) => {
      await expect(
        syncConfigs(
          {
            'invalid.txt': { contents: 'no sentinel here', sentinel: '__SENTINEL__' },
          },
          { rootDir },
        ),
      ).rejects.toThrow(/must include the configured sentinel/);
    });
  });

  test('skips existing files missing the sentinel', async () => {
    await withTempDir(async (rootDir) => {
      const filePath = path.join(rootDir, 'config/managed.json');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, '{"user":true}\n', 'utf8');

      const result = await syncConfigs(
        {
          'config/managed.json': {
            contents: '__SENTINEL__\n{"managed":true}\n',
            sentinel: '__SENTINEL__',
          },
        },
        { rootDir },
      );

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'config/managed.json',
          action: 'unchanged',
          managed: false,
          skipped: false,
          gitignored: false,
          warning: expect.stringContaining('Not overwriting'),
        }),
      ]);

      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"user":true}\n');
      await expect(readFile(path.join(rootDir, '.gitignore'), 'utf8')).rejects.toThrowError();
    });
  });

  test('updates files that preserve the sentinel', async () => {
    await withTempDir(async (rootDir) => {
      await syncConfigs(
        {
          'sentinel.txt': {
            contents: '// cpconfig\nvalue=1\n',
            sentinel: '// cpconfig',
          },
        },
        { rootDir },
      );

      const result = await syncConfigs(
        {
          'sentinel.txt': {
            contents: '// cpconfig\nvalue=2\n',
            sentinel: '// cpconfig',
          },
        },
        { rootDir },
      );

      expect(result.files).toEqual([
        expect.objectContaining({
          path: 'sentinel.txt',
          action: 'updated',
          managed: true,
          gitignored: true,
        }),
      ]);
      await expect(readFile(path.join(rootDir, 'sentinel.txt'), 'utf8')).resolves.toBe(
        '// cpconfig\nvalue=2\n',
      );
    });
  });
});

async function withTempDir<T>(callback: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cpconfig-test-'));

  try {
    await mkdir(rootDir, { recursive: true });
    return await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}
