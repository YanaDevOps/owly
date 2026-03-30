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

function buildDownstreamLifecycleApi() {
  const calls = {
    clearTransportRecovery: 0,
    delMedia: [],
    refreshParticipantPresence: [],
    setMedia: [],
    renderParticipantRow: [],
    statsIntervals: [],
  };
  const participantStates = new Map();
  let now = 1000;

  const context = vm.createContext({
    console,
    Map,
    Date: {
      now() {
        return now;
      },
    },
    serverConnection: null,
    isFirefox() {
      return false;
    },
    debugLog() {},
    clearTransportRecovery() {
      calls.clearTransportRecovery += 1;
    },
    delMedia(localId) {
      calls.delMedia.push(localId);
    },
    refreshParticipantPresence(id) {
      calls.refreshParticipantPresence.push(id);
    },
    setMedia(c, _mirror, _video, forceReset) {
      calls.setMedia.push({ localId: c.localId, forceReset: !!forceReset });
    },
    resetMedia() {},
    handleTransportStatus() {},
    setMediaStatus() {},
    gotDownStats() {},
    shouldRunActivityDetection() {
      return false;
    },
    getActivityDetectionInterval() {
      return 0;
    },
    hasVideoTrack(stream) {
      return !!(
        stream &&
        stream.getTracks().some(
          track => track.kind === 'video' && track.readyState !== 'ended',
        )
      );
    },
    getOrCreateParticipantState(id) {
      if (!participantStates.has(id)) {
        participantStates.set(id, {
          userinfo: { username: 'alice', streams: {} },
          transientDisconnect: false,
          placeholderConnectingSince: 0,
        });
      }
      return participantStates.get(id);
    },
    renderParticipantRow(id) {
      calls.renderParticipantRow.push(id);
    },
  });

  const snippet = [
    'let serverConnection = null;',
    extractConst('participantReconnectPlaceholderGracePeriod'),
    extractConst('conferenceConnectingPlaceholderGracePeriod'),
    extractFunction('noteExpectedDownstreamRecovery'),
    extractFunction('clearExpectedDownstreamRecovery'),
    extractFunction('isExpectedDownstreamRecovery'),
    extractFunction('clearDownstreamTrackLifecycle'),
    extractFunction('bindDownstreamTrackLifecycle'),
    extractFunction('markParticipantStreamReconnecting'),
    extractFunction('gotDownStream'),
    'this.__exports = {',
    '  gotDownStream,',
    '  isExpectedDownstreamRecovery,',
    '  setServerConnection(value) { serverConnection = value; },',
    '  advanceTime(value) { __now = value; },',
    '};',
  ].join('\n\n');

  context.__now = now;
  Object.defineProperty(context.Date, 'now', {
    value() {
      return context.__now;
    },
  });
  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    calls,
    participantStates,
    setNow(value) {
      context.__now = value;
    },
  };
}

function buildMediaStateApi() {
  const calls = {
    refreshParticipantPresence: [],
    scheduleConferenceLayout: 0,
    warnings: [],
  };
  const mediaElements = new Map();

  class FakeMediaElement {
    constructor() {
      this.classList = makeClassList();
      this.srcObject = null;
    }

    play() {
      return Promise.resolve();
    }
  }

  const context = vm.createContext({
    console,
    document: {
      getElementById(id) {
        return mediaElements.get(id) || null;
      },
    },
    HTMLMediaElement: FakeMediaElement,
    getSettings() {
      return { displayAll: false };
    },
    isFirefox() {
      return false;
    },
    debugLog() {},
    scheduleConferenceLayout() {
      calls.scheduleConferenceLayout += 1;
    },
    getStreamConnectionHealth() {
      return context.__health;
    },
    getStreamUserId(c) {
      return c && c.source ? c.source : null;
    },
    refreshParticipantPresence(id) {
      calls.refreshParticipantPresence.push(id);
    },
    shouldSuppressDownstreamFailureWarning() {
      return true;
    },
    displayWarning(message) {
      calls.warnings.push(message);
    },
  });

  const snippet = [
    extractFunction('hasVideoTrack'),
    extractFunction('shouldRecreateDownstreamCameraMedia'),
    extractFunction('showHideMedia'),
    extractFunction('setMediaStatus'),
    'this.__exports = {',
    '  hasVideoTrack,',
    '  shouldRecreateDownstreamCameraMedia,',
    '  showHideMedia,',
    '  setMediaStatus,',
    '};',
  ].join('\n\n');

  context.__health = 'healthy';
  vm.runInContext(snippet, context);

  return {
    ...context.__exports,
    calls,
    createMedia(localId, classes = []) {
      const media = new FakeMediaElement();
      classes.forEach(name => media.classList.add(name));
      mediaElements.set(`media-${localId}`, media);
      return media;
    },
    setHealth(value) {
      context.__health = value;
    },
  };
}

