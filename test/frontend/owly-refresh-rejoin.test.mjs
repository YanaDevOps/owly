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
  const marker = `function ${name}(`;
  const start = owlySource.indexOf(marker);
  if (start < 0) {
    throw new Error(`Could not find function ${name}`);
  }

  let index = owlySource.indexOf('(', start);
  let parenDepth = 0;
  for (; index < owlySource.length; index += 1) {
    const ch = owlySource[index];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        index = owlySource.indexOf('{', index);
        break;
      }
    }
  }
  if (index < 0) {
    throw new Error(`Could not parse parameters for function ${name}`);
  }
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

function createStorageBacking(initialEntries = {}) {
  return new Map(Object.entries(initialEntries));
}

function createStorage(backing) {
  return {
    getItem(key) {
      return backing.has(key) ? backing.get(key) : null;
    },
    setItem(key, value) {
      backing.set(key, value);
    },
    removeItem(key) {
      backing.delete(key);
    },
  };
}

function buildRefreshRejoinApi({
  now = 1000,
  groupName = 'demo-room',
  tabKey = 'tab-1',
  storageBacking = createStorageBacking(),
} = {}) {
  const context = vm.createContext({
    window: {
      localStorage: createStorage(storageBacking),
    },
    Date: {
      now: () => context.__now,
    },
    console,
    group: groupName,
    reconnectState: null,
    reconnectPending: false,
    loginPassword: null,
    pwAuth: false,
    __now: now,
    getPersistentClientTabKey() {
      return tabKey;
    },
    setVisibility() {},
  });

  const snippet = [
    extractConst('refreshRejoinStateStoragePrefix'),
    extractConst('refreshRejoinStateTtlMs'),
    extractFunction('cloneJoinCredentials'),
    extractFunction('normaliseReconnectAuthState'),
    extractFunction('getRefreshRejoinStateStorageKey'),
    extractFunction('persistRefreshRejoinState'),
    extractFunction('loadRefreshRejoinState'),
    extractFunction('rememberReconnectAuthState'),
    extractFunction('restoreRefreshRejoinState'),
    extractFunction('clearReconnectAuthState'),
    'this.__exports = {',
    '  rememberReconnectAuthState,',
    '  restoreRefreshRejoinState,',
    '  loadRefreshRejoinState,',
    '  clearReconnectAuthState,',
    '  getStorageKey(groupName) { return getRefreshRejoinStateStorageKey(groupName); },',
    '  setNow(value) { __now = value; },',
    '  getReconnectState() { return reconnectState; },',
    '  isReconnectPending() { return reconnectPending; },',
    '  getLoginPassword() { return loginPassword; },',
    '  isPwAuth() { return pwAuth; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    storageBacking,
  };
}

