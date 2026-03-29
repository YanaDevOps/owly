import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const owlySource = fs.readFileSync(
  path.resolve('static/owly.js'),
  'utf8',
);

function extractConst(name) {
  const match = owlySource.match(new RegExp(`const ${name} = [^;]+;`));
  if (!match) {
    throw new Error(`Could not find const ${name}`);
  }
  return match[0];
}

function extractFunction(name) {
  const asyncMarker = `async function ${name}(`;
  const marker = `function ${name}(`;
  let start = owlySource.indexOf(asyncMarker);
  if (start < 0) {
    start = owlySource.indexOf(marker);
  }
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

function buildVideoThroughputApi() {
  const context = vm.createContext({
    console,
    __send: 'normal',
    __profile: 'desktop',
    getSettings() {
      return { send: context.__send };
    },
    getPerformanceProfile() {
      return context.__profile;
    },
    streamHasExpensiveFilter(stream) {
      return !!(stream && stream.expensive);
    },
  });

  const snippet = [
    extractConst('legacyNormalVideoRate'),
    extractConst('mobileUnlimitedVideoRate'),
    extractConst('lowPowerMobileUnlimitedVideoRate'),
    extractConst('mobileEffectVideoRate'),
    extractConst('lowPowerMobileEffectVideoRate'),
    extractFunction('getSelectedMaxVideoThroughput'),
    extractFunction('getMobileProfileVideoThroughputCap'),
    extractFunction('getMaxVideoThroughput'),
    'this.__exports = {',
    '  getMaxVideoThroughput,',
    '  setSend(value) { __send = value; },',
    '  setProfile(value) { __profile = value; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildUpstreamStatsApi() {
  const calls = [];
  const context = vm.createContext({
    console,
    updateMobilePressurePolicy(stream, summary) {
      calls.push({ stream, summary });
    },
  });

  const snippet = [
    extractFunction('analyseUpstreamStats'),
    extractFunction('gotUpStats'),
    'this.__exports = { gotUpStats };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    gotUpStats: context.__exports.gotUpStats,
    calls,
  };
}

function buildReconnectApi() {
  let timerId = 0;
  const timers = new Map();
  const messages = [];
  const errors = [];
  const connectTriggers = [];

  const context = vm.createContext({
    console,
    Object,
    reconnectState: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    reconnectPending: false,
    reconnectRestoreLocalMedia: false,
    group: 'room',
    updateReconnectCooldownUi() {},
    setConnected() {},
    displayError(message) {
      errors.push(message);
    },
    displayMessage(message) {
      messages.push(message);
    },
    serverConnect(trigger) {
      connectTriggers.push(trigger);
    },
    setTimeout(fn, delay) {
      timerId += 1;
      timers.set(timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });

  const snippet = [
    'let reconnectState = null;',
    'let reconnectTimer = null;',
    'let reconnectAttempts = 0;',
    'let reconnectPending = false;',
    'let reconnectRestoreLocalMedia = false;',
    'let group = "room";',
    extractConst('reconnectMaxAttempts'),
    extractFunction('clearReconnectTimer'),
    extractFunction('getReconnectDelay'),
    extractFunction('hasReconnectAuthState'),
    extractFunction('shouldAutoReconnectAfterClose'),
    extractFunction('scheduleReconnect'),
    'this.__exports = {',
    '  scheduleReconnect,',
    '  shouldAutoReconnectAfterClose,',
    '  setReconnectState(value) { reconnectState = value; },',
    '  setReconnectAttempts(value) { reconnectAttempts = value; },',
    '  getReconnectAttempts() { return reconnectAttempts; },',
    '  isReconnectPending() { return reconnectPending; },',
    '  getTimerDelays() { return Array.from(__timers.values()).map(timer => timer.delay); },',
    '  runFirstTimer() { const first = __timers.values().next().value; if (first) first.fn(); },',
    '  makeConnection(closeRequestedByClient, closeRequestReason = "") {',
    '    return { closeRequestedByClient, closeRequestReason };',
    '  },',
    '};',
  ].join('\n\n');

  context.__timers = timers;
  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    messages,
    errors,
    connectTriggers,
  };
}

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) {
      names.forEach(name => values.add(name));
    },
    remove(...names) {
      names.forEach(name => values.delete(name));
    },
    contains(name) {
      return values.has(name);
    },
    toggle(name, force) {
      if (force === undefined) {
        if (values.has(name)) {
          values.delete(name);
          return false;
        }
        values.add(name);
        return true;
      }
      if (force) {
        values.add(name);
        return true;
      }
      values.delete(name);
      return false;
    },
  };
}

