import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const protocolSource = fs.readFileSync(
  path.resolve('static/protocol.js'),
  'utf8',
);

function extractConst(name) {
  const match = protocolSource.match(new RegExp(`const ${name} = [^;]+;`));
  if (!match) {
    throw new Error(`Could not find const ${name}`);
  }
  return match[0];
}

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

function createStorageBacking(initialEntries = {}) {
  return new Map(Object.entries(initialEntries));
}

function createStorage(backing, { throws = false } = {}) {
  return {
    getItem(key) {
      if (throws) {
        throw new Error('storage unavailable');
      }
      return backing.has(key) ? backing.get(key) : null;
    },
    setItem(key, value) {
      if (throws) {
        throw new Error('storage unavailable');
      }
      backing.set(key, value);
    },
    removeItem(key) {
      if (throws) {
        throw new Error('storage unavailable');
      }
      backing.delete(key);
    },
  };
}

class FakeBroadcastChannelHub {
  constructor() {
    this.channels = new Map();
  }

  connect(name, instance) {
    if (!this.channels.has(name)) {
      this.channels.set(name, new Set());
    }
    this.channels.get(name).add(instance);
  }

  disconnect(name, instance) {
    if (!this.channels.has(name)) {
      return;
    }
    this.channels.get(name).delete(instance);
    if (this.channels.get(name).size === 0) {
      this.channels.delete(name);
    }
  }

  post(name, sender, data) {
    const listeners = this.channels.get(name);
    if (!listeners) {
      return;
    }
    for (const listener of Array.from(listeners)) {
      if (listener === sender) {
        continue;
      }
      if (typeof listener.onmessage === 'function') {
        listener.onmessage({ data });
      }
    }
  }
}

function buildClientIdApi({
  localStorageBacking = createStorageBacking(),
  sessionStorageBacking = createStorageBacking(),
  windowName = '',
  localThrows = false,
  sessionThrows = false,
  randomSeedStart = 1,
  broadcastHub = null,
} = {}) {
  let randomSeed = randomSeedStart;
  const window = {
    name: windowName,
    localStorage: createStorage(localStorageBacking, { throws: localThrows }),
    sessionStorage: createStorage(sessionStorageBacking, { throws: sessionThrows }),
  };

  const context = vm.createContext({
    Uint8Array,
    crypto: {
      getRandomValues(array) {
        for (let i = 0; i < array.length; i += 1) {
          array[i] = randomSeed % 256;
          randomSeed += 17;
        }
        return array;
      },
    },
    window,
    setTimeout,
    clearTimeout,
  });

  if (broadcastHub) {
    context.BroadcastChannel = class FakeBroadcastChannel {
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        broadcastHub.connect(name, this);
      }

      postMessage(data) {
        broadcastHub.post(this.name, this, data);
      }

      close() {
        broadcastHub.disconnect(this.name, this);
      }
    };
  }

  const snippet = [
    extractFunction('toHex'),
    extractFunction('newRandomId'),
    extractConst('clientIdStorageKey'),
    extractConst('clientUsernameStorageKey'),
    extractConst('clientResumeTokenStorageKey'),
    extractConst('clientTabKeyWindowPrefix'),
    extractConst('clientTabProbeChannelName'),
    extractConst('clientTabProbeTimeoutMs'),
    extractFunction('isPersistentClientId'),
    extractFunction('getPersistentClientTabKey'),
    extractFunction('getPersistentClientPageId'),
    extractFunction('rotatePersistentClientTabKey'),
    extractFunction('getPersistentClientScopedStorageKey'),
    extractFunction('getPersistentClientValue'),
    extractFunction('setPersistentClientValue'),
    extractFunction('getPersistentClientId'),
    extractFunction('getPersistentClientUsername'),
    extractFunction('getPersistentClientResumeToken'),
    extractFunction('rememberPersistentClientUsername'),
    extractFunction('rememberPersistentClientResumeToken'),
    extractFunction('splitPersistentClientIdentityAcrossTabs'),
    extractFunction('rotatePersistentClientId'),
    extractFunction('getPersistentClientProbeChannel'),
    extractFunction('ensurePersistentClientTabOwnership'),
    extractFunction('ensurePersistentClientIdForUsername'),
    'let persistentClientPageId = null;',
    'let persistentClientProbeChannel = null;',
    'this.__exports = {',
    '  getPersistentClientId,',
    '  getPersistentClientTabKey,',
    '  ensurePersistentClientTabOwnership,',
    '  ensurePersistentClientIdForUsername,',
    '  getPersistentClientUsername,',
    '  getPersistentClientResumeToken,',
    '  rememberPersistentClientUsername,',
    '  rememberPersistentClientResumeToken,',
    '  clientIdStorageKey,',
    '  clientUsernameStorageKey,',
    '  clientResumeTokenStorageKey,',
    '  getWindowName() { return window.name; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    localStorageBacking,
    sessionStorageBacking,
  };
}

