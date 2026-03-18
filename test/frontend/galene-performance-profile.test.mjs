import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const galeneSource = fs.readFileSync(
  path.resolve('static/galene.js'),
  'utf8',
);

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = galeneSource.indexOf(marker);
  if (start < 0) {
    throw new Error(`Could not find function ${name}`);
  }

  let index = galeneSource.indexOf('{', start);
  let depth = 0;
  for (; index < galeneSource.length; index += 1) {
    const ch = galeneSource[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return galeneSource.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not parse function ${name}`);
}

function buildPerfApi({
  userAgent,
  hardwareConcurrency = 8,
  deviceMemory = 8,
  mobileLayout = false,
  oldSafari = false,
} = {}) {
  const context = vm.createContext({
    navigator: {
      userAgent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
      hardwareConcurrency,
      deviceMemory,
    },
    window: {
      matchMedia() {
        return { matches: mobileLayout };
      },
    },
    document: {
      getElementById() {
        return null;
      },
      visibilityState: 'visible',
      documentElement: {
        classList: {
          toggle() {},
        },
      },
    },
  });

  const snippet = [
    extractFunction('isMobileLayout'),
    extractFunction('isLikelyMobileDevice'),
    extractFunction('isIOSDevice'),
    extractFunction('isFirefox'),
    `function isOldSafari() { return ${oldSafari ? 'true' : 'false'}; }`,
    extractFunction('getHardwareConcurrency'),
    extractFunction('getDeviceMemory'),
    extractFunction('getPerformanceProfile'),
    extractFunction('shouldUseReducedChromeEffects'),
    extractFunction('getDefaultSendSetting'),
    extractFunction('getDefaultSimulcastSetting'),
    extractFunction('getAdaptiveMaxFrameRate'),
    extractFunction('getActivityDetectionInterval'),
    extractFunction('getActivityDetectionPeriod'),
    extractFunction('buildVideoConstraints'),
    extractFunction('shouldCollectUpstreamStats'),
    'this.__exports = { getPerformanceProfile, shouldUseReducedChromeEffects, getDefaultSendSetting, getDefaultSimulcastSetting, getAdaptiveMaxFrameRate, getActivityDetectionInterval, getActivityDetectionPeriod, buildVideoConstraints, shouldCollectUpstreamStats };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildSettingsApi(initialSettings) {
  let stored = JSON.stringify(initialSettings);
  const context = vm.createContext({
    fallbackSettings: null,
    window: {
      localStorage: {
        getItem() {
          return stored;
        },
        setItem(_key, value) {
          stored = value;
        },
      },
    },
    console,
  });

  const snippet = [
    'let fallbackSettings = null;',
    extractFunction('storeSettings'),
    extractFunction('normaliseSettings'),
    extractFunction('getSettings'),
    'this.__exports = { getSettings };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildFilterRestoreApi() {
  const context = vm.createContext({});

  const snippet = [
    "const expensiveFilterNames = new Set(['background-blur', 'background-replace']);",
    'let expensiveFiltersArmedThisSession = false;',
    "let deferredStartupExpensiveFilter = '';",
    extractFunction('needsExpensiveFilterOption'),
    extractFunction('getRestoredFilterValue'),
    'this.__exports = {',
    '  getRestoredFilterValue,',
    '  arm(value) { expensiveFiltersArmedThisSession = value; },',
    '  getDeferred() { return deferredStartupExpensiveFilter; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildConnectionHealthApi({ now = 1000 } = {}) {
  const timers = [];
  const context = vm.createContext({
    Date: {
      now: () => now,
    },
    clearTimeout() {},
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    streamUiHealth: new Map(),
    participantConnectionPoorGracePeriod: 5000,
    __timers: timers,
  });

  const snippet = [
    'const streamUiHealth = new Map();',
    'const participantConnectionPoorGracePeriod = 5000;',
    extractFunction('getOrCreateStreamUiHealth'),
    extractFunction('clearStreamUiHealthTimer'),
    extractFunction('scheduleStreamUiGraceRefresh'),
    extractFunction('getStreamConnectionHealth'),
    'this.__exports = { getStreamConnectionHealth, timers: __timers };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildReconnectPolicyApi() {
  const context = vm.createContext({});

  const snippet = [
    extractFunction('getReconnectDelay'),
    extractFunction('isAuthorisationFailure'),
    'this.__exports = { getReconnectDelay, isAuthorisationFailure };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

test('desktop profile keeps performance profile as desktop and disables adaptive cap', () => {
  const api = buildPerfApi();

  assert.equal(api.getPerformanceProfile(), 'desktop');
  assert.equal(api.shouldUseReducedChromeEffects(), false);
  assert.equal(api.getDefaultSendSetting(), 'unlimited');
  assert.equal(api.getDefaultSimulcastSetting(), 'on');
  assert.equal(api.getAdaptiveMaxFrameRate(), 30);
  assert.equal(api.getActivityDetectionInterval(), 500);
  assert.equal(api.getActivityDetectionPeriod(), 1200);
  assert.equal(api.shouldCollectUpstreamStats(), true);
});

test('modern mobile profile applies balanced mobile caps', () => {
  const api = buildPerfApi({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    mobileLayout: true,
  });

  const constraints = api.buildVideoConstraints({ video: '', blackboardMode: false });

  assert.equal(api.getPerformanceProfile(), 'mobile');
  assert.equal(api.shouldUseReducedChromeEffects(), true);
  assert.equal(api.getDefaultSimulcastSetting(), 'auto');
  assert.equal(api.getAdaptiveMaxFrameRate(), 24);
  assert.equal(api.getActivityDetectionInterval(), 1000);
  assert.equal(api.getActivityDetectionPeriod(), 1800);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.frameRate)), { ideal: 24, max: 24 });
  assert.equal(constraints.width, undefined);
  assert.equal(constraints.height, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.aspectRatio)), { ideal: 4 / 3 });
});

test('low power mobile profile applies stricter caps', () => {
  const api = buildPerfApi({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 Version/15.6 Mobile/15E148 Safari/604.1',
    hardwareConcurrency: 4,
    deviceMemory: 0,
    mobileLayout: true,
    oldSafari: true,
  });

  const constraints = api.buildVideoConstraints({
    video: '',
    resolution: [1920, 1080],
    blackboardMode: false,
  });

  assert.equal(api.getPerformanceProfile(), 'low-power-mobile');
  assert.equal(api.shouldUseReducedChromeEffects(), true);
  assert.equal(api.getDefaultSimulcastSetting(), 'auto');
  assert.equal(api.getAdaptiveMaxFrameRate(), 15);
  assert.equal(api.getActivityDetectionInterval(), 1500);
  assert.equal(api.getActivityDetectionPeriod(), 2200);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.frameRate)), { ideal: 15, max: 15 });
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.width)), { ideal: 1920 });
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.height)), { ideal: 1080 });
});

test('firefox keeps simulcast default disabled', () => {
  const api = buildPerfApi({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  });

  assert.equal(api.getDefaultSimulcastSetting(), 'off');
});

test('old settings are normalised immediately when read', () => {
  const api = buildSettingsApi({
    performanceDefaultsVersion: 1,
    activityDetection: true,
    activityDetectionConfigured: true,
  });

  const settings = api.getSettings();

  assert.equal(settings.performanceDefaultsVersion, 4);
  assert.equal(settings.activityDetection, false);
  assert.equal(settings.activityDetectionConfigured, true);
});

test('explicit user activity preference is preserved during migration', () => {
  const api = buildSettingsApi({
    performanceDefaultsVersion: 1,
    activityDetection: true,
    activityDetectionConfigured: true,
    activityDetectionUserSet: true,
  });

  const settings = api.getSettings();

  assert.equal(settings.performanceDefaultsVersion, 4);
  assert.equal(settings.activityDetection, true);
  assert.equal(settings.activityDetectionUserSet, true);
});

test('stale forceRelay is cleared during migration', () => {
  const api = buildSettingsApi({
    performanceDefaultsVersion: 1,
    forceRelay: true,
  });

  const settings = api.getSettings();

  assert.equal(settings.performanceDefaultsVersion, 4);
  assert.equal(settings.forceRelay, false);
});

test('forceRelay is cleared even for already-migrated settings', () => {
  const api = buildSettingsApi({
    performanceDefaultsVersion: 4,
    forceRelay: true,
  });

  const settings = api.getSettings();
  assert.equal(settings.performanceDefaultsVersion, 4);
  assert.equal(settings.forceRelay, false);
});

test('expensive saved filters are deferred until user re-enables them in session', () => {
  const api = buildFilterRestoreApi();

  assert.equal(api.getRestoredFilterValue('background-blur'), '');
  assert.equal(api.getDeferred(), 'background-blur');

  api.arm(true);

  assert.equal(api.getRestoredFilterValue('background-blur'), 'background-blur');
  assert.equal(api.getDeferred(), '');
});

test('non-expensive saved filters restore immediately', () => {
  const api = buildFilterRestoreApi();

  assert.equal(api.getRestoredFilterValue('mirror'), 'mirror');
  assert.equal(api.getDeferred(), '');
});

test('checking ICE state does not mark stream as poor', () => {
  const api = buildConnectionHealthApi();
  const stream = {
    localId: 's1',
    pc: { iceConnectionState: 'checking' },
  };

  assert.equal(api.getStreamConnectionHealth(stream), 'unknown');
});

test('disconnected ICE state gets grace period before marking stream poor', () => {
  const api = buildConnectionHealthApi({ now: 1000 });
  const stream = {
    localId: 's2',
    pc: { iceConnectionState: 'connected' },
  };

  assert.equal(api.getStreamConnectionHealth(stream), 'healthy');
  stream.pc.iceConnectionState = 'disconnected';
  assert.equal(api.getStreamConnectionHealth(stream), 'healthy');
  assert.equal(api.timers.length, 1);
});

test('failed ICE state marks stream as poor immediately', () => {
  const api = buildConnectionHealthApi();
  const stream = {
    localId: 's3',
    pc: { iceConnectionState: 'failed' },
  };

  assert.equal(api.getStreamConnectionHealth(stream), 'poor');
});

test('reconnect delays start immediately and then cap quickly', () => {
  const api = buildReconnectPolicyApi();

  assert.equal(api.getReconnectDelay(0), 0);
  assert.equal(api.getReconnectDelay(1), 1000);
  assert.equal(api.getReconnectDelay(2), 2000);
  assert.equal(api.getReconnectDelay(3), 5000);
  assert.equal(api.getReconnectDelay(8), 5000);
});

test('authorisation failures are detected from client and server messages', () => {
  const api = buildReconnectPolicyApi();

  assert.equal(api.isAuthorisationFailure('not authorised'), true);
  assert.equal(api.isAuthorisationFailure({ message: 'The server said: not authorized' }), true);
  assert.equal(api.isAuthorisationFailure({ serverError: 'not-authorised' }), true);
  assert.equal(api.isAuthorisationFailure({ message: 'duplicate username' }), false);
});