function buildReplacementApi() {
  const calls = [];
  const context = vm.createContext({
    console,
    Filter: class Filter {},
    async removeFilter() {
      calls.push('removeFilter');
    },
    stopStream(stream) {
      calls.push(`stopStream:${stream.id}`);
    },
  });

  const snippet = [
    extractFunction('getUpStreamStopTarget'),
    extractFunction('releaseReplacedLocalMedia'),
    'this.__exports = { releaseReplacedLocalMedia, Filter };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    releaseReplacedLocalMedia: context.__exports.releaseReplacedLocalMedia,
    Filter: context.__exports.Filter,
    calls,
  };
}

function buildJoinedLeaveApi() {
  const calls = {
    clearReconnectAuthState: 0,
    closeSafariStream: 0,
    closeConnectionIfOpen: [],
    disconnectConferenceNow: [],
    setButtonsVisibility: 0,
    setChangePassword: [],
  };

  const context = vm.createContext({
    console,
    WebSocket: {
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    },
    serverConnection: null,
    presentRequested: null,
    reconnectRestoreLocalMedia: false,
    reconnectPending: false,
    probingState: null,
    token: null,
    isAuthorisationFailure() {
      return false;
    },
    clearReconnectAuthState() {
      calls.clearReconnectAuthState += 1;
    },
    closeSafariStream() {
      calls.closeSafariStream += 1;
    },
    closeConnectionIfOpen(_connection, reason) {
      calls.closeConnectionIfOpen.push(reason);
    },
    disconnectConferenceNow(reason) {
      calls.disconnectConferenceNow.push(reason);
    },
    setButtonsVisibility() {
      calls.setButtonsVisibility += 1;
    },
    setChangePassword(value) {
      calls.setChangePassword.push(value);
    },
    setVisibility() {},
    displayError() {
      throw new Error('displayError should not be called');
    },
  });

  const snippet = [
    'let serverConnection = null;',
    'let presentRequested = null;',
    'let reconnectRestoreLocalMedia = false;',
    'let reconnectPending = false;',
    'let probingState = null;',
    'let token = null;',
    extractFunction('isTransientJoinedLeave'),
    extractFunction('gotJoined'),
    'this.__exports = {',
    '  gotJoined,',
    '  setServerConnection(value) { serverConnection = value; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    gotJoined: context.__exports.gotJoined,
    setServerConnection: context.__exports.setServerConnection,
    calls,
  };
}

function buildDisconnectApi() {
  const calls = {
    invalidateLocalCameraOperations: 0,
    cancelPendingReconnect: [],
    clearReconnectAuthState: 0,
    closeSafariStream: 0,
    setConnected: [],
    setButtonsVisibility: 0,
    setChangePassword: [],
    updateReconnectCooldownUi: 0,
    closeConnectionIfOpen: [],
  };

  const context = vm.createContext({
    console,
    serverConnection: null,
    reconnectRestoreLocalMedia: true,
    localPresentationDesired: true,
    invalidateLocalCameraOperations() {
      calls.invalidateLocalCameraOperations += 1;
    },
    cancelPendingReconnect(resetAttempts) {
      calls.cancelPendingReconnect.push(resetAttempts);
    },
    clearReconnectAuthState() {
      calls.clearReconnectAuthState += 1;
    },
    closeSafariStream() {
      calls.closeSafariStream += 1;
    },
    setConnected(value) {
      calls.setConnected.push(value);
    },
    setButtonsVisibility() {
      calls.setButtonsVisibility += 1;
    },
    setChangePassword(value) {
      calls.setChangePassword.push(value);
    },
    updateReconnectCooldownUi() {
      calls.updateReconnectCooldownUi += 1;
    },
    closeConnectionIfOpen(_connection, reason) {
      calls.closeConnectionIfOpen.push(reason);
    },
  });

  const snippet = [
    'let serverConnection = null;',
    'let reconnectRestoreLocalMedia = true;',
    'let localPresentationDesired = true;',
    extractFunction('closeConnectionStreamsLocally'),
    extractFunction('disconnectConferenceNow'),
    'this.__exports = {',
    '  disconnectConferenceNow,',
    '  setServerConnection(value) { serverConnection = value; },',
    '  getServerConnection() { return serverConnection; },',
    '  getReconnectRestoreLocalMedia() { return reconnectRestoreLocalMedia; },',
    '  getLocalPresentationDesired() { return localPresentationDesired; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    calls,
  };
}

