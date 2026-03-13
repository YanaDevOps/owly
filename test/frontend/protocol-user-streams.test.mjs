import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const protocolSource = fs.readFileSync(
  path.resolve('static/protocol.js'),
  'utf8',
);

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = protocolSource.indexOf(marker);
  if (start < 0) {
    throw new Error(`Could not find function ${name}`);
  }

  let index = protocolSource.indexOf('{', start);
  let depth = 0;
  for (; index < protocolSource.length; index++) {
    const ch = protocolSource[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return protocolSource.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not parse function ${name}`);
}

function buildRecomputeUserStreams() {
  const context = vm.createContext({
    JSON,
    isSocketOpen() {
      return false;
    },
    console,
  });

  vm.runInContext(
    `${extractFunction('recomputeUserStreams')}\nthis.__exports = { recomputeUserStreams };`,
    context,
  );

  return context.__exports.recomputeUserStreams;
}

function createStream(kinds) {
  return {
    getTracks() {
      return kinds.map((kind) => ({ kind }));
    },
  };
}

function normalise(value) {
  return JSON.parse(JSON.stringify(value));
}

test('recomputeUserStreams only keeps remote streams for the matching source user', () => {
  const recomputeUserStreams = buildRecomputeUserStreams();
  const sc = {
    id: 'local-user',
    up: {},
    down: {
      a: { source: 'remote-a', label: 'camera', stream: createStream(['video', 'audio']) },
      b: { source: 'remote-b', label: 'camera', stream: createStream(['video']) },
      c: { source: 'remote-a', label: 'screenshare', stream: createStream(['video']) },
    },
    users: {
      'remote-a': { streams: {} },
      'remote-b': { streams: {} },
    },
  };

  const changed = recomputeUserStreams(sc, 'remote-a');

  assert.equal(changed, true);
  assert.deepEqual(normalise(sc.users['remote-a'].streams), {
    camera: { video: true, audio: true },
    screenshare: { video: true },
  });
  assert.deepEqual(normalise(sc.users['remote-b'].streams), {});
});

test('recomputeUserStreams uses upstreams for the local user only', () => {
  const recomputeUserStreams = buildRecomputeUserStreams();
  const sc = {
    id: 'local-user',
    up: {
      localCamera: { label: 'camera', stream: createStream(['video', 'audio']) },
    },
    down: {
      remoteCamera: { source: 'remote-a', label: 'camera', stream: createStream(['video']) },
    },
    users: {
      'local-user': { streams: {} },
      'remote-a': { streams: {} },
    },
  };

  recomputeUserStreams(sc, 'local-user');

  assert.deepEqual(normalise(sc.users['local-user'].streams), {
    camera: { video: true, audio: true },
  });
});
