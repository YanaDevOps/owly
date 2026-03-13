import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {
  ...process.env,
  GOCACHE: path.join(rootDir, 'tmp-gocache'),
  GOMODCACHE: path.join(rootDir, 'tmp-gomodcache'),
};

const result = spawnSync(
  'go',
  ['test', './group', './rtpconn', './webserver'],
  {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

process.exit(result.status ?? 1);