function buildGotCloseApi() {
  const calls = {
    invalidateLocalCameraOperations: 0,
    closeSafariStream: 0,
    updateReconnectCooldownUi: 0,
    scheduleReconnect: [],
    clearReconnectAuthState: 0,
    setConnected: [],
    setButtonsVisibility: 0,
    setChangePassword: [],
  };

  class FakeForm {}
  class FakeElement {
    constructor() {
      this.classList = makeClassList(['ok']);
    }
  }

  const loginForm = new FakeForm();
  const elements = {
    loginform: loginForm,
    'login-device-selection': new FakeElement(),
    'camera-device-card': new FakeElement(),
    'microphone-device-card': new FakeElement(),
  };

  const context = vm.createContext({
    console,
    WebSocket: {
      OPEN: 1,
    },
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
    },
    HTMLFormElement: FakeForm,
    reconnectState: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    reconnectPending: false,
    reconnectRestoreLocalMedia: false,
    localPresentationDesired: false,
    serverConnection: null,
    group: 'room',
    _loginPermissionsGranted: true,
    invalidateLocalCameraOperations() {
      calls.invalidateLocalCameraOperations += 1;
    },
    closeSafariStream() {
      calls.closeSafariStream += 1;
    },
    updateReconnectCooldownUi() {
      calls.updateReconnectCooldownUi += 1;
    },
    scheduleReconnect(reason) {
      calls.scheduleReconnect.push(reason);
    },
    clearReconnectAuthState() {
      calls.clearReconnectAuthState += 1;
    },
    setConnected(value) {
      calls.setConnected.push(value);
    },
    setButtonsVisibility() {
      calls.setButtonsVisibility += 1;
    },
    setChangePassword(value) {
      calls.setChangePassword.push(value);
    },
  });

  const snippet = [
    'let reconnectState = null;',
    'let reconnectTimer = null;',
    'let reconnectAttempts = 0;',
    'let reconnectPending = false;',
    'let reconnectRestoreLocalMedia = false;',
    'let localPresentationDesired = false;',
    'let serverConnection = null;',
    'let group = "room";',
    'let _loginPermissionsGranted = true;',
    extractConst('reconnectMaxAttempts'),
    extractFunction('clearReconnectTimer'),
    extractFunction('hasReconnectAuthState'),
    extractFunction('shouldAutoReconnectAfterClose'),
    extractFunction('gotClose'),
    'this.__exports = {',
    '  gotClose,',
    '  setServerConnection(value) { serverConnection = value; },',
    '  setReconnectState(value) { reconnectState = value; },',
    '  setLocalPresentationDesired(value) { localPresentationDesired = value; },',
    '  getReconnectPending() { return reconnectPending; },',
    '  getReconnectRestoreLocalMedia() { return reconnectRestoreLocalMedia; },',
    '  getServerConnection() { return serverConnection; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    calls,
  };
}

test('getMaxVideoThroughput applies mobile and pressure caps', () => {
  const api = buildVideoThroughputApi();

  api.setSend('unlimited');
  api.setProfile('mobile');
  assert.equal(api.getMaxVideoThroughput({ up: true, label: 'camera', userdata: {} }), 1400000);

  api.setProfile('low-power-mobile');
  assert.equal(api.getMaxVideoThroughput({
    up: true,
    label: 'camera',
    expensive: true,
    userdata: {},
  }), 600000);

  api.setProfile('desktop');
  api.setSend('normal');
  assert.equal(api.getMaxVideoThroughput({
    up: true,
    label: 'camera',
    userdata: { pressureBitrateCap: 350000 },
  }), 350000);
});

test('gotUpStats forwards analysed upstream summary into pressure policy', () => {
  const api = buildUpstreamStatsApi();
  const stream = { localId: 'camera-1' };

  api.gotUpStats.call(stream, {
    video: {
      'outbound-rtp': {
        rate: 420000,
        qualityLimitationReason: 'cpu',
        framesPerSecond: 9,
      },
    },
  });

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].stream, stream);
  assert.equal(api.calls[0].summary.bitrate, 420000);
  assert.equal(api.calls[0].summary.cpuLimited, true);
  assert.equal(api.calls[0].summary.lowFrameRate, true);
});

test('scheduleReconnect arms silent reconnect timer using reconnect state', () => {
  const api = buildReconnectApi();

  api.setReconnectState({
    group: 'room',
    username: 'alice',
    credentials: 'secret',
  });

  assert.equal(api.scheduleReconnect('socket closed'), true);
  assert.equal(api.isReconnectPending(), true);
  assert.equal(api.getReconnectAttempts(), 1);
  assert.deepEqual(Array.from(api.getTimerDelays()), [1000]);
  assert.deepEqual(Array.from(api.messages), ['Connection lost, reconnecting...']);

  api.runFirstTimer();
  assert.deepEqual(Array.from(api.connectTriggers), ['reconnect']);
});

