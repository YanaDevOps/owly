import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {
  ...process.env,
  GOCACHE: path.join(rootDir, 'tmp-gocache'),
};

const command = process.platform === 'win32' ? 'go' : '/bin/bash';
const args = process.platform === 'win32'
  ? ['test', './group', './rtpconn', './token', './webserver']
  : ['-lc', 'go test ./group ./rtpconn ./token ./webserver'];

const result = spawnSync(command, args, {
  cwd: rootDir,
  env,
  encoding: 'utf8',
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

process.exit(result.status ?? 1);
