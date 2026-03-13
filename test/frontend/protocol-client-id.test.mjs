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

function buildClientIdApi({ storedValue, sessionThrows = false } = {}) {
  const storage = new Map();
  if (storedValue !== undefined) {
    storage.set('owly_client_id_v1', storedValue);
  }

  const sessionStorage = {
    getItem(key) {
      if (sessionThrows) {
        throw new Error('session storage unavailable');
      }
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      if (sessionThrows) {
        throw new Error('session storage unavailable');
      }
      storage.set(key, value);
    },
  };

  let randomSeed = 1;
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
    window: {
      sessionStorage,
    },
  });

  const snippet = [
    extractFunction('toHex'),
    extractFunction('newRandomId'),
    extractConst('clientIdStorageKey'),
    extractFunction('getPersistentClientId'),
    'this.__exports = { getPersistentClientId, clientIdStorageKey };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    storage,
  };
}

test('getPersistentClientId reuses a valid stored id', () => {
  const storedId = '0123456789abcdef0123456789abcdef';
  const api = buildClientIdApi({ storedValue: storedId });

  assert.equal(api.getPersistentClientId(), storedId);
  assert.equal(api.storage.get(api.clientIdStorageKey), storedId);
});

test('getPersistentClientId persists a generated id for the tab', () => {
  const api = buildClientIdApi();

  const first = api.getPersistentClientId();
  const second = api.getPersistentClientId();

  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(second, first);
  assert.equal(api.storage.get(api.clientIdStorageKey), first);
});

test('getPersistentClientId falls back to random when sessionStorage fails', () => {
  const api = buildClientIdApi({ sessionThrows: true });
  const id = api.getPersistentClientId();

  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(api.storage.size, 0);
});