test('shouldAutoReconnectAfterClose skips client-requested and join-failed closes', () => {
  const api = buildReconnectApi();
  api.setReconnectState({
    group: 'room',
    username: 'alice',
    credentials: 'secret',
  });

  assert.equal(
    api.shouldAutoReconnectAfterClose(api.makeConnection(true, 'User disconnected')),
    false,
  );
  assert.equal(
    api.shouldAutoReconnectAfterClose(api.makeConnection(false, 'join failed')),
    false,
  );
  assert.equal(
    api.shouldAutoReconnectAfterClose(api.makeConnection(false, 'Media stall recovery')),
    true,
  );
});

test('releaseReplacedLocalMedia closes the old stream before stopping its tracks', async () => {
  const api = buildReplacementApi();
  const filter = new api.Filter();
  filter.inputStream = { id: 'filtered-input' };
  const connection = {
    userdata: { filter },
    stream: { id: 'published-stream' },
    close(replace) {
      api.calls.push(`close:${replace}`);
    },
  };

  await api.releaseReplacedLocalMedia(connection);

  assert.deepEqual(api.calls, [
    'removeFilter',
    'close:true',
    'stopStream:filtered-input',
  ]);
});

test('gotJoined ignores synthetic leave events emitted during socket close', async () => {
  const api = buildJoinedLeaveApi();
  const connection = {
    socket: { readyState: 2 },
    closeRequestedByClient: false,
  };

  api.setServerConnection(connection);
  await api.gotJoined.call(connection, 'leave', 'room', [], {}, {}, '', '');

  assert.equal(api.calls.clearReconnectAuthState, 0);
  assert.deepEqual(api.calls.disconnectConferenceNow, []);
  assert.deepEqual(api.calls.closeConnectionIfOpen, []);
  assert.equal(api.calls.setButtonsVisibility, 1);
  assert.deepEqual(api.calls.setChangePassword, [null]);
});

test('disconnectConferenceNow clears local session state immediately', () => {
  const api = buildDisconnectApi();
  const streamCloseCalls = [];
  const connection = {
    up: {
      a: { localId: 'up-1', close() { streamCloseCalls.push('up-1'); } },
    },
    down: {
      b: { localId: 'down-1', close() { streamCloseCalls.push('down-1'); } },
    },
    socket: { readyState: 1 },
  };

  api.setServerConnection(connection);
  api.disconnectConferenceNow('User disconnected');

  assert.equal(api.getServerConnection(), null);
  assert.equal(api.getReconnectRestoreLocalMedia(), false);
  assert.equal(api.getLocalPresentationDesired(), false);
  assert.deepEqual(streamCloseCalls, ['up-1', 'down-1']);
  assert.equal(api.calls.invalidateLocalCameraOperations, 1);
  assert.deepEqual(api.calls.cancelPendingReconnect, [true]);
  assert.equal(api.calls.clearReconnectAuthState, 1);
  assert.equal(api.calls.closeSafariStream, 1);
  assert.deepEqual(api.calls.setConnected, [false]);
  assert.equal(api.calls.setButtonsVisibility, 1);
  assert.deepEqual(api.calls.setChangePassword, [null]);
  assert.equal(api.calls.updateReconnectCooldownUi, 1);
  assert.deepEqual(api.calls.closeConnectionIfOpen, ['User disconnected']);
});

test('gotClose preserves local presentation intent during auto reconnect', () => {
  const api = buildGotCloseApi();
  const connection = {
    closeRequestedByClient: false,
    closeRequestReason: '',
  };

  api.setServerConnection(connection);
  api.setReconnectState({
    group: 'room',
    username: 'alice',
    credentials: 'secret',
  });
  api.setLocalPresentationDesired(true);

  api.gotClose.call(connection, 1006, 'socket closed');

  assert.equal(api.getReconnectPending(), true);
  assert.equal(api.getReconnectRestoreLocalMedia(), true);
  assert.deepEqual(api.calls.scheduleReconnect, ['socket closed']);
  assert.deepEqual(api.calls.setConnected, []);
  assert.equal(api.calls.setButtonsVisibility, 0);
  assert.equal(api.calls.invalidateLocalCameraOperations, 1);
  assert.equal(api.calls.closeSafariStream, 1);
  assert.equal(api.calls.updateReconnectCooldownUi, 1);
  assert.equal(api.getServerConnection(), connection);
});