test('same tab keeps the same client id across refresh via window.name', () => {
  const localStorageBacking = createStorageBacking();
  const firstTab = buildClientIdApi({ localStorageBacking });

  const firstId = firstTab.getPersistentClientId();
  const windowName = firstTab.getWindowName();
  const refreshedTab = buildClientIdApi({
    localStorageBacking,
    windowName,
  });

  assert.match(firstId, /^[0-9a-f]{32}$/);
  assert.equal(refreshedTab.getPersistentClientId(), firstId);
});

test('new tab gets a new client id even with shared localStorage', () => {
  const localStorageBacking = createStorageBacking();
  const firstTab = buildClientIdApi({ localStorageBacking });
  const secondTab = buildClientIdApi({
    localStorageBacking,
    randomSeedStart: 91,
  });

  const firstId = firstTab.getPersistentClientId();
  const secondId = secondTab.getPersistentClientId();

  assert.notEqual(secondId, firstId);
  assert.notEqual(secondTab.getWindowName(), firstTab.getWindowName());
});

test('legacy sessionStorage client id is promoted into tab-scoped storage', () => {
  const legacyId = '0123456789abcdef0123456789abcdef';
  const localStorageBacking = createStorageBacking();
  const sessionStorageBacking = createStorageBacking({
    owly_client_id_v1: legacyId,
  });

  const api = buildClientIdApi({
    localStorageBacking,
    sessionStorageBacking,
  });

  const promotedId = api.getPersistentClientId();
  const scopedKey = `${api.clientIdStorageKey}:${api.getPersistentClientTabKey()}`;

  assert.equal(promotedId, legacyId);
  assert.equal(localStorageBacking.get(scopedKey), legacyId);
});

test('username change rotates client id within the same tab', () => {
  const api = buildClientIdApi();

  const firstId = api.ensurePersistentClientIdForUsername('alice');
  const secondId = api.ensurePersistentClientIdForUsername('alice');
  const thirdId = api.ensurePersistentClientIdForUsername('bob');

  assert.equal(secondId, firstId);
  assert.notEqual(thirdId, firstId);
  assert.equal(api.getPersistentClientUsername(), 'bob');
});

test('username change clears stored resume token within the same tab', () => {
  const api = buildClientIdApi();

  api.ensurePersistentClientIdForUsername('alice');
  api.rememberPersistentClientResumeToken('resume-token-1');
  assert.equal(api.getPersistentClientResumeToken(), 'resume-token-1');

  api.ensurePersistentClientIdForUsername('bob');

  assert.equal(api.getPersistentClientResumeToken(), null);
});

test('duplicated tab with inherited window.name rotates client identity when another tab already owns it', async () => {
  const localStorageBacking = createStorageBacking();
  const broadcastHub = new FakeBroadcastChannelHub();

  const originalTab = buildClientIdApi({
    localStorageBacking,
    broadcastHub,
  });
  originalTab.ensurePersistentClientIdForUsername('alice');
  originalTab.rememberPersistentClientResumeToken('resume-token-1');
  await originalTab.ensurePersistentClientTabOwnership();

  const inheritedWindowName = originalTab.getWindowName();
  const duplicateTab = buildClientIdApi({
    localStorageBacking,
    broadcastHub,
    windowName: inheritedWindowName,
    randomSeedStart: 91,
  });
  const inheritedId = duplicateTab.getPersistentClientId();
  duplicateTab.rememberPersistentClientUsername('alice');
  duplicateTab.rememberPersistentClientResumeToken('resume-token-1');

  await duplicateTab.ensurePersistentClientTabOwnership();
  const rotatedId = duplicateTab.ensurePersistentClientIdForUsername('alice');

  assert.notEqual(duplicateTab.getWindowName(), inheritedWindowName);
  assert.notEqual(rotatedId, inheritedId);
  assert.equal(duplicateTab.getPersistentClientUsername(), 'alice');
  assert.equal(duplicateTab.getPersistentClientResumeToken(), null);
});

test('getPersistentClientId falls back to random when storage is unavailable', () => {
  const api = buildClientIdApi({
    localThrows: true,
    sessionThrows: true,
  });
  const id = api.getPersistentClientId();

  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(api.localStorageBacking.size, 0);
  assert.equal(api.sessionStorageBacking.size, 0);
});
