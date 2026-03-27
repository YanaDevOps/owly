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
    extractFunction('isMobilePerformanceProfile'),
    extractFunction('shouldUseReducedChromeEffects'),
    extractFunction('getDefaultSendSetting'),
    extractFunction('getDefaultSimulcastSetting'),
    extractFunction('getAdaptiveMaxFrameRate'),
    extractFunction('getFilterFrameRate'),
    extractFunction('getActivityDetectionInterval'),
    extractFunction('getActivityDetectionPeriod'),
    extractFunction('buildVideoConstraints'),
    extractFunction('shouldCollectUpstreamStats'),
    extractFunction('shouldAllowCpuSegmentationFallback'),
    'this.__exports = { getPerformanceProfile, isMobilePerformanceProfile, shouldUseReducedChromeEffects, getDefaultSendSetting, getDefaultSimulcastSetting, getAdaptiveMaxFrameRate, getFilterFrameRate, getActivityDetectionInterval, getActivityDetectionPeriod, buildVideoConstraints, shouldCollectUpstreamStats, shouldAllowCpuSegmentationFallback };',
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

function buildMediaBudgetApi({
  performanceProfile = 'desktop',
  send = 'unlimited',
  simulcast = 'auto',
  userCount = 3,
} = {}) {
  const users = {};
  for (let i = 0; i < userCount; i += 1) {
    users[`user-${i}`] = { permissions: {} };
  }

  const context = vm.createContext({
    filters: {
      'background-blur': { kind: 'blur' },
      'background-replace': { kind: 'replace' },
    },
    getPerformanceProfile() {
      return performanceProfile;
    },
    getSettings() {
      return {
        send,
        simulcast,
      };
    },
    serverConnection: {
      users,
    },
    console,
  });

  const snippet = [
    'const simulcastRate = 100000;',
    'const legacyNormalVideoRate = 700000;',
    'const mobileUnlimitedVideoRate = 1400000;',
    'const lowPowerMobileUnlimitedVideoRate = 900000;',
    'const mobileEffectVideoRate = 900000;',
    'const lowPowerMobileEffectVideoRate = 600000;',
    'const mobilePressureFallbackVideoRate = 500000;',
    'const lowPowerMobilePressureFallbackVideoRate = 350000;',
    extractFunction('isMobilePerformanceProfile'),
    extractFunction('isExpensiveFilterDefinition'),
    extractFunction('streamHasExpensiveFilter'),
    extractFunction('getSelectedMaxVideoThroughput'),
    extractFunction('getMobileProfileVideoThroughputCap'),
    extractFunction('getMaxVideoThroughput'),
    extractFunction('doSimulcast'),
    'this.__exports = { getMaxVideoThroughput, doSimulcast, filters };',
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
  assert.equal(api.isMobilePerformanceProfile(), false);
  assert.equal(api.shouldUseReducedChromeEffects(), false);
  assert.equal(api.getDefaultSendSetting(), 'normal');
  assert.equal(api.getDefaultSimulcastSetting(), 'auto');
  assert.equal(api.getAdaptiveMaxFrameRate(), 30);
  assert.equal(api.getFilterFrameRate(30), 30);
  assert.equal(api.getActivityDetectionInterval(), 500);
  assert.equal(api.getActivityDetectionPeriod(), 1200);
  assert.equal(api.shouldCollectUpstreamStats(), true);
  assert.equal(api.shouldAllowCpuSegmentationFallback(), true);
});

test('modern mobile profile keeps legacy send defaults and simple constraints', () => {
  const api = buildPerfApi({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    mobileLayout: true,
  });

  const constraints = api.buildVideoConstraints({ video: '', blackboardMode: false });

  assert.equal(api.getPerformanceProfile(), 'mobile');
  assert.equal(api.isMobilePerformanceProfile(), true);
  assert.equal(api.shouldUseReducedChromeEffects(), true);
  assert.equal(api.getDefaultSendSetting(), 'normal');
  assert.equal(api.getDefaultSimulcastSetting(), 'auto');
  assert.equal(api.getAdaptiveMaxFrameRate(), 24);
  assert.equal(api.getFilterFrameRate(15), 12);
  assert.equal(api.getActivityDetectionInterval(), 1000);
  assert.equal(api.getActivityDetectionPeriod(), 1800);
  assert.equal(constraints.frameRate, undefined);
  assert.equal(constraints.width, undefined);
  assert.equal(constraints.height, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.aspectRatio)), { ideal: 4 / 3 });
  assert.equal(api.shouldAllowCpuSegmentationFallback(), false);
});

test('low power mobile profile keeps legacy capture constraints', () => {
  const api = buildPerfApi({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 Version/15.6 Mobile/15E148 Safari/604.1',
    hardwareConcurrency: 4,
    deviceMemory: 0,
    mobileLayout: true,
    oldSafari: true,
  });

  const constraints = api.buildVideoConstraints({
    video: '',
    blackboardMode: false,
  });

  assert.equal(api.getPerformanceProfile(), 'low-power-mobile');
  assert.equal(api.isMobilePerformanceProfile(), true);
  assert.equal(api.shouldUseReducedChromeEffects(), true);
  assert.equal(api.getDefaultSendSetting(), 'normal');
  assert.equal(api.getDefaultSimulcastSetting(), 'auto');
  assert.equal(api.getAdaptiveMaxFrameRate(), 15);
  assert.equal(api.getFilterFrameRate(15), 10);
  assert.equal(api.getActivityDetectionInterval(), 1500);
  assert.equal(api.getActivityDetectionPeriod(), 2200);
  assert.equal(constraints.frameRate, undefined);
  assert.equal(constraints.width, undefined);
  assert.equal(constraints.height, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints.aspectRatio)), { ideal: 4 / 3 });
  assert.equal(api.shouldAllowCpuSegmentationFallback(), false);
});

test('firefox keeps simulcast default disabled', () => {
  const api = buildPerfApi({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  });

  assert.equal(api.getDefaultSimulcastSetting(), 'off');
});

test('media budget falls back to legacy normal throughput', () => {
  const api = buildMediaBudgetApi({
    performanceProfile: 'mobile',
    send: 'normal',
    simulcast: 'auto',
  });

  assert.equal(api.getMaxVideoThroughput({ userdata: {} }), 700000);
  assert.equal(api.doSimulcast(), true);
});

test('mobile throughput no longer depends on filter or pressure caps', () => {
  const api = buildMediaBudgetApi({
    performanceProfile: 'low-power-mobile',
    send: 'unlimited',
  });

  assert.equal(api.getMaxVideoThroughput({
    userdata: {
      filterDefinition: api.filters['background-replace'],
    },
  }), null);
  assert.equal(api.getMaxVideoThroughput({
    userdata: {
      pressureBitrateCap: 350000,
    },
  }), null);
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
