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
  const markers = [
    `async function ${name}(`,
    `function ${name}(`,
  ];
  let start = -1;
  for (const marker of markers) {
    start = protocolSource.indexOf(marker);
    if (start >= 0) {
      break;
    }
  }
  if (start < 0) {
    throw new Error(`Could not find function ${name}`);
  }

  let index = protocolSource.indexOf('{', start);
  let depth = 0;
  for (; index < protocolSource.length; index += 1) {
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

function buildJoinedMessageApi() {
  const calls = {
    onjoined: [],
    onuser: [],
    resumeTokens: [],
  };

  const context = vm.createContext({
    console,
    rememberPersistentClientResumeToken(token) {
      calls.resumeTokens.push(token);
    },
  });

  const snippet = [
    extractFunction('applyJoinedMessage'),
    'this.__exports = { applyJoinedMessage };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    applyJoinedMessage: context.__exports.applyJoinedMessage,
    calls,
  };
}

function buildSocketCloseApi() {
  const calls = {
    closedStreams: [],
    clearedIntervals: [],
    onclose: [],
    onjoined: [],
    onuser: [],
  };

  const context = vm.createContext({
    console,
    clearInterval(handler) {
      calls.clearedIntervals.push(handler);
    },
  });

  const snippet = [
    extractFunction('handleSocketClose'),
    'this.__exports = { handleSocketClose };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    handleSocketClose: context.__exports.handleSocketClose,
    calls,
    makeStream(id) {
      return {
        close() {
          calls.closedStreams.push(id);
        },
      };
    },
  };
}

function normalise(value) {
  return JSON.parse(JSON.stringify(value));
}

test('applyJoinedMessage leaves roster intact for terminal states until the UI decides to clear it', () => {
  const api = buildJoinedMessageApi();
  const sc = {
    group: 'room',
    username: 'alice',
    users: {
      alice: { username: 'alice', streams: {} },
      bob: { username: 'bob', streams: {} },
    },
    permissions: ['present'],
    rtcConfiguration: { iceServers: [] },
    onuser(id, kind) {
      api.calls.onuser.push([id, kind]);
    },
    onjoined(kind, group, permissions, status, data, error, value) {
      api.calls.onjoined.push({
        kind,
        group,
        permissions,
        status,
        data,
        error,
        value,
      });
    },
  };

  api.applyJoinedMessage(sc, {
    kind: 'leave',
    group: 'room',
    permissions: [],
    status: {},
    data: {},
    error: '',
    value: '',
  });

  assert.deepEqual(Object.keys(sc.users), ['alice', 'bob']);
  assert.equal(sc.group, 'room');
  assert.equal(sc.username, 'alice');
  assert.deepEqual(sc.permissions, ['present']);
  assert.deepEqual(normalise(sc.rtcConfiguration), { iceServers: [] });
  assert.deepEqual(api.calls.onuser, []);
  assert.deepEqual(api.calls.onjoined, [{
    kind: 'leave',
    group: 'room',
    permissions: [],
    status: {},
    data: {},
    error: null,
    value: null,
  }]);
});

test('applyJoinedMessage updates connection state for join before notifying the app', () => {
  const api = buildJoinedMessageApi();
  const seenStates = [];
  const sc = {
    group: null,
    username: null,
    users: {},
    permissions: [],
    rtcConfiguration: null,
    onjoined(kind, group) {
      seenStates.push({
        kind,
        group,
        username: this.username,
        permissions: [...this.permissions],
        rtcConfiguration: this.rtcConfiguration,
      });
    },
  };

  api.applyJoinedMessage(sc, {
    kind: 'join',
    group: 'room',
    username: 'alice',
    permissions: ['present'],
    rtcConfiguration: { iceServers: [{ urls: 'turn:turn.example' }] },
    resumeToken: 'resume-token',
    status: {},
    data: {},
  });

  assert.equal(sc.group, 'room');
  assert.equal(sc.username, 'alice');
  assert.deepEqual(sc.permissions, ['present']);
  assert.deepEqual(normalise(sc.rtcConfiguration), {
    iceServers: [{ urls: 'turn:turn.example' }],
  });
  assert.deepEqual(api.calls.resumeTokens, ['resume-token']);
  assert.deepEqual(normalise(seenStates), [{
    kind: 'join',
    group: 'room',
    username: 'alice',
    permissions: ['present'],
    rtcConfiguration: {
      iceServers: [{ urls: 'turn:turn.example' }],
    },
  }]);
});

test('handleSocketClose does not clear the roster before the app classifies the close', () => {
  const api = buildSocketCloseApi();
  const pingHandler = { id: 'ping' };
  const sc = {
    group: 'room',
    username: 'alice',
    users: {
      alice: { username: 'alice', streams: {} },
      bob: { username: 'bob', streams: {} },
    },
    permissions: ['present'],
    up: {
      up1: api.makeStream('up1'),
    },
    down: {
      down1: api.makeStream('down1'),
    },
    pingHandler,
    livenessTimeoutStreak: 2,
    socket: { readyState: 3 },
    onuser(id, kind) {
      api.calls.onuser.push([id, kind]);
    },
    onjoined(kind, group) {
      api.calls.onjoined.push([kind, group]);
    },
    onclose(code, reason) {
      api.calls.onclose.push([code, reason]);
    },
  };

  api.handleSocketClose(sc, { code: 1006, reason: 'network' });

  assert.deepEqual(api.calls.closedStreams, ['up1', 'down1']);
  assert.deepEqual(api.calls.clearedIntervals, [pingHandler]);
  assert.deepEqual(Object.keys(sc.users), ['alice', 'bob']);
  assert.deepEqual(sc.permissions, ['present']);
  assert.equal(sc.group, 'room');
  assert.equal(sc.username, 'alice');
  assert.deepEqual(api.calls.onuser, []);
  assert.deepEqual(api.calls.onjoined, []);
  assert.deepEqual(api.calls.onclose, [[1006, 'network']]);
  assert.equal(sc.pingHandler, null);
  assert.equal(sc.livenessTimeoutStreak, 0);
  assert.equal(sc.socket, null);
});
