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
  const marker = `function ${name}(`;
  const start = protocolSource.indexOf(marker);
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

function buildClientIdApi({
  localStorageBacking = createStorageBacking(),
  sessionStorageBacking = createStorageBacking(),
  windowName = '',
  localThrows = false,
  sessionThrows = false,
  randomSeedStart = 1,
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
  });

  const snippet = [
    extractFunction('toHex'),
    extractFunction('newRandomId'),
    extractConst('clientIdStorageKey'),
    extractConst('clientUsernameStorageKey'),
    extractConst('clientTabKeyWindowPrefix'),
    extractFunction('isPersistentClientId'),
    extractFunction('getPersistentClientTabKey'),
    extractFunction('getPersistentClientScopedStorageKey'),
    extractFunction('getPersistentClientValue'),
    extractFunction('setPersistentClientValue'),
    extractFunction('getPersistentClientId'),
    extractFunction('getPersistentClientUsername'),
    extractFunction('rememberPersistentClientUsername'),
    extractFunction('rotatePersistentClientId'),
    extractFunction('ensurePersistentClientIdForUsername'),
    'this.__exports = {',
    '  getPersistentClientId,',
    '  getPersistentClientTabKey,',
    '  ensurePersistentClientIdForUsername,',
    '  getPersistentClientUsername,',
    '  rememberPersistentClientUsername,',
    '  clientIdStorageKey,',
    '  clientUsernameStorageKey,',
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