function buildPageTransitionApi() {
  const events = [];
  const context = vm.createContext({
    pageTransitionCloseHandled: false,
    pageTransitionInProgress: false,
    serverConnection: { id: 'conn-1' },
    setFiltersPaused(value) {
      events.push(['filters', value]);
    },
    setActivityDetectionPaused(value) {
      events.push(['activity', value]);
    },
    cancelPendingReconnect(resetAttempts) {
      events.push(['cancel', resetAttempts]);
    },
    closeConnectionIfOpen(connection, reason) {
      events.push(['close', connection.id, reason]);
    },
  });

  const snippet = [
    extractFunction('beginPageTransitionDisconnect'),
    'this.__exports = {',
    '  beginPageTransitionDisconnect,',
    '  getEvents() { return __events; },',
    '  getFlags() {',
    '    return {',
    '      handled: pageTransitionCloseHandled,',
    '      inProgress: pageTransitionInProgress,',
    '    };',
    '  },',
    '};',
  ].join('\n\n');

  context.__events = events;
  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildPlaceholderApi({ now = 1000, userStreams = [] } = {}) {
  const context = vm.createContext({
    Map,
    Object,
    Date: {
      now: () => context.__now,
    },
    participantPresence: new Map(),
    conferenceConnectingPlaceholderGracePeriod: 2000,
    __now: now,
    __userStreams: userStreams,
    getUserStreams() {
      return context.__userStreams;
    },
    hasVideoTrack(stream) {
      if (!stream) {
        return false;
      }
      if (typeof stream.getTracks === 'function') {
        return stream.getTracks().some(
          track => track.kind === 'video' && track.readyState !== 'ended',
        );
      }
      return !!stream.hasVideo;
    },
  });

  const snippet = [
    extractFunction('getOrCreateParticipantState'),
    extractConst('participantReconnectPlaceholderGracePeriod'),
    extractFunction('getParticipantLiveStreamSummary'),
    extractFunction('getConferencePlaceholderStatus'),
    extractFunction('shouldRenderConferencePlaceholder'),
    'this.__exports = {',
    '  getConferencePlaceholderStatus,',
    '  shouldRenderConferencePlaceholder,',
    '  setParticipantState(id, patch) {',
    '    const state = getOrCreateParticipantState(id);',
    '    Object.assign(state, patch);',
    '  },',
    '  setNow(value) { __now = value; },',
    '  setUserStreams(streams) { __userStreams = streams; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  context.__exports.setUserStreams(userStreams);
  return context.__exports;
}

function buildDeletePresenceApi({ userStreams = [] } = {}) {
  const context = vm.createContext({
    Map,
    participantPresence: new Map(),
    __userStreams: userStreams,
    __artifactRemovals: [],
    __deletedMarks: [],
    __clearedDeletedMarks: [],
    __timers: [],
    __clearedTimers: [],
    __renderedRows: [],
    __layoutCalls: 0,
    __stageBadgeCalls: 0,
    document: {
      getElementById() {
        return null;
      },
    },
    getUserStreams() {
      return context.__userStreams;
    },
    removeConferenceArtifactsForUser(id) {
      context.__artifactRemovals.push(id);
    },
    markConferenceUserDeleted(id) {
      context.__deletedMarks.push(id);
    },
    clearConferenceUserDeleted(id) {
      context.__clearedDeletedMarks.push(id);
    },
    updateParticipantsHeader() {},
    renderParticipantRow(id) {
      context.__renderedRows.push(id);
    },
    scheduleConferenceLayout() {
      context.__layoutCalls += 1;
    },
    updateStageBadge() {
      context.__stageBadgeCalls += 1;
    },
    setTimeout(fn, delay) {
      const timer = { fn, delay };
      context.__timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      context.__clearedTimers.push(timer);
    },
  });

  const snippet = [
    extractConst('participantReconnectPlaceholderGracePeriod'),
    extractFunction('clearParticipantRemovalTimer'),
    extractFunction('removeUserRow'),
    extractFunction('removeParticipantImmediately'),
    extractFunction('delUser'),
    'this.__exports = {',
    '  delUser,',
    '  seedParticipant(id, patch = {}) {',
    '    participantPresence.set(id, {',
    "      id, username: '', userinfo: { username: 'Participant', streams: {} },",
    "      offline: false, transientDisconnect: false, offlineSince: null,",
    "      removeTimer: null, placeholderConnectingSince: 0, connectionStatus: 'online',",
    '      speaking: false, hasAudio: false,',
    '      ...patch,',
    '    });',
    '  },',
    '  setUserStreams(streams) { __userStreams = streams; },',
    '  getState(id) { return participantPresence.get(id) || null; },',
    '  getArtifactRemovals() { return [...__artifactRemovals]; },',
    '  getDeletedMarks() { return [...__deletedMarks]; },',
    '  getTimers() { return [...__timers]; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildConferenceParticipantsApi({ streams = [] } = {}) {
  const context = vm.createContext({
    Map,
    Set,
    Object,
    participantPresence: new Map(),
    recentlyDeletedConferenceUsers: new Map(),
    serverConnection: {
      id: null,
      users: {},
      username: 'You',
    },
    __streams: streams,
    pruneRecentlyDeletedConferenceUsers() {},
    getAllStreams() {
      return context.__streams;
    },
    getStreamUserId(stream) {
      return stream.userId;
    },
    stringCompare(a, b) {
      return a.localeCompare(b);
    },
    isConferenceUserRecentlyDeleted() {
      return false;
    },
  });

  const snippet = [
    extractFunction('hasSystemPermission'),
    extractFunction('getConferenceParticipants'),
    'this.__exports = {',
    '  getConferenceParticipants,',
    '  seedParticipant(id, patch = {}) {',
    '    participantPresence.set(id, {',
    "      id, username: '', userinfo: { username: 'Participant', permissions: [], data: {}, streams: {} },",
    '      transientDisconnect: false,',
    '      ...patch,',
    '    });',
    '  },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

test('refresh rejoin state is restored for the same tab and group', () => {
  const storageBacking = createStorageBacking();
  const firstPage = buildRefreshRejoinApi({ storageBacking, now: 1000 });

  firstPage.rememberReconnectAuthState({
    group: 'demo-room',
    username: 'alice',
    credentials: 'secret',
    pwAuth: true,
  });

  const refreshedPage = buildRefreshRejoinApi({ storageBacking, now: 1500 });
  const restored = refreshedPage.restoreRefreshRejoinState('demo-room');

  assert.equal(restored, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshedPage.getReconnectState())),
    {
      group: 'demo-room',
      username: 'alice',
      credentials: 'secret',
      pwAuth: true,
    },
  );
  assert.equal(refreshedPage.getLoginPassword(), 'secret');
  assert.equal(refreshedPage.isPwAuth(), true);
  assert.equal(refreshedPage.isReconnectPending(), true);
});

test('expired refresh rejoin state is discarded', () => {
  const storageBacking = createStorageBacking();
  const api = buildRefreshRejoinApi({ storageBacking, now: 62001 });
  const storageKey = api.getStorageKey('demo-room');
  storageBacking.set(storageKey, JSON.stringify({
    group: 'demo-room',
    username: 'alice',
    credentials: 'secret',
    pwAuth: true,
    savedAt: 0,
  }));

  const restored = api.restoreRefreshRejoinState('demo-room');

  assert.equal(restored, false);
  assert.equal(storageBacking.has(storageKey), false);
});

test('clearReconnectAuthState removes persisted refresh credentials', () => {
  const storageBacking = createStorageBacking();
  const api = buildRefreshRejoinApi({ storageBacking });

  api.rememberReconnectAuthState({
    group: 'demo-room',
    username: 'alice',
    credentials: 'secret',
    pwAuth: true,
  });
  const storageKey = api.getStorageKey('demo-room');
  assert.equal(storageBacking.has(storageKey), true);

  api.clearReconnectAuthState();

  assert.equal(storageBacking.has(storageKey), false);
  assert.equal(api.getReconnectState(), null);
  assert.equal(api.getLoginPassword(), null);
});

test('page transition only pauses heavy work and leaves connection state untouched', () => {
  const api = buildPageTransitionApi();

  api.beginPageTransitionDisconnect({ persisted: false });

  assert.deepEqual(api.getEvents(), [
    ['filters', true],
    ['activity', true],
  ]);
  const flags = api.getFlags();
  assert.equal(flags.handled, false);
  assert.equal(flags.inProgress, false);
});

test('persisted pagehide only pauses heavy work and does not close the socket', () => {
  const api = buildPageTransitionApi();

  api.beginPageTransitionDisconnect({ persisted: true });

  assert.deepEqual(api.getEvents(), [
    ['filters', true],
    ['activity', true],
  ]);
  const flags = api.getFlags();
  assert.equal(flags.handled, false);
  assert.equal(flags.inProgress, false);
});

test('stale remote video placeholder disappears after the short grace window', () => {
  const api = buildPlaceholderApi({ now: 1000 });
  const participant = {
    id: 'remote-1',
    local: false,
    userinfo: {
      streams: {
        camera: {
          video: true,
          audio: true,
        },
      },
    },
  };

  assert.equal(api.shouldRenderConferencePlaceholder(participant), true);
  api.setNow(3501);
  assert.equal(api.shouldRenderConferencePlaceholder(participant), false);
});

test('audio-only placeholder stays visible', () => {
  const api = buildPlaceholderApi();
  const participant = {
    id: 'remote-2',
    local: false,
    userinfo: {
      streams: {
        camera: {
          video: false,
          audio: true,
        },
      },
    },
  };

  assert.equal(api.getConferencePlaceholderStatus(participant), 'Camera off');
  assert.equal(api.shouldRenderConferencePlaceholder(participant), true);
});

test('live stream summary overrides stale roster metadata for stopped camera', () => {
  const api = buildPlaceholderApi({
    userStreams: [{
      label: 'camera',
      stream: {
        getTracks() {
          return [{ kind: 'audio', readyState: 'live' }];
        },
      },
    }],
  });
  const participant = {
    id: 'remote-4',
    local: false,
    userinfo: {
      streams: {
        camera: {
          video: true,
          audio: true,
        },
      },
    },
  };

  assert.equal(api.getConferencePlaceholderStatus(participant), 'Camera off');
  assert.equal(api.shouldRenderConferencePlaceholder(participant), true);
});

test('transient reconnect placeholder stays visible for the full reconnect grace window', () => {
  const api = buildPlaceholderApi({ now: 1000 });
  const participant = {
    id: 'remote-3',
    local: false,
    userinfo: {
      streams: {
        camera: {
          video: true,
          audio: true,
        },
      },
    },
  };

  api.setParticipantState('remote-3', {
    transientDisconnect: true,
  });

  assert.equal(api.getConferencePlaceholderStatus(participant), 'Connecting');
  assert.equal(api.shouldRenderConferencePlaceholder(participant), true);
  api.setNow(15999);
  assert.equal(api.shouldRenderConferencePlaceholder(participant), true);
  api.setNow(16001);
  assert.equal(api.shouldRenderConferencePlaceholder(participant), false);
});

test('hard leave removes the participant immediately without waiting for a reconnect timer', () => {
  const api = buildDeletePresenceApi();
  api.seedParticipant('remote-4', {
    username: 'Alice',
  });

  api.delUser('remote-4');

  assert.equal(api.getState('remote-4'), null);
  assert.deepEqual([...api.getArtifactRemovals()], ['remote-4']);
  assert.deepEqual([...api.getDeletedMarks()], ['remote-4']);
  assert.equal(api.getTimers().length, 0);
});

test('server delete removes media artifacts immediately even when stale streams remain', () => {
  const api = buildDeletePresenceApi({
    userStreams: [{ localId: 'stream-1' }],
  });
  api.seedParticipant('remote-5', {
    username: 'Bob',
  });

  api.delUser('remote-5');

  const state = api.getState('remote-5');
  assert.deepEqual([...api.getArtifactRemovals()], ['remote-5']);
  assert.equal(state, null);
  assert.deepEqual([...api.getDeletedMarks()], ['remote-5']);
  assert.equal(api.getTimers().length, 0);
});

test('conference participants do not duplicate transient reconnect users when a fallback stream exists', () => {
  const api = buildConferenceParticipantsApi({
    streams: [
      {
        userId: 'remote-6',
        localId: 'stream-6',
        label: 'camera',
        username: 'Carol',
        up: false,
        stream: {
          getTracks() {
            return [{ kind: 'video' }];
          },
        },
      },
    ],
  });
  api.seedParticipant('remote-6', {
    username: 'Carol',
    transientDisconnect: true,
    userinfo: {
      username: 'Carol',
      permissions: [],
      data: {},
      streams: {
        camera: {
          video: true,
          audio: true,
        },
      },
    },
  });

  const participants = api.getConferenceParticipants();

  assert.equal(participants.length, 1);
  assert.equal(participants[0].id, 'remote-6');
});