function buildRefreshLocalCameraUiApi() {
  const calls = {
    updatePeerVideoState: [],
    setLabel: 0,
    setMedia: [],
    restoreLiveSelfPreviewPeer: 0,
    scheduleConferenceLayout: 0,
    setButtonsVisibility: 0,
  };

  const peer = { id: 'peer-camera-1' };
  const selfPreviewSlot = {
    classList: {
      contains() {
        return false;
      },
    },
  };

  const context = vm.createContext({
    console,
    getPeer(localId) {
      return localId === 'camera-1' ? peer : null;
    },
    getMediaTrackSignature(stream) {
      return stream ? stream.signature || '' : '';
    },
    hasVideoTrack(stream) {
      return !!(
        stream &&
        stream.getTracks().some(
          track => track.kind === 'video' && track.readyState !== 'ended',
        )
      );
    },
    updatePeerVideoState(c, nextPeer) {
      calls.updatePeerVideoState.push([c.localId, nextPeer && nextPeer.id]);
    },
    setLabel() {
      calls.setLabel += 1;
    },
    getSettings() {
      return { mirrorView: true };
    },
    setMedia(c, mirror, _video, forceReset) {
      calls.setMedia.push({
        localId: c.localId,
        mirror,
        forceReset,
      });
      return Promise.resolve();
    },
    getSelfPreviewSlot() {
      return selfPreviewSlot;
    },
    restoreLiveSelfPreviewPeer(slot) {
      if (slot === selfPreviewSlot)
        calls.restoreLiveSelfPreviewPeer += 1;
      return true;
    },
    scheduleConferenceLayout() {
      calls.scheduleConferenceLayout += 1;
    },
    setButtonsVisibility() {
      calls.setButtonsVisibility += 1;
    },
  });

  const snippet = [
    extractFunction('refreshLocalCameraUi'),
    'this.__exports = { refreshLocalCameraUi };',
  ].join('\n\n');

  vm.runInContext(snippet, context);

  return {
    refreshLocalCameraUi: context.__exports.refreshLocalCameraUi,
    calls,
  };
}

