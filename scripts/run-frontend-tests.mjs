import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
const args = ['--test'];
if (Number.isFinite(nodeMajorVersion) && nodeMajorVersion >= 22) {
  args.push('--test-isolation=none');
}
const frontendTestDir = path.join(process.cwd(), 'test', 'frontend');
const frontendTests = fs.readdirSync(frontendTestDir)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .map((entry) => path.join('test', 'frontend', entry))
  .sort();
args.push(...frontendTests);

const result = spawnSync(
  process.execPath,
  args,
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

process.exit(result.status ?? 1);
