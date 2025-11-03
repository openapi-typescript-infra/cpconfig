# cpconfig

`cpconfig` is a tiny toolkit that keeps project-specific configuration files in sync with disk. Give it the
list of files you care about, and it will write them, ensure parent directories exist, and maintain a clearly
marked block inside `.gitignore`.

The goal is to provide the ergonomic bootstrap experience of tools like [`coconfig`](https://github.com/gas-buddy/coconfig)
without any custom module loading or complicated configuration layering—just code.

## Features

- **Deterministic sync** – Declare files and their contents, `cpconfig` handles creation and updates.
- **Managed `.gitignore` block** – Automatically keeps tracked configs out of git with a dedicated annotated section.
- **Safe by default** – No implicit imports or magic; works with plain TypeScript/JavaScript data.
- **Dry runs** – Compute what would change without touching the file system.

## Installation

```bash
yarn add @sesamecare-oss/cpconfig
# or
npm install @sesamecare-oss/cpconfig
```

## Programmatic usage

```ts
import { syncConfigs } from '@sesamecare-oss/cpconfig';

await syncConfigs(
  {
    'config/.env.local': {
      contents: 'API_TOKEN=abc123',
    },
    '.secrets.json': {
      contents: () => JSON.stringify({ key: 'value' }, null, 2),
    },
  },
  {
    rootDir: process.cwd(), // optional, defaults to process.cwd()
  },
);
```

The call above writes the files if necessary and maintains this `.gitignore` block:

```
# Managed by cpconfig
config/.env.local
.secrets.json
```

Run the function as many times as you like—it is idempotent and only touches files when their content changes.

## Package-driven configuration

Most projects will declare their config files directly in `package.json` and call the bundled CLI as part of
`postinstall`:

```json
{
  "name": "my-project",
  "scripts": {
    "postinstall": "cpconfig"
  },
  "cpconfig": {
    "files": {
      "config/.env.local": { "contents": "API_TOKEN=abc123" },
      ".secrets.json": { "contents": "{\n  \"key\": \"value\"\n}" }
    }
  }
}
```

The CLI walks up from the current working directory, finds the nearest `package.json`, and reads the `cpconfig`
definition (or `config.cpconfig`). Definitions can either be an object of files (as above) or an object with
`{ "files": { ... }, "options": { ... } }`, mirroring the programmatic API.

- Run `npx cpconfig` manually whenever you need to refresh files.
- Add `cpconfig` to `postinstall` to keep developer machines in sync automatically.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` | Base directory used to resolve all config paths. |
| `dryRun` | `boolean` | `false` | When `true`, compute the diff without writing to disk. |
| `encoding` | `BufferEncoding` | `'utf8'` | Encoding used when reading and writing files. |
| `gitignorePath` | `string` | `<rootDir>/.gitignore` | Custom location for the managed gitignore file. |

Each config file can optionally set `gitignore: false` to opt out of the managed block, or provide a `mode`
(integer) that is applied when the file is first created.

## Result object

`syncConfigs` resolves with a structured result describing what happened:

```ts
const result = await syncConfigs(files);

result.files; // [{ path: 'config/.env.local', action: 'created', gitignored: true }, ...]
result.gitignore; // { updated: true, added: ['config/.env.local'], removed: [] }
```

Use this information to log progress, emit metrics, or drive prompts.

## CLI options

```
cpconfig --help

Options:
  --dry-run             Compute changes without writing files
  --json                Print the sync result as JSON
  --root <path>         Override the root directory used for file writes
  --gitignore <path>    Override the gitignore file path
  --config <path>       Load configuration from an explicit JSON file
  --help, -h            Show this message
```

## Dry runs

Combine `dryRun: true` with the result payload to surface pending configuration changes without touching disk:

```ts
const preview = await syncConfigs(files, { dryRun: true });

if (preview.gitignore.updated || preview.files.some((file) => file.action !== 'unchanged')) {
  console.log('Configuration out of date. Run cpconfig to apply changes.');
}
```

## License

UNLICENSED – tailor to your organisation’s distribution policy before publishing.