function buildCameraToggleApi() {
  const calls = {
    displayMessage: [],
    displayError: [],
    setLocalCameraOff: [],
    refreshLocalCameraUi: [],
    removeFilter: [],
    setFilter: [],
    getUserMedia: [],
    stopStream: [],
    setMediaChoices: [],
  };
  class FilterStub {}
  const audioTrack = new FakeTrack('audio', 'audio-1');
  const liveVideoTrack = new FakeTrack('video', 'video-1');

  const context = vm.createContext({
    console,
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          calls.getUserMedia.push(constraints);
          const tracks = [];
          if (constraints.audio) {
            tracks.push(new FakeTrack('audio', 'new-audio'));
          }
          if (constraints.video) {
            tracks.push(new FakeTrack('video', 'new-video'));
          }
          return new FakeStream(tracks);
        },
      },
    },
    Filter: FilterStub,
    displayMessage(message) {
      calls.displayMessage.push(message);
    },
    displayError(error) {
      calls.displayError.push(error);
    },
    setLocalCameraOff(value, reflect) {
      calls.setLocalCameraOff.push([value, reflect]);
    },
    refreshLocalCameraUi(stream) {
      calls.refreshLocalCameraUi.push(stream && stream.localId);
    },
    hasVideoTrack(stream) {
      return !!(
        stream &&
        stream.getTracks().some(
          track => track.kind === 'video' && track.readyState !== 'ended',
        )
      );
    },
    stopStream(stream) {
      calls.stopStream.push(stream);
    },
    setMediaChoices(done) {
      calls.setMediaChoices.push(done);
    },
    getSettings() {
      return {
        audio: 'mic-1',
        video: '',
        resolution: null,
        blackboardMode: false,
        cameraOff: false,
      };
    },
    async removeFilter(c, options = {}) {
      calls.removeFilter.push(options);
      if (c.userdata.filter instanceof FilterStub) {
        c.userdata.sourceStream = c.userdata.filter.inputStream;
        c.stream = c.userdata.filter.inputStream;
        c.userdata.filter = null;
      }
    },
    async setFilter(c) {
      calls.setFilter.push(c.localId);
      const source = c.userdata.sourceStream || c.stream;
      if (c.userdata.filterDefinition && context.hasVideoTrack(source)) {
        const output = new FakeStream([
          ...source.getAudioTracks(),
          new FakeTrack('video', 'filtered-video'),
        ]);
        const filter = new FilterStub();
        filter.inputStream = source;
        filter.outputStream = output;
        c.userdata.filter = filter;
        c.stream = output;
        return;
      }
      c.stream = source;
    },
  });

  const snippet = [
    extractFunction('buildAudioConstraints'),
    extractFunction('buildVideoConstraints'),
    extractFunction('hasActiveAudioTrack'),
    extractFunction('hasActivePresentationTracks'),
    extractFunction('getCameraSourceStream'),
    extractFunction('stopCameraTrackInSession'),
    extractFunction('startCameraTrackInSession'),
    'this.__exports = {',
      '  stopCameraTrackInSession,',
      '  startCameraTrackInSession,',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    calls,
    makeCamera({ withVideo, withAudio = true, withFilter = false }) {
      const tracks = [];
      if (withAudio) {
        tracks.push(audioTrack);
      }
      if (withVideo) {
        tracks.push(liveVideoTrack);
      }
      const source = new FakeStream(tracks);
      const stream = withFilter && withVideo ?
        new FakeStream([audioTrack, new FakeTrack('video', 'filtered-video')]) :
        source;
      const userdata = {
        sourceStream: source,
        filterDefinition: withFilter ? {} : null,
      };
      if (withFilter && withVideo) {
        const filter = new FilterStub();
        filter.inputStream = source;
        filter.outputStream = stream;
        userdata.filter = filter;
      }
      return {
        localId: 'camera-1',
        stream,
        userdata,
      };
    },
  };
}

function buildReplacementUpStreamApi() {
  const calls = [];
  const context = vm.createContext({
    newUpStream(localId) {
      const stream = { localId, replace: null };
      calls.push(stream);
      return stream;
    },
  });

  const snippet = [
    extractFunction('createReplacementUpStream'),
    'this.__exports = { createReplacementUpStream };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    calls,
  };
}

