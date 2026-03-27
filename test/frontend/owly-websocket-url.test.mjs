import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const owlySource = fs.readFileSync(
  path.resolve('static/owly.js'),
  'utf8',
);

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = owlySource.indexOf(marker);
  if (start < 0) {
    throw new Error(`Could not find function ${name}`);
  }

  let index = owlySource.indexOf('{', start);
  let depth = 0;
  for (; index < owlySource.length; index += 1) {
    const ch = owlySource[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return owlySource.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not parse function ${name}`);
}

function buildApi({ protocol = 'https:', host = 'owly.example.com' } = {}) {
  const context = vm.createContext({
    URL,
    location: {
      protocol,
      host,
      href: `${protocol}//${host}/group/public/`,
    },
  });

  vm.runInContext(
    `${extractFunction('getWebSocketEndpointUrl')}\nthis.__exports = { getWebSocketEndpointUrl };`,
    context,
  );

  return context.__exports;
}

test('getWebSocketEndpointUrl falls back to the current page origin', () => {
  const api = buildApi();
  assert.equal(
    api.getWebSocketEndpointUrl(''),
    'wss://owly.example.com/ws',
  );
});

test('getWebSocketEndpointUrl upgrades ws to wss on https pages', () => {
  const api = buildApi();
  assert.equal(
    api.getWebSocketEndpointUrl('ws://owly.example.com/ws'),
    'wss://owly.example.com/ws',
  );
});

test('getWebSocketEndpointUrl keeps ws on http pages', () => {
  const api = buildApi({ protocol: 'http:', host: 'localhost:8443' });
  assert.equal(
    api.getWebSocketEndpointUrl('ws://localhost:8443/ws'),
    'ws://localhost:8443/ws',
  );
});
