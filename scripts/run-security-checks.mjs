import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      GOCACHE: path.join(rootDir, 'tmp-gocache'),
      GOMODCACHE: path.join(rootDir, 'tmp-gomodcache'),
      npm_config_cache: path.join(rootDir, 'tmp-npm-cache'),
      ...extraEnv,
    },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`Failed to run ${command}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const goCommand = process.platform === 'win32' ? 'go.exe' : 'go';

if (process.platform === 'win32') {
  run('cmd.exe', ['/d', '/s', '/c', 'npm', 'run', 'lint']);
} else {
  run('npm', ['run', 'lint']);
}
run(goCommand, ['test', './webserver', '-run', 'Test(CSPHeader|CheckOrigin)']);