function buildSyncContainerApi() {
  const context = vm.createContext({
    clearPeerPresentation() {},
  });

  const snippet = [
    extractFunction('syncContainerChildren'),
    'this.__exports = { syncContainerChildren };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildButtonsVisibilityApi() {
  const calls = {
    setVisibility: [],
    setLocalCameraOff: [],
    updateStageBadge: 0,
  };

  const context = vm.createContext({
    console,
    serverConnection: {
      socket: true,
      permissions: ['present'],
    },
    navigator: {
      mediaDevices: {
        getUserMedia() {},
        getDisplayMedia() {},
      },
    },
    RTCPeerConnection: function RTCPeerConnection() {},
    document: {
      getElementById(id) {
        if (id === 'sharebutton')
          return null;
        return { classList: makeClassList(), querySelector() { return null; } };
      },
    },
    findUpMedia() {
      return context.__cameraStream;
    },
    findUpMediaCalls: 0,
    getPeerCount() {
      return 0;
    },
    getSettings() {
      return { cameraOff: false };
    },
    hasVideoTrack(stream) {
      return !!(
        stream &&
        stream.getTracks().some(
          track => track.kind === 'video' && track.readyState !== 'ended',
        )
      );
    },
    setVisibility(id, visible) {
      calls.setVisibility.push([id, visible]);
    },
    setLocalCameraOff(value, reflect) {
      calls.setLocalCameraOff.push([value, reflect]);
    },
    updateStageBadge() {
      calls.updateStageBadge += 1;
    },
  });

  const snippet = [
    extractFunction('hasActiveAudioTrack'),
    extractFunction('hasActivePresentationTracks'),
    extractFunction('isActiveLocalPresentationStream'),
    extractFunction('setButtonsVisibility'),
    'this.__exports = {',
    '  setButtonsVisibility,',
    '  setCameraStream(value) { __cameraStream = value; },',
    '};',
  ].join('\n\n');

  context.__cameraStream = null;
  vm.runInContext(snippet, context);

  return {
    ...context.__exports,
    calls,
  };
}

function buildConferencePlaceholderStatusApi() {
  const context = vm.createContext({
    console,
    participantPresence: new Map(),
    getParticipantLiveStreamSummary() {
      return {};
    },
  });

  const snippet = [
    'let participantPresence = new Map();',
    extractFunction('getConferencePlaceholderStatus'),
    'this.__exports = { getConferencePlaceholderStatus };',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return context.__exports;
}

function buildReplaceCameraStreamApi() {
  const calls = {
    addLocalMedia: [],
  };

  const context = vm.createContext({
    __cameraStream: null,
    findUpMedia() {
      return context.__cameraStream;
    },
    addLocalMedia(localId) {
      calls.addLocalMedia.push(localId);
      return Promise.resolve(localId);
    },
    hasActiveAudioTrack(stream) {
      return !!(
        stream &&
        stream.getAudioTracks().some(track => track.readyState !== 'ended')
      );
    },
    hasVideoTrack(stream) {
      return !!(
        stream &&
        stream.getTracks().some(
          track => track.kind === 'video' && track.readyState !== 'ended',
        )
      );
    },
  });

  const snippet = [
    extractFunction('hasActivePresentationTracks'),
    extractFunction('isActiveLocalPresentationStream'),
    extractFunction('replaceCameraStream'),
    'this.__exports = {',
    '  replaceCameraStream,',
    '  setCameraStream(value) { __cameraStream = value; },',
    '};',
  ].join('\n\n');

  vm.runInContext(snippet, context);
  return {
    ...context.__exports,
    calls,
  };
}

class FakeContainerNode {
  constructor(id) {
    this.id = id;
    this.parentElement = null;
    this.children = [];
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  insertBefore(child, referenceNode) {
    if (!referenceNode) {
      return this.appendChild(child);
    }
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
    const index = this.children.indexOf(referenceNode);
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    child.parentElement = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
    }
    return child;
  }
}

class FakePeerNode extends FakeContainerNode {
  constructor(id) {
    super(id);
    this.classList = makeClassList();
    this.style = {
      removeProperty() {},
    };
  }

  get nextElementSibling() {
    if (!this.parentElement) {
      return null;
    }
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      return;
    }
    this.listeners.get(type).delete(listener);
  }

  emit(type, event = {}) {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }
}

class FakeTrack extends FakeEventTarget {
  constructor(kind, id, readyState = 'live') {
    super();
    this.kind = kind;
    this.id = id;
    this.readyState = readyState;
  }

  stop() {
    this.readyState = 'ended';
    this.emit('ended');
  }
}

class FakeStream extends FakeEventTarget {
  constructor(tracks = []) {
    super();
    this.tracks = [...tracks];
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter(track => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter(track => track.kind === 'video');
  }

  addTrack(track) {
    this.tracks.push(track);
    this.emit('addtrack', { track });
  }

  removeTrack(track) {
    this.tracks = this.tracks.filter(candidate => candidate !== track);
    this.emit('removetrack', { track });
  }
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

test('refreshLocalCameraUi forces a local media refresh and repairs self preview after camera restart', async () => {
  const api = buildRefreshLocalCameraUiApi();
  const stream = {
    signature: 'camera-track-v2',
    getTracks() {
      return [{ kind: 'video', readyState: 'live' }];
    },
  };
  const camera = {
    localId: 'camera-1',
    label: 'camera',
    up: true,
    stream,
    userdata: {
      boundMediaTrackSignature: 'camera-track-v1',
      boundMediaHadVideo: false,
    },
    setStream(next) {
      this.lastSetStream = next;
    },
  };

  api.refreshLocalCameraUi(camera);
  await Promise.resolve();

  assert.equal(camera.lastSetStream, stream);
  assert.deepEqual(api.calls.updatePeerVideoState, [['camera-1', 'peer-camera-1']]);
  assert.equal(api.calls.setLabel, 1);
  assert.deepEqual(api.calls.setMedia, [{
    localId: 'camera-1',
    mirror: true,
    forceReset: true,
  }]);
  assert.equal(api.calls.restoreLiveSelfPreviewPeer, 1);
  assert.equal(api.calls.scheduleConferenceLayout, 2);
  assert.equal(api.calls.setButtonsVisibility, 1);
});

test('stopCameraTrackInSession removes only the live video track and keeps camera session alive', async () => {
  const api = buildCameraToggleApi();
  const original = api.makeCamera({ withVideo: true });

  const ok = await api.stopCameraTrackInSession(original);

  assert.equal(ok, true);
  assert.deepEqual(api.calls.setLocalCameraOff, [[true, true]]);
  assert.deepEqual(api.calls.refreshLocalCameraUi, ['camera-1']);
  assert.deepEqual(api.calls.displayMessage, []);
  assert.equal(original.userdata.sourceStream.getVideoTracks().length, 0);
  assert.equal(api.calls.removeFilter.length, 0);
});

test('startCameraTrackInSession requests only a new video track and restores camera without replacement', async () => {
  const api = buildCameraToggleApi();
  const original = api.makeCamera({ withVideo: false });

  const ok = await api.startCameraTrackInSession(original);

  assert.equal(ok, true);
  assert.deepEqual(api.calls.setLocalCameraOff, [[false, true]]);
  assert.deepEqual(api.calls.refreshLocalCameraUi, ['camera-1']);
  assert.equal(api.calls.getUserMedia.length, 1);
  assert.equal(api.calls.getUserMedia[0].audio, false);
  assert.equal(original.userdata.sourceStream.getVideoTracks().length, 1);
});

test('stopCameraTrackInSession removes active filter before dropping source video', async () => {
  const api = buildCameraToggleApi();
  const original = api.makeCamera({ withVideo: true, withFilter: true });

  const ok = await api.stopCameraTrackInSession(original);

  assert.equal(ok, true);
  assert.equal(api.calls.removeFilter.length, 1);
  assert.equal(api.calls.removeFilter[0].suppressSync, true);
  assert.equal(original.userdata.sourceStream.getVideoTracks().length, 0);
});

test('createReplacementUpStream preserves replace id after local camera teardown', () => {
  const api = buildReplacementUpStreamApi();

  const replacement = api.createReplacementUpStream('camera-1', 'old-up-id');

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].localId, 'camera-1');
  assert.equal(replacement.replace, 'old-up-id');
});

test('syncContainerChildren removes stale peers that are no longer active', () => {
  const api = buildSyncContainerApi();
  const container = new FakeContainerNode('grid');
  const stale = new FakePeerNode('peer-stale');
  const activeA = new FakePeerNode('peer-a');
  const activeB = new FakePeerNode('peer-b');

  container.appendChild(stale);
  container.appendChild(activeA);
  container.appendChild(activeB);

  api.syncContainerChildren(container, [activeB, activeA]);

  assert.deepEqual(container.children.map(child => child.id), ['peer-b', 'peer-a']);
  assert.equal(stale.parentElement, null);
});

test('setButtonsVisibility hides camera controls when there is no active local camera stream', () => {
  const api = buildButtonsVisibilityApi();
  api.setCameraStream({
    label: 'camera',
    stream: new FakeStream([]),
  });

  api.setButtonsVisibility();

  assert.deepEqual(api.calls.setVisibility, [
    ['mutebutton', true],
    ['camerabutton', false],
    ['sharebutton', true],
    ['chatbutton', true],
    ['workspace-toggle-mobile', true],
    ['mediaoptions', true],
    ['sendform', true],
    ['simulcastform', true],
    ['inputform', true],
    ['inputbutton', true],
    ['no-media-message', false],
  ]);
  assert.deepEqual(api.calls.setLocalCameraOff, [[false, false]]);
  assert.equal(api.calls.updateStageBadge, 1);
});

test('getConferencePlaceholderStatus reports media off for an intentionally disabled camera session', () => {
  const api = buildConferencePlaceholderStatusApi();

  assert.equal(api.getConferencePlaceholderStatus({
    id: 'user-1',
    userinfo: {
      streams: {
        camera: {},
      },
    },
  }), 'Media off');
});

test('replaceCameraStream refreshes the local camera stream whenever it exists', async () => {
  const api = buildReplaceCameraStreamApi();
  api.setCameraStream({
    label: 'camera',
    localId: 'camera-1',
    stream: new FakeStream([]),
  });

  await api.replaceCameraStream();

  assert.deepEqual(api.calls.addLocalMedia, ['camera-1']);
});

test('downstream replace clears stale media and marks participant reconnecting', () => {
  const api = buildDownstreamLifecycleApi();
  const connection = {};
  const stream = {
    localId: 'down-1',
    source: 'user-1',
    username: 'alice',
    userdata: {},
    setStatsInterval(interval) {
      api.calls.statsIntervals.push(interval);
    },
  };

  api.setServerConnection(connection);
  api.gotDownStream.call(connection, stream);
  stream.onclose(true);

  assert.equal(api.calls.clearTransportRecovery, 1);
  assert.deepEqual(api.calls.delMedia, ['down-1']);
  assert.deepEqual(api.calls.refreshParticipantPresence, ['user-1']);
  assert.deepEqual(api.calls.renderParticipantRow, ['user-1']);
  assert.equal(api.participantStates.get('user-1').transientDisconnect, true);
  assert.equal(api.isExpectedDownstreamRecovery(stream), true);
  assert.deepEqual(api.calls.statsIntervals, [0]);
});

test('downstream track lifecycle forces media rebind when tracks change on the same stream', () => {
  const api = buildDownstreamLifecycleApi();
  const connection = {};
  const initialTrack = new FakeTrack('video', 'track-1');
  const replacementTrack = new FakeTrack('video', 'track-2');
  const mediaStream = new FakeStream([initialTrack]);
  const stream = {
    localId: 'down-2',
    source: 'user-2',
    username: 'bob',
    userdata: {},
    setStatsInterval() {},
  };

  api.setServerConnection(connection);
  api.gotDownStream.call(connection, stream);
  stream.ondowntrack(initialTrack, null, mediaStream);
  mediaStream.removeTrack(initialTrack);

  assert.equal(api.isExpectedDownstreamRecovery(stream), true);

  mediaStream.addTrack(replacementTrack);

  assert.equal(api.isExpectedDownstreamRecovery(stream), false);

  replacementTrack.readyState = 'ended';
  replacementTrack.emit('ended');

  assert.equal(api.isExpectedDownstreamRecovery(stream), true);
  assert.deepEqual(
    api.calls.setMedia.map(call => call.forceReset),
    [false, true, true, true, true],
  );
  assert.deepEqual(api.calls.refreshParticipantPresence, [
    'user-2',
    'user-2',
    'user-2',
  ]);
});

test('showHideMedia keeps remote camera peer visible for camera-off placeholder state', () => {
  const api = buildMediaStateApi();
  const peer = {
    classList: makeClassList(['peer-hidden']),
  };
  const stream = {
    getTracks() {
      return [{ kind: 'audio', readyState: 'live' }];
    },
  };

  api.showHideMedia({
    up: false,
    label: 'camera',
    localId: 'down-camera',
    stream,
  }, peer);

  assert.equal(peer.classList.contains('peer-hidden'), false);
  assert.equal(api.calls.scheduleConferenceLayout, 1);
});

test('setMediaStatus clears failed styling for remote camera without live video', () => {
  const api = buildMediaStateApi();
  const media = api.createMedia('down-camera', ['media-failed']);
  const stream = {
    getTracks() {
      return [{ kind: 'audio', readyState: 'live' }];
    },
  };

  api.setHealth('poor');
  api.setMediaStatus({
    localId: 'down-camera',
    up: false,
    label: 'camera',
    source: 'user-1',
    stream,
    pc: { iceConnectionState: 'failed' },
    userdata: {},
  });

  assert.equal(media.classList.contains('media-failed'), false);
  assert.deepEqual(api.calls.refreshParticipantPresence, ['user-1']);
});

test('downstream camera recreate decision triggers when live video returns', () => {
  const api = buildMediaStateApi();
  const media = api.createMedia('down-camera');

  assert.equal(
    api.shouldRecreateDownstreamCameraMedia(
      { up: false, label: 'camera' },
      media,
      false,
      true,
    ),
    true,
  );
  assert.equal(
    api.shouldRecreateDownstreamCameraMedia(
      { up: false, label: 'camera' },
      media,
      true,
      true,
    ),
    false,
  );
});
