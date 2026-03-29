import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const eslintEntrypoint = path.join(rootDir, 'node_modules', 'eslint', 'bin', 'eslint.js');

if (!fs.existsSync(eslintEntrypoint)) {
  console.error('Local ESLint was not found. Run `npm ci` to install devDependencies before linting.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [eslintEntrypoint, ...process.argv.slice(2)],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
