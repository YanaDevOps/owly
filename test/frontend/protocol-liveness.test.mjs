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

function buildLivenessApi(userAgent) {
  const context = vm.createContext({
    navigator: {
      userAgent,
    },
  });

  const snippet = [
    extractFunction('isLikelyMobileUserAgent'),
    extractFunction('getSocketLivenessConfig'),
    'this.__exports = { isLikelyMobileUserAgent, getSocketLivenessConfig };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

test('desktop websocket liveness stays close to legacy timeout', () => {
  const api = buildLivenessApi(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
  );

  assert.equal(api.isLikelyMobileUserAgent(), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getSocketLivenessConfig())),
    {
      pingIntervalMs: 10000,
      idlePingDelayMs: 15000,
      livenessTimeoutMs: 65000,
    },
  );
});

test('mobile websocket liveness now matches legacy timeout too', () => {
  const api = buildLivenessApi(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
  );

  assert.equal(api.isLikelyMobileUserAgent(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getSocketLivenessConfig())),
    {
      pingIntervalMs: 10000,
      idlePingDelayMs: 15000,
      livenessTimeoutMs: 65000,
    },
  );
});
