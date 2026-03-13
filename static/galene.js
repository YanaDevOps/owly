// Copyright (c) 2026 yanix.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';
/* global rememberPersistentClientUsername, ensurePersistentClientIdForUsername */

/* global ServerConnection */

/**
 * The name of the group that we join.
 *
 * @type {string}
 */
let group;

/**
 * The connection to the server.
 *
 * @type {ServerConnection}
 */
let serverConnection;

/**
 * The group status.  This is set twice, once over HTTP in the start
 * function in order to obtain the WebSocket address, and a second time
 * after joining.
 *
 * @type {Object}
 */
let groupStatus = {};

/**
 * True if we need to request a password.
 *
 * type {boolean}
 */
let pwAuth = false;

/**
 * The token we use to login.  This is erased as soon as possible.
 *
 * @type {string}
 */
let token = null;

/**
 * The password used for login, stored for generating share links.
 *
 * @type {string}
 */
let loginPassword = null;

/**
 * Password extracted from URL, used to clean URL after successful join.
 *
 * @type {string|null}
 */
let passwordFromUrl = null;

/**
 * The state of the login automaton.
 *
 * @type {"probing" | "need-username" | "success"}
 */
let probingState = null;

/**
 * State stored for reconnection after connection loss.
 *
 * @type {Object}
 */
let reconnectState = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const reconnectMaxAttempts = 10;
const reconnectBaseDelay = 1000;
const reconnectCooldownMs = 10000;
let reconnectPending = false;
let reconnectCooldownUntil = 0;
let reconnectCooldownTimer = null;
let serverConnectPromise = null;
let overlayPanelOrder = 30;
let activeToolPanel = 'media';
let stagedLocalId = null;
let pinnedLocalId = null;
let previewFocusOnSelf = false;
let focusedConferenceLocalId = null;
let mobilePreviewSuppressClickUntil = 0;
let mobilePreviewDragState = null;
let mobilePreviewDragFrame = null;
let sharedScreenZoomState = {
    scale: 1,
    translateX: 0,
    translateY: 0,
};
let sharedScreenTouchState = null;
let sharedScreenZoomMediaLocalId = null;
const participantPresence = new Map();
const recentlyDeletedConferenceUsers = new Map();
const participantOfflineGracePeriod = 2000;
const participantConnectionPoorGracePeriod = 5000;
const streamUiHealth = new Map();
const mobilePreviewDragThreshold = 10;
const mobilePreviewCollapseThreshold = 28;
const mobilePreviewHandleWidth = 20;
const mobilePreviewBoundsPadding = 12;

/**
 * Whether login permissions have been granted. Intentionally unused.
 *
 * @type {boolean}
 */
let _loginPermissionsGranted = false;

/**
 * @typedef {Object} settings - the type of stored settings
 * @property {boolean} [localMute]
 * @property {string} [video]
 * @property {string} [audio]
 * @property {string} [audioOutput]
 * @property {string} [simulcast]
 * @property {string} [send]
 * @property {string} [request]
 * @property {boolean} [activityDetection]
 * @property {boolean} [displayAll]
 * @property {Array.<number>} [resolution]
 * @property {boolean} [mirrorView]
 * @property {boolean} [blackboardMode]
 * @property {string} [filter]
 * @property {boolean} [preprocessing]
 * @property {boolean} [hqaudio]
 * @property {boolean} [forceRelay]
 * @property {boolean} [activityDetectionConfigured]
 * @property {boolean} [chatParticipantsCollapsed]
 * @property {boolean} [cameraOff]
 * @property {'left'|'right'} [mobilePreviewSide]
 * @property {number|null} [mobilePreviewOffsetY]
 * @property {boolean} [mobilePreviewCollapsed]
 */

/**
 * fallbackSettings is used to store settings if session storage is not
 * available.
 *
 * @type{settings}
 */
let fallbackSettings = null;

/**
 * audioEnabled tracks whether user has interacted with the page.
 * After first interaction, downstream videos can be unmuted automatically.
 *
 * @type{boolean}
 */
let audioEnabled = false;
let audioOutputWarningShown = false;

const debugStorageKeys = ['owly_debug', 'galene_debug'];
const usernameStorageWriteKey = 'owly_username';
const usernameStorageReadKeys = ['owly_username', 'galene_username'];

function getStoredFlag(keys) {
    for (const key of keys) {
        try {
            const value = localStorage.getItem(key);
            if (value !== null)
                return value;
        } catch {
            return null;
        }
    }
    return null;
}

function getStoredUsername() {
    return getStoredFlag(usernameStorageReadKeys);
}

function setStoredUsername(username) {
    try {
        if (username) {
            localStorage.setItem(usernameStorageWriteKey, username);
            localStorage.removeItem('galene_username');
        } else {
            localStorage.removeItem(usernameStorageWriteKey);
        }
    } catch (e) {
        console.warn('Failed to persist username to localStorage:', e);
    }
}

const verboseRtcLogs = (() => {
    return getStoredFlag(debugStorageKeys) === '1';
})();

function debugLog(...args) {
    if (!verboseRtcLogs)
        return;
    console.log(...args);
}

function clearReconnectCooldownTimer() {
    if (!reconnectCooldownTimer)
        return;
    clearInterval(reconnectCooldownTimer);
    reconnectCooldownTimer = null;
}

function isReconnectCooldownActive() {
    return reconnectCooldownUntil > Date.now();
}

function updateReconnectCooldownUi() {
    const button = document.getElementById('connectbutton');
    if (!(button instanceof HTMLInputElement))
        return;

    if (!isReconnectCooldownActive()) {
        reconnectCooldownUntil = 0;
        clearReconnectCooldownTimer();
        button.disabled = false;
        button.value = 'Connect';
        return;
    }

    const remainingMs = Math.max(0, reconnectCooldownUntil - Date.now());
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    button.disabled = true;
    button.value = `Try again in ${remainingSeconds}s`;
}

function startReconnectCooldown(duration = reconnectCooldownMs) {
    reconnectCooldownUntil = Math.max(reconnectCooldownUntil, Date.now() + duration);
    updateReconnectCooldownUi();
    if (reconnectCooldownTimer)
        return;
    reconnectCooldownTimer = window.setInterval(() => {
        updateReconnectCooldownUi();
    }, 250);
}

function clearReconnectCooldown() {
    reconnectCooldownUntil = 0;
    updateReconnectCooldownUi();
}

/**
 * Overwrite settings with the parameter.  This uses session storage if
 * available, and the global variable fallbackSettings otherwise.
 *
 * @param {settings} settings
 */
function storeSettings(settings) {
    try {
        window.localStorage.setItem('settings', JSON.stringify(settings));
        fallbackSettings = null;
    } catch (e) {
        console.warn("Couldn't store settings:", e);
        fallbackSettings = settings;
    }
}

/**
 * Normalise persisted settings before the rest of the app reads them.
 * This lets us migrate old performance-sensitive defaults early, before
 * room startup triggers optional background/filter work.
 *
 * @param {settings} settings
 * @returns {{settings: settings, changed: boolean}}
 */
function normaliseSettings(settings) {
    const next = settings || {};
    let changed = false;

    if (!next.hasOwnProperty('performanceDefaultsVersion') ||
        next.performanceDefaultsVersion < 4) {
        if (!next.hasOwnProperty('activityDetectionUserSet')) {
            next.activityDetection = false;
            next.activityDetectionConfigured = true;
        }
        next.performanceDefaultsVersion = 4;
        changed = true;
    }

    // forceRelay was only ever a hidden/debug setting. If it leaks into
    // persisted settings on a deployment where relay is unhealthy, users can
    // end up stuck in a permanent "Connecting"/gray-video state. Clear it
    // unconditionally unless we ever reintroduce an explicit user-facing
    // control for it.
    if (next.forceRelay) {
        next.forceRelay = false;
        changed = true;
    }

    return {settings: next, changed};
}

/**
 * Return the current value of stored settings.  This always returns
 * a dictionary, even when there are no stored settings.
 *
 * @returns {settings}
 */
function getSettings() {
    /** @type {settings} */
    let settings;
    try {
        const json = window.localStorage.getItem('settings');
        settings = JSON.parse(json);
    } catch (e) {
        console.warn("Couldn't retrieve settings:", e);
        settings = fallbackSettings;
    }
    const normalised = normaliseSettings(settings || {});
    if (normalised.changed)
        storeSettings(normalised.settings);
    return normalised.settings;
}

/**
 * Update stored settings with the key/value pairs stored in the parameter.
 *
 * @param {settings} settings
 */
function updateSettings(settings) {
    const s = getSettings();
    for (const key in settings)
        s[key] = settings[key];
    storeSettings(s);
}

/**
 * Update a single key/value pair in the stored settings.
 *
 * @param {string} key
 * @param {any} value
 */
function updateSetting(key, value) {
    const s = {};
    s[key] = value;
    updateSettings(s);
}

/**
 * Remove a single key/value pair from the stored settings.
 *
 * @param {string} key
 */
function delSetting(key) {
    const s = getSettings();
    if (!(key in s))
        return;
    delete(s[key]);
    storeSettings(s);
}

function supportsAudioOutputSelection() {
    return typeof HTMLMediaElement !== 'undefined' &&
        typeof HTMLMediaElement.prototype.setSinkId === 'function';
}

function getDesiredAudioOutputId() {
    const settings = getSettings();
    return typeof settings.audioOutput === 'string' ? settings.audioOutput : '';
}

function reflectAudioOutputAvailability() {
    const row = document.getElementById('audiooutputrow');
    const hint = document.getElementById('audiooutputhint');
    const select = getSelectElement('audiooutputselect');
    const supported = supportsAudioOutputSelection();

    if (row)
        row.classList.toggle('audio-output-unsupported', !supported);
    select.disabled = !supported;
    if (!supported)
        select.value = '';
    if (hint)
        hint.classList.toggle('invisible', supported);
}

async function applyAudioOutputToMediaElement(media, sinkId, userInitiated) {
    if (!(media instanceof HTMLMediaElement) || !supportsAudioOutputSelection())
        return true;

    const nextSinkId = sinkId || '';
    if (media._sinkIdApplied === nextSinkId)
        return true;

    try {
        await media.setSinkId(nextSinkId);
        media._sinkIdApplied = nextSinkId;
        return true;
    } catch (e) {
        media._sinkIdApplied = undefined;
        console.warn('Failed to switch audio output:', e);
        if (userInitiated && !audioOutputWarningShown) {
            audioOutputWarningShown = true;
            displayWarning('This browser could not switch the audio output device.');
        }
        return false;
    }
}

async function applyAudioOutputToCurrentMedia(userInitiated) {
    if (!supportsAudioOutputSelection())
        return;
    const sinkId = getDesiredAudioOutputId();
    const mediaElements = Array.from(document.querySelectorAll('video.media'));
    await Promise.all(mediaElements.map(media =>
        applyAudioOutputToMediaElement(media, sinkId, !!userInitiated),
    ));
}

/**
 * getElementById, then assert that the result is an HTMLSelectElement.
 *
 * @param {string} id
 */
function getSelectElement(id) {
    const elt = document.getElementById(id);
    if (!elt || !(elt instanceof HTMLSelectElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * getElementById, then assert that the result is an HTMLInputElement.
 *
 * @param {string} id
 */
function getInputElement(id) {
    const elt = document.getElementById(id);
    if (!elt || !(elt instanceof HTMLInputElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * getElementById, then assert that the result is an HTMLButtonElement.
 *
 * @param {string} id
 */
function getButtonElement(id) {
    const elt = document.getElementById(id);
    if (!elt || !(elt instanceof HTMLButtonElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * Ensure that the UI reflects the stored settings.
 */
function reflectSettings() {
    const settings = getSettings();
    let store = false;
    const performanceProfile = getPerformanceProfile();

    setLocalMute(settings.localMute);
    if (settings.hasOwnProperty('cameraOff')) {
        setLocalCameraOff(!!settings.cameraOff, false);
    } else {
        settings.cameraOff = false;
        setLocalCameraOff(false, false);
        store = true;
    }

    const videoselect = getSelectElement('videoselect');
    if (!settings.hasOwnProperty('video') ||
       !selectOptionAvailable(videoselect, settings.video)) {
        // Prefer front camera if available
        if (window.frontCameraDeviceId && selectOptionAvailable(videoselect, window.frontCameraDeviceId)) {
            settings.video = window.frontCameraDeviceId;
        } else {
            settings.video = selectOptionDefault(videoselect);
        }
        store = true;
    }
    videoselect.value = settings.video;

    const audioselect = getSelectElement('audioselect');
    if (!settings.hasOwnProperty('audio') ||
       !selectOptionAvailable(audioselect, settings.audio)) {
        settings.audio = selectOptionDefault(audioselect);
        store = true;
    }
    audioselect.value = settings.audio;

    const audiooutputselect = getSelectElement('audiooutputselect');
    if (supportsAudioOutputSelection()) {
        if (!settings.hasOwnProperty('audioOutput') ||
           !selectOptionAvailable(audiooutputselect, settings.audioOutput)) {
            settings.audioOutput = '';
            store = true;
        }
        audiooutputselect.value = settings.audioOutput;
    } else {
        audiooutputselect.value = '';
    }
    reflectAudioOutputAvailability();

    if (settings.hasOwnProperty('filter')) {
        getSelectElement('filterselect').value =
            getRestoredFilterValue(settings.filter);
    } else {
        // Use the default value from the select element
        const filterselect = getSelectElement('filterselect');
        const s = filterselect.value;
        if (s) {
            settings.filter = s;
            store = true;
        }
    }

    // Show/hide background controls based on filter selection
    const bgControls = document.getElementById('background-image-controls');
    if (bgControls) {
        const filterValue = getSelectElement('filterselect').value;
        if (filterValue === 'background-replace') {
            bgControls.classList.remove('invisible');
        } else {
            bgControls.classList.add('invisible');
        }
    }

    if (settings.hasOwnProperty('request')) {
        getSelectElement('requestselect').value = settings.request;
    } else {
        settings.request = getSelectElement('requestselect').value;
        store = true;
    }

    if (settings.hasOwnProperty('send')) {
        getSelectElement('sendselect').value = settings.send;
    } else {
        settings.send = getSelectElement('sendselect').value;
        store = true;
    }

    if (settings.hasOwnProperty('simulcast')) {
        getSelectElement('simulcastselect').value = settings.simulcast;
    } else {
        settings.simulcast = getSelectElement('simulcastselect').value;
        store = true;
    }

    if (settings.hasOwnProperty('blackboardMode')) {
        getInputElement('blackboardbox').checked = settings.blackboardMode;
    } else {
        settings.blackboardMode = getInputElement('blackboardbox').checked;
        store = true;
    }

    if (settings.hasOwnProperty('mirrorView')) {
        getInputElement('mirrorbox').checked = settings.mirrorView;
    } else {
        settings.mirrorView = getInputElement('mirrorbox').checked;
        store = true;
    }

    if (settings.hasOwnProperty('activityDetectionConfigured')) {
        getInputElement('activitybox').checked = settings.activityDetection;
    } else {
        getInputElement('activitybox').checked = performanceProfile === 'desktop';
        settings.activityDetection = performanceProfile === 'desktop';
        settings.activityDetectionConfigured = true;
        store = true;
    }

    if (settings.hasOwnProperty('displayAll')) {
        getInputElement('displayallbox').checked = settings.displayAll;
    } else {
        // Firefox: Enable displayAll by default to ensure downstream videos are visible
        if (isFirefox()) {
            getInputElement('displayallbox').checked = true;
            console.log('[reflectSettings] Firefox: Enabled displayAll by default');
        }
        settings.displayAll = getInputElement('displayallbox').checked;
        store = true;
    }

    if (settings.hasOwnProperty('preprocessing')) {
        getInputElement('preprocessingbox').checked = settings.preprocessing;
    } else {
        settings.preprocessing = getInputElement('preprocessingbox').checked;
        store = true;
    }

    if (settings.hasOwnProperty('hqaudio')) {
        getInputElement('hqaudiobox').checked = settings.hqaudio;
    } else {
        settings.hqaudio = getInputElement('hqaudiobox').checked;
        store = true;
    }

    if (settings.hasOwnProperty('chatParticipantsCollapsed')) {
        setParticipantsCollapsed(!!settings.chatParticipantsCollapsed, false);
    } else {
        settings.chatParticipantsCollapsed = true;
        setParticipantsCollapsed(true, false);
        store = true;
    }

    if (store)
        storeSettings(settings);
}

/**
 * Returns true if we should use the mobile layout.  This should be kept
 * in sync with the CSS.
 */
function isMobileLayout() {
    return !!window.matchMedia('only screen and (max-width: 1024px)').matches;
}

function isMobileBurgerLayout() {
    return !!window.matchMedia('only screen and (max-width: 900px)').matches;
}

function isLikelyMobileDevice() {
    const ua = navigator.userAgent.toLowerCase();
    return /android|iphone|ipad|ipod|mobile/.test(ua);
}

function isIOSDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function getHardwareConcurrency() {
    return navigator.hardwareConcurrency || 0;
}

function getDeviceMemory() {
    return navigator.deviceMemory || 0;
}

function getPerformanceProfile() {
    if (!isLikelyMobileDevice())
        return 'desktop';
    if (isOldSafari())
        return 'low-power-mobile';
    const cores = getHardwareConcurrency();
    const memory = getDeviceMemory();
    if ((cores && cores <= 4) || (memory && memory <= 4))
        return 'low-power-mobile';
    if (isIOSDevice() && cores && cores <= 6)
        return 'low-power-mobile';
    return 'mobile';
}

function shouldUseReducedChromeEffects() {
    return getPerformanceProfile() !== 'desktop';
}

function shouldRelayoutForPanelToggle() {
    return !isMobileBurgerLayout();
}

function applyPerformanceProfileChrome() {
    const root = document.documentElement;
    const profile = getPerformanceProfile();
    root.classList.toggle('reduced-chrome-effects', shouldUseReducedChromeEffects());
    root.classList.toggle('low-power-mobile-effects', profile === 'low-power-mobile');
}

function getAdaptiveMaxFrameRate() {
    return 0;
}

function getActivityDetectionInterval() {
    switch (getPerformanceProfile()) {
    case 'mobile':
        return 1000;
    case 'low-power-mobile':
        return 1500;
    default:
        return 500;
    }
}

function getActivityDetectionPeriod() {
    switch (getPerformanceProfile()) {
    case 'mobile':
        return 1800;
    case 'low-power-mobile':
        return 2200;
    default:
        return 1200;
    }
}

function shouldRunActivityDetection() {
    const activityBox = document.getElementById('activitybox');
    if (!(activityBox instanceof HTMLInputElement))
        return false;
    if (!activityBox.checked || document.visibilityState !== 'visible')
        return false;
    if (!serverConnection || !serverConnection.down)
        return false;
    return Object.values(serverConnection.down).some(stream => !!stream);
}

function shouldCollectUpstreamStats() {
    return false;
}

function getFilterFrameRate(baseFrameRate) {
    return baseFrameRate || 30;
}

function scheduleIdleTask(fn, timeout = 300) {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => fn(), {timeout});
        return;
    }
    window.setTimeout(fn, 0);
}

function getAllStreams() {
    if (!serverConnection)
        return [];
    return [
        ...Object.values(serverConnection.up || {}),
        ...Object.values(serverConnection.down || {}),
    ];
}

/**
 * @param {user} userinfo
 * @returns {user}
 */
function snapshotUserInfo(userinfo) {
    const streams = {};
    if (userinfo && userinfo.streams) {
        for (const label in userinfo.streams)
            streams[label] = {...userinfo.streams[label]};
    }
    return {
        username: (userinfo && userinfo.username) || '',
        permissions: (userinfo && userinfo.permissions) ? [...userinfo.permissions] : [],
        data: (userinfo && userinfo.data) ? {...userinfo.data} : {},
        streams: streams,
    };
}

function getOrCreateParticipantState(id) {
    let state = participantPresence.get(id);
    if (!state) {
        state = {
            id: id,
            username: '',
            userinfo: null,
            offline: false,
            offlineSince: null,
            removeTimer: null,
            connectionStatus: 'online',
            speaking: false,
            hasAudio: false,
        };
        participantPresence.set(id, state);
    }
    return state;
}

function getOrCreateStreamUiHealth(localId) {
    let state = streamUiHealth.get(localId);
    if (!state) {
        state = {
            lastConnectedAt: 0,
            disconnectedSince: 0,
            graceTimer: null,
        };
        streamUiHealth.set(localId, state);
    }
    return state;
}

function clearStreamUiHealthTimer(state) {
    if (!state || !state.graceTimer)
        return;
    clearTimeout(state.graceTimer);
    state.graceTimer = null;
}

function forgetStreamUiHealth(localId) {
    if (!localId)
        return;
    const state = streamUiHealth.get(localId);
    if (!state)
        return;
    clearStreamUiHealthTimer(state);
    streamUiHealth.delete(localId);
}

function scheduleStreamUiGraceRefresh(c, delay) {
    if (!c || !c.localId)
        return;
    const state = getOrCreateStreamUiHealth(c.localId);
    if (state.graceTimer)
        return;
    state.graceTimer = setTimeout(() => {
        state.graceTimer = null;
        setMediaStatus(c);
    }, delay);
}

function getStreamConnectionHealth(c) {
    if (!c || !c.localId)
        return 'unknown';

    const iceState = c.pc && c.pc.iceConnectionState;
    const state = getOrCreateStreamUiHealth(c.localId);
    const now = Date.now();

    if (iceState === 'connected' || iceState === 'completed') {
        state.lastConnectedAt = now;
        state.disconnectedSince = 0;
        clearStreamUiHealthTimer(state);
        return 'healthy';
    }

    if (iceState === 'failed') {
        clearStreamUiHealthTimer(state);
        return 'poor';
    }

    if (iceState === 'disconnected') {
        if (!state.disconnectedSince)
            state.disconnectedSince = now;
        const elapsed = now - state.disconnectedSince;
        if (elapsed >= participantConnectionPoorGracePeriod) {
            clearStreamUiHealthTimer(state);
            return 'poor';
        }
        scheduleStreamUiGraceRefresh(c, participantConnectionPoorGracePeriod - elapsed);
        return state.lastConnectedAt ? 'healthy' : 'unknown';
    }

    clearStreamUiHealthTimer(state);
    state.disconnectedSince = 0;
    return state.lastConnectedAt ? 'healthy' : 'unknown';
}

function clearParticipantRemovalTimer(state) {
    if (!state || !state.removeTimer)
        return;
    clearTimeout(state.removeTimer);
    state.removeTimer = null;
}

function clearParticipantPresence() {
    for (const state of participantPresence.values())
        clearParticipantRemovalTimer(state);
    participantPresence.clear();
    recentlyDeletedConferenceUsers.clear();
    for (const state of streamUiHealth.values())
        clearStreamUiHealthTimer(state);
    streamUiHealth.clear();
    const div = document.getElementById('users');
    if (div)
        div.textContent = '';
    updateParticipantsHeader();
}

function getStreamUserId(c) {
    if (!c)
        return null;
    if (c.up)
        return c.sc ? c.sc.id : null;
    return c.source || null;
}

function pruneRecentlyDeletedConferenceUsers() {
    const now = Date.now();
    for (const [id, deletedAt] of recentlyDeletedConferenceUsers) {
        if (now - deletedAt > 15000)
            recentlyDeletedConferenceUsers.delete(id);
    }
}

function markConferenceUserDeleted(id) {
    if (!id)
        return;
    pruneRecentlyDeletedConferenceUsers();
    recentlyDeletedConferenceUsers.set(id, Date.now());
}

function clearConferenceUserDeleted(id) {
    if (!id)
        return;
    recentlyDeletedConferenceUsers.delete(id);
}

function isConferenceUserRecentlyDeleted(id) {
    if (!id)
        return false;
    pruneRecentlyDeletedConferenceUsers();
    return recentlyDeletedConferenceUsers.has(id);
}

function removeConferenceArtifactsForUser(id) {
    if (!id)
        return;

    const placeholder = document.getElementById(getConferencePlaceholderId(id));
    if (placeholder)
        placeholder.remove();

    for (const stream of getUserStreams(id)) {
        if (!stream)
            continue;
        delMedia(stream.localId);
    }
}

function clearConferenceUi() {
    focusedConferenceLocalId = null;
    stagedLocalId = null;
    pinnedLocalId = null;
    previewFocusOnSelf = false;
    conferenceLayoutKey = '';

    const stageSlot = getStageSlot();
    const grid = getMosaicGrid();
    const strip = getParticipantStrip();
    const selfPreviewSlot = getSelfPreviewSlot();

    syncContainerChildren(stageSlot, []);
    syncContainerChildren(grid, []);
    syncContainerChildren(strip, []);
    setSelfPreviewPeer(selfPreviewSlot, null);
    setVisibility('stage-empty', false);

    for (const peer of document.querySelectorAll('[id^="conference-placeholder-"], [id^="peer-"]')) {
        if (peer instanceof HTMLElement)
            peer.remove();
    }
}

function getUserStreams(id) {
    if (!id)
        return [];
    return getAllStreams().filter(c => getStreamUserId(c) === id);
}

function isParticipantSpeaking(id, state) {
    if (state && state.offline)
        return false;
    const now = Date.now();
    return getUserStreams(id).some(c => {
        const last = c.userdata && c.userdata.lastVoiceActivity;
        return !!(c.userdata && c.userdata.active) ||
            !!(last && now - last <= getActivityDetectionPeriod());
    });
}

function participantHasAudio(id, state) {
    if (state && state.offline)
        return !!state.hasAudio;
    const userinfo =
        (serverConnection && serverConnection.users && serverConnection.users[id]) ||
        (state && state.userinfo);
    if (userinfo && userinfo.streams) {
        for (const stream of Object.values(userinfo.streams)) {
            if (stream && stream.audio)
                return true;
        }
    }
    return getUserStreams(id).some(c =>
        !!(c.stream && c.stream.getTracks().some(t => t.kind === 'audio')),
    );
}

function getParticipantConnectionStatus(id, state) {
    if (state && state.offline)
        return 'offline';

    let healthy = false;
    let poor = false;
    for (const c of getUserStreams(id)) {
        const health = getStreamConnectionHealth(c);
        if (health === 'healthy')
            healthy = true;
        else if (health === 'poor')
            poor = true;
    }

    if (healthy)
        return 'online';
    if (poor)
        return 'poor';
    return 'online';
}

function ensureUserElement(id) {
    let user = document.getElementById('user-' + id);
    if (user)
        return user;

    user = document.createElement('div');
    user.id = 'user-' + id;
    user.classList.add('user-p');
    const presence = document.createElement('span');
    presence.classList.add('user-presence');
    const name = document.createElement('span');
    name.classList.add('user-name');
    const audio = document.createElement('span');
    audio.classList.add('user-audio-icon');
    user.appendChild(presence);
    user.appendChild(name);
    user.appendChild(audio);
    return user;
}

function placeUserElement(user, id, username, stale) {
    const div = document.getElementById('users');
    if (!div || !user)
        return;

    const children = Array.from(div.children).filter(child => child !== user);
    let before = null;

    if (!stale) {
        if (serverConnection && id === serverConnection.id) {
            before = children[0] || null;
        } else {
            for (const child of children) {
                if (!(child instanceof HTMLElement))
                    continue;
                const childId = child.id.slice('user-'.length);
                if (serverConnection && childId === serverConnection.id)
                    continue;
                if (child.classList.contains('user-status-stale')) {
                    before = child;
                    break;
                }

                const childState = participantPresence.get(childId);
                const childUsername =
                    (childState && childState.username) ||
                    (serverConnection && serverConnection.users[childId] &&
                     serverConnection.users[childId].username) ||
                    '';

                if (!childUsername || stringCompare(childUsername, username) > 0) {
                    before = child;
                    break;
                }
            }
        }
    }

    if (user.parentElement === div)
        div.removeChild(user);

    if (before)
        div.insertBefore(user, before);
    else
        div.appendChild(user);
}

function removeUserRow(id, removeState) {
    const user = document.getElementById('user-' + id);
    if (user && user.parentElement)
        user.parentElement.removeChild(user);
    if (removeState) {
        const state = participantPresence.get(id);
        if (state)
            clearParticipantRemovalTimer(state);
        participantPresence.delete(id);
    }
    updateParticipantsHeader();
}

function renderParticipantRow(id) {
    const state = participantPresence.get(id);
    const liveUser =
        serverConnection && serverConnection.users ?
            serverConnection.users[id] :
            null;
    const userinfo = liveUser || (state && state.userinfo);
    if (!userinfo)
        return;

    const user = ensureUserElement(id);
    const username = userinfo.username ? userinfo.username : '(anon)';
    user.title = username;
    const name = user.querySelector('.user-name');
    const audio = user.querySelector('.user-audio-icon');
    if (name)
        name.textContent = username;

    const connectionStatus = (state && state.connectionStatus) || 'online';
    const hasAudio = state ? state.hasAudio : false;
    const speaking = !!(state && state.speaking);
    const stale = !!(state && state.offline);
    const raisedHand = !!(userinfo.data && userinfo.data.raisehand);
    const muted = !!(userinfo.data && userinfo.data.muted);
    const showMic = hasAudio && !muted;

    user.classList.toggle('user-status-online', connectionStatus === 'online');
    user.classList.toggle('user-status-poor', connectionStatus === 'poor');
    user.classList.toggle('user-status-offline', connectionStatus === 'offline');
    user.classList.toggle('user-status-stale', stale);
    user.classList.toggle('user-status-speaking', speaking);
    user.classList.toggle('user-status-raisehand', raisedHand);
    user.classList.toggle('user-status-microphone', showMic);
    user.classList.toggle('user-status-microphone-muted', !showMic);
    if (audio)
        audio.innerHTML =
            `<i class="fas ${showMic ? 'fa-microphone' : 'fa-microphone-slash'}" aria-hidden="true"></i>`;

    placeUserElement(user, id, username, stale);
    updateParticipantsHeader();
}

function refreshParticipantPresence(id, userinfo) {
    if (!id)
        return;

    const state = getOrCreateParticipantState(id);
    const liveUser =
        userinfo ||
        (serverConnection && serverConnection.users ? serverConnection.users[id] : null);

    if (liveUser) {
        state.userinfo = snapshotUserInfo(liveUser);
        state.username = liveUser.username || state.username || '(anon)';
        state.offline = false;
        state.offlineSince = null;
        clearParticipantRemovalTimer(state);
    } else if (!state.userinfo) {
        return;
    }

    state.connectionStatus = getParticipantConnectionStatus(id, state);
    state.hasAudio = participantHasAudio(id, state);
    state.speaking = isParticipantSpeaking(id, state);
    renderParticipantRow(id);
}

function markParticipantOffline(id) {
    const state = participantPresence.get(id);
    if (!state || !state.userinfo) {
        removeUserRow(id, true);
        return;
    }

    clearParticipantRemovalTimer(state);
    state.offline = true;
    state.offlineSince = Date.now();
    state.connectionStatus = 'offline';
    state.speaking = false;
    renderParticipantRow(id);

    state.removeTimer = setTimeout(() => {
        removeUserRow(id, true);
    }, participantOfflineGracePeriod);
}

function getPeerElements() {
    return Array.from(document.querySelectorAll('[id^="peer-"]'));
}

function getPeerCount() {
    return getPeerElements().length;
}

function getPeer(localId) {
    return document.getElementById('peer-' + localId);
}

function getStageSlot() {
    return document.getElementById('stage-slot');
}

function getConferenceGridHost() {
    return document.getElementById('conference-grid-host');
}

function getMosaicGrid() {
    return document.getElementById('mosaic-grid');
}

function getParticipantStrip() {
    return document.getElementById('peers');
}

function getVideoContainer() {
    return document.getElementById('video-container');
}

function getSelfPreviewSlot() {
    return document.getElementById('self-preview-slot');
}

function getSelfPreviewPeerElement(slot) {
    if (!slot)
        return null;
    return Array.from(slot.children).find(child =>
        child instanceof HTMLElement &&
        child.id &&
        (child.id.startsWith('peer-') ||
         child.id.startsWith('conference-placeholder-')),
    ) || null;
}

function getMobilePreviewPreferences() {
    const settings = getSettings();
    return {
        side: settings.mobilePreviewSide === 'left' ? 'left' : 'right',
        offsetY: Number.isFinite(settings.mobilePreviewOffsetY) ?
            settings.mobilePreviewOffsetY :
            null,
        hasCustomPosition: !!settings.mobilePreviewHasCustomPosition,
        collapsed: !!settings.mobilePreviewCollapsed,
    };
}

function persistMobilePreviewPreferences(preferences) {
    updateSettings({
        mobilePreviewSide: preferences.side,
        mobilePreviewOffsetY: Number.isFinite(preferences.offsetY) ?
            Math.round(preferences.offsetY) :
            null,
        mobilePreviewHasCustomPosition: !!preferences.hasCustomPosition,
        mobilePreviewCollapsed: !!preferences.collapsed,
    });
}

function isMobilePreviewInteractive(slot) {
    return !!(
        slot &&
        isMobileBurgerLayout() &&
        !slot.classList.contains('invisible')
    );
}

function getMobilePreviewBounds(slot) {
    const container =
        slot && (slot.closest('.conference-stage') || slot.closest('.video-container'));
    if (!(container instanceof HTMLElement) || !slot)
        return null;

    const containerRect = container.getBoundingClientRect();
    const controls = getStageLocalControls();
    const controlsRect =
        controls && !controls.classList.contains('invisible') ?
            controls.getBoundingClientRect() :
            null;
    const previewHeight = slot.offsetHeight || Math.round(slot.offsetWidth * (4 / 3)) || 120;
    const headerGap = mobilePreviewBoundsPadding;
    const topMin = Math.max(headerGap, 0);
    const defaultBottomGap = controlsRect ?
        Math.max(
            mobilePreviewBoundsPadding,
            containerRect.bottom - controlsRect.top + mobilePreviewBoundsPadding,
        ) :
        88;
    const maxTop = Math.max(
        topMin,
        containerRect.height - previewHeight - defaultBottomGap,
    );

    return {
        container: container,
        topMin: topMin,
        maxTop: maxTop,
        defaultTop: maxTop,
    };
}

function clampMobilePreviewOffsetY(slot, offsetY) {
    const bounds = getMobilePreviewBounds(slot);
    if (!bounds)
        return 0;
    const rawOffset = Number.isFinite(offsetY) ? offsetY : bounds.defaultTop;
    return Math.min(bounds.maxTop, Math.max(bounds.topMin, rawOffset));
}

function updateSelfPreviewHandle(slot) {
    if (!slot)
        return;
    const handle = slot.querySelector('.self-preview-handle');
    if (!(handle instanceof HTMLButtonElement))
        return;

    const icon = handle.querySelector('i');
    const collapsed = slot.classList.contains('preview-collapsed');
    const left = slot.classList.contains('preview-side-left');
    const iconClass = collapsed ?
        (left ? 'fa-chevron-right' : 'fa-chevron-left') :
        (left ? 'fa-chevron-left' : 'fa-chevron-right');

    if (icon instanceof HTMLElement)
        icon.className = `fas ${iconClass}`;

    handle.setAttribute(
        'aria-label',
        collapsed ? 'Expand self preview' : 'Collapse self preview',
    );
}

function startMobilePreviewDrag(slot, event, collapsedOrigin = false) {
    if (!isMobilePreviewInteractive(slot))
        return false;

    const bounds = getMobilePreviewBounds(slot);
    if (!bounds)
        return false;

    const prefs = getMobilePreviewPreferences();
    const originTop = prefs.hasCustomPosition ?
        clampMobilePreviewOffsetY(slot, prefs.offsetY) :
        bounds.defaultTop;
    const originRect = slot.getBoundingClientRect();

    mobilePreviewDragState = {
        slot: slot,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        pendingDx: 0,
        pendingDy: 0,
        lastDx: 0,
        lastDy: 0,
        originTop: originTop,
        originRect: originRect,
        bounds: bounds,
        initialSide: prefs.side,
        moved: false,
        collapsedOrigin: collapsedOrigin,
    };
    slot.classList.add('preview-dragging');
    slot.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    return true;
}

function applyMobilePreviewState(slot, persist = false) {
    if (!slot)
        return;

    if (!isMobilePreviewInteractive(slot)) {
        slot.classList.remove(
            'preview-side-left',
            'preview-side-right',
            'preview-docked',
            'preview-custom-position',
            'preview-collapsed',
            'preview-dragging',
        );
        slot.style.removeProperty('--self-preview-top');
        slot.style.removeProperty('transform');
        updateSelfPreviewHandle(slot);
        return;
    }

    const preferences = getMobilePreviewPreferences();
    const top = preferences.hasCustomPosition ?
        clampMobilePreviewOffsetY(slot, preferences.offsetY) :
        null;
    slot.classList.toggle('preview-side-left', preferences.side === 'left');
    slot.classList.toggle('preview-side-right', preferences.side !== 'left');
    slot.classList.toggle('preview-docked', !preferences.hasCustomPosition);
    slot.classList.toggle('preview-custom-position', !!preferences.hasCustomPosition);
    slot.classList.toggle('preview-collapsed', !!preferences.collapsed);
    if (preferences.hasCustomPosition && Number.isFinite(top))
        slot.style.setProperty('--self-preview-top', `${Math.round(top)}px`);
    else
        slot.style.removeProperty('--self-preview-top');
    slot.style.removeProperty('transform');
    updateSelfPreviewHandle(slot);

    if (persist && preferences.hasCustomPosition &&
        Number.isFinite(top) && top !== preferences.offsetY) {
        persistMobilePreviewPreferences({
            side: preferences.side,
            offsetY: top,
            hasCustomPosition: true,
            collapsed: preferences.collapsed,
        });
    }
}

function toggleMobilePreviewCollapsed(force) {
    const slot = getSelfPreviewSlot();
    if (!isMobilePreviewInteractive(slot))
        return;
    const preferences = getMobilePreviewPreferences();
    const nextCollapsed =
        typeof force === 'boolean' ? force : !preferences.collapsed;
    persistMobilePreviewPreferences({
        side: preferences.side,
        offsetY: preferences.hasCustomPosition ?
            clampMobilePreviewOffsetY(slot, preferences.offsetY) :
            null,
        hasCustomPosition: preferences.hasCustomPosition,
        collapsed: nextCollapsed,
    });
    applyMobilePreviewState(slot, false);
    if (!nextCollapsed)
        restoreLiveSelfPreviewPeer(slot);
}

function finishMobilePreviewDrag(commit) {
    const state = mobilePreviewDragState;
    if (!state)
        return;

    const slot = state.slot;
    if (mobilePreviewDragFrame) {
        cancelAnimationFrame(mobilePreviewDragFrame);
        mobilePreviewDragFrame = null;
    }

    if (commit) {
        const totalDx = state.lastDx;
        const totalDy = state.lastDy;
        const collapse = state.collapsedOrigin ? true :
            (state.initialSide === 'left' ?
                totalDx < -mobilePreviewCollapseThreshold :
                totalDx > mobilePreviewCollapseThreshold);
        const nextSide =
            state.originRect.left + totalDx + state.originRect.width / 2 <
            state.bounds.container.getBoundingClientRect().left +
                state.bounds.container.getBoundingClientRect().width / 2 ?
                'left' :
                'right';
        const nextTop = clampMobilePreviewOffsetY(
            slot,
            state.originTop + totalDy,
        );

        persistMobilePreviewPreferences({
            side: nextSide,
            offsetY: nextTop,
            hasCustomPosition: state.moved,
            collapsed: collapse,
        });

        if (state.moved) {
            mobilePreviewSuppressClickUntil = performance.now() + 320;
        }
    }

    slot.style.removeProperty('transform');
    slot.classList.remove('preview-dragging');
    if (state.pointerId !== null && slot.hasPointerCapture?.(state.pointerId))
        slot.releasePointerCapture(state.pointerId);
    mobilePreviewDragState = null;
    applyMobilePreviewState(slot, false);
}

function queueMobilePreviewDragFrame() {
    if (!mobilePreviewDragState || mobilePreviewDragFrame)
        return;
    mobilePreviewDragFrame = requestAnimationFrame(() => {
        mobilePreviewDragFrame = null;
        const state = mobilePreviewDragState;
        if (!state)
            return;
        state.lastDx = state.pendingDx;
        state.lastDy = state.pendingDy;
        state.moved = state.moved ||
            Math.abs(state.lastDx) >= mobilePreviewDragThreshold ||
            Math.abs(state.lastDy) >= mobilePreviewDragThreshold;
        state.slot.style.transform =
            `translate3d(${state.lastDx}px, ${state.lastDy}px, 0)`;
    });
}

function ensureMobilePreviewInteractivity(slot) {
    if (!slot || slot.dataset.previewInteractiveBound === 'true')
        return;

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'self-preview-handle';
    handle.setAttribute('aria-label', 'Collapse self preview');
    handle.innerHTML = '<i class="fas fa-chevron-right" aria-hidden="true"></i>';
    handle.addEventListener('pointerdown', event => {
        event.stopPropagation();
        if (slot.classList.contains('preview-collapsed'))
            startMobilePreviewDrag(slot, event, true);
    });
    handle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() < mobilePreviewSuppressClickUntil)
            return;
        toggleMobilePreviewCollapsed();
    });
    slot.appendChild(handle);

    slot.addEventListener('pointerdown', event => {
        if (!isMobilePreviewInteractive(slot))
            return;
        if (!(event.target instanceof HTMLElement))
            return;
        if (event.target.closest('.self-preview-handle'))
            return;
        if (slot.classList.contains('preview-collapsed'))
            return;

        startMobilePreviewDrag(slot, event, false);
    });

    slot.addEventListener('pointermove', event => {
        const state = mobilePreviewDragState;
        if (!state || state.slot !== slot || event.pointerId !== state.pointerId)
            return;
        const nextDx = event.clientX - state.startX;
        const desiredTop = state.originTop + (event.clientY - state.startY);
        const clampedTop = clampMobilePreviewOffsetY(slot, desiredTop);
        state.pendingDx = nextDx;
        state.pendingDy = clampedTop - state.originTop;
        queueMobilePreviewDragFrame();
    });

    const stopDrag = event => {
        const state = mobilePreviewDragState;
        if (!state || state.slot !== slot)
            return;
        if (event && event.pointerId !== state.pointerId)
            return;
        finishMobilePreviewDrag(true);
    };

    slot.addEventListener('pointerup', stopDrag);
    slot.addEventListener('pointercancel', stopDrag);
    slot.addEventListener('lostpointercapture', () => finishMobilePreviewDrag(false));

    slot.dataset.previewInteractiveBound = 'true';
    updateSelfPreviewHandle(slot);
}

function getParticipantsContainer() {
    return document.querySelector('.chat-users');
}

function getRenderedParticipantCount() {
    const users = document.getElementById('users');
    if (users)
        return users.children.length;
    return Array.from(participantPresence.values()).filter(state => !!state.userinfo).length;
}

function updateParticipantsHeader() {
    const container = getParticipantsContainer();
    const toggle = document.getElementById('participants-toggle');
    const count = document.getElementById('participants-count');
    const collapsed = !!(container && container.classList.contains('chat-users-collapsed'));
    const total = getRenderedParticipantCount();

    if (count) {
        count.textContent = `${total}`;
        count.title = `${total} participant${total === 1 ? '' : 's'}`;
    }

    if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute(
            'aria-label',
            `${collapsed ? 'Show' : 'Hide'} participants (${total})`,
        );
    }
}

function setParticipantsCollapsed(collapsed, persist) {
    const container = getParticipantsContainer();
    if (container)
        container.classList.toggle('chat-users-collapsed', collapsed);
    updateParticipantsHeader();
    if (persist)
        updateSetting('chatParticipantsCollapsed', collapsed);
}

function getStageLocalControls() {
    return document.querySelector('.stage-local-controls');
}

function isPeerVisible(peer) {
    return !!(peer && !peer.classList.contains('peer-hidden'));
}

function getPeerStream(peer) {
    if (!peer || !serverConnection)
        return null;
    const localId = peer.id.replace('peer-', '');
    if (!localId)
        return null;
    if (serverConnection.findByLocalId) {
        const found = serverConnection.findByLocalId(localId);
        if (found)
            return found;
    }
    for (const id in serverConnection.up) {
        const stream = serverConnection.up[id];
        if (stream.localId === localId)
            return stream;
    }
    for (const id in serverConnection.down) {
        const stream = serverConnection.down[id];
        if (stream.localId === localId)
            return stream;
    }
    return null;
}

function isConferencePlaceholderPeer(peer) {
    return !!(peer && peer.dataset && peer.dataset.placeholderUserId);
}

function getConferencePeerUserId(peer) {
    if (!peer)
        return null;
    if (isConferencePlaceholderPeer(peer))
        return peer.dataset.placeholderUserId || null;
    const stream = getPeerStream(peer);
    return getStreamUserId(stream);
}

function isConferencePeerLocal(peer) {
    if (!peer)
        return false;
    if (isConferencePlaceholderPeer(peer))
        return peer.dataset.localPeer === 'true';
    const stream = getPeerStream(peer);
    return !!(stream && stream.up);
}

function getConferencePeerName(peer) {
    if (!peer)
        return '';
    if (isConferencePlaceholderPeer(peer))
        return peer.dataset.username || '';
    const stream = getPeerStream(peer);
    return (stream && stream.username) || '';
}

function hasSystemPermission(userinfo) {
    const permissions = userinfo && userinfo.permissions;
    if (!permissions)
        return false;
    if (Array.isArray(permissions))
        return permissions.includes('system');
    return !!permissions.system;
}

function getConferenceParticipants() {
    const participants = [];
    const seen = new Set();
    pruneRecentlyDeletedConferenceUsers();
    if (serverConnection) {
        const localId = serverConnection.id;
        const users = serverConnection.users || {};
        const localInfo = users[localId] || {
            username: serverConnection.username || 'You',
            data: {},
            streams: {},
        };
        if (localId && !hasSystemPermission(localInfo)) {
            participants.push({
                id: localId,
                username: localInfo.username || serverConnection.username || 'You',
                userinfo: localInfo,
                local: true,
            });
            seen.add(localId);
        }

        for (const id in users) {
            if (seen.has(id))
                continue;
            const user = users[id];
            if (hasSystemPermission(user))
                continue;
            participants.push({
                id: id,
                username: user.username || id,
                userinfo: user,
                local: false,
            });
            seen.add(id);
        }
    }

    // Stream-backed fallback: if a live stream exists before the roster/user
    // entry is fully visible to the UI, still create a participant slot for
    // that stream so the room doesn't collapse into pseudo-solo/Connecting.
    const streamEntries = new Map();
    getAllStreams().forEach(c => {
        if (!c || !c.stream)
            return;
        const userId = getStreamUserId(c) || c.localId;
        if (!userId || seen.has(userId) || streamEntries.has(userId) ||
            isConferenceUserRecentlyDeleted(userId))
            return;

        const streams = {};
        if (c.label) {
            streams[c.label] = {};
            c.stream.getTracks().forEach(track => {
                streams[c.label][track.kind] = true;
            });
        }

        streamEntries.set(userId, {
            id: userId,
            username: c.username || (c.up ? 'You' : userId),
            userinfo: {
                username: c.username || (c.up ? 'You' : userId),
                permissions: [],
                data: {},
                streams: streams,
            },
            local: !!c.up,
        });
    });
    participants.push(...streamEntries.values());

    return participants.sort((a, b) => {
        if (a.local !== b.local)
            return a.local ? 1 : -1;
        return stringCompare(a.username || a.id, b.username || b.id);
    });
}

function getConferencePlaceholderId(userId) {
    return `conference-placeholder-${encodeURIComponent(userId)}`;
}

function getConferencePlaceholderStatus(participant) {
    const userinfo = participant && participant.userinfo;
    const streams = (userinfo && userinfo.streams) || {};
    const camera = streams.camera;
    if (camera) {
        if (camera.video === false && camera.audio)
            return 'Audio only';
        if (camera.video === false)
            return 'Camera off';
        if (camera.video)
            return 'Connecting';
    }
    for (const stream of Object.values(streams)) {
        if (!stream)
            continue;
        if (stream.video === false && stream.audio)
            return 'Audio only';
    }
    return 'Connecting';
}

function ensureConferencePlaceholderPeer(participant) {
    const id = getConferencePlaceholderId(participant.id);
    let peer = document.getElementById(id);
    if (!peer) {
        peer = document.createElement('div');
        peer.id = id;
        peer.className = 'peer peer-no-video peer-participant-placeholder';
        peer.dataset.placeholderUserId = participant.id;
        const peers = getParticipantStrip();
        if (peers)
            peers.appendChild(peer);

        const placeholder = document.createElement('div');
        placeholder.className = 'peer-avatar-placeholder';

        const initials = document.createElement('div');
        initials.className = 'peer-avatar-initials';
        placeholder.appendChild(initials);

        const status = document.createElement('div');
        status.className = 'peer-avatar-status';
        status.innerHTML =
            '<i class="fas fa-video-slash" aria-hidden="true"></i>' +
            '<span class="peer-avatar-status-text">Connecting</span>';
        placeholder.appendChild(status);

        const label = document.createElement('div');
        label.className = 'label';

        peer.appendChild(placeholder);
        peer.appendChild(label);
        setPeerAspect(peer, participant.local ? 3 / 4 : 16 / 9, false);
        peer.onclick = null;
    }

    peer.dataset.username = participant.username || '';
    peer.dataset.localPeer = participant.local ? 'true' : 'false';
    peer.classList.remove('peer-hidden');
    peer.classList.add('peer-no-video');

    const label = peer.querySelector('.label');
    if (label)
        label.textContent = participant.local ? (participant.username || 'You') :
            (participant.username || 'Participant');

    const initials = peer.querySelector('.peer-avatar-initials');
    if (initials)
        initials.textContent = getNameInitials(
            participant.username || (participant.local ? 'You' : 'Participant'),
            participant.local ? 'Y' : 'P',
        );

    const statusText = peer.querySelector('.peer-avatar-status-text');
    if (statusText)
        statusText.textContent = getConferencePlaceholderStatus(participant);

    const placeholder = peer.querySelector('.peer-avatar-placeholder');
    if (placeholder)
        placeholder.setAttribute('aria-hidden', 'false');

    return peer;
}

function pruneConferencePlaceholderPeers(activeIds) {
    for (const peer of document.querySelectorAll('[id^="conference-placeholder-"]')) {
        if (activeIds.has(peer.id))
            continue;
        peer.remove();
    }
}

function ensureConferencePeerDisplay(peer) {
    if (!peer)
        return;
    peer.classList.remove('peer-hidden');
}

function getDefaultPeerAspect(c) {
    if (c && c.label === 'camera' && c.up)
        return 3 / 4;
    return 16 / 9;
}

function classifyPeerAspect(aspect) {
    if (aspect <= 0.95)
        return 'portrait';
    if (aspect >= 1.05)
        return 'landscape';
    return 'square';
}

function isCompactMobileLayout() {
    return !!window.matchMedia('only screen and (max-width: 640px)').matches;
}

function getPeerAspect(peer) {
    if (!peer)
        return 16 / 9;
    const aspect = parseFloat(peer.dataset.aspectRatio || '');
    if (!(Number.isFinite(aspect) && aspect > 0))
        return 16 / 9;

    if (
        isCompactMobileLayout() &&
        !peer.classList.contains('peer-self-preview') &&
        !peer.classList.contains('peer-stage') &&
        classifyPeerAspect(aspect) === 'portrait'
    )
        return Math.max(aspect, 0.88);

    return aspect;
}

function setPeerAspect(peer, aspect, triggerResize = true) {
    if (!peer || !Number.isFinite(aspect) || aspect <= 0)
        return;
    const clamped = Math.max(0.52, Math.min(2.4, aspect));
    const previous = parseFloat(peer.dataset.aspectRatio || '');
    const orientation = classifyPeerAspect(clamped);
    peer.dataset.aspectRatio = clamped.toFixed(4);
    peer.dataset.orientation = orientation;
    peer.style.setProperty('--peer-aspect-ratio', clamped.toFixed(4));
    peer.classList.toggle('peer-portrait', orientation === 'portrait');
    peer.classList.toggle('peer-landscape', orientation === 'landscape');
    peer.classList.toggle('peer-square', orientation === 'square');
    if (triggerResize && (!Number.isFinite(previous) || Math.abs(previous - clamped) > 0.01))
        scheduleConferenceLayout();
}

function updatePeerAspectFromMedia(peer, media, c) {
    if (!peer || !media)
        return;
    const aspect =
        media.videoWidth && media.videoHeight ?
            media.videoWidth / media.videoHeight :
            getDefaultPeerAspect(c);
    setPeerAspect(peer, aspect);
}

async function tryStartDownstreamPlayback(c, media) {
    if (!c || !media || c.up || !media.srcObject)
        return false;
    try {
        await media.play();
        if (c.userdata && c.userdata.play)
            delete c.userdata.play;
        return true;
    } catch (e) {
        if (e && e.name === 'AbortError')
            return false;
        console.warn('[tryStartDownstreamPlayback] play() failed for', c.localId, e);
        if (c.userdata)
            c.userdata.play = true;
        return false;
    }
}

function clearPeerPresentation(peer) {
    if (!peer)
        return;
    peer.classList.remove('peer-stage', 'peer-self-preview');
    peer.style.removeProperty('width');
    peer.style.removeProperty('height');
    peer.style.removeProperty('flex-basis');
}

function syncContainerChildren(container, children) {
    if (!container)
        return;
    let referenceNode = container.firstElementChild;
    for (const child of children) {
        if (child.parentElement !== container) {
            container.appendChild(child);
        } else if (child !== referenceNode) {
            container.insertBefore(child, referenceNode);
        }
        referenceNode = child.nextElementSibling;
    }
}

function countMosaicRows(peers, availableWidth, rowHeight, gap) {
    let rows = 1;
    let rowWidth = 0;
    for (const peer of peers) {
        const tileWidth = Math.max(88, Math.round(rowHeight * getPeerAspect(peer)));
        if (rowWidth && rowWidth + gap + tileWidth > availableWidth) {
            rows += 1;
            rowWidth = tileWidth;
        } else {
            rowWidth += (rowWidth ? gap : 0) + tileWidth;
        }
    }
    return rows;
}

function getConferenceMinimumRowHeight(mode) {
    if (isCompactMobileLayout())
        return mode === 'duo' ? 150 : 120;
    return 180;
}

function getPeerOrientation(peer) {
    if (!peer)
        return 'landscape';
    return peer.dataset.orientation || classifyPeerAspect(getPeerAspect(peer));
}

function getCompactMobileGroupColumns(peers) {
    if (peers.length <= 2)
        return 1;
    return 2;
}

function getCompactMobileGroupVisibleRows(peers) {
    if (peers.length <= 2)
        return peers.length;
    return 2;
}

function shouldUseCompactMobileGroupGrid(mode, peers) {
    return !!(isCompactMobileLayout() && mode === 'group' && peers.length >= 3);
}

function getDesktopGroupColumns(peers) {
    if (peers.length <= 1)
        return 1;
    if (peers.length <= 4)
        return 2;
    return 3;
}

function getDesktopGroupRowSizes(count) {
    if (count <= 0)
        return [];
    if (count === 1)
        return [1];
    if (count === 2)
        return [2];
    if (count === 3)
        return [2, 1];
    if (count === 4)
        return [2, 2];
    if (count === 5)
        return [3, 2];
    if (count === 6)
        return [3, 3];
    if (count === 7)
        return [3, 2, 2];
    if (count === 8)
        return [3, 3, 2];
    if (count === 9)
        return [3, 3, 3];

    const rows = [3, 3, 3];
    let remaining = count - 9;
    while (remaining > 0) {
        rows.push(Math.min(3, remaining));
        remaining -= 3;
    }
    return rows;
}

function chooseCompactMobileGroupRowHeight(peers, availableWidth, availableHeight, gap) {
    if (!peers.length)
        return 0;

    const columns = getCompactMobileGroupColumns(peers);
    const visibleRows = getCompactMobileGroupVisibleRows(peers);
    const heightBound = Math.floor(
        (availableHeight - gap * Math.max(0, visibleRows - 1)) / visibleRows,
    );
    const minHeight = 180;
    return Math.max(minHeight, heightBound);
}

function getGridMetrics(grid) {
    const styles = window.getComputedStyle(grid);
    const verticalInset = isCompactMobileLayout() ? 72 : 84;
    return {
        gap: parseFloat(styles.gap || '12') || 12,
        availableWidth: Math.max(220, grid.clientWidth - 24),
        availableHeight: Math.max(180, grid.clientHeight - verticalInset),
    };
}

function chooseMosaicRowHeight(peers, availableWidth, availableHeight, gap, mode) {
    if (!peers.length)
        return 220;

    if (mode === 'duo' && peers.length === 2) {
        const totalAspect = peers.reduce((sum, peer) => sum + getPeerAspect(peer), 0);
        return Math.max(
            150,
            Math.min(availableHeight, Math.floor((availableWidth - gap) / totalAspect)),
        );
    }

    if (mode === 'group' && !isCompactMobileLayout()) {
        const columns = getDesktopGroupColumns(peers);
        const rows = Math.max(1, Math.ceil(peers.length / columns));
        const columnWidth = Math.floor(
            (availableWidth - gap * Math.max(0, columns - 1)) / columns,
        );
        const targetDesktopAspect = 1.24;
        return Math.max(
            220,
            Math.min(
                Math.floor((availableHeight - gap * Math.max(0, rows - 1)) / rows),
                Math.floor(columnWidth / targetDesktopAspect),
            ),
        );
    }

    const widthBound = peers.reduce((minHeight, peer) => {
        const aspect = Math.max(0.52, getPeerAspect(peer));
        return Math.min(minHeight, Math.floor(availableWidth / aspect));
    }, Infinity);
    const boundedHeight = Math.max(120, Math.min(availableHeight, widthBound));

    if (mode === 'group' && isCompactMobileLayout() && peers.length >= 2) {
        const packedHeight = chooseCompactMobileGroupRowHeight(
            peers,
            availableWidth,
            availableHeight,
            gap,
        );
        if (packedHeight)
            return packedHeight;
    }

    if (mode === 'group' && isCompactMobileLayout() && peers.length <= 2) {
        return Math.max(
            160,
            Math.min(boundedHeight, Math.floor((availableHeight - gap) / peers.length)),
        );
    }

    if (peers.length === 1)
        return boundedHeight;

    const maxHeight = Math.max(140, Math.min(boundedHeight, 340));
    for (let rowHeight = maxHeight; rowHeight >= 120; rowHeight -= 4) {
        const rows = countMosaicRows(peers, availableWidth, rowHeight, gap);
        const totalHeight = rows * rowHeight + Math.max(0, rows - 1) * gap;
        if (totalHeight <= availableHeight)
            return rowHeight;
    }

    return Math.max(
        120,
        Math.floor((availableHeight - gap) /
            Math.max(1, Math.ceil(Math.sqrt(peers.length)))),
    );
}

function shouldUseStackedGrid(mode, peers) {
    if (!isCompactMobileLayout())
        return false;
    if (mode === 'duo')
        return peers.length === 2;
    if (mode === 'group')
        return peers.length <= 2;
    return false;
}

function chooseStackedRowHeight(peers, availableHeight, gap, mode) {
    if (!peers.length)
        return 220;
    if (mode === 'group' && isCompactMobileLayout()) {
        const visibleRows = peers.length;
        return Math.max(
            getConferenceMinimumRowHeight(mode),
            Math.floor((availableHeight - gap * Math.max(0, visibleRows - 1)) / visibleRows),
        );
    }
    return Math.max(
        getConferenceMinimumRowHeight(mode),
        Math.floor((availableHeight - gap * Math.max(0, peers.length - 1)) / peers.length),
    );
}

function measureGridLayout(grid, peers, mode) {
    const visiblePeers = peers.filter(isPeerVisible);
    if (!grid || !visiblePeers.length) {
        return {
            rowHeight: 0,
            stacked: false,
            fits: true,
        };
    }

    const {gap, availableWidth, availableHeight} = getGridMetrics(grid);
    const compactMobileGrid = shouldUseCompactMobileGroupGrid(mode, visiblePeers);
    const stacked = !compactMobileGrid && shouldUseStackedGrid(mode, visiblePeers);
    const desktopGroupRows = mode === 'group' && !isCompactMobileLayout() ?
        getDesktopGroupRowSizes(visiblePeers.length) :
        null;
    const rowHeight = compactMobileGrid ?
        chooseCompactMobileGroupRowHeight(
            visiblePeers,
            availableWidth,
            availableHeight,
            gap,
        ) :
        desktopGroupRows ?
        Math.max(
            220,
            Math.floor(
                (availableHeight - gap * Math.max(0, Math.min(desktopGroupRows.length, 3) - 1)) /
                Math.max(1, Math.min(desktopGroupRows.length, 3)),
            ),
        ) :
        stacked ?
        chooseStackedRowHeight(visiblePeers, availableHeight, gap, mode) :
        chooseMosaicRowHeight(
            visiblePeers,
            availableWidth,
            availableHeight,
            gap,
            mode,
        );

    return {
        rowHeight,
        stacked,
        compactMobileGrid,
        desktopGroupRows,
        columns: compactMobileGrid ?
            getCompactMobileGroupColumns(visiblePeers) :
            (mode === 'group' && !isCompactMobileLayout()) ?
                getDesktopGroupColumns(visiblePeers) :
                Math.max(1, visiblePeers.length),
        fits: rowHeight >= getConferenceMinimumRowHeight(mode),
    };
}

function layoutPeerGrid(grid, peers, mode) {
    if (!grid)
        return;
    const visiblePeers = peers.filter(isPeerVisible);
    if (!visiblePeers.length) {
        grid.style.removeProperty('--mosaic-row-height');
        grid.classList.remove('stacked-grid');
        grid.classList.remove('compact-mobile-group-grid');
        grid.classList.remove('last-row-two');
        grid.style.removeProperty('--mosaic-columns');
        return;
    }

    const layout = measureGridLayout(grid, visiblePeers, mode);
    const rowHeight = layout.rowHeight;
    grid.style.setProperty('--mosaic-row-height', `${rowHeight}px`);
    grid.classList.toggle('stacked-grid', layout.stacked);
    grid.classList.toggle('compact-mobile-group-grid', !!layout.compactMobileGrid);
    grid.style.setProperty('--mosaic-columns', `${layout.columns || Math.max(1, visiblePeers.length)}`);

    visiblePeers.forEach(peer => {
        peer.style.removeProperty('--peer-row-columns');
    });

    if (!isCompactMobileLayout() && mode === 'group' && layout.desktopGroupRows?.length) {
        const baseColumns = getDesktopGroupColumns(visiblePeers);
        let index = 0;
        layout.desktopGroupRows.forEach(columns => {
            const renderedColumns = columns === 1 ? baseColumns : columns;
            for (let i = 0; i < columns && index < visiblePeers.length; i += 1, index += 1) {
                visiblePeers[index].style.setProperty('--peer-row-columns', `${renderedColumns}`);
            }
        });
    }

    return layout;
}

function setSelfPreviewPeer(slot, peer) {
    if (!slot)
        return;
    ensureMobilePreviewInteractivity(slot);
    const handle = slot.querySelector('.self-preview-handle');
    if (peer && isConferencePlaceholderPeer(peer) &&
        peer.dataset.localPeer === 'true') {
        const liveLocalPeer = getLiveLocalConferencePeer();
        if (liveLocalPeer)
            peer = liveLocalPeer;
    }
    const current = getSelfPreviewPeerElement(slot);
    if (!peer) {
        if (current) {
            current.classList.remove('peer-self-preview');
            current.remove();
        }
        slot.classList.add('invisible');
        slot.setAttribute('aria-hidden', 'true');
        applyMobilePreviewState(slot, false);
        return;
    }
    peer.classList.add('peer-self-preview');
    if (current === peer && !slot.classList.contains('invisible')) {
        slot.setAttribute('aria-hidden', 'false');
        applyMobilePreviewState(slot, true);
        return;
    }
    if (current && current !== peer) {
        current.classList.remove('peer-self-preview');
        current.remove();
    }
    if (handle instanceof HTMLElement)
        slot.insertBefore(peer, handle);
    else
        slot.appendChild(peer);
    slot.classList.remove('invisible');
    slot.setAttribute('aria-hidden', 'false');
    applyMobilePreviewState(slot, true);
}

function getCurrentLocalSelfPreviewPeer(slot) {
    const current = getSelfPreviewPeerElement(slot);
    if (!current)
        return null;
    if (isConferencePeerLocal(current))
        return current;
    if (isConferencePlaceholderPeer(current) && current.dataset.localPeer === 'true')
        return current;
    return null;
}

function getVisibleVideoCandidates() {
    return getAllStreams().filter(isVisibleStageCandidate);
}

function hasActiveScreenshare() {
    return getVisibleVideoCandidates().some(c => c.label === 'screenshare');
}

function getConferenceLayoutMode() {
    if (hasActiveScreenshare() && getConferenceParticipantCount() <= 1)
        return 'spotlight';

    const visiblePeers = getVisibleConferencePeers(getConferenceLayoutPeers());
    if (visiblePeers.length <= 1)
        return 'solo';
    if (visiblePeers.length === 2)
        return 'duo';
    return 'group';
}

function usesOverlayPanels() {
    return !!window.matchMedia('only screen and (max-width: 1200px)').matches;
}

function bringPanelToFront(panel) {
    if (!panel || !usesOverlayPanels())
        return;
    overlayPanelOrder += 1;
    panel.style.zIndex = `${overlayPanelOrder}`;
}

function updateStageBadge() {
    const countElt = document.getElementById('participant-count');
    const summaryElt = document.getElementById('participant-summary');
    const stageLabel = document.getElementById('stage-label');
    const stageSlot = getStageSlot();
    const strip = getParticipantStrip();
    const grid = getMosaicGrid();
    const selfPreview = getSelfPreviewSlot();
    const mode = getConferenceLayoutMode();
    if (!countElt || !summaryElt || !stageLabel || !stageSlot || !strip || !grid)
        return;

    const participantCount = getConferenceParticipantCount();
    countElt.textContent =
        `${participantCount} participant${participantCount === 1 ? '' : 's'}`;

    const visibleInGrid = Array.from(grid.children)
        .filter(elt => !elt.classList.contains('peer-hidden')).length;
    const visibleInStage = Array.from(stageSlot.children)
        .filter(elt => !elt.classList.contains('peer-hidden')).length;
    const visibleInStrip = Array.from(strip.children)
        .filter(elt => !elt.classList.contains('peer-hidden')).length;
    const selfPreviewVisible = !!(
        selfPreview &&
        !selfPreview.classList.contains('invisible') &&
        selfPreview.children.length
    );

    if (mode === 'solo') {
        stageLabel.textContent = 'Conference';
        summaryElt.textContent = visibleInStage ?
            `${visibleInStage} participant on screen` :
            'Participants will appear here.';
        return;
    }

    if (mode === 'duo' || mode === 'group') {
        stageLabel.textContent = 'Conference';
        if (visibleInGrid) {
            summaryElt.textContent =
                `${visibleInGrid} participant${visibleInGrid === 1 ? '' : 's'} on screen` +
                (selfPreviewVisible ? ' / you in corner' : '');
        } else {
            summaryElt.textContent = 'Participants will appear here.';
        }
        return;
    }

    if (visibleInStrip) {
        summaryElt.textContent =
            `${visibleInStrip} participant${visibleInStrip === 1 ? '' : 's'} below`;
    } else {
        summaryElt.textContent = 'Other participants stay here.';
    }

    const stream = stagedLocalId && serverConnection ?
        serverConnection.findByLocalId(stagedLocalId) : null;
    if (!stream) {
        stageLabel.textContent = 'Conference';
        return;
    }

    const name = stream.username ||
        (stream.up ? (serverConnection && serverConnection.username) || 'You' : 'Participant');
    if (stream.label === 'screenshare') {
        stageLabel.textContent = `${name} is sharing screen`;
    } else if (stream.up) {
        stageLabel.textContent = 'Your stream is on stage';
    } else {
        stageLabel.textContent = `${name} is on stage`;
    }
}

function setProfileInitials(name) {
    const elt = document.getElementById('profile-initials');
    if (!elt)
        return;
    elt.textContent = getNameInitials(name, 'G');
}

function getNameInitials(name, fallback) {
    const parts = (name || 'G')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
    return parts.length ?
        parts.map(part => part[0].toUpperCase()).join('') :
        (fallback || 'G');
}

function hasVideoTrack(stream) {
    return !!(stream && stream.getTracks().some(t => t.kind === 'video'));
}

function isVideoStream(c) {
    if (!c || !c.stream)
        return false;
    if (c.label === 'screenshare')
        return true;
    return hasVideoTrack(c.stream);
}

function isVisibleStageCandidate(c) {
    const peer = getPeer(c.localId);
    return !!(peer && !peer.classList.contains('peer-hidden') && isVideoStream(c));
}

function getStreamActivityTime(c) {
    const last = c && c.userdata && c.userdata.lastVoiceActivity;
    return typeof last === 'number' ? last : 0;
}

function isRecentlyActiveSpeaker(c) {
    if (!c)
        return false;
    const last = getStreamActivityTime(c);
    return !!(c.userdata && c.userdata.active) ||
        !!(last && Date.now() - last <= getActivityDetectionPeriod());
}

function compareStageCandidates(a, b) {
    const activityDelta = getStreamActivityTime(b) - getStreamActivityTime(a);
    if (activityDelta)
        return activityDelta;

    const aName = (a.username || a.localId || '').toLowerCase();
    const bName = (b.username || b.localId || '').toLowerCase();
    return aName.localeCompare(bName);
}

function chooseStageStream() {
    const candidates = getVisibleVideoCandidates();
    if (!candidates.length)
        return null;

    const shares = candidates.filter(c => c.label === 'screenshare');
    if (shares.length) {
        if (stagedLocalId && shares.find(c => c.localId === stagedLocalId))
            return stagedLocalId;
        return shares[0].localId;
    }

    if (pinnedLocalId) {
        const pinned = candidates.find(c => c.localId === pinnedLocalId);
        if (pinned)
            return pinned.localId;
        pinnedLocalId = null;
    }

    const remote = candidates
        .filter(c => !c.up)
        .sort(compareStageCandidates);

    const activeRemote = remote.filter(isRecentlyActiveSpeaker);
    if (activeRemote.length)
        return activeRemote[0].localId;

    if (stagedLocalId) {
        const stagedRemote = remote.find(c => c.localId === stagedLocalId);
        if (stagedRemote)
            return stagedRemote.localId;
    }

    if (remote.length)
        return remote[0].localId;

    const local = candidates.find(c => c.up && c.label === 'camera');
    if (local)
        return local.localId;

    return candidates.sort(compareStageCandidates)[0].localId;
}

function compareMosaicPeers(a, b) {
    const aLocal = isConferencePeerLocal(a);
    const bLocal = isConferencePeerLocal(b);
    if (aLocal !== bLocal)
        return aLocal ? 1 : -1;

    const aStream = getPeerStream(a);
    const bStream = getPeerStream(b);
    const aLabel = aStream ? aStream.label : 'camera';
    const bLabel = bStream ? bStream.label : 'camera';
    if (aLabel !== bLabel) {
        if (aLabel === 'screenshare')
            return -1;
        if (bLabel === 'screenshare')
            return 1;
    }

    const aName = (getConferencePeerName(a) || getConferencePeerUserId(a) || '').toLowerCase();
    const bName = (getConferencePeerName(b) || getConferencePeerUserId(b) || '').toLowerCase();
    return aName.localeCompare(bName);
}

function getVisibleConferencePeers(peers) {
    return peers.filter(isPeerVisible);
}

function getConferenceParticipantCount() {
    return getConferenceParticipants().length;
}

function getConferencePeerIdentity(peer) {
    return getConferencePeerUserId(peer);
}

function getConferencePeerPriority(peer) {
    if (isConferencePlaceholderPeer(peer))
        return 1;
    const stream = getPeerStream(peer);
    if (!stream)
        return -1;
    let priority = 0;
    if (stream.label === 'camera')
        priority += 12;
    if (isVideoStream(stream))
        priority += 8;
    if (stream.up)
        priority += 4;
    return priority;
}

function getConferenceStreamPriority(c) {
    if (!c)
        return -1;
    let priority = 0;
    if (c.label === 'camera')
        priority += 12;
    if (hasVideoTrack(c.stream))
        priority += 8;
    if (c.up)
        priority += 4;
    const health = getStreamConnectionHealth(c);
    if (health === 'healthy')
        priority += 6;
    else if (health === 'poor')
        priority -= 4;
    return priority;
}

function getConferenceStreamRecency(c) {
    if (!c)
        return 0;
    return (
        (c.userdata && c.userdata.lastTrackAt) ||
        c.createdAt ||
        0
    );
}

function getConferenceParticipantCameraPeer(participant) {
    if (!participant)
        return null;

    let bestStream = null;
    for (const stream of getAllStreams()) {
        if (!stream || stream.label !== 'camera')
            continue;
        if (getStreamUserId(stream) !== participant.id)
            continue;
        if (!stream.stream || !hasVideoTrack(stream.stream))
            continue;
        if (
            !bestStream ||
            getConferenceStreamPriority(stream) > getConferenceStreamPriority(bestStream) ||
            (
                getConferenceStreamPriority(stream) === getConferenceStreamPriority(bestStream) &&
                getConferenceStreamRecency(stream) > getConferenceStreamRecency(bestStream)
            )
        ) {
            bestStream = stream;
        }
    }

    if (!bestStream)
        return null;

    return getPeer(bestStream.localId);
}

function getLiveLocalCameraStream() {
    let bestStream = null;
    for (const stream of getAllStreams()) {
        if (!stream || !stream.up || stream.label !== 'camera')
            continue;
        if (!stream.stream || !hasVideoTrack(stream.stream))
            continue;
        if (
            !bestStream ||
            getConferenceStreamPriority(stream) > getConferenceStreamPriority(bestStream) ||
            (
                getConferenceStreamPriority(stream) === getConferenceStreamPriority(bestStream) &&
                getConferenceStreamRecency(stream) > getConferenceStreamRecency(bestStream)
            )
        ) {
            bestStream = stream;
        }
    }
    return bestStream;
}

function getLocalConferenceParticipant() {
    return getConferenceParticipants().find(participant => participant.local) || null;
}

function getLiveLocalConferencePeer() {
    const localStream = getLiveLocalCameraStream();
    if (localStream) {
        const localPeer = getPeer(localStream.localId);
        if (localPeer)
            return localPeer;
    }

    const participant = getLocalConferenceParticipant();
    if (!participant)
        return null;
    return getConferenceParticipantCameraPeer(participant);
}

function restoreLiveSelfPreviewPeer(slot) {
    if (!slot)
        return false;
    const livePeer = getLiveLocalConferencePeer();
    if (livePeer) {
        setSelfPreviewPeer(slot, livePeer);
        return true;
    }
    scheduleConferenceLayout();
    return false;
}

function getConferenceLayoutPeers() {
    const placeholderIds = new Set();
    const peers = [];
    for (const participant of getConferenceParticipants()) {
        const existingPeer = getConferenceParticipantCameraPeer(participant);
        if (existingPeer) {
            ensureConferencePeerDisplay(existingPeer);
            peers.push(existingPeer);
            continue;
        }
        const placeholder = ensureConferencePlaceholderPeer(participant);
        placeholderIds.add(placeholder.id);
        peers.push(placeholder);
    }

    for (const stream of getAllStreams()) {
        if (!stream || stream.label !== 'screenshare')
            continue;
        if (!stream.stream || !hasVideoTrack(stream.stream))
            continue;
        const peer = getPeer(stream.localId);
        if (!peer)
            continue;
        ensureConferencePeerDisplay(peer);
        peers.push(peer);
    }

    pruneConferencePlaceholderPeers(placeholderIds);
    return peers.sort(compareMosaicPeers);
}

function getLocalCameraPreviewPeer(peers, requireGroup) {
    if (requireGroup && getVisibleConferencePeers(peers).length < 3)
        return null;
    return peers.find(peer => {
        if (!isPeerVisible(peer))
            return false;
        if (isConferencePlaceholderPeer(peer))
            return peer.dataset.localPeer === 'true';
        const stream = getPeerStream(peer);
        return !!(stream && stream.up && stream.label === 'camera');
    }) || null;
}

function chooseGridSelfPreviewPeer(grid, peers, mode) {
    const localPreviewPeer = getLocalCameraPreviewPeer(peers, false);
    if (!localPreviewPeer)
        return null;

    const visiblePeers = getVisibleConferencePeers(peers);
    const remotePeers = visiblePeers.filter(peer => !isConferencePeerLocal(peer));
    if (!remotePeers.length)
        return null;

    if (previewFocusOnSelf)
        return remotePeers[0];

    if (mode === 'duo')
        return localPreviewPeer;

    if (mode !== 'group')
        return null;

    return localPreviewPeer;
}

function setConferenceContainerMode(videoContainer, mode) {
    if (!videoContainer)
        return;
    videoContainer.classList.remove(
        'layout-solo',
        'layout-duo',
        'layout-group',
        'layout-focus',
        'layout-spotlight',
        'layout-previewed',
        'layout-two-main',
        'layout-solo-share',
    );
    videoContainer.classList.add(`layout-${mode}`);
}

function setConferencePreviewState(videoContainer, previewed) {
    if (!videoContainer)
        return;
    videoContainer.classList.toggle('layout-previewed', !!previewed);
}

function setConferenceSoloShareState(videoContainer, active) {
    if (!videoContainer)
        return;
    videoContainer.classList.toggle('layout-solo-share', !!active);
}

function setStageCardMode(mode) {
    const stageCard = document.getElementById('stage-card');
    if (!stageCard)
        return;
    stageCard.classList.toggle('stage-camera', mode === 'camera');
    stageCard.classList.toggle('stage-sharing', mode === 'sharing');
}

function getFocusCloseButton() {
    return document.getElementById('focus-close');
}

function getStageFullscreenButton() {
    return document.getElementById('stage-fullscreen');
}

function getMediaElement(localId) {
    const media = localId ? document.getElementById('media-' + localId) : null;
    return media instanceof HTMLVideoElement ? media : null;
}

function isElementFullscreenSupported(element) {
    if (!element)
        return false;
    if (document.fullscreenEnabled || document.webkitFullscreenEnabled)
        return true;
    if (element instanceof HTMLVideoElement) {
        return !!(
            element.webkitEnterFullscreen ||
            element.webkitEnterFullScreen
        );
    }
    return false;
}

function isStageFullscreenActive() {
    const media = getMediaElement(stagedLocalId || focusedConferenceLocalId);
    return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        (media && media.webkitDisplayingFullscreen)
    );
}

function getStageFullscreenTarget() {
    return document.getElementById('stage-slot') ||
        document.getElementById('stage-card') ||
        document.getElementById('video-container');
}

function getSharedScreenFullscreenTarget(localId) {
    return getMediaElement(localId) || getStageFullscreenTarget();
}

function nextAnimationFrame() {
    return new Promise(resolve => window.requestAnimationFrame(resolve));
}

async function enterElementFullscreen(element) {
    if (!element)
        return;
    if (element.requestFullscreen) {
        await element.requestFullscreen();
        return;
    }
    if (element.webkitRequestFullscreen) {
        await element.webkitRequestFullscreen();
        return;
    }
    if (element instanceof HTMLVideoElement) {
        if (element.webkitEnterFullscreen) {
            element.webkitEnterFullscreen();
            return;
        }
        if (element.webkitEnterFullScreen) {
            element.webkitEnterFullScreen();
            return;
        }
    }
}

async function exitElementFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
        return;
    }
    if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
        return;
    }
    const media = getMediaElement(stagedLocalId || focusedConferenceLocalId);
    if (media && media.webkitDisplayingFullscreen && media.webkitExitFullscreen) {
        media.webkitExitFullscreen();
        return;
    }
}

async function openSharedScreenFullscreen(localId) {
    if (!serverConnection)
        return;
    const stream = serverConnection.findByLocalId(localId);
    if (!stream || stream.label !== 'screenshare')
        return;

    if (focusedConferenceLocalId !== localId)
        openConferenceFocus(localId);

    const target = getSharedScreenFullscreenTarget(localId);
    const canBrowserFullscreen = isElementFullscreenSupported(target) &&
        (!stream.up || isMobileBurgerLayout());

    if (!canBrowserFullscreen) {
        updateStageFullscreenState();
        return;
    }

    if (!isStageFullscreenActive())
        await enterElementFullscreen(target);

    updateStageFullscreenState();
}

function updateStageFullscreenState() {
    const button = getStageFullscreenButton();
    if (!(button instanceof HTMLButtonElement))
        return;

    const stream = stagedLocalId && serverConnection ?
        serverConnection.findByLocalId(stagedLocalId) : null;
    const available = !!(
        stream &&
        stream.label === 'screenshare' &&
        isElementFullscreenSupported(getSharedScreenFullscreenTarget(stagedLocalId)) &&
        (!stream.up || isMobileBurgerLayout())
    );
    const fullscreenActive = isStageFullscreenActive();

    button.classList.toggle('invisible', !available);
    button.setAttribute('aria-hidden', available ? 'false' : 'true');
    button.setAttribute(
        'aria-label',
        fullscreenActive ? 'Exit fullscreen shared screen' : 'Open shared screen fullscreen',
    );
    const icon = button.querySelector('i');
    if (icon) {
        icon.classList.toggle('fa-expand', !fullscreenActive);
        icon.classList.toggle('fa-compress', fullscreenActive);
    }
}

function setConferenceFocusState(focused) {
    const button = getFocusCloseButton();
    if (!button)
        return;
    button.classList.toggle('invisible', !focused);
    button.setAttribute('aria-hidden', focused ? 'false' : 'true');
    button.classList.remove('focus-close-camera', 'focus-close-sharing');
    if (focused) {
        const peer = getFocusedConferencePeer();
        const stream = getPeerStream(peer);
        button.classList.add(
            stream && stream.label === 'screenshare' ?
                'focus-close-sharing' :
                'focus-close-camera',
        );
    }
    updateStageFullscreenState();
}

function getFocusedConferencePeer() {
    if (!focusedConferenceLocalId)
        return null;
    const peer = getPeer(focusedConferenceLocalId);
    if (!peer || !isPeerVisible(peer))
        return null;
    const stream = getPeerStream(peer);
    if (!stream || (stream.label !== 'camera' && stream.label !== 'screenshare'))
        return null;
    return peer;
}

function openConferenceFocus(localId) {
    if (!localId)
        return;
    focusedConferenceLocalId = localId;
    previewFocusOnSelf = false;
    resetSharedScreenZoom();
    syncConferenceLayout();
}

function closeConferenceFocus() {
    if (!focusedConferenceLocalId)
        return;
    focusedConferenceLocalId = null;
    resetSharedScreenZoom();
    syncConferenceLayout();
}

function getFocusedSharedScreenStream() {
    if (!serverConnection)
        return null;
    const localId = focusedConferenceLocalId || stagedLocalId;
    if (!localId)
        return null;
    const stream = serverConnection.findByLocalId(localId);
    if (!stream || stream.label !== 'screenshare')
        return null;
    return stream;
}

function getFocusedSharedScreenMedia() {
    const stream = getFocusedSharedScreenStream();
    if (!stream)
        return null;
    return getMediaElement(stream.localId);
}

function clampSharedScreenZoomTranslation(media, scale, x, y) {
    const host = getStageSlot() || media?.parentElement;
    if (!(host instanceof HTMLElement) || !(media instanceof HTMLMediaElement))
        return {x: 0, y: 0};
    const hostRect = host.getBoundingClientRect();
    const mediaRect = media.getBoundingClientRect();
    const maxX = Math.max(0, (mediaRect.width * scale - hostRect.width) / 2);
    const maxY = Math.max(0, (mediaRect.height * scale - hostRect.height) / 2);
    return {
        x: Math.min(maxX, Math.max(-maxX, x)),
        y: Math.min(maxY, Math.max(-maxY, y)),
    };
}

function applySharedScreenZoom() {
    const media = getFocusedSharedScreenMedia();
    const stage = getStageSlot();
    if (!(stage instanceof HTMLElement))
        return;

    ensureSharedScreenTouchInteractions();
    stage.classList.toggle('shared-screen-zoom-active', !!(media && sharedScreenZoomState.scale > 1));
    if (sharedScreenZoomMediaLocalId && (!media || sharedScreenZoomMediaLocalId !== media.id.replace('media-', ''))) {
        const previousMedia = getMediaElement(sharedScreenZoomMediaLocalId);
        if (previousMedia instanceof HTMLMediaElement) {
            previousMedia.style.removeProperty('transform');
            previousMedia.style.removeProperty('transform-origin');
            previousMedia.style.removeProperty('touch-action');
            previousMedia.classList.remove('shared-screen-zoomable');
        }
        sharedScreenZoomMediaLocalId = null;
    }

    if (!(media instanceof HTMLMediaElement))
        return;

    sharedScreenZoomMediaLocalId = media.id.replace('media-', '');
    media.classList.toggle('shared-screen-zoomable', true);
    media.style.transformOrigin = 'center center';
    media.style.touchAction = 'none';
    media.style.transform =
        `translate3d(${sharedScreenZoomState.translateX}px, ${sharedScreenZoomState.translateY}px, 0) scale(${sharedScreenZoomState.scale})`;
}

function resetSharedScreenZoom() {
    sharedScreenZoomState = {
        scale: 1,
        translateX: 0,
        translateY: 0,
    };
    sharedScreenTouchState = null;
    const media = sharedScreenZoomMediaLocalId ? getMediaElement(sharedScreenZoomMediaLocalId) : getFocusedSharedScreenMedia();
    if (media instanceof HTMLMediaElement) {
        media.style.removeProperty('transform');
        media.style.removeProperty('transform-origin');
        media.style.removeProperty('touch-action');
        media.classList.remove('shared-screen-zoomable');
    }
    sharedScreenZoomMediaLocalId = null;
    const stage = getStageSlot();
    if (stage instanceof HTMLElement)
        stage.classList.remove('shared-screen-zoom-active');
}

function getTouchDistance(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
}

function ensureSharedScreenTouchInteractions() {
    const stage = getStageSlot();
    if (!(stage instanceof HTMLElement) || stage.dataset.sharedZoomBound === 'true')
        return;
    stage.dataset.sharedZoomBound = 'true';

    stage.addEventListener('touchstart', event => {
        if (!isMobileBurgerLayout())
            return;
        if (!getFocusedSharedScreenStream())
            return;

        if (event.touches.length === 2) {
            const [a, b] = event.touches;
            sharedScreenTouchState = {
                mode: 'pinch',
                startDistance: getTouchDistance(a, b),
                startScale: sharedScreenZoomState.scale,
                startTranslateX: sharedScreenZoomState.translateX,
                startTranslateY: sharedScreenZoomState.translateY,
            };
            event.preventDefault();
            return;
        }

        if (event.touches.length === 1 && sharedScreenZoomState.scale > 1) {
            const touch = event.touches[0];
            sharedScreenTouchState = {
                mode: 'pan',
                startX: touch.clientX,
                startY: touch.clientY,
                startTranslateX: sharedScreenZoomState.translateX,
                startTranslateY: sharedScreenZoomState.translateY,
            };
            event.preventDefault();
        }
    }, {passive: false});

    stage.addEventListener('touchmove', event => {
        if (!isMobileBurgerLayout())
            return;
        if (!getFocusedSharedScreenStream())
            return;
        const media = getFocusedSharedScreenMedia();
        if (!(media instanceof HTMLMediaElement))
            return;

        if (sharedScreenTouchState && sharedScreenTouchState.mode === 'pinch' && event.touches.length === 2) {
            const [a, b] = event.touches;
            const distance = getTouchDistance(a, b);
            const rawScale = sharedScreenTouchState.startScale * (distance / sharedScreenTouchState.startDistance);
            const nextScale = Math.min(3, Math.max(1, rawScale));
            sharedScreenZoomState.scale = nextScale;
            const clamped = clampSharedScreenZoomTranslation(
                media,
                nextScale,
                sharedScreenTouchState.startTranslateX,
                sharedScreenTouchState.startTranslateY,
            );
            sharedScreenZoomState.translateX = clamped.x;
            sharedScreenZoomState.translateY = clamped.y;
            applySharedScreenZoom();
            event.preventDefault();
            return;
        }

        if (sharedScreenTouchState && sharedScreenTouchState.mode === 'pan' && event.touches.length === 1) {
            const touch = event.touches[0];
            const dx = touch.clientX - sharedScreenTouchState.startX;
            const dy = touch.clientY - sharedScreenTouchState.startY;
            const clamped = clampSharedScreenZoomTranslation(
                media,
                sharedScreenZoomState.scale,
                sharedScreenTouchState.startTranslateX + dx,
                sharedScreenTouchState.startTranslateY + dy,
            );
            sharedScreenZoomState.translateX = clamped.x;
            sharedScreenZoomState.translateY = clamped.y;
            applySharedScreenZoom();
            event.preventDefault();
        }
    }, {passive: false});

    stage.addEventListener('touchend', event => {
        if (!sharedScreenTouchState)
            return;
        if (event.touches.length === 0) {
            if (sharedScreenZoomState.scale <= 1.02)
                resetSharedScreenZoom();
            sharedScreenTouchState = null;
            return;
        }
        if (event.touches.length === 1 && sharedScreenZoomState.scale > 1) {
            const touch = event.touches[0];
            sharedScreenTouchState = {
                mode: 'pan',
                startX: touch.clientX,
                startY: touch.clientY,
                startTranslateX: sharedScreenZoomState.translateX,
                startTranslateY: sharedScreenZoomState.translateY,
            };
            return;
        }
        sharedScreenTouchState = null;
    }, {passive: true});

    stage.addEventListener('touchcancel', () => {
        sharedScreenTouchState = null;
    }, {passive: true});
}

function syncSoloLayout() {
    const videoContainer = getVideoContainer();
    const gridHost = getConferenceGridHost();
    const grid = getMosaicGrid();
    const stageSlot = getStageSlot();
    const strip = getParticipantStrip();
    const selfPreviewSlot = getSelfPreviewSlot();
    const empty = document.getElementById('stage-empty');
    if (!videoContainer || !gridHost || !grid || !stageSlot || !strip || !selfPreviewSlot || !empty)
        return;

    previewFocusOnSelf = false;
    const peers = getConferenceLayoutPeers();
    const soloPeer = peers[0] || null;
    const stagedStream = soloPeer ? getPeerStream(soloPeer) : null;
    stagedLocalId = stagedStream ? stagedStream.localId : null;
    setStageCardMode('camera');

    setConferenceContainerMode(videoContainer, 'solo');
    setConferencePreviewState(videoContainer, false);
    setConferenceSoloShareState(videoContainer, false);
    setConferenceFocusState(false);

    const stagePeers = [];
    peers.forEach(peer => {
        clearPeerPresentation(peer);
        ensureConferencePeerDisplay(peer);
        if (peer === soloPeer) {
            peer.classList.add('peer-stage');
            stagePeers.push(peer);
        }
    });
    syncContainerChildren(stageSlot, stagePeers);
    syncContainerChildren(grid, []);
    syncContainerChildren(strip, []);
    setSelfPreviewPeer(selfPreviewSlot, null);
    setVisibility('stage-empty', !soloPeer);
    const controls = getStageLocalControls();
    if (controls)
        controls.classList.toggle('invisible', !serverConnection || !serverConnection.socket);
}

function syncGridLayout(mode) {
    const videoContainer = getVideoContainer();
    const gridHost = getConferenceGridHost();
    const grid = getMosaicGrid();
    const stageSlot = getStageSlot();
    const strip = getParticipantStrip();
    const selfPreviewSlot = getSelfPreviewSlot();
    const empty = document.getElementById('stage-empty');
    if (!videoContainer || !gridHost || !grid || !stageSlot || !strip || !selfPreviewSlot || !empty)
        return;

    if (mode !== 'duo' && mode !== 'group')
        previewFocusOnSelf = false;
    stagedLocalId = null;
    setStageCardMode(null);
    setConferenceContainerMode(videoContainer, mode);
    setConferenceFocusState(false);
    setConferenceSoloShareState(videoContainer, false);

    const peers = getConferenceLayoutPeers();
    const localPreviewPeer = chooseGridSelfPreviewPeer(grid, peers, mode);
    setConferencePreviewState(videoContainer, !!localPreviewPeer);

    const gridPeers = [];
    peers.forEach(peer => {
        clearPeerPresentation(peer);
        ensureConferencePeerDisplay(peer);
        if (peer === localPreviewPeer)
            return;
        gridPeers.push(peer);
    });
    syncContainerChildren(grid, gridPeers);
    syncContainerChildren(stageSlot, []);
    syncContainerChildren(strip, []);
    setSelfPreviewPeer(selfPreviewSlot, localPreviewPeer || null);

    const visiblePeers = gridPeers.filter(isPeerVisible);
    layoutPeerGrid(grid, visiblePeers, mode);
    videoContainer.classList.toggle(
        'layout-two-main',
        mode === 'group' && !!localPreviewPeer && !isCompactMobileLayout() && visiblePeers.length === 2,
    );

    setVisibility('stage-empty', !visiblePeers.length && !localPreviewPeer);
    const controls = getStageLocalControls();
    if (controls)
        controls.classList.toggle('invisible', !serverConnection || !serverConnection.socket);
}

function syncFocusedLayout(peer) {
    const videoContainer = getVideoContainer();
    const grid = getMosaicGrid();
    const stageSlot = getStageSlot();
    const strip = getParticipantStrip();
    const selfPreviewSlot = getSelfPreviewSlot();
    const empty = document.getElementById('stage-empty');
    if (!videoContainer || !grid || !stageSlot || !strip || !selfPreviewSlot || !empty)
        return;

    stagedLocalId = peer.id.replace('peer-', '');
    const focusedStream = getPeerStream(peer);
    const participantPeers = getConferenceLayoutPeers();
    const localPreviewPeer = focusedStream && focusedStream.label === 'screenshare'
        ? (
            getLiveLocalConferencePeer() ||
            getLocalCameraPreviewPeer(participantPeers, false) ||
            getCurrentLocalSelfPreviewPeer(selfPreviewSlot)
        )
        : null;
    setStageCardMode(focusedStream && focusedStream.label === 'screenshare' ? 'sharing' : 'camera');
    setConferenceContainerMode(videoContainer, 'focus');
    setConferencePreviewState(videoContainer, !!(localPreviewPeer && localPreviewPeer !== peer));
    setConferenceSoloShareState(videoContainer, false);
    setConferenceFocusState(true);

    clearPeerPresentation(peer);
    ensureConferencePeerDisplay(peer);
    peer.classList.add('peer-stage');

    syncContainerChildren(stageSlot, [peer]);
    syncContainerChildren(grid, []);
    syncContainerChildren(strip, []);
    setSelfPreviewPeer(
        selfPreviewSlot,
        localPreviewPeer && localPreviewPeer !== peer ? localPreviewPeer : null,
    );
    setVisibility('stage-empty', false);

    const controls = getStageLocalControls();
    if (controls)
        controls.classList.toggle('invisible', !serverConnection || !serverConnection.socket);
}

function syncSpotlightLayout() {
    const stageSlot = getStageSlot();
    const grid = getMosaicGrid();
    const strip = getParticipantStrip();
    const selfPreviewSlot = getSelfPreviewSlot();
    const empty = document.getElementById('stage-empty');
    const videoContainer = getVideoContainer();
    if (!stageSlot || !grid || !strip || !selfPreviewSlot || !empty || !videoContainer)
        return;

    previewFocusOnSelf = false;
    setConferenceContainerMode(videoContainer, 'spotlight');
    setConferenceFocusState(false);
    stagedLocalId = chooseStageStream();
    const stagedStream = stagedLocalId && serverConnection ?
        serverConnection.findByLocalId(stagedLocalId) : null;
    const spotlightParticipants = getConferenceParticipants();
    const soloShare = !!(
        stagedStream &&
        stagedStream.label === 'screenshare' &&
        spotlightParticipants.length <= 1
    );
    setStageCardMode(stagedStream && stagedStream.label === 'screenshare' ?
        'sharing' : 'camera');
    setConferenceSoloShareState(videoContainer, soloShare);

    const stagePeer = stagedLocalId ? getPeer(stagedLocalId) : null;
    const participantPeers = getConferenceLayoutPeers();
    const localPreviewPeer =
        getLiveLocalConferencePeer() ||
        getLocalCameraPreviewPeer(participantPeers, false) ||
        getCurrentLocalSelfPreviewPeer(selfPreviewSlot);
    const stagePeers = [];
    const stripPeers = [];
    const participantCount = spotlightParticipants.length;
    const stagedUserId = getStreamUserId(stagedStream);

    if (stagePeer) {
        clearPeerPresentation(stagePeer);
        ensureConferencePeerDisplay(stagePeer);
        stagePeer.classList.add('peer-stage');
        stagePeers.push(stagePeer);
    }

    participantPeers.forEach(peer => {
        if (peer === localPreviewPeer)
            return;
        if (stagePeer && peer === stagePeer)
            return;
        clearPeerPresentation(peer);
        ensureConferencePeerDisplay(peer);
        if (participantCount <= 2)
            return;

        const peerUserId = getConferencePeerUserId(peer);
        if (
            stagedStream &&
            stagedStream.label === 'screenshare' &&
            peerUserId &&
            peerUserId === stagedUserId
        ) {
            return;
        }

        stripPeers.push(peer);
    });
    syncContainerChildren(stageSlot, stagePeers);
    syncContainerChildren(strip, stripPeers);
    syncContainerChildren(grid, []);
    setSelfPreviewPeer(selfPreviewSlot, localPreviewPeer || null);
    setConferencePreviewState(videoContainer, !!localPreviewPeer);

    setVisibility('stage-empty', !stagedLocalId);
    const controls = getStageLocalControls();
    if (controls) {
        controls.classList.toggle('invisible', !serverConnection || !serverConnection.socket);
    }
}

let conferenceLayoutFrame = null;
let conferenceLayoutKey = '';
let lastViewportHeight = 0;
let lastViewportWidth = 0;
let viewportRefreshFrame = null;

function getLayoutChildrenKey(container) {
    if (!container)
        return '';
    return Array.from(container.children)
        .map(child => child.id || child.dataset.placeholderUserId || child.tagName)
        .join('|');
}

function updateConferenceLayoutKey(mode) {
    const nextKey = [
        mode,
        stagedLocalId || '',
        focusedConferenceLocalId || '',
        previewFocusOnSelf ? 'self-expanded' : 'self-default',
        getLayoutChildrenKey(getStageSlot()),
        getLayoutChildrenKey(getMosaicGrid()),
        getLayoutChildrenKey(getParticipantStrip()),
        getLayoutChildrenKey(getSelfPreviewSlot()),
    ].join('::');
    const changed = nextKey !== conferenceLayoutKey;
    conferenceLayoutKey = nextKey;
    return changed;
}

function runConferenceLayout() {
    const mode = getConferenceLayoutMode();
    const focusedPeer = mode !== 'spotlight' ? getFocusedConferencePeer() : null;
    const renderedMode = focusedPeer ? 'focus' : mode;
    if (focusedPeer)
        syncFocusedLayout(focusedPeer);
    else if (mode === 'spotlight')
        syncSpotlightLayout();
    else if (mode === 'solo')
        syncSoloLayout();
    else
        syncGridLayout(mode);
    if (!focusedPeer && focusedConferenceLocalId)
        focusedConferenceLocalId = null;
    const layoutChanged = updateConferenceLayoutKey(renderedMode);
    updateStageBadge();
    applySharedScreenZoom();
    if (layoutChanged)
        scheduleReconsiderDownRate();
}

function syncConferenceLayout() {
    if (conferenceLayoutFrame)
        return;
    conferenceLayoutFrame = window.requestAnimationFrame(() => {
        conferenceLayoutFrame = null;
        runConferenceLayout();
    });
}

function scheduleConferenceLayout() {
    syncConferenceLayout();
}

function scheduleViewportLayoutRefresh() {
    if (viewportRefreshFrame)
        return;
    viewportRefreshFrame = window.requestAnimationFrame(() => {
        viewportRefreshFrame = null;
        const hasmedia = getPeerCount() > 0;
        setVisibility('video-container', hasmedia);
        if (!hasmedia)
            return;
        scheduleConferenceLayout();
        applyMobilePreviewState(getSelfPreviewSlot(), true);
        scheduleReconsiderDownRate();
    });
}

function setChatOpen(open) {
    const chat = document.getElementById('left');
    const layout = document.getElementById('mainrow');
    const chatButton = document.getElementById('chatbutton');
    const wasOpen = !!(chat && !chat.classList.contains('chat-panel-closed'));
    if (!open && chat && document.activeElement instanceof HTMLElement &&
        chat.contains(document.activeElement)) {
        if (chatButton instanceof HTMLElement)
            chatButton.focus();
        else
            document.activeElement.blur();
    }
    if (chat) {
        chat.classList.remove('invisible');
        chat.classList.toggle('chat-panel-closed', !open);
        chat.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open)
            bringPanelToFront(chat);
    }
    if (layout)
        layout.classList.toggle('layout-chat-open', open);
    if (chatButton)
        chatButton.classList.toggle('chat-active', open);
    if (wasOpen !== open && shouldRelayoutForPanelToggle())
        resizePeers();
}

function isChatOpen() {
    const chat = document.getElementById('left');
    return !!(chat && !chat.classList.contains('chat-panel-closed'));
}

function setToolPanel(panelName, open) {
    const panel = document.getElementById('sidebarnav');
    const layout = document.getElementById('mainrow');
    if (!panel)
        return;

    if (panelName)
        activeToolPanel = panelName;

    document.querySelectorAll('.tool-rail-button').forEach(button => {
        if (!(button instanceof HTMLElement))
            return;
        const active = button.dataset.panel === activeToolPanel && open;
        button.classList.toggle('active', active);
    });

    document.querySelectorAll('.tool-section').forEach(section => {
        if (!(section instanceof HTMLElement))
            return;
        section.classList.toggle('active', section.dataset.panel === activeToolPanel);
    });

    panel.classList.toggle('panel-closed', !open);
    if (layout)
        layout.classList.toggle('layout-tool-open', open);
    if (open)
        bringPanelToFront(panel);
    const heading = document.getElementById('tool-panel-heading');
    if (heading) {
        const titles = {
            media: 'Devices',
            video: 'Settings',
            filters: 'Filters',
        };
        heading.textContent = isMobileBurgerLayout() ?
            'Workspace' :
            (titles[activeToolPanel] || 'Settings');
    }

    const mobileToggle = document.getElementById('workspace-toggle-mobile');
    if (mobileToggle)
        mobileToggle.classList.toggle('chat-active', open);
    if (open && activeToolPanel === 'filters' && serverConnection && serverConnection.socket) {
        void ensureFilterOptionsLoaded(true);
        if (deferredStartupExpensiveFilter &&
            !deferredStartupExpensiveFilterNoticeShown) {
            deferredStartupExpensiveFilterNoticeShown = true;
            displayMessage(
                `Remembered ${filters[deferredStartupExpensiveFilter]?.description || 'background effect'} is paused for this session. Choose it again to enable.`,
            );
        }
        const filterSelect = document.getElementById('filterselect');
        const backgroundControls = document.getElementById('background-image-controls');
        if (filterSelect instanceof HTMLSelectElement &&
            backgroundControls instanceof HTMLElement &&
            filterSelect.value === 'background-replace') {
            scheduleBackgroundPresetImagesLoad();
            restoreBackgroundUIState();
        }
    }
}

/**
 * Conditionally hide the video pane.  If force is true, hide it even if
 * there are videos.
 *
 * @param {boolean} [force]
 */
function hideVideo(force) {
    if (getPeerCount() > 0 && !force)
        return;
    if (setVisibility('video-container', false))
        scheduleReconsiderDownRate();
}

/**
 * Show the video pane.
 */
function showVideo() {
    const hasmedia = getPeerCount() > 0;
    const changed = setVisibility('video-container', hasmedia);
    if (hasmedia && changed)
        scheduleConferenceLayout();
    scheduleReconsiderDownRate();
}

/**
 * Returns true if we are running on Safari.
 */
function isSafari() {
    const ua = navigator.userAgent.toLowerCase();
    return ua.indexOf('safari') >= 0 && ua.indexOf('chrome') < 0;
}

/**
 * Returns true if we are running on an old Safari version that has issues
 * with background blur (Safari < 16).
 */
function isOldSafari() {
    if (!isSafari())
        return false;

    const ua = navigator.userAgent;
    // Safari version string looks like "Version/15.6.1"
    const match = ua.match(/Version\/(\d+)\./);
    if (!match)
        return false;  // Assume modern if can't detect

    const majorVersion = parseInt(match[1], 10);
    return majorVersion < 16;
}

/**
 * Returns true if we are running on Firefox.
 */
function isFirefox() {
    const ua = navigator.userAgent.toLowerCase();
    return ua.indexOf('firefox') >= 0;
}

/**
 * setConnected is called whenever we connect or disconnect to the server.
 *
 * @param{boolean} connected
 */
function setConnected(connected) {
    const userbox = document.getElementById('profile');
    const connectionbox = document.getElementById('login-container');
    setVisibility('chatbutton', connected);
    setVisibility('workspace-toggle-mobile', connected);
    if (connected) {
        clearChat();
        clearParticipantPresence();
        userbox.classList.remove('invisible');
        connectionbox.classList.add('invisible');
        displayUsername();
        setChatOpen(!isMobileBurgerLayout());
        setToolPanel(activeToolPanel, false);
    } else {
        expensiveFiltersArmedThisSession = false;
        deferredStartupExpensiveFilter = '';
        deferredStartupExpensiveFilterNoticeShown = false;
        clearParticipantPresence();
        userbox.classList.add('invisible');
        connectionbox.classList.remove('invisible');
        setChatOpen(false);
        clearConferenceUi();
        hideVideo(true);
        setToolPanel(activeToolPanel, false);
    }
}

/**
 * Called when we connect to the server.
 *
 * @this {ServerConnection}
 */
async function gotConnected() {
    if (this !== serverConnection)
        return;
    setConnected(true);
    clearReconnectCooldown();
    try {
        if (reconnectPending && reconnectState) {
            const state = reconnectState;
            reconnectPending = false;
            presentRequested = 'both';
            updateSettings({cameraOff: false});
            setLocalCameraOff(false, false);
            await serverConnection.join(group, state.username, state.credentials);
            return;
        }
        reconnectPending = false;
        await join();
    } catch (e) {
        console.error('gotConnected/join failed:', e);
        displayError(e);
        startReconnectCooldown();
        if (serverConnection)
            serverConnection.close();
    }
}

/**
 * Sets the href field of the "change password" link.
 *
 * @param {string} username
 */
function setChangePassword(username) {
    const s = document.getElementById('chpwspan');
    const a = s.children[0];
    if (!(a instanceof HTMLAnchorElement))
        throw new Error('Bad type for chpwspan');
    if (username) {
        a.href = `/change-password.html?group=${encodeURI(group)}&username=${encodeURI(username)}`;
        a.target = '_blank';
        s.classList.remove('invisible');
    } else {
        a.href = null;
        s.classList.add('invisible');
    }
}

/**
 * Join a group.
 */
async function join() {
    let username = getInputElement('username').value.trim();
    if (username)
        setStoredUsername(username);
    let credentials;
    if (token) {
        pwAuth = false;
        loginPassword = null;  // No password when using token auth
        credentials = {
            type: 'token',
            token: token,
        };
        switch (probingState) {
        case null:
            // when logging in with a token, we need to give the user
            // a chance to interact with the page in order to enable
            // autoplay.  Probe the group first in order to determine if
            // we need a username.  We should really extend the protocol
            // to have a simpler protocol for probing.
            probingState = 'probing';
            username = null;
            break;
        case 'need-username':
        case 'success':
            probingState = null;
            break;
        default:
            console.warn(`Unexpected probing state ${probingState}`);
            probingState = null;
            break;
        }
    } else {
        if (probingState !== null) {
            console.warn(`Unexpected probing state ${probingState}`);
            probingState = null;
        }
        const pw = getInputElement('password').value;
        getInputElement('password').value = '';
        // Only store password if it's non-empty
        if (pw) {
            loginPassword = pw;
        } else {
            loginPassword = null;
        }
        if (!groupStatus.authServer) {
            pwAuth = true;
            credentials = pw;
        } else {
            pwAuth = false;
            credentials = {
                type: 'authServer',
                authServer: groupStatus.authServer,
                location: location.href,
                password: pw,
            };
        }
    }

    try {
        reconnectState = {username, credentials};
        await serverConnection.join(group, username, credentials, {
            muted: !!getSettings().localMute,
        });
    } catch (e) {
        console.error(e);
        // Add login context to error
        if (e instanceof Error) {
            e.message = `Login failed for user '${username}': ${e.message}`;
        }
        displayError(e);
        startReconnectCooldown();
        reconnectState = null;
        serverConnection.close();
    }
}

/**
 * @this {ServerConnection}
 */
function onPeerConnection() {
    if (!getSettings().forceRelay)
        return null;
    const old = this.rtcConfiguration;
    /** @type {RTCConfiguration} */
    const conf = {};
    for (const key in old)
        conf[key] = old[key];
    conf.iceTransportPolicy = 'relay';
    return conf;
}

/**
 * @this {ServerConnection}
 * @param {number} code
 * @param {string} reason
 */
function gotClose(code, reason) {
    if (this !== serverConnection)
        return;

    closeSafariStream();
    setConnected(false);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Log all disconnect reasons
    const closeMeta = {
        code: code,
        reason: reason,
        timestamp: new Date().toISOString(),
        reconnectAttempts: reconnectAttempts,
        clientInitiatedClose: !!this.closeRequestedByClient,
        clientCloseReason: this.closeRequestReason || '',
        clientCloseStackTop: this.closeRequestStack ?
            (this.closeRequestStack.split('\n')[1] || '').trim() :
            '',
        lastClientError: this.lastErrorMessage || '',
    };
    console.log('[Connection] WebSocket closed', closeMeta);
    console.log('[Connection] WebSocket closed JSON', JSON.stringify(closeMeta));

    const willReconnect =
        code !== 1000 &&
        reconnectState &&
        reconnectAttempts < reconnectMaxAttempts;

    if (code !== 1000 && !willReconnect) {
        console.warn('Socket close', code, reason);
        displayError(`Connection closed: ${reason || 'Unknown reason'} (code ${code})`);
        if (!this.closeRequestedByClient)
            startReconnectCooldown();
    }

    // Attempt reconnection on unexpected disconnects
    if (willReconnect) {
        let delay = reconnectBaseDelay * Math.pow(2, reconnectAttempts);
        delay = Math.min(delay, 30000);
        reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${reconnectMaxAttempts})...`);
        displayWarning(`Connection lost. Reconnecting (${reconnectAttempts}/${reconnectMaxAttempts})...`);
        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
                reconnectPending = true;
                await serverConnect();
            } catch (e) {
                console.error('Reconnect failed:', e);
                reconnectPending = false;
                // If reconnect fails due to auth error, show user-friendly message
                if (e && e.message && e.message.includes('not authorised')) {
                    displayError('Reconnection failed: Not authorized. You may need to rejoin the room.');
                    reconnectAttempts = reconnectMaxAttempts; // Stop trying
                } else {
                    displayError('Reconnection failed: ' + (e.message || e));
                }
                closeUpMedia();
            }
        }, delay);
        return;
    }

    // Close media streams when not reconnecting
    closeUpMedia();

    reconnectPending = false;
    reconnectState = null;
    reconnectAttempts = 0;

    const form = document.getElementById('loginform');
    if (!(form instanceof HTMLFormElement))
        throw new Error('Bad type for loginform');

    // Reset login permission state for next connection
    _loginPermissionsGranted = false;
    updateReconnectCooldownUi();
    // Hide and reset device selection cards
    const deviceSelection = document.getElementById('login-device-selection');
    const cameraCard = document.getElementById('camera-device-card');
    const microphoneCard = document.getElementById('microphone-device-card');
    if (deviceSelection) {
        deviceSelection.classList.add('hidden');
    }
    if (cameraCard) {
        cameraCard.classList.add('hidden');
        cameraCard.classList.remove('ok');
    }
    if (microphoneCard) {
        microphoneCard.classList.add('hidden');
        microphoneCard.classList.remove('ok');
    }
}

/**
 * @this {ServerConnection}
 * @param {Stream} c
 */
function gotDownStream(c) {
    if (this !== serverConnection) {
        try {
            c.close();
        } catch (_e) {
            // ignore stale stream close failures
        }
        return;
    }
    const isFF = isFirefox();
    debugLog('[gotDownStream] Received downstream', c.localId, 'from', c.username, 'Firefox:', isFF);
    c.onclose = function(replace) {
        if (!replace) {
            delMedia(c.localId);
            refreshParticipantPresence(c.source);
        }
    };
    c.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    c.ondowntrack = function(_track, _transceiver, _stream) {
        debugLog('[ondowntrack] Track received for', c.localId, 'track kind:', _track ? _track.kind : 'unknown', 'stream:', !!_stream, 'Firefox:', isFF);
        if (isFF) {
            debugLog('[ondowntrack] Firefox - track details:', {
                kind: _track?.kind,
                id: _track?.id,
                enabled: _track?.enabled,
                muted: _track?.muted,
                readyState: _track?.readyState,
            });
        }
        setMedia(c);
    };
    c.onnegotiationcompleted = function() {
        debugLog('[onnegotiationcompleted] Negotiation completed for', c.localId, 'Firefox:', isFF);
        resetMedia(c);
    };
    c.onstatus = function(_status) {
        debugLog('[onstatus] Status for', c.localId, ':', _status, 'Firefox:', isFF);
        setMediaStatus(c);
    };
    c.onstats = gotDownStats;
    if (shouldRunActivityDetection())
        c.setStatsInterval(getActivityDetectionInterval());
    else
        c.setStatsInterval(0);

    setMedia(c);
}

// Store current browser viewport height in css variable
function setViewportHeight() {
    const visualViewport = window.visualViewport;
    const nextHeight = Math.round(visualViewport?.height || window.innerHeight);
    const nextWidth = Math.round(visualViewport?.width || window.innerWidth);
    const nextTop = Math.round(visualViewport?.offsetTop || 0);
    const nextLeft = Math.round(visualViewport?.offsetLeft || 0);
    const heightChanged = nextHeight !== lastViewportHeight;
    const widthChanged = nextWidth !== lastViewportWidth;
    const topChanged = nextTop !== (setViewportHeight.lastTop || 0);
    const leftChanged = nextLeft !== (setViewportHeight.lastLeft || 0);

    if (!heightChanged && !widthChanged && !topChanged && !leftChanged)
        return;

    lastViewportHeight = nextHeight;
    lastViewportWidth = nextWidth;
    setViewportHeight.lastTop = nextTop;
    setViewportHeight.lastLeft = nextLeft;
    document.documentElement.style.setProperty('--vh', `${nextHeight / 100}px`);
    document.documentElement.style.setProperty('--vvh', `${nextHeight}px`);
    document.documentElement.style.setProperty('--vvw', `${nextWidth}px`);
    document.documentElement.style.setProperty('--vv-top', `${nextTop}px`);
    document.documentElement.style.setProperty('--vv-left', `${nextLeft}px`);
    applyPerformanceProfileChrome();
    scheduleViewportLayoutRefresh();
}

// On resize and orientation change, we update viewport height
addEventListener('resize', setViewportHeight);
addEventListener('orientationchange', setViewportHeight);
window.visualViewport?.addEventListener('resize', setViewportHeight);
window.visualViewport?.addEventListener('scroll', setViewportHeight);
document.addEventListener('focusin', e => {
    if (!(e.target instanceof HTMLElement))
        return;
    if (!e.target.matches('input, textarea, select, [contenteditable="true"]'))
        return;
    requestAnimationFrame(() => setViewportHeight());
}, true);
document.addEventListener('focusout', e => {
    if (!(e.target instanceof HTMLElement))
        return;
    if (!e.target.matches('input, textarea, select, [contenteditable="true"]'))
        return;
    setTimeout(() => setViewportHeight(), 80);
}, true);
document.addEventListener('visibilitychange', () => {
    const paused = document.visibilityState !== 'visible';
    setFiltersPaused(paused);
    setActivityDetectionPaused(paused);
    if (!paused)
        scheduleViewportLayoutRefresh();
});
addEventListener('pagehide', () => {
    setFiltersPaused(true);
    setActivityDetectionPaused(true);
});

getButtonElement('presentbutton').onclick = async function(e) {
    e.preventDefault();
    const button = this;
    if (!(button instanceof HTMLButtonElement))
        throw new Error('Unexpected type for this.');
    // there's a potential race condition here: the user might click the
    // button a second time before the stream is set up and the button hidden.
    button.disabled = true;
    try {
        const id = findUpMedia('camera');
        if (!id)
            await addLocalMedia();
    } finally {
        button.disabled = false;
    }
};

getButtonElement('unpresentbutton').onclick = function(e) {
    e.preventDefault();
    closeUpMedia('camera');
};

/**
 * @param {string} id
 * @param {boolean} visible
 */
function setVisibility(id, visible) {
    const elt = document.getElementById(id);
    if (!elt)
        return false;
    const isVisible = !elt.classList.contains('invisible');
    if (isVisible === visible)
        return false;
    if (visible)
        elt.classList.remove('invisible');
    else
        elt.classList.add('invisible');
    return true;
}

/**
 * Shows and hides various UI elements depending on the protocol state.
 */
function setButtonsVisibility() {
    const connected = serverConnection && serverConnection.socket;
    const permissions = serverConnection ? serverConnection.permissions : [];
    const canWebrtc = !(typeof RTCPeerConnection === 'undefined');
    const canPresent = canWebrtc &&
        ('mediaDevices' in navigator) &&
        ('getUserMedia' in navigator.mediaDevices) &&
        permissions.indexOf('present') >= 0;
    const canShare = canWebrtc &&
        ('mediaDevices' in navigator) &&
        ('getDisplayMedia' in navigator.mediaDevices) &&
        permissions.indexOf('present') >= 0;
    // User can chat if they have 'message' or 'present' permission
    const canChat = permissions.indexOf('message') >= 0 || permissions.indexOf('present') >= 0;
    const localStream = findUpMedia('camera');
    const local = !!localStream;
    const localVideoEnabled = !!(localStream && hasVideoTrack(localStream.stream));
    const mediacount = getPeerCount();
    const sharing = !!findUpMedia('screenshare');

    // don't allow multiple presentations
    setVisibility('presentbutton', canPresent && !local);
    setVisibility('unpresentbutton', local);

    // Show mute button when connected
    setVisibility('mutebutton', connected);
    setVisibility('camerabutton', connected && canPresent && local);
    setLocalCameraOff(local ? !localVideoEnabled : !!getSettings().cameraOff, false);

    // allow multiple shared documents
    setVisibility('sharebutton', canShare);

    const shareButton = document.getElementById('sharebutton');
    if (shareButton) {
        const shareIcon = shareButton.querySelector('span .fas');
        const shareLabel = shareButton.querySelector('label');
        shareButton.classList.toggle('nav-cancel', sharing);
        if (shareIcon) {
            shareIcon.classList.toggle('fa-desktop', !sharing);
            shareIcon.classList.toggle('fa-stop', sharing);
        }
        if (shareLabel)
            shareLabel.textContent = sharing ? 'Stop sharing' : 'Share screen';
    }

    // Show chat button when connected
    setVisibility('chatbutton', connected);
    setVisibility('workspace-toggle-mobile', connected);

    setVisibility('mediaoptions', canPresent);
    setVisibility('sendform', canPresent);
    setVisibility('simulcastform', canPresent);

    // Only show chat input when user has permission to send messages
    setVisibility('inputform', connected && canChat);
    setVisibility('inputbutton', connected && canChat);

    // Show helpful message when connected but can't present (no camera/mic/permissions)
    const showNoMediaMessage = connected && !canPresent && mediacount === 0;
    setVisibility('no-media-message', showNoMediaMessage);
    updateStageBadge();
}

/**
 * Sets the local mute state.  If reflect is true, updates the stored settings.
 *
 * @param {boolean} mute
 * @param {boolean} [reflect]
 */
function setLocalMute(mute, reflect) {
    muteLocalTracks(mute);
    const button = document.getElementById('mutebutton');
    const icon = button && button.querySelector("span .fas");
    if (mute) {
        if (icon) {
            icon.classList.add('fa-microphone-slash');
            icon.classList.remove('fa-microphone');
        }
        if (button)
            button.classList.add('muted');
    } else {
        if (icon) {
            icon.classList.remove('fa-microphone-slash');
            icon.classList.add('fa-microphone');
        }
        if (button)
            button.classList.remove('muted');
    }
    if (reflect)
        updateSettings({localMute: mute});
    if (serverConnection && serverConnection.users &&
        serverConnection.users[serverConnection.id]) {
        const user = serverConnection.users[serverConnection.id];
        if (!user.data)
            user.data = {};
        user.data.muted = mute;
        refreshParticipantPresence(serverConnection.id, user);
    }
    if (serverConnection && serverConnection.socket) {
        try {
            serverConnection.userAction('setdata', serverConnection.id, {
                muted: mute,
            });
        } catch (e) {
            console.warn('Failed to sync mute state:', e);
        }
    }
}

function setLocalCameraOff(off, reflect) {
    const value = !!off;
    if (reflect)
        updateSettings({cameraOff: value});
    const button = document.getElementById('camerabutton');
    if (!button)
        return;
    const icon = button.querySelector('span .fas');
    const label = button.querySelector('label');
    button.classList.toggle('nav-cancel', !value);
    button.setAttribute('aria-label', value ? 'Start camera' : 'Stop camera');
    if (icon) {
        icon.classList.toggle('fa-video', !value);
        icon.classList.toggle('fa-video-slash', value);
    }
    if (label)
        label.textContent = value ? 'Start camera' : 'Stop camera';
}

function buildAudioConstraints(settings) {
    /** @type{boolean|MediaTrackConstraints} */
    const audio = settings.audio ? {deviceId: settings.audio} : false;
    if (audio && !settings.preprocessing) {
        audio.echoCancellation = false;
        audio.noiseSuppression = false;
        audio.autoGainControl = false;
    }
    return audio;
}

function buildVideoConstraints(settings) {
    /** @type{MediaTrackConstraints} */
    const video = settings.video ?
        {deviceId: settings.video} :
        {facingMode: 'user'};

    const resolution = settings.resolution;
    if (resolution) {
        video.width = {ideal: resolution[0]};
        video.height = {ideal: resolution[1]};
    } else if (settings.blackboardMode) {
        video.width = {min: 640, ideal: 1920};
        video.height = {min: 400, ideal: 1080};
    } else {
        video.aspectRatio = {ideal: 4 / 3};
    }

    const maxFrameRate = getAdaptiveMaxFrameRate();
    if (maxFrameRate > 0)
        video.frameRate = {ideal: maxFrameRate, max: maxFrameRate};

    return video;
}

function hasActiveAudioTrack(stream) {
    return !!(stream && stream.getAudioTracks().some(t => t.readyState !== 'ended'));
}

function refreshLocalCameraUi(c) {
    if (!c)
        return;
    c.setStream(c.stream);
    const peer = getPeer(c.localId);
    if (peer)
        updatePeerVideoState(c, peer);
    setLabel(c);
    const media = document.getElementById('media-' + c.localId);
    if (media instanceof HTMLVideoElement && hasVideoTrack(c.stream)) {
        media.play().catch(_e => {
            // Autoplay may still be blocked on some browsers; ignore.
        });
    }
    scheduleConferenceLayout();
    setButtonsVisibility();
}

async function stopCameraTrackInSession(c) {
    if (!c || !c.stream)
        return false;

    if (!hasActiveAudioTrack(c.stream)) {
        displayMessage('Keep your microphone active or use Disable to leave the conference.');
        return false;
    }

    const videoTracks = c.stream.getVideoTracks().filter(t => t.readyState !== 'ended');
    if (!videoTracks.length) {
        setLocalCameraOff(true, true);
        refreshLocalCameraUi(c);
        return true;
    }

    videoTracks.forEach(track => {
        try {
            c.stream.removeTrack(track);
        } catch (_e) {
            // Ignore detach errors for stale tracks.
        }
        try {
            track.stop();
        } catch (_e) {
            // Ignore stop errors.
        }
    });

    setLocalCameraOff(true, true);
    refreshLocalCameraUi(c);
    return true;
}

async function startCameraTrackInSession(c) {
    if (!c || !c.stream)
        return false;
    if (hasVideoTrack(c.stream)) {
        setLocalCameraOff(false, true);
        refreshLocalCameraUi(c);
        return true;
    }

    let freshVideoStream = null;
    try {
        freshVideoStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: buildVideoConstraints(getSettings()),
        });
    } catch (e) {
        displayError(e);
        return false;
    }

    const freshVideoTrack = freshVideoStream.getVideoTracks()[0] || null;
    if (!freshVideoTrack) {
        stopStream(freshVideoStream);
        return false;
    }

    c.stream.addTrack(freshVideoTrack);
    setLocalCameraOff(false, true);
    refreshLocalCameraUi(c);
    return true;
}

getSelectElement('videoselect').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({video: this.value});
    replaceCameraStream();
};

getSelectElement('audioselect').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({audio: this.value});
    replaceCameraStream();
};

getSelectElement('audiooutputselect').onchange = async function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({audioOutput: this.value});
    await applyAudioOutputToCurrentMedia(true);
};

getInputElement('mirrorbox').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({mirrorView: this.checked});
    // no need to reopen the camera
    replaceUpStreams('camera');
};

getInputElement('blackboardbox').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({blackboardMode: this.checked});
    replaceCameraStream();
};

getInputElement('preprocessingbox').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({preprocessing: this.checked});
    replaceCameraStream();
};

getInputElement('hqaudiobox').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({hqaudio: this.checked});
    replaceCameraStream();
};

document.getElementById('mutebutton').onclick = function(e) {
    e.preventDefault();
    let localMute = getSettings().localMute;
    if (localMute && !findUpMedia('camera')) {
        displayMessage('Please use Enable to enable your camera or microphone.');
    } else {
        localMute = !localMute;
        setLocalMute(localMute, true);
    }
};

document.getElementById('camerabutton').onclick = async function(e) {
    e.preventDefault();
    const local = findUpMedia('camera');
    if (!local) {
        displayMessage('Please use Enable to enable your camera or microphone.');
        return;
    }
    if (this.dataset.busy === '1')
        return;
    const nextOff = hasVideoTrack(local.stream);
    this.dataset.busy = '1';
    try {
        let ok;
        if (local.userdata.filterDefinition) {
            setLocalCameraOff(nextOff, true);
            await replaceCameraStream();
            const current = findUpMedia('camera');
            ok = !!(current &&
                (nextOff ? !hasVideoTrack(current.stream) : hasVideoTrack(current.stream)));
        } else if (nextOff) {
            ok = await stopCameraTrackInSession(local);
        } else {
            ok = await startCameraTrackInSession(local);
        }
        if (!ok)
            setLocalCameraOff(!nextOff, false);
    } finally {
        delete this.dataset.busy;
        setButtonsVisibility();
    }
};

document.getElementById('sharebutton').onclick = function(e) {
    e.preventDefault();
    if (findUpMedia('screenshare')) {
        closeUpMedia('screenshare');
    } else {
        addShareMedia();
    }
};

const focusCloseButton = document.getElementById('focus-close');
if (focusCloseButton) {
    focusCloseButton.onclick = async function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            try {
                await exitElementFullscreen();
            } catch (error) {
                console.error('[Fullscreen] Failed to exit fullscreen:', error);
            }
        }
        closeConferenceFocus();
    };
}

const stageFullscreenButton = getStageFullscreenButton();
if (stageFullscreenButton) {
    stageFullscreenButton.onclick = async function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.classList.contains('invisible'))
            return;
        try {
            if (isStageFullscreenActive())
                await exitElementFullscreen();
            else if (stagedLocalId)
                await openSharedScreenFullscreen(stagedLocalId);
        } catch (error) {
            console.error('[Fullscreen] Failed to toggle shared screen fullscreen:', error);
            displayError(error);
        } finally {
            updateStageFullscreenState();
        }
    };
}

document.addEventListener('fullscreenchange', updateStageFullscreenState);
document.addEventListener('webkitfullscreenchange', updateStageFullscreenState);

// Chat button - toggle chat panel visibility
document.getElementById('chatbutton').onclick = function(e) {
    e.preventDefault();
    setChatOpen(!isChatOpen());
};

getSelectElement('filterselect').onchange = async function(_e) {
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    if (needsExpensiveFilterOption(this.value))
        await ensureFilterOptionsLoaded(true);
    expensiveFiltersArmedThisSession = needsExpensiveFilterOption(this.value);
    deferredStartupExpensiveFilter = '';
    deferredStartupExpensiveFilterNoticeShown = false;
    updateSettings({filter: this.value});
    const c = findUpMedia('camera');
    if (c) {
        const filter = (this.value && filters[this.value]) || null;
        if (filter)
            c.userdata.filterDefinition = filter;
        else
            delete c.userdata.filterDefinition;
        try {
            await replaceUpStream(c);
        } catch (e) {
            console.error('[Filter] Failed to replace stream after filter change:', e);
            displayError(e);
        }
    }

    // Show/hide background controls based on filter selection
    const bgControls = document.getElementById('background-image-controls');
    if (bgControls) {
        if (this.value === 'background-replace') {
            scheduleBackgroundPresetImagesLoad();
            bgControls.classList.remove('invisible');
            // Restore UI state from sessionStorage
            restoreBackgroundUIState();
        } else {
            bgControls.classList.add('invisible');
        }
    }
};

/**
 * Returns the desired max video throughput depending on the settings.
 *
 * @returns {number}
 */
function getMaxVideoThroughput() {
    const v = getSettings().send;
    switch (v) {
    case 'lowest':
        return 150000;
    case 'low':
        return 300000;
    case 'normal':
        return 700000;
    case 'unlimited':
        return null;
    default:
        console.error('Unknown video quality', v);
        return 700000;
    }
}

getSelectElement('sendselect').onchange = async function(_e) {
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({send: this.value});
    await reconsiderSendParameters();
};

getSelectElement('simulcastselect').onchange = async function(_e) {
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({simulcast: this.value});
    await reconsiderSendParameters();
};

// Background image controls event handlers
const bgPresetItems = document.querySelectorAll('.bg-preset-item');
bgPresetItems.forEach(item => {
    item.addEventListener('click', function() {
        const bgPath = this.getAttribute('data-bg');
        if (!bgPath) return;
        scheduleBackgroundPresetImagesLoad();

        // Store selection in sessionStorage
        sessionStorage.setItem('backgroundPreset', bgPath);
        sessionStorage.removeItem('backgroundImage');

        // Update UI
        updateBackgroundUISelection('preset', bgPath);

        // Apply background to active filter
        applyBackgroundToFilter();

        console.log('[BackgroundReplace] Selected preset:', bgPath);
    });
});

// Custom background upload handler
const uploadBgButton = document.getElementById('upload-bg-button');
if (uploadBgButton) {
    uploadBgButton.addEventListener('click', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';

        input.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;

            try {
                // Read and process the image
                const dataUrl = await processBackgroundImage(file);

                // Store in sessionStorage
                sessionStorage.setItem('backgroundImage', dataUrl);
                sessionStorage.removeItem('backgroundPreset');

                // Update UI
                updateBackgroundUISelection('custom', file.name);

                // Apply background to active filter
                applyBackgroundToFilter();

                console.log('[BackgroundReplace] Uploaded custom image:', file.name);
            } catch (err) {
                console.error('[BackgroundReplace] Failed to upload image:', err);
                displayError(`Failed to upload image: ${err.message}`);
            }
        };

        input.click();
    });
}

// Clear custom background handler
const clearBgButton = document.getElementById('clear-bg-button');
if (clearBgButton) {
    clearBgButton.addEventListener('click', function() {
        sessionStorage.removeItem('backgroundImage');

        // Update UI
        const customLabel = document.getElementById('custom-bg-label');
        if (customLabel) {
            customLabel.classList.add('invisible');
        }

        // Apply to filter (will use gray fallback)
        applyBackgroundToFilter();

        console.log('[BackgroundReplace] Cleared custom background');
    });
}

/**
 * Process uploaded background image: resize and compress
 * @param {File} file - The uploaded file
 * @returns {Promise<string>} - Data URL of processed image
 */
async function processBackgroundImage(file) {
    const MAX_WIDTH = 1920;
    const MAX_HEIGHT = 1080;
    const JPEG_QUALITY = 0.8;

    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();

        reader.onload = function(e) {
            img.src = e.target.result;
        };

        img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            // Calculate scaled dimensions
            if (width > MAX_WIDTH || height > MAX_HEIGHT) {
                const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }

            canvas.width = width;
            canvas.height = height;

            // Draw and compress
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            try {
                const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

                // Check size (sessionStorage has ~5MB limit)
                const size = dataUrl.length * 0.75; // rough byte size
                if (size > 4 * 1024 * 1024) { // 4MB limit
                    throw new Error('Image is too large after compression');
                }

                resolve(dataUrl);
            } catch (e) {
                reject(new Error('Failed to process image: ' + e.message));
            }
        };

        img.onerror = function() {
            reject(new Error('Failed to load image'));
        };

        reader.onerror = function() {
            reject(new Error('Failed to read file'));
        };

        reader.readAsDataURL(file);
    });
}

/**
 * Update background UI selection state
 * @param {string} type - 'preset' or 'custom'
 * @param {string} value - Preset path or filename
 */
function updateBackgroundUISelection(type, value) {
    // Clear all preset selections
    bgPresetItems.forEach(item => {
        item.classList.remove('selected');
    });

    // Hide custom label
    const customLabel = document.getElementById('custom-bg-label');
    if (customLabel) {
        customLabel.classList.add('invisible');
    }

    if (type === 'preset') {
        // Highlight selected preset
        const selectedItem = document.querySelector(`.bg-preset-item[data-bg="${value}"]`);
        if (selectedItem) {
            selectedItem.classList.add('selected');
        }
    } else if (type === 'custom') {
        // Show custom filename
        if (customLabel) {
            const filenameSpan = document.getElementById('bg-filename');
            if (filenameSpan) {
                filenameSpan.textContent = value;
            }
            customLabel.classList.remove('invisible');
        }
    }
}

/**
 * Restore UI state from sessionStorage
 */
function restoreBackgroundUIState() {
    const customImage = sessionStorage.getItem('backgroundImage');
    const preset = sessionStorage.getItem('backgroundPreset');

    if (customImage) {
        // Get filename from data URL (just show "Custom image")
        updateBackgroundUISelection('custom', 'Custom image');
    } else if (preset) {
        updateBackgroundUISelection('preset', preset);
    }
}

/**
 * Apply background to the active background-replace filter
 */
function applyBackgroundToFilter() {
    const c = findUpMedia('camera');
    // Use c.userdata.filter (the Filter instance), not filterDefinition (the template)
    if (c && c.userdata.filter && c.userdata.filter.definition &&
        c.userdata.filter.definition.loadBackgroundImage) {
        // Reload background image - call on filter definition with Filter instance as 'this'
        c.userdata.filter.definition.loadBackgroundImage.call(c.userdata.filter).catch(err => {
            console.error('[BackgroundReplace] Failed to load background:', err);
        });
    }
}

/**
 * Maps the state of the receive UI element to a protocol request.
 *
 * @param {string} what
 * @returns {Object<string,Array<string>>}
 */

function mapRequest(what) {
    switch (what) {
    case '':
        return {};
    case 'audio':
        return {'': ['audio']};
    case 'screenshare':
        return {screenshare: ['audio','video'], '': ['audio']};
    case 'everything-low':
        return {'': ['audio','video-low']};
    case 'everything':
        return {'': ['audio','video']};
    default:
        throw new Error(`Unknown value ${what} in request`);
    }
}

/**
 * Like mapRequest, but for a single label.
 *
 * @param {string} what
 * @param {string} label
 * @returns {Array<string>}
 */

function mapRequestLabel(what, label) {
    const r = mapRequest(what);
    if (label in r)
        return r[label];
    else
        return r[''];
}


getSelectElement('requestselect').onchange = function(e) {
    e.preventDefault();
    if (!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({request: this.value});
    serverConnection.request(mapRequest(this.value));
    reconsiderDownRate();
};

const activityDetectionThreshold = 0.2;

getInputElement('activitybox').onchange = function(_e) {
    if (!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({
        activityDetection: this.checked,
        activityDetectionConfigured: true,
        activityDetectionUserSet: true,
    });
    for (const id in serverConnection.down) {
        const c = serverConnection.down[id];
        if (this.checked && document.visibilityState === 'visible')
            c.setStatsInterval(getActivityDetectionInterval());
        else {
            c.setStatsInterval(0);
            setActive(c, false);
        }
    }
};

getInputElement('displayallbox').onchange = function(_e) {
    if (!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({displayAll: this.checked});
    for (const id in serverConnection.down) {
        const c = serverConnection.down[id];
        const elt = document.getElementById('peer-' + c.localId);
        showHideMedia(c, elt);
    }
    syncConferenceLayout();
};


/**
 * @this {Stream}
 * @param {Object<string,any>} stats
 */
function gotUpStats(stats) {
    const c = this;

    const values = [];

    for (const id in stats) {
        if (stats[id] && stats[id]['outbound-rtp']) {
            const rate = stats[id]['outbound-rtp'].rate;
            if (typeof rate === 'number') {
                values.push(rate);
            }
        }
    }

    // Don't overwrite the username label with bitrate stats
    // The label now shows the username instead
}

/**
 * @param {Stream} c
 * @param {boolean} value
 */
function setActive(c, value) {
    if (!!c.userdata.active === !!value)
        return;
    c.userdata.active = value;
    const peer = document.getElementById('peer-' + c.localId);
    if (peer) {
        if (value)
            peer.classList.add('peer-active');
        else
            peer.classList.remove('peer-active');
    }
    refreshParticipantPresence(getStreamUserId(c));
}

/**
 * @this {Stream}
 * @param {Object<string,any>} stats
 */
function gotDownStats(stats) {
    if (!getInputElement('activitybox').checked)
        return;

    const c = this;

    let maxEnergy = 0;

    c.pc.getReceivers().forEach(r => {
        const tid = r.track && r.track.id;
        const s = tid && stats[tid];
        const energy = s && s['inbound-rtp'] && s['inbound-rtp'].audioEnergy;
        if (typeof energy === 'number')
            maxEnergy = Math.max(maxEnergy, energy);
    });

    // totalAudioEnergy is defined as the integral of the square of the
    // volume, so square the threshold.
    if (maxEnergy > activityDetectionThreshold * activityDetectionThreshold) {
        c.userdata.lastVoiceActivity = Date.now();
        setActive(c, true);
    } else {
        const last = c.userdata.lastVoiceActivity;
        if (!last || Date.now() - last > getActivityDetectionPeriod())
            setActive(c, false);
    }
}

/**
 * Add an option to an HTMLSelectElement.
 *
 * @param {HTMLSelectElement} select
 * @param {string} label
 * @param {string} [value]
 */
function addSelectOption(select, label, value) {
    if (!value)
        value = label;
    for (let i = 0; i < select.children.length; i++) {
        const child = select.children[i];
        if (!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if (child.value === value) {
            if (child.label !== label) {
                child.label = label;
            }
            return;
        }
    }

    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

/**
 * Returns true if an HTMLSelectElement has an option with a given value.
 *
 * @param {HTMLSelectElement} select
 * @param {string} value
 */
function selectOptionAvailable(select, value) {
    const children = select.children;
    for (let i = 0; i < children.length; i++) {
        const child = select.children[i];
        if (!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if (child.value === value)
            return true;
    }
    return false;
}

/**
 * @param {HTMLSelectElement} select
 * @returns {string}
 */
function selectOptionDefault(select) {
    /* First non-empty option. */
    for (let i = 0; i < select.children.length; i++) {
        const child = select.children[i];
        if (!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if (child.value)
            return child.value;
    }
    /* The empty option is always available. */
    return '';
}

/**
  * True if we already went through setMediaChoices twice.
  *
  * @type {boolean}
  */
let mediaChoicesDone = false;

/**
 * Populate the media choices menu.
 *
 * Since media names might not be available before we call
 * getDisplayMedia, we call this function twice, the second time in order
 * to update the menu with user-readable labels.
 *
 * @param{boolean} done
 */
async function setMediaChoices(done) {
    if (mediaChoicesDone)
        return;

    const devices = [];
    try {
        if ('mediaDevices' in navigator)
            devices.push(...await navigator.mediaDevices.enumerateDevices());
    } catch (e) {
        console.error(e);
        return;
    }

    let cn = 1, mn = 1, on = 1;
    const videoDevices = [];
    let frontCameraDeviceId = null;

    devices.forEach(d => {
        let label = d.label;
        if (d.kind === 'videoinput') {
            if (!label)
                label = `Camera ${cn}`;
            // Check if this is a front-facing camera by label
            const isFront = label.toLowerCase().includes('front') ||
                         label.toLowerCase().includes('user') ||
                         label.toLowerCase().includes('selfie') ||
                         label.toLowerCase().includes('facetime') ||
                         label.toLowerCase().includes('face');
            videoDevices.push({deviceId: d.deviceId, label: label, isFront: isFront, order: cn});
            cn++;
        } else if (d.kind === 'audioinput') {
            if (!label)
                label = `Microphone ${mn}`;
            addSelectOption(getSelectElement('audioselect'),
                            label, d.deviceId);
            mn++;
        } else if (d.kind === 'audiooutput') {
            if (!label)
                label = `Output ${on}`;
            addSelectOption(getSelectElement('audiooutputselect'),
                            label, d.deviceId);
            on++;
        }
    });

    // If we have permission, try to detect front camera by testing
    if (videoDevices.length > 0 && videoDevices[0].label !== `Camera 1`) {
        // We have labels, try to find front camera
        for (const v of videoDevices) {
            if (v.isFront) {
                frontCameraDeviceId = v.deviceId;
                break;
            }
        }
    }

    // Sort video devices: front-facing cameras first, then others
    videoDevices.sort((a, b) => {
        if (a.isFront && !b.isFront) return -1;
        if (!a.isFront && b.isFront) return 1;
        return a.order - b.order;
    });

    // Add sorted video devices to select
    videoDevices.forEach(v => {
        addSelectOption(getSelectElement('videoselect'), v.label, v.deviceId);
    });

    // Store front camera device ID for later use
    if (frontCameraDeviceId) {
        window.frontCameraDeviceId = frontCameraDeviceId;
    }

    reflectAudioOutputAvailability();
    mediaChoicesDone = done;
}


/**
 * @param {string} [localId]
 */
function newUpStream(localId) {
    if (!serverConnection)
        throw new Error("Not connected");
    const c = serverConnection.newUpStream(localId);
    c.onstatus = function(_status) {
        setMediaStatus(c);
    };
    c.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    return c;
}

/**
 * Sets an up stream's video throughput and simulcast parameters.
 *
 * @param {Stream} c
 * @param {number} bps
 * @param {boolean} simulcast
 */
async function setSendParameters(c, bps, simulcast) {
    if (!c.up)
        throw new Error('Setting throughput of down stream');
    if (c.label === 'screenshare')
        simulcast = false;
    const senders = c.pc.getSenders();
    for (let i = 0; i < senders.length; i++) {
        const s = senders[i];
        if (!s.track || s.track.kind !== 'video')
            continue;
        const p = s.getParameters();
        if ((!p.encodings ||
            !simulcast && p.encodings.length !== 1) ||
           (simulcast && p.encodings.length !== 2)) {
            await replaceUpStream(c);
            return;
        }
        p.encodings.forEach(e => {
            if (!e.rid || e.rid === 'h')
                e.maxBitrate = bps || unlimitedRate;
        });
        await s.setParameters(p);
    }
}

let reconsiderParametersTimer = null;

/**
 * Sets the send parameters for all up streams.
 */
async function reconsiderSendParameters() {
    cancelReconsiderParameters();
    const t = getMaxVideoThroughput();
    const s = doSimulcast();
    const promises = [];
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        promises.push(setSendParameters(c, t, s));
    }
    await Promise.all(promises);
}

/**
 * Schedules a call to reconsiderSendParameters after a delay.
 * The delay avoids excessive flapping.
 */
function scheduleReconsiderParameters() {
    cancelReconsiderParameters();
    reconsiderParametersTimer =
        setTimeout(reconsiderSendParameters, 10000 + Math.random() * 10000);
}

function cancelReconsiderParameters() {
    if (reconsiderParametersTimer) {
        clearTimeout(reconsiderParametersTimer);
        reconsiderParametersTimer = null;
    }
}

/**
 * @typedef {Object} filterDefinition
 * @property {string} [description]
 * @property {number} [frameRate]
 * @property {(this: filterDefinition) => Promise<boolean>} [predicate]
 * @property {(this: Filter) => Promise<void>} [init]
 * @property {(this: Filter) => Promise<void>} [cleanup]
 * @property {(this: Filter, src: HTMLVideoElement, ctx: CanvasRenderingContext2D) => Promise<boolean>} draw
 */

/**
 * @param {MediaStream} stream
 * @param {filterDefinition} definition
 * @constructor
 */
function Filter(stream, definition) {
    /** @ts-ignore */
    if (!HTMLCanvasElement.prototype.captureStream) {
        throw new Error('Filters are not supported on this platform');
    }

    /** @type {MediaStream} */
    this.inputStream = stream;
    /** @type {filterDefinition} */
    this.definition = definition;
    /** @type {number} */
    this.frameRate = 30;
    /** @type {HTMLVideoElement} */
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.autoplay = true;
    /** @type {HTMLCanvasElement} */
    this.canvas = document.createElement('canvas');
    /** @type {any} */
    this.context = this.canvas.getContext('2d');
    /** @type {MediaStream} */
    this.captureStream = null;
    /** @type {MediaStream} */
    this.outputStream = null;
    /** @type {number} */
    this.timer = null;
    /** @type {number} */
    this.count = 0;
    /** @type {boolean} */
    this.fixedFramerate = false;
    /** @type {boolean} */
    this.lockFrameRate = false;
    /** @type {Object} */
    this.userdata = {};
    /** @type {MediaStream} */
    this.captureStream = this.canvas.captureStream(0);
    /** @type {boolean} */
    this.busy = false;
    /** @type {boolean} */
    this.paused = false;
}

Filter.prototype.startTimer = function() {
    if (document.visibilityState !== 'visible') {
        this.paused = true;
        return;
    }
    if (this.timer)
        clearInterval(this.timer);
    this.timer = setInterval(() => this.draw(), 1000 / this.frameRate);
};

Filter.prototype.start = async function() {
    /** @ts-ignore */
    if (!this.captureStream.getTracks()[0].requestFrame) {
        console.warn('captureFrame not supported, using fixed framerate');
        /** @ts-ignore */
        this.captureStream = this.canvas.captureStream(this.frameRate);
        this.fixedFramerate = true;
    }

    this.outputStream = new MediaStream();
    this.outputStream.addTrack(this.captureStream.getTracks()[0]);
    this.inputStream.getTracks().forEach(t => {
        t.onended = _e => this.stop();
        if (t.kind !== 'video')
            this.outputStream.addTrack(t);
    });

    // On mobile browsers (especially Android/Chrome), video elements not in the DOM
    // may not play properly. Add the video element as hidden to ensure it plays.
    this.video.style.position = 'absolute';
    this.video.style.visibility = 'hidden';
    this.video.style.width = '1px';
    this.video.style.height = '1px';
    this.video.style.pointerEvents = 'none';
    document.body.appendChild(this.video);

    this.video.srcObject = this.inputStream;
    this.video.muted = true;
    try {
        await this.video.play();
    } catch (e) {
        console.error('Filter video play() failed:', e);
        displayError(e);
    }
    if (this.definition.init)
        await this.definition.init.call(this);
    if (document.visibilityState === 'visible')
        this.startTimer();
    else
        this.paused = true;
};

Filter.prototype.draw = async function() {
    if (this.paused || document.visibilityState !== 'visible')
        return;

    if (this.video.videoWidth === 0 && this.video.videoHeight === 0) {
        // video not started yet
        return;
    }

    // check framerate every 30 frames
    if (!this.lockFrameRate && (this.count % 30) === 0) {
        let frameRate = 0;
        this.inputStream.getTracks().forEach(t => {
            if (t.kind === 'video') {
                const r = t.getSettings().frameRate;
                if (r)
                    frameRate = r;
            }
        });
        if (frameRate && frameRate !== this.frameRate) {
            this.frameRate = frameRate;
            this.startTimer();
        }
    }

    if (this.busy) {
        // drop frame
        return;
    }

    try {
        this.busy = true;
        let ok = false;
        try {
            ok = await this.definition.draw.call(
                this, this.video, this.context,
            );
        } catch (e) {
            console.error(e);
        }
        if (ok && !this.fixedFramerate) {
            /** @ts-ignore */
            this.captureStream.getTracks()[0].requestFrame();
        }
        this.count++;
    } finally {
        this.busy = false;
    }
};

Filter.prototype.pause = function() {
    if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
    }
    this.paused = true;
};

Filter.prototype.resume = function() {
    if (!this.paused || this.timer)
        return;
    this.paused = false;
    this.startTimer();
};

Filter.prototype.stop = async function() {
    if (!this.timer)
        this.paused = false;
    else {
        clearInterval(this.timer);
        this.timer = null;
    }
    this.captureStream.getTracks()[0].stop();
    // Remove video element from DOM
    if (this.video.parentNode) {
        this.video.parentNode.removeChild(this.video);
    }
    if (this.definition.cleanup)
        await this.definition.cleanup.call(this);
    this.paused = false;
};

function setFiltersPaused(paused) {
    getAllStreams().forEach(c => {
        const filter = c.userdata && c.userdata.filter;
        if (!(filter instanceof Filter))
            return;
        if (paused)
            filter.pause();
        else
            filter.resume();
    });
}

function setActivityDetectionPaused(paused) {
    if (!serverConnection)
        return;
    const enabled = shouldRunActivityDetection();
    for (const id in serverConnection.down) {
        const stream = serverConnection.down[id];
        if (!stream)
            continue;
        if (paused || !enabled) {
            stream.setStatsInterval(0);
            if (paused)
                setActive(stream, false);
        } else {
            stream.setStatsInterval(getActivityDetectionInterval());
        }
    }
}

/**
 * Removes any filter set on c.
 *
 * @param {Stream} c
 */
async function removeFilter(c) {
    const old = c.userdata.filter;
    if (!old)
        return;

    if (!(old instanceof Filter))
        throw new Error('userdata.filter is not a filter');

    // We are intentionally stopping the filter stream. Prevent the
    // track-ended handler (installed in setUpStream) from closing c.
    if (old.outputStream) {
        old.outputStream.getTracks().forEach(t => {
            t.onended = null;
        });
    }

    c.setStream(old.inputStream);
    await old.stop();
    c.userdata.filter = null;
}

/**
 * Sets the filter described by c.userdata.filterDefinition on c.
 *
 * @param {Stream} c
 */
async function setFilter(c) {
    await removeFilter(c);

    if (!c.userdata.filterDefinition)
        return;
    if (!hasVideoTrack(c.stream))
        return;

    const expensiveFilter =
        c.userdata.filterDefinition === filters['background-blur'] ||
        c.userdata.filterDefinition === filters['background-replace'];
    if (expensiveFilter && !expensiveFiltersArmedThisSession) {
        for (const [name, definition] of Object.entries(filters)) {
            if (definition === c.userdata.filterDefinition) {
                deferredStartupExpensiveFilter = name;
                break;
            }
        }
        c.userdata.filterDefinition = null;
        return;
    }
    if (expensiveFilter && getPerformanceProfile() === 'low-power-mobile' && isOldSafari()) {
        c.userdata.filterDefinition = null;
        const filterSelect = document.getElementById('filterselect');
        if (filterSelect instanceof HTMLSelectElement)
            filterSelect.value = '';
        updateSettings({filter: ''});
        displayMessage('Background effects are disabled on this device to protect performance.');
        return;
    }

    const filter = new Filter(c.stream, c.userdata.filterDefinition);
    filter.userdata.ownerStream = c;
    if (filter.definition.frameRate) {
        filter.frameRate = getFilterFrameRate(filter.definition.frameRate);
        filter.lockFrameRate = true;
    }
    await filter.start();
    c.setStream(filter.outputStream);
    c.userdata.filter = filter;
}

const SEGMENTER_MODEL_PATH = '/third-party/tasks-vision/models/selfie_segmenter.tflite';
const SEGMENTATION_WORKER_URL = '/background-blur-worker.js?v=1.5.27';
const FRAME_WORKER_TIMEOUT_MS = 10000;
const INIT_WORKER_TIMEOUT_MS = 45000;

function closeImageBitmapSafe(bitmap) {
    if (bitmap && typeof bitmap.close === 'function') {
        try {
            bitmap.close();
        } catch (_e) {
            // Ignore close errors on detached/closed bitmaps.
        }
    }
}

function closeWorkerPayloadBitmaps(data) {
    if (!data || typeof data !== 'object')
        return;
    closeImageBitmapSafe(data.bitmap);
    closeImageBitmapSafe(data.mask);
}

function isWorkerTimeoutError(e) {
    return !!(e && e.message === 'worker response timeout');
}

function noteSegmentationTimeout(filter) {
    const now = Date.now();
    const timeouts = (filter.userdata.workerTimeouts || [])
        .filter(ts => now - ts <= 30000);
    timeouts.push(now);
    filter.userdata.workerTimeouts = timeouts;
    return timeouts.length;
}

async function fallbackFilterForPerformance(filter) {
    if (filter.userdata.performanceFallbackPromise)
        return filter.userdata.performanceFallbackPromise;
    filter.userdata.performanceFallbackPromise = (async () => {
        const owner = filter.userdata.ownerStream;
        try {
            const filterSelect = document.getElementById('filterselect');
            if (filterSelect instanceof HTMLSelectElement)
                filterSelect.value = '';
            updateSettings({filter: ''});
            if (owner && owner.userdata.filter === filter) {
                owner.userdata.filterDefinition = null;
                await removeFilter(owner);
                refreshLocalCameraUi(owner);
            }
            displayMessage('Background effect was disabled to protect performance on this device.');
        } finally {
            filter.userdata.performanceFallbackPromise = null;
        }
    })();
    return filter.userdata.performanceFallbackPromise;
}

function configureSegmentationWorker(worker, logPrefix) {
    worker.onerror = function(e) {
        if (e && e.message && e.message.includes('document')) {
            console.warn(`[${logPrefix}] Suppressing MediaPipe document error`);
            e.preventDefault();
            return false;
        }
        console.error(`[${logPrefix}] Worker error:`, e);
        return false;
    };
}

async function createSegmentationWorker(filter, logPrefix, cpuWarningMessage) {
    if (!(filter instanceof Filter))
        throw new Error('Bad type for filter');

    if (filter.userdata.worker) {
        filter.userdata.worker.terminate();
        filter.userdata.worker = null;
    }

    const worker = new Worker(SEGMENTATION_WORKER_URL);
    configureSegmentationWorker(worker, logPrefix);
    filter.userdata.worker = worker;

    let initResult;
    try {
        initResult = await workerSendReceive(
            worker,
            {model: SEGMENTER_MODEL_PATH},
            undefined,
            {timeoutMs: INIT_WORKER_TIMEOUT_MS},
        );
    } catch (e) {
        worker.terminate();
        if (filter.userdata.worker === worker)
            filter.userdata.worker = null;
        throw e;
    }

    if (initResult && initResult.usesCPU && !filter.userdata.cpuFallbackWarningShown) {
        filter.userdata.cpuFallbackWarningShown = true;
        if (cpuWarningMessage)
            displayWarning(cpuWarningMessage);
    }

    filter.userdata.workerTimeouts = [];

    return initResult;
}

async function restartSegmentationWorker(filter, logPrefix, cpuWarningMessage) {
    if (filter.userdata.workerRestartPromise)
        return filter.userdata.workerRestartPromise;

    filter.userdata.workerRestartPromise = (async () => {
        try {
            const timeoutCount = noteSegmentationTimeout(filter);
            if (timeoutCount >= 2) {
                console.warn(`[${logPrefix}] Repeated worker timeouts, disabling filter for performance`);
                await fallbackFilterForPerformance(filter);
                return;
            }
            console.warn(`[${logPrefix}] Worker response timeout, restarting worker...`);
            await createSegmentationWorker(filter, logPrefix, cpuWarningMessage);
            console.log(`[${logPrefix}] Worker restarted successfully`);
        } catch (e) {
            console.error(`[${logPrefix}] Worker restart failed:`, e);
        } finally {
            filter.userdata.workerRestartPromise = null;
        }
    })();

    return filter.userdata.workerRestartPromise;
}

/**
 * Sends a message to a worker, then waits for a reply.
 *
 * @param {Worker} worker
 * @param {any} message
 * @param {any[]} [transfer]
 * @param {{timeoutMs?: number}} [options]
 */
async function workerSendReceive(worker, message, transfer, options) {
    if (worker._galeneBusy)
        throw new Error("worker busy");
    worker._galeneBusy = true;
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 30000;
    const requestId = (worker._galeneRequestId || 0) + 1;
    worker._galeneRequestId = requestId;
    let timeoutId = null;

    const p = new Promise((resolve, reject) => {
        const cleanup = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const onMessage = e => {
            const data = e ? e.data : null;
            if (!data || data._requestId !== requestId) {
                closeWorkerPayloadBitmaps(data);
                return;
            }
            cleanup();
            if (data.error && data.error.message) {
                reject(new Error(data.error.message));
                return;
            }
            if (data.error && data.error.name) {
                reject(new Error(data.error.name));
                return;
            }
            if (data instanceof Error) {
                reject(data);
                return;
            }
            if (data && data.name === 'Error' && data.message) {
                reject(new Error(data.message));
                return;
            }
            resolve(data || null);
        };

        const onError = e => {
            if (e && e.defaultPrevented)
                return;
            cleanup();
            reject(new Error(e && e.message ? e.message : 'worker error'));
        };

        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);

        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error('worker response timeout'));
        }, timeoutMs);
    });
    try {
        const payload = Object.assign({}, message, {_requestId: requestId});
        worker.postMessage(payload, transfer);
        return await p;
    } finally {
        worker._galeneBusy = false;
    }
}

/**
 * @type {Object.<string,filterDefinition>}
 */
const filters = {
    'mirror-h': {
        description: "Horizontal mirror",
        draw: async function(src, ctx) {
            if (!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if (ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(-1, 1);
            ctx.drawImage(src, -src.videoWidth, 0);
            ctx.resetTransform();
            return true;
        },
    },
    'mirror-v': {
        description: "Vertical mirror",
        draw: async function(src, ctx) {
            if (!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if (ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(1, -1);
            ctx.drawImage(src, 0, -src.videoHeight);
            ctx.resetTransform();
            return true;
        },
    },
    'rotate': {
        description: 'Rotate',
        draw: async function(src, ctx) {
            if (!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if (ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(-1, -1);
            ctx.drawImage(src, -src.videoWidth, -src.videoHeight);
            ctx.resetTransform();
            return true;
        },
    },
    'background-blur': {
        description: 'Background blur',
        frameRate: 15,
        predicate: async function() {
            // Check if browser supports Workers
            if (!window.Worker) {
                console.warn('Background blur not supported on this browser');
                return false;
            }
            const available = await ensureVisionBundleAvailable();
            if (!available)
                return false;
            return true;
        },
        init: async function(_ctx) {
            if (!(this instanceof Filter))
                throw new Error('Bad type for this');
            if (this.userdata.worker)
                throw new Error("Worker already running (this shouldn't happen)");
            console.log('[BackgroundBlur] Initializing worker...');
            try {
                console.log('[BackgroundBlur] Sending model to worker...');
                const initResult = await createSegmentationWorker(
                    this,
                    'BackgroundBlur',
                    'Background blur is using CPU mode (may be slower). GPU acceleration unavailable.',
                );
                console.log('[BackgroundBlur] Worker initialized successfully');

                // Check if CPU fallback was used
                if (initResult && initResult.usesCPU) {
                    console.warn('[BackgroundBlur] Using CPU mode (GPU unavailable)');
                }
            } catch (e) {
                console.error('[BackgroundBlur] Failed to initialize worker:', e);
                // Clean up if worker creation failed
                if (this.userdata.worker) {
                    this.userdata.worker.terminate();
                    this.userdata.worker = null;
                }

                // Show user-friendly error message
                if (e.message && (e.message.includes('WebGL') || e.message.includes('MediaPipe'))) {
                    displayError('Background blur unavailable: WebGL not supported in your browser/system. ' +
                        'Try enabling hardware acceleration in chrome://settings or use Firefox.');
                } else {
                    displayError('Background blur failed to initialize: ' + e.message);
                }

                // Re-throw to let the filter know init failed
                throw e;
            }
        },
        cleanup: async function() {
            if (this.userdata.worker) {
                this.userdata.worker.terminate();
                this.userdata.worker = null;
            }
            this.userdata.workerRestartPromise = null;
        },
        draw: async function(src, ctx) {
            if (!this.userdata.worker)
                return false;
            let bitmap = await createImageBitmap(src);
            try {
                let result;
                try {
                    result = await workerSendReceive(this.userdata.worker, {
                        bitmap: bitmap,
                        timestamp: performance.now(),
                    }, [bitmap], {timeoutMs: FRAME_WORKER_TIMEOUT_MS});
                } catch (e) {
                    if (isWorkerTimeoutError(e)) {
                        await restartSegmentationWorker(
                            this,
                            'BackgroundBlur',
                            'Background blur is using CPU mode (may be slower). GPU acceleration unavailable.',
                        );
                        return false;
                    }
                    throw e;
                }

                if (!result)
                    return false;

                const mask = result.mask;
                bitmap = result.bitmap;

                if (ctx.canvas.width !== src.videoWidth ||
                   ctx.canvas.height !== src.videoHeight) {
                    ctx.canvas.width = src.videoWidth;
                    ctx.canvas.height = src.videoHeight;
                }

                // set the alpha mask, background is opaque
                ctx.globalCompositeOperation = 'copy';
                ctx.drawImage(mask, 0, 0);

                // rather than blurring the original image, we first mask
                // the background then blur, this avoids a halo effect
                ctx.globalCompositeOperation = 'source-in';
                ctx.drawImage(result.bitmap, 0, 0);
		if ('filter' in ctx) {
                    ctx.globalCompositeOperation = 'copy';
                    ctx.filter = `blur(${src.videoWidth / 48}px)`;
                    ctx.drawImage(ctx.canvas, 0, 0);
                    ctx.filter = 'none';
		} else {
		    // Safari bug 198416, context.filter is not supported.

                    // Work around typescript inferring ctx as none
                    ctx = /**@type{CanvasRenderingContext2D}*/(ctx);

		    const scale = 24;
		    const swidth = src.videoWidth / scale;
		    const sheight = src.videoHeight / scale;
		    if (!('canvas' in this.userdata))
			this.userdata.canvas = document.createElement('canvas');
                    /** @type {HTMLCanvasElement} */
		    const c2 = this.userdata.canvas;
		    if (c2.width !== swidth)
			c2.width = swidth;
		    if (c2.height !== sheight)
			c2.height = sheight;
		    const ctx2 = c2.getContext('2d');
		    // scale down the background
		    ctx2.globalCompositeOperation = 'copy';
		    ctx2.drawImage(ctx.canvas,
				   0, 0, src.videoWidth, src.videoHeight,
				   0, 0, swidth, sheight,
				  );
		    // scale back up, composite atop the original background
		    ctx.globalCompositeOperation = 'source-atop';
		    ctx.drawImage(ctx2.canvas,
				  0, 0,
				  src.videoWidth / scale,
				  src.videoHeight / scale,
				  0, 0, src.videoWidth, src.videoHeight,
				 );
		}

		// now draw the foreground
                ctx.globalCompositeOperation = 'destination-atop';
                ctx.drawImage(result.bitmap, 0, 0);
                ctx.globalCompositeOperation = 'source-over';

                closeImageBitmapSafe(mask);
            } finally {
                closeImageBitmapSafe(bitmap);
            }
            return true;
        },
    },
    'background-replace': {
        description: 'Background replace',
        frameRate: 15,
        predicate: async function() {
            // Check if browser supports Workers
            if (!window.Worker) {
                console.warn('Background replace not supported on this browser');
                return false;
            }
            const available = await ensureVisionBundleAvailable();
            if (!available)
                return false;
            return true;
        },
        init: async function(_ctx) {
            if (!(this instanceof Filter))
                throw new Error('Bad type for this');
            if (this.userdata.worker)
                throw new Error("Worker already running (this shouldn't happen)");
            console.log('[BackgroundReplace] Initializing worker...');
            try {
                console.log('[BackgroundReplace] Sending model to worker...');
                const initResult = await createSegmentationWorker(
                    this,
                    'BackgroundReplace',
                    'Background replacement is using CPU mode (may be slower). GPU acceleration unavailable.',
                );
                console.log('[BackgroundReplace] Worker initialized successfully');

                // Check if CPU fallback was used
                if (initResult && initResult.usesCPU) {
                    console.warn('[BackgroundReplace] Using CPU mode (GPU unavailable)');
                }

                // Load background image - call through definition with Filter instance as 'this'
                await this.definition.loadBackgroundImage.call(this);
            } catch (e) {
                console.error('[BackgroundReplace] Failed to initialize worker:', e);
                if (this.userdata.worker) {
                    this.userdata.worker.terminate();
                    this.userdata.worker = null;
                }

                // Show user-friendly error message
                if (e.message && (e.message.includes('WebGL') || e.message.includes('MediaPipe'))) {
                    displayError('Background replacement unavailable: WebGL not supported in your browser/system. ' +
                        'Try enabling hardware acceleration in chrome://settings or use Firefox.');
                } else {
                    displayError('Background replacement failed to initialize: ' + e.message);
                }

                throw e;
            }
        },
        cleanup: async function() {
            if (this.userdata.worker) {
                this.userdata.worker.terminate();
                this.userdata.worker = null;
            }
            this.userdata.workerRestartPromise = null;
            // Clear cached background image
            if (this.userdata.backgroundImage) {
                this.userdata.backgroundImage = null;
            }
        },
        // Load background image from sessionStorage or preset
        loadBackgroundImage: async function() {
            if (!(this instanceof Filter))
                throw new Error('Bad type for this');

            const self = this;

            // Helper to load image from data URL
            const loadImageFromDataUrl = function(dataUrl) {
                return new Promise((resolve, _reject) => {
                    const img = new Image();
                    img.onload = () => {
                        self.userdata.backgroundImage = img;
                        resolve(img);
                    };
                    img.onerror = () => {
                        console.warn('[BackgroundReplace] Failed to load custom image');
                        self.userdata.backgroundImage = null;
                        resolve(null);
                    };
                    img.src = dataUrl;
                });
            };

            // Helper to load image from preset path
            const loadImageFromPreset = function(presetPath) {
                return new Promise((resolve, _reject) => {
                    const img = new Image();
                    img.onload = () => {
                        console.log(`[BackgroundReplace] Loaded preset: ${presetPath}, size: ${img.width}x${img.height}`);
                        if (img.width === 0 || img.height === 0) {
                            console.warn('[BackgroundReplace] Image has zero dimensions');
                            self.userdata.backgroundImage = null;
                            resolve(null);
                            return;
                        }
                        self.userdata.backgroundImage = img;
                        resolve(img);
                    };
                    img.onerror = (e) => {
                        console.error(`[BackgroundReplace] Failed to load preset: ${presetPath}`, e);
                        self.userdata.backgroundImage = null;
                        resolve(null);
                    };
                    // Set crossOrigin to handle CORS if needed
                    img.crossOrigin = 'anonymous';
                    img.src = presetPath;
                });
            };

            // Check for custom uploaded image first
            const customImage = sessionStorage.getItem('backgroundImage');
            if (customImage) {
                return loadImageFromDataUrl(customImage);
            }

            // Check for preset selection
            const preset = sessionStorage.getItem('backgroundPreset');
            if (preset) {
                return loadImageFromPreset(preset);
            }

            // No background selected - will use gray fallback
            this.userdata.backgroundImage = null;
            return null;
        },
        _drawCoverFit: function(ctx, img) {
            // Draw image with cover-fit (like CSS background-size: cover)
            const canvas = ctx.canvas;
            const imgRatio = img.width / img.height;
            const canvasRatio = canvas.width / canvas.height;

            let drawWidth, drawHeight, offsetX, offsetY;

            if (imgRatio > canvasRatio) {
                // Image is wider than canvas - fit to height
                drawHeight = canvas.height;
                drawWidth = img.width * (canvas.height / img.height);
                offsetX = (canvas.width - drawWidth) / 2;
                offsetY = 0;
            } else {
                // Image is taller than canvas - fit to width
                drawWidth = canvas.width;
                drawHeight = img.height * (canvas.width / img.width);
                offsetX = 0;
                offsetY = (canvas.height - drawHeight) / 2;
            }

            ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
        },
        draw: async function(src, ctx) {
            if (!this.userdata.worker)
                return false;
            let bitmap = await createImageBitmap(src);
            try {
                let result;
                try {
                    result = await workerSendReceive(this.userdata.worker, {
                        bitmap: bitmap,
                        timestamp: performance.now(),
                    }, [bitmap], {timeoutMs: FRAME_WORKER_TIMEOUT_MS});
                } catch (e) {
                    if (isWorkerTimeoutError(e)) {
                        await restartSegmentationWorker(
                            this,
                            'BackgroundReplace',
                            'Background replacement is using CPU mode (may be slower). GPU acceleration unavailable.',
                        );
                        return false;
                    }
                    throw e;
                }

                if (!result)
                    return false;

                const mask = result.mask;
                bitmap = result.bitmap;

                if (ctx.canvas.width !== src.videoWidth ||
                   ctx.canvas.height !== src.videoHeight) {
                    ctx.canvas.width = src.videoWidth;
                    ctx.canvas.height = src.videoHeight;
                }

                // Performance/stability first: use worker-provided mask directly.
                // Previous per-frame CPU mask refinement could stall the main thread
                // and indirectly cause websocket heartbeat delays.
                ctx.globalCompositeOperation = 'copy';
                ctx.drawImage(mask, 0, 0);

                // Step 4: draw the person ONLY where the mask is TRANSPARENT (inverted logic)
                // Use source-out: source drawn only where destination is transparent
                ctx.globalCompositeOperation = 'source-out';
                ctx.drawImage(result.bitmap, 0, 0);

                // Step 3: draw the background image BEHIND the person
                ctx.globalCompositeOperation = 'destination-over';
                if (this.userdata.backgroundImage) {
                    // Call _drawCoverFit from the filter definition
                    this.definition._drawCoverFit.call(this.definition, ctx, this.userdata.backgroundImage);
                } else {
                    ctx.fillStyle = '#808080';
                    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
                }

                // Reset composite operation
                ctx.globalCompositeOperation = 'source-over';

                closeImageBitmapSafe(mask);
            } finally {
                closeImageBitmapSafe(bitmap);
            }
            return true;
        },
    },
};

async function addFilters() {
    await ensureFilterOptionsLoaded(false);
}

const expensiveFilterNames = new Set(['background-blur', 'background-replace']);
let baseFilterOptionsLoaded = false;
let expensiveFilterOptionsLoaded = false;
let expensiveFilterOptionsPromise = null;
let backgroundPresetImagesLoaded = false;
let backgroundPresetImagesScheduled = false;
let visionBundleAvailable = null;
let visionBundleAvailabilityPromise = null;
let expensiveFiltersArmedThisSession = false;
let deferredStartupExpensiveFilter = '';
let deferredStartupExpensiveFilterNoticeShown = false;

function addFilterOption(name, definition) {
    const select = getSelectElement('filterselect');
    if (selectOptionAvailable(select, name))
        return;
    addSelectOption(select, definition.description || name, name);
}

function needsExpensiveFilterOption(value) {
    return expensiveFilterNames.has(value || '');
}

function getRestoredFilterValue(value) {
    const filterValue = value || '';
    if (!filterValue)
        return '';
    if (needsExpensiveFilterOption(filterValue) &&
        !expensiveFiltersArmedThisSession) {
        deferredStartupExpensiveFilter = filterValue;
        return '';
    }
    if (deferredStartupExpensiveFilter === filterValue)
        deferredStartupExpensiveFilter = '';
    return filterValue;
}

async function addFilterOptions(includeExpensive) {
    for (const name in filters) {
        if (expensiveFilterNames.has(name) !== includeExpensive)
            continue;
        const definition = filters[name];
        if (definition.predicate) {
            if (!(await definition.predicate.call(definition)))
                continue;
        }
        addFilterOption(name, definition);
    }
}

async function ensureFilterOptionsLoaded(includeExpensive) {
    if (!baseFilterOptionsLoaded) {
        await addFilterOptions(false);
        baseFilterOptionsLoaded = true;
    }
    if (!includeExpensive || expensiveFilterOptionsLoaded)
        return;
    if (expensiveFilterOptionsPromise)
        return expensiveFilterOptionsPromise;
    expensiveFilterOptionsPromise = (async () => {
        try {
            await addFilterOptions(true);
            expensiveFilterOptionsLoaded = true;
        } finally {
            expensiveFilterOptionsPromise = null;
        }
    })();
    return expensiveFilterOptionsPromise;
}

async function ensureVisionBundleAvailable() {
    if (visionBundleAvailable !== null)
        return visionBundleAvailable;
    if (visionBundleAvailabilityPromise)
        return visionBundleAvailabilityPromise;
    visionBundleAvailabilityPromise = (async () => {
        try {
            const r = await fetch('/third-party/tasks-vision/vision_bundle.mjs', {
                method: 'HEAD',
            });
            visionBundleAvailable = r.ok;
            if (!r.ok && r.status !== 404) {
                console.warn(
                    `Fetch vision_bundle.mjs: ${r.status} ${r.statusText}`,
                );
            }
        } catch (e) {
            console.warn('Fetch vision_bundle.mjs failed:', e);
            visionBundleAvailable = false;
        } finally {
            visionBundleAvailabilityPromise = null;
        }
        return visionBundleAvailable;
    })();
    return visionBundleAvailabilityPromise;
}

function ensureBackgroundPresetImagesLoaded() {
    if (backgroundPresetImagesLoaded)
        return;
    document.querySelectorAll('#bg-presets img[data-src]').forEach(img => {
        if (!(img instanceof HTMLImageElement))
            return;
        const src = img.dataset.src;
        if (!src)
            return;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.fetchPriority = 'low';
        img.src = src;
        delete img.dataset.src;
    });
    backgroundPresetImagesLoaded = true;
}

function scheduleBackgroundPresetImagesLoad() {
    if (backgroundPresetImagesLoaded || backgroundPresetImagesScheduled)
        return;
    backgroundPresetImagesScheduled = true;
    scheduleIdleTask(() => {
        backgroundPresetImagesScheduled = false;
        ensureBackgroundPresetImagesLoaded();
    });
}

const unlimitedRate = 1000000000;
const simulcastRate = 100000;
const hqAudioRate = 128000;

/**
 * Decide whether we want to send simulcast.
 *
 * @returns {boolean}
 */
function doSimulcast() {
    switch (getSettings().simulcast) {
    case 'on':
        return true;
    case 'off':
        return false;
    default:
        let count = 0;
        for (const n in serverConnection.users) {
            if (!serverConnection.users[n].permissions["system"]) {
                count++;
                if (count > 2)
                    break;
            }
        }
        if (count <= 2)
            return false;
        const bps = getMaxVideoThroughput();
        return bps <= 0 || bps >= 2 * simulcastRate;
    }
}

/**
 * Sets up c to send the given stream.  Some extra parameters are stored
 * in c.userdata.
 *
 * @param {Stream} c
 * @param {MediaStream} stream
 */

async function setUpStream(c, stream) {
    if (c.stream !== null)
        throw new Error("Setting nonempty stream");

    debugLog('[setUpStream] Setting up stream for', c.localId, 'label:', c.label, 'tracks:', stream.getTracks().length);
    // Set username for up streams so the label shows the username instead of stats
    // Use multiple fallbacks: serverConnection.username, localStorage, or 'You'
    let username = serverConnection.username;
    if (!username) {
        try {
            username = getStoredUsername();
        } catch (e) {
            console.warn('Failed to get username from localStorage:', e);
        }
    }
    if (!username) {
        try {
            username = getInputElement('username').value.trim();
        } catch (e) {
            // Ignore if username input not found
        }
    }
    c.username = username || 'You';
    debugLog('[setUpStream] Set username for', c.localId, ':', c.username);
    c.setStream(stream);

    // set up the handler early, in case setFilter fails.
    c.onclose = async replace => {
        const localId = c.localId;
        const userId = c.sc ? c.sc.id : null;
        const streamToStop =
            c.userdata.filter instanceof Filter && c.userdata.filter.inputStream ?
                c.userdata.filter.inputStream :
                c.stream;

        try {
            await removeFilter(c);
        } catch (e) {
            console.error('[setUpStream/onclose] removeFilter failed:', localId, e);
        }

        if (!replace) {
            if (streamToStop)
                stopStream(streamToStop);
            if (c.userdata.onclose) {
                try {
                    c.userdata.onclose.call(c);
                } catch (e) {
                    console.error('[setUpStream/onclose] userdata.onclose failed:', localId, e);
                }
            }
            delMedia(localId);
            if (userId)
                refreshParticipantPresence(userId);
        }
    };

    await setFilter(c);

    /**
     * @param {MediaStreamTrack} t
     */
    function addUpTrack(t) {
        debugLog('[addUpTrack] Adding track to', c.localId, 'kind:', t.kind, 'id:', t.id, 'enabled:', t.enabled);
        const settings = getSettings();
        if (c.label === 'camera') {
            if (t.kind === 'audio') {
                if (settings.localMute)
                    t.enabled = false;
            } else if (t.kind === 'video') {
                if (settings.blackboardMode) {
                    t.contentHint = 'detail';
                }
            }
        }
        t.onended = _e => {
            stream.onaddtrack = null;
            stream.onremovetrack = null;
            c.close();
        };

        const encodings = [];
        const simulcast = c.label !== 'screenshare' && doSimulcast();
        if (t.kind === 'video') {
            const bps = getMaxVideoThroughput();
            // Firefox doesn't like us setting the RID if we're not
            // simulcasting.
            if (simulcast) {
                encodings.push({
                    rid: 'h',
                    maxBitrate: bps || unlimitedRate,
                });
                encodings.push({
                    rid: 'l',
                    scaleResolutionDownBy: 2,
                    maxBitrate: simulcastRate,
                });
            } else {
                encodings.push({
                    maxBitrate: bps || unlimitedRate,
                });
            }
        } else {
            if (settings.hqaudio) {
                encodings.push({
                    maxBitrate: hqAudioRate,
                });
            }
        }
        const tr = c.pc.addTransceiver(t, {
            direction: 'sendonly',
            streams: [stream],
            sendEncodings: encodings,
        });

        // Firefox before 110 does not implement sendEncodings, and
        // requires this hack, which throws an exception on Chromium.
        try {
            const p = tr.sender.getParameters();
            if (!p.encodings) {
                p.encodings = encodings;
                tr.sender.setParameters(p);
            }
        } catch {
            // Ignore
        }
    }

    // c.stream might be different from stream if there's a filter
    c.stream.getTracks().forEach(addUpTrack);

    stream.onaddtrack = function(e) {
        addUpTrack(e.track);
    };

    stream.onremovetrack = function(e) {
        const t = e.track;

        /** @type {RTCRtpSender} */
        let sender;
        c.pc.getSenders().forEach(s => {
            if (s.track === t)
                sender = s;
        });
        if (sender) {
            c.pc.removeTrack(sender);
        } else {
            console.warn('Removing unknown track');
        }

        let found = false;
        c.pc.getSenders().forEach(s => {
            if (s.track)
                found = true;
        });
        if (!found) {
            stream.onaddtrack = null;
            stream.onremovetrack = null;
            c.close();
        }
    };

    if (shouldCollectUpstreamStats()) {
        c.onstats = gotUpStats;
        c.setStatsInterval(2000);
    } else {
        c.onstats = null;
        c.setStatsInterval(0);
    }
}

/**
 * Replaces c with a freshly created stream, duplicating any relevant
 * parameters in c.userdata.
 *
 * @param {Stream} c
 * @returns {Promise<Stream>}
 */
const replacingUpStreams = new Map();

async function replaceUpStream(c) {
    await removeFilter(c);
    return replaceUpStreamWithStream(c, c.stream);
}

async function replaceUpStreamWithStream(c, stream) {
    const key = c.localId || c.id;
    if (replacingUpStreams.has(key))
        return replacingUpStreams.get(key);

    const promise = (async () => {
        const cn = newUpStream(c.localId);
        cn.label = c.label;
        if (c.userdata.filterDefinition)
            cn.userdata.filterDefinition = c.userdata.filterDefinition;
        if (c.userdata.onclose)
            cn.userdata.onclose = c.userdata.onclose;
        const media = /** @type{HTMLVideoElement} */
            (document.getElementById('media-' + c.localId));
        try {
            await setUpStream(cn, stream);
        } catch (e) {
            console.error(e);
            displayError(e);
            cn.close();
            c.close();
            return null;
        }

        await setMedia(cn,
                       cn.label === 'camera' && getSettings().mirrorView,
                       cn.label === 'video' && media);

        return cn;
    })();

    replacingUpStreams.set(key, promise);
    try {
        return await promise;
    } finally {
        if (replacingUpStreams.get(key) === promise)
            replacingUpStreams.delete(key);
    }
}

/**
 * Replaces all up streams with the given label.  If label is null,
 * replaces all up stream.
 *
 * @param {string} label
 */
async function replaceUpStreams(label) {
    const promises = [];
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (label && c.label !== label)
            continue;
        promises.push(replaceUpStream(c));
    }
    await Promise.all(promises);
}

/**
 * Closes and reopens the camera then replaces the camera stream.
 */
function replaceCameraStream() {
    const c = findUpMedia('camera');
    if (c)
        return addLocalMedia(c.localId);
    return Promise.resolve();
}

/**
 * @param {string} [localId]
 */
async function addLocalMedia(localId) {
    const settings = getSettings();

    const audio = buildAudioConstraints(settings);
    const video = settings.cameraOff ? false : buildVideoConstraints(settings);

    const old = serverConnection.findByLocalId(localId);
    if (old) {
        // make sure that the camera is released before we try to reopen it
        await removeFilter(old);
        stopStream(old.stream);
    }

    const constraints = {audio: audio, video: video};
    /** @type {MediaStream} */
    let stream = null;
    try {
        // safariStream may be holding the audio device; release it first
        // so that on old iOS hardware (e.g. iPhone 6s) the new request
        // does not get a track that immediately fires `ended`.
        if (safariStream) {
            stopStream(safariStream);
            safariStream = null;
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
        displayError(e);
        return;
    }

    setMediaChoices(true);

    let c;

    try {
        c = newUpStream(localId);
    } catch (e) {
        console.log(e);
        displayError(e);
        return;
    }

    c.label = 'camera';

    const restoredFilter = getRestoredFilterValue(settings.filter);
    if (restoredFilter) {
        const filter = filters[restoredFilter];
        if (filter)
            c.userdata.filterDefinition = filter;
        else
            displayWarning(`Unknown filter ${restoredFilter}`);
    }

    try {
        await setUpStream(c, stream);
        await setMedia(c, settings.mirrorView);
    } catch (e) {
        console.error(e);
        displayError(e);
        c.close();
    }
    setButtonsVisibility();
}

let safariScreenshareDone = false;

async function addShareMedia() {
    if (!safariScreenshareDone) {
        if (isSafari()) {
            const ok = confirm(
                'Screen sharing in Safari is broken.  ' +
                    'It will work at first, ' +
                    'but then your video will randomly freeze.  ' +
                    'Are you sure that you wish to enable screensharing?',
            );
            if (!ok)
                return;
        }
        safariScreenshareDone = true;
    }

    /** @type {MediaStream} */
    let stream = null;
    try {
        if (!('getDisplayMedia' in navigator.mediaDevices))
            throw new Error('Your browser does not support screen sharing');
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
        });
    } catch (e) {
        console.error(e);
        displayError(e);
        return;
    }

    const c = newUpStream();
    c.label = 'screenshare';
    await setUpStream(c, stream);
    await setMedia(c);
    setButtonsVisibility();
}

/**
 * @param {File} file
 */
async function addFileMedia(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    let stream;
    /** @ts-ignore */
    if (video.captureStream)
        /** @ts-ignore */
        stream = video.captureStream();
    /** @ts-ignore */
    else if (video.mozCaptureStream)
        /** @ts-ignore */
        stream = video.mozCaptureStream();
    else {
        displayError("This browser doesn't support file playback");
        return;
    }

    const c = newUpStream();
    c.label = 'video';
    c.userdata.onclose = function() {
        const media = /** @type{HTMLVideoElement} */
            (document.getElementById('media-' + this.localId));
        if (media && media.src) {
            URL.revokeObjectURL(media.src);
            media.src = null;
        }
    };
    await setUpStream(c, stream);

    const presenting = !!findUpMedia('camera');
    const muted = getSettings().localMute;
    if (presenting && !muted) {
        setLocalMute(true, true);
        displayWarning('You have been muted');
    }

    await setMedia(c, false, video);
    c.userdata.play = true;
    setButtonsVisibility();
}

/**
 * @param {MediaStream} s
 */
function stopStream(s) {
    s.getTracks().forEach(t => {
        try {
            t.stop();
        } catch (e) {
            console.warn(e);
        }
    });
}

/**
 * closeUpMedia closes all up connections with the given label.  If label
 * is null, it closes all up connections.
 *
 * @param {string} [label]
*/
function closeUpMedia(label) {
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (label && c.label !== label)
            continue;
        c.close();
    }
}

/**
 * @param {string} label
 * @returns {Stream}
 */
function findUpMedia(label) {
    if (!serverConnection)
        return null;
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (c.label === label)
            return c;
    }
    return null;
}

/**
 * @param {boolean} mute
 */
function muteLocalTracks(mute) {
    if (!serverConnection)
        return;
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (c.label === 'camera') {
            const stream = c.stream;
            stream.getTracks().forEach(t => {
                if (t.kind === 'audio') {
                    t.enabled = !mute;
                }
            });
        }
    }
}

/**
 * @param {string} id
 * @param {boolean} force
 * @param {boolean} [value]
 */
function forceDownRate(id, force, value) {
    const c = serverConnection.down[id];
    if (!c)
        throw new Error("Unknown down stream");
    if ('requested' in c.userdata) {
        if (force)
            c.userdata.requested.force = !!value;
        else
            delete(c.userdata.requested.force);
    } else {
        if (force)
            c.userdata.requested = {force: value};
    }
    reconsiderDownRate(id);
}

/**
 * Maps 'video' to 'video-low'.  Returns null if nothing changed.
 *
 * @param {string[]} requested
 * @returns {string[]}
 */
function mapVideoToLow(requested) {
    const result = [];
    let found = false;
    for (let i = 0; i < requested.length; i++) {
        let r = requested[i];
        if (r === 'video') {
            r = 'video-low';
            found = true;
        }
        result.push(r);
    }
    if (!found)
        return null;
    return result;
}

/**
 * Reconsider the video track requested for a given down stream.
 *
 * @param {string} [id] - the id of the track to reconsider, all if null.
 */
function reconsiderDownRate(id) {
    if (!serverConnection)
        return;
    if (!id) {
        for (const id in serverConnection.down) {
            reconsiderDownRate(id);
        }
        return;
    }
    const c = serverConnection.down[id];
    if (!c)
        throw new Error("Unknown down stream");
    const normalrequest = mapRequestLabel(getSettings().request, c.label);

    const requestlow = mapVideoToLow(normalrequest);
    if (requestlow === null)
        return;

    const old = c.userdata.requested;
    let low = false;
    if (old && ('force' in old)) {
        low = old.force;
    } else {
        const media = /** @type {HTMLVideoElement} */
            (document.getElementById('media-' + c.localId));
        if (!media)
            throw new Error("No media for stream");
        const w = media.scrollWidth;
        const h = media.scrollHeight;
        if (w && h && w * h <= 320 * 240) {
            low = true;
        }
    }

    if (low !== !!(old && old.low)) {
        if ('requested' in c.userdata)
            c.userdata.requested.low = low;
        else
            c.userdata.requested = {low: low};
        c.request(low ? requestlow : null);
    }
}

let reconsiderDownRateTimer = null;

/**
 * Schedules reconsiderDownRate() to be run later.  The delay avoids too
 * much recomputations when resizing the window.
 */
function scheduleReconsiderDownRate() {
    if (reconsiderDownRateTimer)
        return;
    reconsiderDownRateTimer =
        setTimeout(() => {
            reconsiderDownRateTimer = null;
            reconsiderDownRate();
        }, 200);
}

/**
 * Return true when two MediaStreams are effectively the same stream.
 * Some browsers may deliver distinct object instances for the same stream id.
 *
 * @param {MediaStream|null} a
 * @param {MediaStream|null} b
 * @returns {boolean}
 */
function sameStream(a, b) {
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    return !!(a.id && b.id && a.id === b.id);
}

/**
 * setMedia adds a new media element corresponding to stream c.
 *
 * @param {Stream} c
 * @param {boolean} [mirror]
 *     - whether to mirror the video
 * @param {HTMLVideoElement} [video]
 *     - the video element to add.  If null, a new element with custom
 *       controls will be created.
 */
async function setMedia(c, mirror, video) {
    const isFF = isFirefox();
    debugLog('[setMedia] Setting media for', c.localId, 'up:', c.up, 'stream:', !!c.stream, 'tracks:', c.stream ? c.stream.getTracks().length : 0, 'Firefox:', isFF);
    let div = document.getElementById('peer-' + c.localId);
    let createdPeer = false;
    if (!div) {
        div = document.createElement('div');
        div.id = 'peer-' + c.localId;
        div.classList.add('peer');
        div.dataset.localId = c.localId;
        setPeerAspect(div, getDefaultPeerAspect(c), false);
        div.onclick = function(event) {
            const target = event.target;
            if (!(target instanceof HTMLElement))
                return;
            if (performance.now() < mobilePreviewSuppressClickUntil)
                return;
            if (target.closest('.video-controls') || target.closest('.top-video-controls'))
                return;
            if (c.label === 'screenshare') {
                event.preventDefault();
                event.stopPropagation();
                openConferenceFocus(c.localId);
                return;
            }
            const mode = getConferenceLayoutMode();
            if (mode !== 'duo' && mode !== 'group' && mode !== 'spotlight')
                return;
            openConferenceFocus(c.localId);
        };
        const peersdiv = document.getElementById('peers');
        peersdiv.appendChild(div);
        createdPeer = true;
    }

    // For down streams, only show/hide after stream is available
    // This prevents hiding videos before they arrive
    if (c.up || c.stream) {
        showHideMedia(c, div);
    } else {
        // For down streams without stream yet, show by default
        // (will be re-evaluated when stream arrives)
        div.classList.remove('peer-hidden');
    }

    let media = /** @type {HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    if (!media) {
        if (video) {
            media = video;
        } else {
            media = document.createElement('video');
            // Mute all videos initially for autoplay compliance
            // Desktop browsers won't autoplay videos with sound
            media.muted = true;
            // Firefox requires explicit volume setting
            media.volume = 1.0;
        }

        media.classList.add('media');
        media.autoplay = true;
        media.playsInline = true;
        media.setAttribute('webkit-playsinline', 'true');
        // Firefox doesn't support playsinline attribute (iOS only)
        // Don't set it on Firefox to avoid warnings
        if (!isFirefox()) {
            media.setAttribute('playsinline', '');
        }
        media.id = 'media-' + c.localId;
        div.appendChild(media);
        addCustomControls(media, div, c, !!video);
        if (!c.up)
            void applyAudioOutputToMediaElement(media, getDesiredAudioOutputId(), false);
        const syncAspect = () => updatePeerAspectFromMedia(div, media, c);
        media.addEventListener('loadedmetadata', syncAspect);
        const retryPlayback = () => {
            if (c.up || !c.userdata || !c.userdata.play)
                return;
            tryStartDownstreamPlayback(c, media);
        };
        media.addEventListener('loadeddata', retryPlayback);
        media.addEventListener('canplay', retryPlayback);
    }

    if (mirror)
        media.classList.add('mirror');
    else
        media.classList.remove('mirror');

    const hadMediaStream = !!(media && media.srcObject);
    if (!video && !sameStream(
        /** @type {MediaStream|null} */ (media.srcObject),
        /** @type {MediaStream|null} */ (c.stream),
    )) {
        media.srcObject = c.stream;
        updatePeerAspectFromMedia(div, media, c);
        // Only call play() if we have an actual stream
        if (c.stream) {
            // Re-evaluate visibility now that we have a stream
            showHideMedia(c, div);
            // Log stream details for Firefox debugging
            if (isFirefox()) {
                const tracks = c.stream.getTracks();
                debugLog('[setMedia] Firefox: Stream details for', c.localId, ':', {
                    id: c.stream.id,
                    tracks: tracks.length,
                    trackKinds: tracks.map(t => t.kind),
                    active: tracks.map(t => t.enabled),
                });
            }
            // Always start downstream media muted until playback has actually
            // begun. Older iPhone Safari builds are much less tolerant of
            // autoplay attempts with sound and can get stuck in a permanent
            // "Connecting"/gray-video state if the element starts unmuted.
            if (c.userMuted !== undefined) {
                media.muted = c.userMuted;
                debugLog('[setMedia] Preserving user mute preference for', c.localId, ':', c.userMuted);
            } else {
                media.muted = true;
                if (!c.up && audioEnabled) {
                    debugLog(
                        '[setMedia] Starting downstream video muted for autoplay safety, will unmute after play()',
                        c.localId,
                    );
                }
            }

            // Firefox-specific: ensure volume is set
            if (isFirefox()) {
                media.volume = 1.0;
                debugLog('[setMedia] Firefox: Ensuring volume is set to 1.0 for', c.localId);
            }

            // iOS Safari and Android/Chrome may ignore autoplay; explicitly call play()
            // Desktop browsers also require videos to be muted for autoplay
            // Firefox may need a small delay
            const playVideo = async () => {
                try {
                    if (!c.up) {
                        const started = await tryStartDownstreamPlayback(c, media);
                        if (!started && c.userdata && c.userdata.play)
                            return;
                    } else {
                        await media.play();
                    }
                    debugLog('[setMedia] play() succeeded for', c.localId, 'Firefox:', isFirefox(), 'muted:', media.muted);

                    // For downstream videos that started muted, try to unmute after playback starts
                    // But only if user hasn't manually set a mute preference
                    if (!c.up && media.muted && audioEnabled && c.userMuted === undefined) {
                        // Add a small delay to ensure playback has actually started
                        setTimeout(() => {
                            debugLog('[setMedia] Attempting to unmute downstream video', c.localId);
                            media.muted = false;
                            debugLog('[setMedia] Downstream video', c.localId, 'unmuted:', !media.muted);
                            updateVolumeControlsUi(c.localId, false);
                            debugLog('[setMedia] Volume button UI updated for', c.localId);
                        }, 200);
                    }

                    // If video is already unmuted (audioEnabled was true), update UI now
                    if (!c.up && !media.muted) {
                        updateVolumeControlsUi(c.localId, false);
                        debugLog('[setMedia] Volume button UI set to unmuted for', c.localId);
                    }
                } catch (e) {
                    if (e && e.name === 'AbortError') {
                        // Expected when srcObject is updated while play() is pending.
                        return;
                    }
                    console.warn('[setMedia] play() failed for', c.localId, ':', e, 'Firefox:', isFirefox);
                    if (c.up) {
                        // For the local (up) stream, surface the error so the user
                        // knows to tap the video or retry rather than seeing a blank tile.
                        displayError(e);
                    } else {
                        // For downstream videos, the video should be visible but muted
                        debugLog('[setMedia] Downstream video', c.localId, 'is muted due to autoplay policy');
                        c.userdata.play = true;
                    }
                }
            };

            if (isFirefox()) {
                // Firefox may need a small delay to ensure the video element is ready
                setTimeout(() => playVideo(), 50);
            } else {
                playVideo();
            }
        }
    }

    let label = document.getElementById('label-' + c.localId);
    if (!label) {
        label = document.createElement('div');
        label.id = 'label-' + c.localId;
        label.classList.add('label');
        div.appendChild(label);
    }

    setLabel(c);
    updatePeerVideoState(c, div);
    setMediaStatus(c);
    if (c.up && c.label === 'camera') {
        const selfPreviewSlot = getSelfPreviewSlot();
        if (selfPreviewSlot && !selfPreviewSlot.classList.contains('invisible')) {
            const currentPreviewPeer = getCurrentLocalSelfPreviewPeer(selfPreviewSlot);
            if (!currentPreviewPeer || isConferencePlaceholderPeer(currentPreviewPeer))
                setSelfPreviewPeer(selfPreviewSlot, div);
        }
    }
    if (createdPeer || (!hadMediaStream && !!c.stream))
        scheduleConferenceLayout();

    showVideo();
}


/**
 * @param {Stream} c
 * @param {HTMLElement} elt
 */
function showHideMedia(c, elt) {
    if (!elt)
        return;
    const isFF = isFirefox();
    const wasHidden = elt.classList.contains('peer-hidden');
    let display = c.up || getSettings().displayAll;
    // Firefox: Always show downstream videos that have a stream, regardless of displayAll setting
    // This ensures Firefox users can see others even if displayAll is not checked
    if (isFF && !c.up && c.stream) {
        display = true;
        debugLog('[showHideMedia] Firefox: Force display for downstream', c.localId);
    }
    if (!display && c.stream) {
        const tracks = c.stream.getTracks();
        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            if (t.kind === 'video') {
                display = true;
                break;
            }
        }
    }
    if (isFF) {
        debugLog('[showHideMedia] Firefox:', c.localId, 'display:', display, 'c.up:', c.up, 'displayAll:', getSettings().displayAll, 'hasStream:', !!c.stream);
    }
    if (display)
        elt.classList.remove('peer-hidden');
    else
        elt.classList.add('peer-hidden');
    if (wasHidden !== elt.classList.contains('peer-hidden'))
        scheduleConferenceLayout();
}

/**
 * resetMedia resets the source stream of the media element associated
 * with c.  This has the side-effect of resetting any frozen frames.
 *
 * @param {Stream} c
 */
function resetMedia(c) {
    const media = /** @type {HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    if (!media) {
        console.error("Resetting unknown media element");
        return;
    }
    // This workaround is mainly useful on Firefox where frozen frames
    // are more common after renegotiation. On Chromium this can trigger
    // spurious play() AbortError noise.
    if (!isFirefox())
        return;
    media.srcObject = media.srcObject;
}

/**
 * @param {Element} elt
 */
function cloneHTMLElement(elt) {
    if (!(elt instanceof HTMLElement))
        throw new Error('Unexpected element type');
    return /** @type{HTMLElement} */(elt.cloneNode(true));
}

/**
 * @param {HTMLVideoElement} media
 * @param {HTMLElement} container
 * @param {Stream} c
 */
function addCustomControls(media, container, c, toponly) {
    media.controls = false;
    if (toponly || c.up || c.label === 'screenshare')
        return;

    let controls = document.getElementById('controls-' + c.localId);
    if (controls)
        return;

    const template = document.getElementById('videocontrols-template');
    if (!(template instanceof HTMLElement) || !template.firstElementChild)
        return;

    controls = cloneHTMLElement(/** @type {HTMLElement} */ (template.firstElementChild));
    controls.id = 'controls-' + c.localId;
    controls.classList.remove('invisible');
    container.appendChild(controls);
    registerControlHandlers(c, media, controls);

    const volume = getVideoButton(controls, 'volume');
    if (volume) {
        setVolumeButton(
            media.muted,
            getVideoButton(volume, 'volume-mute'),
            getVideoButton(volume, 'volume-slider'),
        );
    }
}

/**
 * @param {HTMLElement} container
 * @param {string} name
 */
function getVideoButton(container, name) {
    return /** @type {HTMLElement} */(container.getElementsByClassName(name)[0]);
}

/**
 * @param {boolean} muted
 * @param {HTMLElement} button
 * @param {HTMLElement} slider
 */
function setVolumeButton(muted, button, slider) {
    if (!muted) {
        button.classList.remove("fa-volume-mute");
        button.classList.add("fa-volume-up");
    } else {
        button.classList.remove("fa-volume-up");
        button.classList.add("fa-volume-mute");
    }

    if (!(slider instanceof HTMLInputElement))
        throw new Error("Couldn't find volume slider");
}

function updateVolumeControlsUi(localId, muted) {
    const container = document.getElementById('controls-' + localId);
    if (!container)
        return;
    const volumeBtn = container.getElementsByClassName('volume-mute')[0];
    const volumeSlider = container.getElementsByClassName('volume-slider')[0];
    if (volumeBtn && volumeSlider)
        setVolumeButton(muted, volumeBtn, volumeSlider);
}

function setVolumePopoverOpen(volume, open) {
    if (!volume)
        return;
    if (volume._closeTimer) {
        clearTimeout(volume._closeTimer);
        volume._closeTimer = null;
    }
    volume.classList.toggle('volume-open', open);
    const popover = getVideoButton(volume, 'volume-popover');
    if (popover)
        popover.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function scheduleVolumePopoverClose(volume) {
    if (!volume)
        return;
    if (volume._closeTimer)
        clearTimeout(volume._closeTimer);
    volume._closeTimer = window.setTimeout(() => {
        if (!volume.matches(':hover') && !volume.contains(document.activeElement))
            setVolumePopoverOpen(volume, false);
        volume._closeTimer = null;
    }, 80);
}

/**
 * @param {Stream} c
 * @param {HTMLVideoElement} media
 * @param {HTMLElement} container
 */
function registerControlHandlers(c, media, container) {
    const volume = getVideoButton(container, 'volume');
    if (volume) {
        const trigger = getVideoButton(volume, 'volume-trigger');
        const slider = /** @type {HTMLInputElement|null} */ (getVideoButton(volume, 'volume-slider'));
        if (!volume.dataset.bound) {
            volume.dataset.bound = 'true';
            volume.addEventListener('focusin', () => setVolumePopoverOpen(volume, true));
            volume.addEventListener('focusout', () => {
                window.setTimeout(() => {
                    if (!volume.contains(document.activeElement))
                        setVolumePopoverOpen(volume, false);
                }, 0);
            });
            volume.addEventListener('mouseenter', () => setVolumePopoverOpen(volume, true));
            volume.addEventListener('mouseleave', () => scheduleVolumePopoverClose(volume));
        }
        if (trigger) {
            trigger.onclick = function(event) {
                event.preventDefault();
                event.stopPropagation();
                const nextOpen = !volume.classList.contains('volume-open');
                setVolumePopoverOpen(volume, nextOpen);
                if (nextOpen && slider)
                    slider.focus({preventScroll: true});
            };
        }
        volume.oninput = function() {
          const slider = /** @type{HTMLInputElement} */
              (getVideoButton(volume, "volume-slider"));
          const nextVolume = parseInt(slider.value, 10) / 100;
          media.volume = nextVolume;
          media.muted = nextVolume <= 0;
          c.userMuted = media.muted;
          setVolumeButton(
              media.muted,
              getVideoButton(volume, 'volume-mute'),
              slider,
          );
        };
    }
}

/**
 * @param {string} localId
 */
function delMedia(localId) {
    const stream = getAllStreams().find(c => c.localId === localId);
    const userId = getStreamUserId(stream);
    const peer = document.getElementById('peer-' + localId);
    if (!peer) {
        const peers = document.querySelectorAll('[id^="peer-"]');
        console.warn('[delMedia] Attempted to remove non-existent peer:', localId,
                     'Existing:', Array.from(peers).map(p => p.id));
        if (userId)
            refreshParticipantPresence(userId);
        return;
    }

    const media = /** @type{HTMLVideoElement} */
        (document.getElementById('media-' + localId));

    if (media instanceof HTMLMediaElement)
        media.srcObject = null;
    if (peer.parentElement)
        peer.parentElement.removeChild(peer);
    if (pinnedLocalId === localId)
        pinnedLocalId = null;
    if (stagedLocalId === localId)
        stagedLocalId = null;
    if (focusedConferenceLocalId === localId)
        focusedConferenceLocalId = null;
    if (stream && stream.label === 'screenshare') {
        resetSharedScreenZoom();
        updateStageFullscreenState();
    }
    forgetStreamUiHealth(localId);

    setButtonsVisibility();
    syncConferenceLayout();
    hideVideo();
    if (userId)
        refreshParticipantPresence(userId);
}

/**
 * @param {Stream} c
 */
function setMediaStatus(c) {
    const isFF = isFirefox();
    const state = c && c.pc && c.pc.iceConnectionState;
    const connectionHealth = getStreamConnectionHealth(c);
    const good = connectionHealth === 'healthy';
    const degraded = connectionHealth === 'poor';
    const userId = getStreamUserId(c);

    const media = document.getElementById('media-' + c.localId);
    if (!media) {
        console.warn('[setMediaStatus] Setting status of unknown media.', c.localId, 'Firefox:', isFF);
        if (userId)
            refreshParticipantPresence(userId);
        return;
    }
    if (isFF) {
        console.log('[setMediaStatus] Firefox:', c.localId, 'state:', state, 'good:', good, 'srcObject:', !!media.srcObject);
    }
    if (good) {
        media.classList.remove('media-failed');
        if (c.userdata.play) {
            if (media instanceof HTMLMediaElement)
                media.play().catch (e => {
                    console.error(e);
                    displayError(e);
                });
            delete(c.userdata.play);
        }
    } else if (degraded) {
        media.classList.add('media-failed');
    } else {
        media.classList.remove('media-failed');
    }

    if (!c.up && state === 'failed') {
        const from = c.username ?
            `from user ${c.username}` :
            'from anonymous user';
        displayWarning(`Cannot receive media ${from}, still trying...`);
    }
    if (userId)
        refreshParticipantPresence(userId);
}

function resolveStreamLabelData(c, fallback) {
    if (c && c.username) {
        return {
            text: c.username,
            fallback: false,
        };
    }

    if (fallback && /^\d+\+\d+$/.test(fallback)) {
        try {
            const storedUsername = getStoredUsername();
            if (storedUsername) {
                return {
                    text: storedUsername,
                    fallback: false,
                };
            }
        } catch (_e) {
            // Ignore localStorage errors.
        }
        return {
            text: '',
            fallback: false,
        };
    }

    if (fallback) {
        return {
            text: fallback,
            fallback: true,
        };
    }

    return {
        text: '',
        fallback: false,
    };
}

function ensurePeerAvatarPlaceholder(c, peer) {
    let placeholder = document.getElementById('peer-avatar-' + c.localId);
    if (placeholder)
        return placeholder;

    placeholder = document.createElement('div');
    placeholder.id = 'peer-avatar-' + c.localId;
    placeholder.classList.add('peer-avatar-placeholder');

    const initials = document.createElement('div');
    initials.classList.add('peer-avatar-initials');
    placeholder.appendChild(initials);

    const status = document.createElement('div');
    status.classList.add('peer-avatar-status');
    status.innerHTML =
        '<i class="fas fa-video-slash" aria-hidden="true"></i>' +
        '<span class="peer-avatar-status-text">Camera off</span>';
    placeholder.appendChild(status);

    peer.appendChild(placeholder);
    return placeholder;
}

function updatePeerVideoState(c, peer) {
    if (!peer)
        return;

    const noVideo = !!(c && c.stream && !hasVideoTrack(c.stream));
    peer.classList.toggle('peer-no-video', noVideo);

    const placeholder = ensurePeerAvatarPlaceholder(c, peer);
    const label = document.getElementById('label-' + c.localId);
    const statusText = placeholder.querySelector('.peer-avatar-status-text');
    const initials = placeholder.querySelector('.peer-avatar-initials');
    const displayName = (label && label.textContent && label.textContent.trim()) ||
        (c && c.username) ||
        (c && c.up ? 'You' : 'Participant');

    if (initials)
        initials.textContent = getNameInitials(displayName, c && c.up ? 'Y' : 'P');
    if (statusText)
        statusText.textContent = c && c.label === 'camera' ? 'Camera off' : 'Audio only';
    placeholder.setAttribute('aria-hidden', noVideo ? 'false' : 'true');
}


/**
 * @param {Stream} c
 * @param {string} [fallback]
 */
function setLabel(c, fallback) {
    const label = document.getElementById('label-' + c.localId);
    if (!label)
        return;
    const data = resolveStreamLabelData(c, fallback);
    label.textContent = data.text;
    label.classList.toggle('label-fallback', data.fallback);
    const peer = getPeer(c.localId);
    if (peer)
        updatePeerVideoState(c, peer);
}

/**
 * Update all up stream labels with the current username.
 * This is called after the user successfully joins.
 */
function updateUpstreamLabels() {
    if (!serverConnection)
        return;
    const username = serverConnection.username;
    if (!username)
        return;
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (c.up) {
            c.username = username;
            setLabel(c);
            console.log('[updateUpstreamLabels] Updated label for', c.localId, 'to', username);
        }
    }
}

function resizePeers() {
    scheduleConferenceLayout();
}

/**
 * Lexicographic order, with case differences secondary.
 * @param{string} a
 * @param{string} b
 */
function stringCompare(a, b) {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la < lb)
        return -1;
    else if (la > lb)
        return +1;
    else if (a < b)
        return -1;
    else if (a > b)
        return +1;
    return 0;
}

/**
 * @param {string} v
 */
function dateFromInput(v) {
    const d = new Date(v);
    if (d.toString() === 'Invalid Date')
        throw new Error('Invalid date');
    return d;
}

/**
 * @param {Date} d
 */
function dateToInput(d) {
    const dd = new Date(d);
    dd.setMinutes(dd.getMinutes() - dd.getTimezoneOffset());
    return dd.toISOString().slice(0, -1);
}

function inviteMenu() {
    const d = /** @type {HTMLDialogElement} */
        (document.getElementById('invite-dialog'));
    if (!('HTMLDialogElement' in window) || !d.showModal) {
        displayError("This browser doesn't support modal dialogs");
        return;
    }
    d.returnValue = '';
    const c = getButtonElement('invite-cancel');
    c.onclick = function(_e) {
        d.close('cancel');
};
    const u = getInputElement('invite-username');
    u.value = '';
    const now = new Date();
    now.setMilliseconds(0);
    now.setSeconds(0);
    const nb = getInputElement('invite-not-before');
    nb.min = dateToInput(now);
    const ex = getInputElement('invite-expires');
    const expires = new Date(now);
    expires.setDate(expires.getDate() + 2);
    ex.min = dateToInput(now);
    ex.value = dateToInput(expires);
    d.showModal();
}

document.getElementById('invite-dialog').onclose = function(_e) {
    if (!(this instanceof HTMLDialogElement))
        throw new Error('Unexpected type for this');
    const dialog = /** @type {HTMLDialogElement} */(this);
    if (dialog.returnValue !== 'invite')
        return;
    const u = getInputElement('invite-username');
    const username = u.value.trim() || null;
    const nb = getInputElement('invite-not-before');
    let notBefore = null;
    if (nb.value) {
        try {
            notBefore = dateFromInput(nb.value);
        } catch (e) {
            displayError(`Couldn't parse ${nb.value}: ${e}`);
            return;
        }
    }
    const ex = getInputElement('invite-expires');
    let expires = null;
    if (ex.value) {
        try {
            expires = dateFromInput(ex.value);
        } catch (e) {
            displayError(`Couldn't parse ${nb.value}: ${e}`);
            return;
        }
    }
    const template = {};
    if (username)
        template.username = username;
    if (notBefore)
        template['not-before'] = notBefore;
    if (expires)
        template.expires = expires;
    makeToken(template);
};

/**
 * @param {HTMLElement} elt
 */
function userMenu(elt) {
    if (!elt.id.startsWith('user-'))
        throw new Error('Unexpected id for user menu');
    const id = elt.id.slice('user-'.length);
    const user = serverConnection.users[id];
    if (!user)
        throw new Error("Couldn't find user");
    const items = [];
    if (id === serverConnection.id) {
        const mydata = serverConnection.users[serverConnection.id].data;
        if (mydata['raisehand'])
            items.push({label: 'Unraise hand', onClick: () => {
                serverConnection.userAction(
                    'setdata', serverConnection.id, {'raisehand': null},
                );
            }});
        else
            items.push({label: 'Raise hand', onClick: () => {
                serverConnection.userAction(
                    'setdata', serverConnection.id, {'raisehand': true},
                );
            }});
        if (serverConnection.version !== "1" &&
           serverConnection.permissions.indexOf('token') >= 0) {
            items.push({label: 'Invite user', onClick: () => {
                inviteMenu();
            }});
        }
        if (serverConnection.permissions.indexOf('present') >= 0 && canFile())
            items.push({label: 'Broadcast file', onClick: presentFile});
        items.push({label: 'Restart media', onClick: renegotiateStreams});
    } else {
        items.push({label: 'Send file', onClick: () => {
            sendFile(id);
        }});
        if (serverConnection.permissions.indexOf('op') >= 0) {
            items.push({type: 'seperator'}); // sic
            if (user.permissions.indexOf('present') >= 0)
                items.push({label: 'Forbid presenting', onClick: () => {
                    serverConnection.userAction('unpresent', id);
                }});
            else
                items.push({label: 'Allow presenting', onClick: () => {
                    serverConnection.userAction('present', id);
                }});
            items.push({label: 'Mute', onClick: () => {
                serverConnection.userMessage('mute', id);
            }});
            items.push({label: 'Kick out', onClick: () => {
                serverConnection.userAction('kick', id);
            }});
            items.push({label: 'Identify', onClick: () => {
                serverConnection.userAction('identify', id);
            }});
        }
    }
    /** @ts-ignore */
    new Contextual({
        items: items,
    });
}

/**
 * @param {string} id
 * @param {user} userinfo
 */
function addUser(id, userinfo) {
    clearConferenceUserDeleted(id);
    const state = getOrCreateParticipantState(id);
    clearParticipantRemovalTimer(state);
    state.offline = false;
    state.offlineSince = null;
    state.userinfo = snapshotUserInfo(userinfo);
    state.username = userinfo.username || state.username || '(anon)';
    ensureUserElement(id);
    refreshParticipantPresence(id, userinfo);
}

 /**
  * @param {string} id
  * @param {user} userinfo
  */
function changeUser(id, userinfo) {
    clearConferenceUserDeleted(id);
    ensureUserElement(id);
    setUserStatus(id, null, userinfo);
}

/**
 * @param {string} id
 * @param {HTMLElement} elt
 * @param {user} userinfo
 */
function setUserStatus(id, elt, userinfo) {
    void elt;
    refreshParticipantPresence(id, userinfo);
}

/**
 * @param {string} id
 */
function delUser(id) {
    markConferenceUserDeleted(id);
    removeConferenceArtifactsForUser(id);
    markParticipantOffline(id);
}

/**
 * @param {string} id
 * @param {string} kind
 */
function gotUser(id, kind) {
    if (this !== serverConnection)
        return;
    switch (kind) {
    case 'add':
        addUser(id, serverConnection.users[id]);
        break;
    case 'delete':
        delUser(id);
        break;
    case 'change':
        changeUser(id, serverConnection.users[id]);
        break;
    default:
        console.warn('Unknown user kind', kind);
        break;
    }
    updateStageBadge();
    scheduleConferenceLayout();
}

function displayUsername() {
    document.getElementById('userspan').textContent = serverConnection.username;
    const op = serverConnection.permissions.indexOf('op') >= 0;
    const present = serverConnection.permissions.indexOf('present') >= 0;
    let text = '';
    if (op && present)
        text = '(op, presenter)';
    else if (op)
        text = 'operator';
    else if (present)
        text = 'presenter';
    document.getElementById('permspan').textContent = text;
    setProfileInitials(serverConnection.username);
    updateStageBadge();
}

let presentRequested = null;

/**
 * @param {string} s
 */
function capitalise(s) {
    if (s.length <= 0)
        return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {string} title
 */
function legacySetTitle(title) {
    const roomTitle = title || 'Owly';
    document.title = title ? `${title} - Owly` : 'Owly';
    document.getElementById('title').textContent = roomTitle;
    return;
    document.title = title ? `${title} · Owly` : 'Owly';
    document.title = title ? `${title} - Owly` : 'Owly';
    document.getElementById('title').textContent = roomTitle;
    return;
    function set(title) {
        document.title = title;
        document.getElementById('title').textContent = title;
    }
    if (title)
        set(title);
    else
        set('Owly');
}

function setTitle(title) {
    const roomTitle = title || 'Owly';
    document.title = title ? `${title} - Owly` : 'Owly';
    document.getElementById('title').textContent = roomTitle;
}

/**
 * Under Safari, we request access to the camera at startup in order to
 * enable autoplay.  The camera stream is stored in safariStream.
 *
 * @type {MediaStream}
 */
let safariStream = null;

async function openSafariStream() {
    if (!isSafari())
        return;

    // loginStream already has audio from a user gesture — opening a second
    // concurrent audio capture here races with it and, on older iOS devices
    // (e.g. iPhone 6s), causes iOS to fire `ended` on the first audio track,
    // triggering the t.onended → c.close() cascade that removes the video.
    if (loginStream)
        return;

    if (!safariStream)
        safariStream = await navigator.mediaDevices.getUserMedia({audio: true});
}

async function closeSafariStream() {
    if (!safariStream)
        return;
    stopStream(safariStream);
    safariStream = null;
}

/**
 * Avoid forcing an extra websocket close while we are already handling
 * a remote close event.
 *
 * @param {ServerConnection} connection
 * @param {string} reason
 */
function closeConnectionIfOpen(connection, reason) {
    if (!connection || !connection.socket)
        return;
    const state = connection.socket.readyState;
    if (state === WebSocket.CONNECTING || state === WebSocket.OPEN)
        connection.close(reason);
}

/**
 * @this {ServerConnection}
 * @param {string} kind
 * @param {string} group
 * @param {Array<string>} perms
 * @param {Object<string,any>} status
 * @param {Object<string,any>} data
 * @param {string} error
 * @param {string} message
 */
async function gotJoined(kind, group, perms, status, data, error, message) {
    if (this !== serverConnection)
        return;
    const present = presentRequested;
    presentRequested = null;

    switch (kind) {
    case 'fail':
        reconnectPending = false;
        reconnectState = null;
        startReconnectCooldown();
        if (probingState === 'probing' && error === 'need-username') {
            probingState = 'need-username';
            setVisibility('passwordform', false);
        } else {
            token = null;
            const err = new Error('The server said: ' + message);
            err.name = 'ServerError';
            err.serverError = error;
            if (Error.captureStackTrace)
                Error.captureStackTrace(err, gotJoined);
            displayError(err);
        }
        closeSafariStream();
        closeConnectionIfOpen(this, 'join failed');
        setButtonsVisibility();
        return;
    case 'redirect':
        reconnectPending = false;
        closeSafariStream();
        closeConnectionIfOpen(this, 'join redirect');
        token = null;
        document.location.href = message;
        return;
    case 'leave':
        reconnectPending = false;
        closeSafariStream();
        closeConnectionIfOpen(this, 'join leave');
        setButtonsVisibility();
        setChangePassword(null);
        return;
    case 'join':
    case 'change':
        if (probingState === 'probing') {
            probingState = 'success';
            setVisibility('userform', false);
            setVisibility('passwordform', false);
            closeSafariStream();
            closeConnectionIfOpen(this, 'probing complete');
            setButtonsVisibility();
            return;
        } else {
            token = null;
        }
        reconnectAttempts = 0;
        if (typeof rememberPersistentClientUsername === 'function')
            rememberPersistentClientUsername(serverConnection.username || null);
        // don't discard endPoint and friends
        for (const key in status)
            groupStatus[key] = status[key];
        setTitle((status && status.displayName) || capitalise(group));
        displayUsername();
        // Update all up stream labels with the username
        updateUpstreamLabels();
        setButtonsVisibility();
        setChatOpen(!isMobileBurgerLayout());
        setToolPanel(activeToolPanel, false);
        setChangePassword(pwAuth && !!groupStatus.canChangePassword &&
                          serverConnection.username,
        );
        openSafariStream();
        if (kind === 'change')
            return;

        // Show share link button if user has logged in with password
        if (loginPassword) {
            setVisibility('sharelink-section', true);
        }

        // Clean URL to remove encoded password after successful join
        if (passwordFromUrl && group) {
            const cleanPath = `/group/${group}/`;
            window.history.replaceState(null, '', cleanPath);
        }
        break;
    default:
        token = null;
        displayError('Unknown join message');
        closeSafariStream();
        closeConnectionIfOpen(this, 'unknown join message');
        return;
    }

    const input = /** @type{HTMLTextAreaElement} */
        (document.getElementById('input'));
    input.placeholder = 'Type /help for help';
    setTimeout(() => {
input.placeholder = '';
}, 8000);

    if (status.locked)
        displayWarning('This group is locked');

    if (typeof RTCPeerConnection === 'undefined')
        displayWarning("This browser doesn't support WebRTC");
    else
        this.request(mapRequest(getSettings().request));

    if (('mediaDevices' in navigator) &&
       ('getUserMedia' in navigator.mediaDevices) &&
       serverConnection.permissions.indexOf('present') >= 0 &&
       !findUpMedia('camera')) {
        if (present) {
            if (present === 'both') {
                updateSettings({cameraOff: false});
                setLocalCameraOff(false, false);
            }
            // Set default video selection based on present type
            if (present === 'mike') {
                updateSettings({video: ''});
            } else if (present === 'both') {
                delSetting('video');
            }

            reflectSettings();

            const button = getButtonElement('presentbutton');
            button.disabled = true;
            try {
                await addLocalMedia();
                // Ensure microphone is not muted by default
                setLocalMute(false, true);
            } finally {
                button.disabled = false;
            }
        } else {
            displayMessage(
                "Press Enable to enable your camera or microphone",
            );
        }
    }
}

/**
 * @param {TransferredFile} f
 */
function gotFileTransfer(f) {
    f.onevent = gotFileTransferEvent;
    const p = document.createElement('p');
    if (f.up)
        p.textContent =
        `We have offered to send a file called "${f.name}" ` +
        `to user ${f.username}.`;
    else
        p.textContent =
        `User ${f.username} offered to send us a file ` +
        `called "${f.name}" of size ${f.size}.`;
    let bno = null, byes = null;
    if (!f.up) {
        byes = document.createElement('button');
        byes.textContent = 'Accept';
        byes.onclick = function(_e) {
            f.receive();
        };
        byes.id = "byes-" + f.fullid();
    }
    bno = document.createElement('button');
    bno.textContent = f.up ? 'Cancel' : 'Reject';
    bno.onclick = function(_e) {
        f.cancel();
    };
    bno.id = "bno-" + f.fullid();
    const status = document.createElement('span');
    status.id = 'status-' + f.fullid();
    if (!f.up) {
        status.textContent =
            '(Choosing "Accept" will disclose your IP address.)';
    }
    const statusp = document.createElement('p');
    statusp.id = 'statusp-' + f.fullid();
    statusp.appendChild(status);
    const div = document.createElement('div');
    div.id = 'file-' + f.fullid();
    div.appendChild(p);
    if (byes)
        div.appendChild(byes);
    if (bno)
        div.appendChild(bno);
    div.appendChild(statusp);
    div.classList.add('message');
    div.classList.add('message-private');
    div.classList.add('message-row');
    const box = document.getElementById('box');
    box.appendChild(div);
    return div;
}

/**
 * @param {TransferredFile} f
 * @param {string} status
 * @param {number} [value]
 */
function setFileStatus(f, status, value) {
    const statuselt = document.getElementById('status-' + f.fullid());
    if (!statuselt)
        throw new Error("Couldn't find statusp");
    statuselt.textContent = status;
    if (value) {
        const progress = document.getElementById('progress-' + f.fullid());
         if (!progress || !(progress instanceof HTMLProgressElement))
            throw new Error("Couldn't find progress element");
        progress.value = value;
        const label = document.getElementById('progresstext-' + f.fullid());
        const percent = Math.round(100 * value / progress.max);
        label.textContent = `${percent}%`;
    }
}

/**
 * @param {TransferredFile} f
 * @param {number} [max]
 */
function createFileProgress(f, max) {
    const statusp = document.getElementById('statusp-' + f.fullid());
    if (!statusp)
        throw new Error("Couldn't find status div");
    /** @type HTMLProgressElement */
    const progress = document.createElement('progress');
    progress.id = 'progress-' + f.fullid();
    progress.classList.add('file-progress');
    progress.max = max;
    progress.value = 0;
    statusp.appendChild(progress);
    const progresstext = document.createElement('span');
    progresstext.id = 'progresstext-' + f.fullid();
    progresstext.textContent = '0%';
    statusp.appendChild(progresstext);
}

/**
 * @param {TransferredFile} f
 * @param {boolean} delyes
 * @param {boolean} delno
 * @param {boolean} [delprogress]
 */
function delFileStatusButtons(f, delyes, delno, delprogress) {
    const div = document.getElementById('file-' + f.fullid());
    if (!div)
        throw new Error("Couldn't find file div");
    if (delyes) {
        const byes = document.getElementById('byes-' + f.fullid());
        if (byes)
            div.removeChild(byes);
    }
    if (delno) {
        const bno = document.getElementById('bno-' + f.fullid());
        if (bno)
            div.removeChild(bno);
    }
    if (delprogress) {
        const statusp = document.getElementById('statusp-' + f.fullid());
        const progress = document.getElementById('progress-' + f.fullid());
        const progresstext =
            document.getElementById('progresstext-' + f.fullid());
        if (progress)
            statusp.removeChild(progress);
        if (progresstext)
            statusp.removeChild(progresstext);
    }
}

/**
 * @this {TransferredFile}
 * @param {string} state
 * @param {any} [data]
 */
function gotFileTransferEvent(state, data) {
    const f = this;
    switch (state) {
    case 'inviting':
        break;
    case 'connecting':
        delFileStatusButtons(f, true, false);
        setFileStatus(f, 'Connecting...');
        createFileProgress(f, f.size);
        break;
    case 'connected':
        setFileStatus(f, f.up ? 'Sending...' : 'Receiving...', f.datalen);
        break;
    case 'done':
        delFileStatusButtons(f, true, true, true);
        setFileStatus(f, 'Done.');
        if (!f.up) {
            const url = URL.createObjectURL(data);
            const a = document.createElement('a');
            a.href = url;
            a.textContent = f.name;
            a.download = f.name;
            a.type = f.mimetype;
            a.click();
            URL.revokeObjectURL(url);
        }
        break;
    case 'cancelled':
        delFileStatusButtons(f, true, true, true);
        if (data)
            setFileStatus(f, `Cancelled: ${data.toString()}.`);
        else
            setFileStatus(f, 'Cancelled.');
        break;
    case 'closed':
        break;
    default:
        console.error(`Unexpected state "${state}"`);
        f.cancel(`unexpected state "${state}" (this shouldn't happen)`);
        break;
    }
}

/**
 * @param {string} id
 * @param {string} dest
 * @param {string} username
 * @param {Date} time
 * @param {boolean} privileged
 * @param {string} kind
 * @param {string} error
 * @param {any} message
 */
function gotUserMessage(id, dest, username, time, privileged, kind, error, message) {
    switch (kind) {
    case 'kicked':
    case 'error':
    case 'warning':
    case 'info':
        if (!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        const from = id ? (username || 'Anonymous') : 'The Server';
        const err = new Error(`${from} said: ${message}`);
        err.name = kind === 'error' ? 'ServerError' : kind === 'kicked' ? 'Kicked' : kind;
        err.serverMessage = message;
        err.serverKind = kind;
        // Capture stack at this point for debugging
        if (Error.captureStackTrace)
            Error.captureStackTrace(err, gotUserMessage);
        displayError(err, kind);
        break;
    case 'mute':
        if (!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        setLocalMute(true, true);
        const by = username ? ' by ' + username : '';
        displayWarning(`You have been muted${by}`);
        break;
    case 'clearchat': {
        if (!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        const id = message && message.id;
        const userId = message && message.userId;
        clearChat(id, userId);
        break;
    }
    case 'token':
        if (!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        if (error) {
            displayError(`Token operation failed: ${message}`);
            return;
        }
        if (typeof message !== 'object') {
            displayError('Unexpected type for token');
            return;
        }
        const f = formatToken(message, false);
        localMessage(f[0] + ': ' + f[1]);
        if ('share' in navigator) {
            try {
                navigator.share({
                    title: `Invitation to Owly group ${message.group}`,
                    text: f[0],
                    url: f[1],
                });
            } catch (e) {
                console.warn("Share failed", e);
            }
        }
        break;
    case 'tokenlist':
        if (!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        if (error) {
            displayError(`Token operation failed: ${message}`);
            return;
        }
        let s = '';
        for (let i = 0; i < message.length; i++) {
            const f = formatToken(message[i], true);
            s = s + f[0] + ': ' + f[1] + "\n";
        }
        localMessage(s);
        break;
    case 'userinfo':
        if (!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        const u = message.username ?
            'username ' + message.username :
            'unknown username';
        const a = message.address ?
            'address ' + message.address :
            'unknown address';
        localMessage(`User ${message.id} has ${u} and ${a}.`);
        break;
    case 'chatreaction':
        if (!message || typeof message !== 'object' || !message.id)
            return;
        updateMessageReactions(message.id, {
            counts: message.counts || {},
            selected: message.selected || null,
        });
        break;
    default:
        console.warn(`Got unknown user message ${kind}`);
        break;
    }
};

/**
 * @param {Object} token
 * @param {boolean} [details]
 */
function formatToken(token, details) {
    const url = new URL(window.location.href);
    const params = new URLSearchParams();
    params.append('token', token.token);
    url.search = params.toString();
    let foruser = '', by = '', togroup = '';
    if (token.username)
        foruser = ` for user ${token.username}`;
    if (details) {
        if (token.issuedBy)
            by = ' issued by ' + token.issuedBy;
        if (token.issuedAt) {
            if (by === '')
                by = ' issued at ' + token.issuedAt;
            else
                by = by + ' at ' + (new Date(token.issuedAt)).toLocaleString();
        }
    } else {
        if (token.group)
            togroup = ' to group ' + token.group;
    }
    let since = '';
    if (token["not-before"])
        since = ` since ${(new Date(token['not-before'])).toLocaleString()}`;
    /** @type{Date} */
    let expires = null;
    let until = '';
    if (token.expires) {
        expires = new Date(token.expires);
        until = ` until ${expires.toLocaleString()}`;
    }
    return [
        (expires && (expires >= new Date())) ?
            `Invitation${foruser}${togroup}${by} valid${since}${until}` :
            `Expired invitation${foruser}${togroup}${by}`,
        url.toString(),
    ];
}

const urlRegexp = /https?:\/\/[-a-zA-Z0-9@:%/._\\+~#&()=?]+[-a-zA-Z0-9@:%/_\\+~#&()=]/g;

/**
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function formatText(text) {
    const r = new RegExp(urlRegexp);
    const result = [];
    let pos = 0;
    while (true) {
        const m = r.exec(text);
        if (!m)
            break;
        result.push(document.createTextNode(text.slice(pos, m.index)));
        const a = document.createElement('a');
        a.href = m[0];
        a.textContent = m[0];
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        result.push(a);
        pos = m.index + m[0].length;
    }
    result.push(document.createTextNode(text.slice(pos)));

    const div = document.createElement('div');
    result.forEach(e => {
        div.appendChild(e);
    });
    return div;
}

/**
 * @param {Date} time
 * @returns {string}
 */
function formatTime(time) {
    const delta = Date.now() - time.getTime();
    const m = time.getMinutes();
    if (delta > -30000)
        return time.getHours() + ':' + ((m < 10) ? '0' : '') + m;
    return time.toLocaleString();
}

/**
 * @typedef {Object} lastMessage
 * @property {string} [nick]
 * @property {string} [peerId]
 * @property {string} [dest]
 * @property {Date} [time]
 */

/** @type {lastMessage} */
let lastMessage = {};

const composerEmojiGroups = [
    {
        title: 'Smileys',
        emojis: ['😀', '😁', '😂', '🙂', '😉', '😊', '😍', '🤩', '😎', '🥳', '😅', '😭'],
    },
    {
        title: 'Gestures',
        emojis: ['👍', '👎', '👏', '🙌', '🙏', '👌', '✌️', '🤝', '💪', '🫶'],
    },
    {
        title: 'People',
        emojis: ['🙋', '🤔', '🤯', '😴', '🤓', '😇', '🤗', '🤷', '🙆', '🧑‍💻'],
    },
    {
        title: 'Symbols',
        emojis: ['❤️', '🔥', '✨', '🎉', '✅', '⚡', '💡', '📌', '📣', '🫡'],
    },
];

const quickReactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const chatReactionState = new Map();

function normaliseReactionState(reactions) {
    if (!reactions || typeof reactions !== 'object')
        return null;

    const counts = {};
    if (reactions.counts && typeof reactions.counts === 'object') {
        for (const [emoji, count] of Object.entries(reactions.counts)) {
            if (typeof count === 'number' && count > 0)
                counts[emoji] = count;
        }
    }

    const selected =
        typeof reactions.selected === 'string' && reactions.selected ?
            reactions.selected :
            null;

    if (!Object.keys(counts).length && !selected)
        return null;

    return {counts, selected};
}

function storeReactionState(messageId, reactions) {
    if (!messageId)
        return null;

    const state = normaliseReactionState(reactions);
    if (state)
        chatReactionState.set(messageId, state);
    else
        chatReactionState.delete(messageId);
    return state;
}

function getMessageRowById(messageId) {
    if (!messageId)
        return null;
    return document.querySelector(`.message-row[data-message-id="${messageId}"]`);
}

function closeReactionPickers(exceptId) {
    document.querySelectorAll('.reaction-picker').forEach(picker => {
        if (!(picker instanceof HTMLElement))
            return;
        const open = picker.dataset.messageId === exceptId;
        picker.classList.toggle('invisible', !open);
        const row = picker.closest('.message-row');
        if (!row)
            return;
        const trigger = row.querySelector('.reaction-trigger');
        if (trigger)
            trigger.classList.toggle('active', open);
    });
}

function closeEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    const toggle = document.getElementById('emoji-toggle');
    if (picker) {
        picker.classList.add('invisible');
        picker.setAttribute('aria-hidden', 'true');
    }
    if (toggle)
        toggle.classList.remove('active');
}

function resizeChatInput(reset) {
    const input = document.getElementById('input');
    if (!(input instanceof HTMLTextAreaElement))
        return;

    if (reset) {
        input.style.height = '';
        return;
    }

    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

function insertEmojiAtCursor(textarea, emoji) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value =
        textarea.value.slice(0, start) +
        emoji +
        textarea.value.slice(end);
    const next = start + emoji.length;
    textarea.selectionStart = next;
    textarea.selectionEnd = next;
    textarea.focus();
    resizeChatInput();
}

function renderEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    if (!picker || picker.dataset.ready === 'true')
        return;

    composerEmojiGroups.forEach(group => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('emoji-group');

        const title = document.createElement('div');
        title.classList.add('emoji-group-title');
        title.textContent = group.title;
        wrapper.appendChild(title);

        const grid = document.createElement('div');
        grid.classList.add('emoji-grid');

        group.emojis.forEach(emoji => {
            const button = document.createElement('button');
            button.type = 'button';
            button.classList.add('emoji-option');
            button.textContent = emoji;
            button.onclick = function(event) {
                event.preventDefault();
                event.stopPropagation();
                const input = document.getElementById('input');
                if (!(input instanceof HTMLTextAreaElement))
                    return;
                insertEmojiAtCursor(input, emoji);
            };
            grid.appendChild(button);
        });

        wrapper.appendChild(grid);
        picker.appendChild(wrapper);
    });

    picker.dataset.ready = 'true';
}

function toggleEmojiPicker(force) {
    const picker = document.getElementById('emoji-picker');
    const toggle = document.getElementById('emoji-toggle');
    if (!picker || !toggle)
        return;

    renderEmojiPicker();
    const open = typeof force === 'boolean' ? force : picker.classList.contains('invisible');
    picker.classList.toggle('invisible', !open);
    picker.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggle.classList.toggle('active', open);
    if (open)
        closeReactionPickers();
}

function buildReactionPicker(messageId) {
    const picker = document.createElement('div');
    picker.classList.add('reaction-picker', 'invisible');
    picker.dataset.messageId = messageId;

    picker.addEventListener('click', event => event.stopPropagation());

    quickReactionEmojis.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('reaction-option');
        button.dataset.emoji = emoji;
        button.textContent = emoji;
        button.onclick = function(event) {
            event.preventDefault();
            event.stopPropagation();
            toggleReaction(messageId, emoji);
        };
        picker.appendChild(button);
    });

    return picker;
}

function updateMessageReactions(messageId, reactions) {
    const state = storeReactionState(messageId, reactions);
    const row = getMessageRowById(messageId);
    if (!row)
        return;

    const bar = row.querySelector('.message-reactions');
    const picker = row.querySelector('.reaction-picker');
    const trigger = row.querySelector('.reaction-trigger');

    if (bar) {
        bar.textContent = '';
        if (state && Object.keys(state.counts).length) {
            Object.entries(state.counts).forEach(([emoji, count]) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.classList.add('reaction-chip');
                chip.classList.toggle('active', state.selected === emoji);
                chip.dataset.emoji = emoji;
                chip.onclick = function(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleReaction(messageId, emoji);
                };

                const emojiSpan = document.createElement('span');
                emojiSpan.textContent = emoji;
                const countSpan = document.createElement('span');
                countSpan.classList.add('reaction-count');
                countSpan.textContent = `${count}`;
                chip.appendChild(emojiSpan);
                chip.appendChild(countSpan);
                bar.appendChild(chip);
            });
            bar.classList.remove('invisible');
        } else {
            bar.classList.add('invisible');
        }
    }

    if (picker) {
        picker.querySelectorAll('.reaction-option').forEach(button => {
            if (!(button instanceof HTMLElement))
                return;
            button.classList.toggle('active', !!(state && state.selected === button.dataset.emoji));
        });
    }

    if (trigger)
        trigger.classList.toggle('has-selection', !!(state && state.selected));
}

function toggleReaction(messageId, emoji) {
    if (!serverConnection || !serverConnection.socket) {
        displayError('Not connected.');
        return;
    }

    const current = chatReactionState.get(messageId);
    const next = current && current.selected === emoji ? null : emoji;

    try {
        serverConnection.groupAction('reactchat', {
            id: messageId,
            emoji: next,
        });
        closeReactionPickers();
    } catch (e) {
        console.error(e);
        displayError(e);
    }
}

function buildMessageMeta(time, messageId, canReact) {
    const meta = document.createElement('div');
    meta.classList.add('message-meta');

    if (time) {
        const tm = document.createElement('span');
        tm.classList.add('message-time');
        tm.textContent = formatTime(time);
        meta.appendChild(tm);
    }

    if (canReact) {
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.classList.add('reaction-trigger');
        trigger.title = 'Add reaction';
        trigger.setAttribute('aria-label', 'Add reaction');
        trigger.innerHTML = '<i class="far fa-smile" aria-hidden="true"></i>';
        trigger.onclick = function(event) {
            event.preventDefault();
            event.stopPropagation();
            const row = getMessageRowById(messageId);
            if (!row)
                return;
            const picker = row.querySelector('.reaction-picker');
            if (!(picker instanceof HTMLElement))
                return;
            const open = picker.classList.contains('invisible');
            closeReactionPickers(open ? messageId : undefined);
        };
        meta.appendChild(trigger);
    }

    return meta;
}

function shouldStickChatToBottom(box) {
    if (!box)
        return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
}

/**
 * @param {string} id
 * @param {string} peerId
 * @param {string} dest
 * @param {string} nick
 * @param {Date} time
 * @param {boolean} privileged
 * @param {boolean} history
 * @param {string} kind
 * @param {string|HTMLElement} message
 * @param {{counts?: Object<string, number>, selected?: string|null}} [reactions]
 */
function addToChatbox(id, peerId, dest, nick, time, privileged, history, kind, message, reactions) {
    if (kind === 'caption') {
        displayCaption(message);
        return;
    }

    void privileged;

    const box = document.getElementById('box');
    const stickToBottom = shouldStickChatToBottom(box);
    const row = document.createElement('div');
    row.classList.add('message-row');
    if (id)
        row.dataset.messageId = id;
    const container = document.createElement('div');
    container.classList.add('message');
    row.appendChild(container);
    const messageIsOwn = !!(serverConnection && peerId === serverConnection.id);
    const canReact = !!(id && peerId && !dest && kind !== 'me');
    if (!peerId)
        container.classList.add('message-system');
    if (messageIsOwn)
        row.classList.add('message-me');
    else if (peerId)
        row.classList.add('message-other');
    if (dest)
        container.classList.add('message-private');

    if (id)
        container.dataset.id = id;
    if (peerId) {
        container.dataset.peerId = peerId;
        container.dataset.username = nick;
        container.addEventListener('click', function(e) {
            if (e.detail !== 2)
                return;
            const elt = e.currentTarget;
            if (!elt || !(elt instanceof HTMLElement))
                throw new Error("Couldn't find chat message div");
            chatMessageMenu(elt);
        });
    }

    /** @type{HTMLElement} */
    let body;
    if (message instanceof HTMLElement) {
        body = message;
    } else if (typeof message === 'string') {
        body = formatText(message);
    } else {
        throw new Error('Cannot add element to chatbox');
    }

    if (kind !== 'me') {
        let doHeader = true;
        if (lastMessage.nick !== (nick || null) ||
           lastMessage.peerId !== (peerId || null) ||
           lastMessage.dest !== (dest || null) ||
           !time || !lastMessage.time) {
            doHeader = true;
        } else {
            const delta = time.getTime() - lastMessage.time.getTime();
            doHeader = delta < 0 || delta > 60000;
        }

        if (doHeader) {
            const header = document.createElement('p');
            const user = document.createElement('span');
            const u = dest && serverConnection && serverConnection.users[dest];
            const name = (u && u.username);
            user.textContent = dest ?
                `${nick || '(anon)'} \u2192 ${name || '(anon)'}` :
                (nick || '(anon)');
            user.classList.add('message-user');
            header.appendChild(user);
            header.classList.add('message-header');
            container.appendChild(header);
        }

        const content = document.createElement('div');
        content.appendChild(body);
        content.classList.add('message-content');
        container.appendChild(content);
        lastMessage.nick = (nick || null);
        lastMessage.peerId = peerId;
        lastMessage.dest = (dest || null);
        lastMessage.time = (time || null);
    } else {
        const content = document.createElement('div');
        content.classList.add('message-content');
        const prefix = document.createElement('span');
        prefix.classList.add('message-me-prefix');
        prefix.textContent = `* ${nick || '(anon)'}`;
        content.appendChild(prefix);
        content.appendChild(document.createTextNode(' '));
        content.appendChild(body);
        container.appendChild(content);
        lastMessage = {};
    }

    if (!container.classList.contains('message-system'))
        container.appendChild(buildMessageMeta(time, id, canReact));

    if (canReact) {
        const reactionBar = document.createElement('div');
        reactionBar.classList.add('message-reactions', 'invisible');
        row.appendChild(reactionBar);
        row.appendChild(buildReactionPicker(id));
    } else if (id) {
        storeReactionState(id, reactions);
    }

    box.appendChild(row);

    if (canReact)
        updateMessageReactions(id, reactions);

    if (history || stickToBottom || box.scrollHeight <= box.clientHeight) {
        box.scrollTop = box.scrollHeight - box.clientHeight;
    }

    return;
}

/**
 * @param {HTMLElement} elt
 */
function chatMessageMenu(elt) {
    if (!(serverConnection && serverConnection.permissions &&
         serverConnection.permissions.indexOf('op') >= 0))
        return;

    const messageId = elt.dataset.id;
    const peerId = elt.dataset.peerId;
    if (!peerId)
        return;
    const username = elt.dataset.username;
    const u = username || 'user';

    const items = [];
    if (messageId)
        items.push({label: 'Delete message', onClick: () => {
            serverConnection.groupAction('clearchat', {
                id: messageId,
                userId: peerId,
            });
        }});
    items.push({label: `Delete all from ${u}`,
                onClick: () => {
                    serverConnection.groupAction('clearchat', {
                        userId: peerId,
                    });
                }});
    items.push({label: `Identify ${u}`, onClick: () => {
        serverConnection.userAction('identify', peerId);
    }});
    items.push({label: `Kick out ${u}`, onClick: () => {
        serverConnection.userAction('kick', peerId);
    }});

    /** @ts-ignore */
    new Contextual({
        items: items,
    });
}

/**
 * @param {string|HTMLElement} message
 */
function setCaption(message) {
    const container = document.getElementById('captions-container');
    const captions = document.getElementById('captions');
    if (!message) {
        captions.replaceChildren();
        container.classList.add('invisible');
    } else {
        if (message instanceof HTMLElement)
            captions.replaceChildren(message);
        else
            captions.textContent = message;
        container.classList.remove('invisible');
    }
}

let captionsTimer = null;

/**
 * @param {string|HTMLElement} message
 */
function displayCaption(message) {
    if (captionsTimer !== null) {
        clearTimeout(captionsTimer);
        captionsTimer = null;
    }
    setCaption(message);
    captionsTimer = setTimeout(() => setCaption(null), 3000);
}

/**
 * @param {string|HTMLElement} message
 */
function localMessage(message) {
    return addToChatbox(null, null, null, null, new Date(), false, false, '', message);
}

/**
 * @param {string} [id]
 * @param {string} [userId]
 */
function clearChat(id, userId) {
    lastMessage = {};
    closeEmojiPicker();
    closeReactionPickers();

    const box = document.getElementById('box');
    if (!id && !userId) {
        box.textContent = '';
        chatReactionState.clear();
        return;
    }

    const elts = box.children;
    let i = 0;
    while (i < elts.length) {
        const row = elts.item(i);
        if (row instanceof HTMLDivElement) {
            const div = row.firstChild;
            if (div instanceof HTMLDivElement)
                if ((!id || div.dataset.id === id) &&
                   div.dataset.peerId === userId) {
                    if (div.dataset.id)
                        chatReactionState.delete(div.dataset.id);
                    box.removeChild(row);
                    continue;
                }
        }
        i++;
    }
}

/**
 * A command known to the command-line parser.
 *
 * @typedef {Object} command
 * @property {string} [parameters]
 *     - A user-readable list of parameters.
 * @property {string} [description]
 *     - A user-readable description, null if undocumented.
 * @property {() => string} [predicate]
 *     - Returns null if the command is available.
 * @property {(c: string, r: string) => void} f
 */

/**
 * The set of commands known to the command-line parser.
 *
 * @type {Object.<string,command>}
 */
const commands = {};

function operatorPredicate() {
    if (serverConnection && serverConnection.permissions &&
       serverConnection.permissions.indexOf('op') >= 0)
        return null;
    return 'You are not an operator';
}

function recordingPredicate() {
    if (serverConnection && serverConnection.permissions &&
       serverConnection.permissions.indexOf('record') >= 0)
        return null;
    return 'You are not allowed to record';
}

commands.help = {
    description: 'display this help',
    f: (_c, _r) => {
        /** @type {string[]} */
        const cs = [];
        for (const cmd in commands) {
            const c = commands[cmd];
            if (!c.description)
                continue;
            if (c.predicate && c.predicate())
                continue;
            cs.push(`/${cmd}${c.parameters ? ' ' + c.parameters : ''}: ${c.description}`);
        }
        localMessage(cs.sort().join('\n'));
    },
};

commands.me = {
    f: (_c, _r) => {
        // handled as a special case
        throw new Error("this shouldn't happen");
    },
};

commands.set = {
    f: (_c, r) => {
        if (!r) {
            const settings = getSettings();
            let s = "";
            for (const key in settings)
                s = s + `${key}: ${JSON.stringify(settings[key])}\n`;
            localMessage(s);
            return;
        }
        const p = parseCommand(r);
        let value;
        if (p[1]) {
            value = JSON.parse(p[1]);
        } else {
            value = true;
        }
        updateSetting(p[0], value);
        reflectSettings();
    },
};

commands.unset = {
    f: (_c, r) => {
        delSetting(r.trim());
        return;
    },
};

commands.leave = {
    description: "leave group",
    f: (_c, _r) => {
        if (!serverConnection)
            throw new Error('Not connected');
        serverConnection.close();
    },
};

commands.clear = {
    predicate: operatorPredicate,
    description: 'clear the chat history',
    f: (_c, _r) => {
        serverConnection.groupAction('clearchat');
    },
};

commands.lock = {
    predicate: operatorPredicate,
    description: 'lock this group',
    parameters: '[message]',
    f: (_c, r) => {
        serverConnection.groupAction('lock', r);
    },
};

commands.unlock = {
    predicate: operatorPredicate,
    description: 'unlock this group, revert the effect of /lock',
    f: (_c, _r) => {
        serverConnection.groupAction('unlock');
    },
};

commands.record = {
    predicate: recordingPredicate,
    description: 'start recording',
    f: (_c, _r) => {
        serverConnection.groupAction('record');
    },
};

commands.unrecord = {
    predicate: recordingPredicate,
    description: 'stop recording',
    f: (_c, _r) => {
        serverConnection.groupAction('unrecord');
    },
};

commands.subgroups = {
    predicate: operatorPredicate,
    description: 'list subgroups',
    f: (_c, _r) => {
        serverConnection.groupAction('subgroups');
    },
};

/**
 * @type {Object<string,number>}
 */
const units = {
    s: 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    mon: 31 * 24 * 60 * 60 * 1000,
    yr: 365 * 24 * 60 * 60 * 1000,
};

/**
 * @param {string} s
 * @returns {Date|number}
 */
function parseExpiration(s) {
    if (!s)
        return null;
    const re = /^([0-9]+)(s|min|h|d|yr)$/;
    const e = re.exec(s);
    if (e) {
        const unit = units[e[2]];
        if (!unit)
            throw new Error(`Couldn't find unit ${e[2]}`);
        return parseInt(e[1]) * unit;
    }
    const d = new Date(s);
    if (d.toString() === 'Invalid Date')
        throw new Error("Couldn't parse expiration date");
    return d;
}

function makeTokenPredicate() {
    return (serverConnection.permissions.indexOf('token') < 0 ?
            "You don't have permission to create tokens" : null);
}

function editTokenPredicate() {
    return (serverConnection.permissions.indexOf('token') < 0 ||
            serverConnection.permissions.indexOf('op') < 0 ?
            "You don't have permission to edit or list tokens" : null);
}

/**
 * @param {Object} [template]
 */
function makeToken(template) {
    if (!template)
        template = {};
    const v = {
        group: group,
    };
    if ('username' in template)
        v.username = template.username;
    if ('expires' in template)
        v.expires = template.expires;
    else
        v.expires = units.d;
    if ('not-before' in template)
        v["not-before"] = template["not-before"];
    if ('permissions' in template)
        v.permissions = template.permissions;
    else {
        v.permissions = [];
        if (serverConnection.permissions.indexOf('present') >= 0)
            v.permissions.push('present');
        if (serverConnection.permissions.indexOf('message') >= 0)
            v.permissions.push('message');
    }
    serverConnection.groupAction('maketoken', v);
}

commands.invite = {
    predicate: makeTokenPredicate,
    description: "create an invitation link",
    parameters: "[username] [expiration]",
    f: (_c, r) => {
        const p = parseCommand(r);
        const template = {};
        if (p[0])
            template.username = p[0];
        const expires = parseExpiration(p[1]);
        if (expires)
            template.expires = expires;
        makeToken(template);
    },
};

/**
 * @param {string} t
 */
function parseToken(t) {
    const m = /^https?:\/\/.*?token=([^?]+)/.exec(t);
    if (m) {
        return m[1];
    } else if (!/^https?:\/\//.exec(t)) {
        return t;
    } else {
        throw new Error("Couldn't parse link");
    }
}

commands.reinvite = {
    predicate: editTokenPredicate,
    description: "extend an invitation link",
    parameters: "link [expiration]",
    f: (_c, r) => {
        const p = parseCommand(r);
        const v = {};
        v.token = parseToken(p[0]);
        if (p[1])
            v.expires = parseExpiration(p[1]);
        else
            v.expires = units.d;
        serverConnection.groupAction('edittoken', v);
    },
};

commands.revoke = {
    predicate: editTokenPredicate,
    description: "revoke an invitation link",
    parameters: "link",
    f: (_c, r) => {
        const token = parseToken(r);
        serverConnection.groupAction('edittoken', {
            token: token,
            expires: -units.s,
        });
    },
};

commands.listtokens = {
    predicate: editTokenPredicate,
    description: "list invitation links",
    f: (_c, _r) => {
        serverConnection.groupAction('listtokens');
    },
};

function renegotiateStreams() {
    for (const id in serverConnection.up)
        serverConnection.up[id].restartIce();
    for (const id in serverConnection.down)
        serverConnection.down[id].restartIce();
}

commands.renegotiate = {
    description: 'renegotiate media streams',
    f: (_c, _r) => {
        renegotiateStreams();
    },
};

commands.replace = {
    f: (_c, _r) => {
        replaceUpStreams(null);
    },
};

commands.sharescreen = {
    description: 'start a screen share',
    f: (_c, _r) => {
        addShareMedia();
    },
};

commands.unsharescreen = {
    description: 'stop screen share',
    f: (_c, _r) => {
        closeUpMedia('screenshare');
    },
};

/**
 * parseCommand splits a string into two space-separated parts.  The first
 * part may be quoted and may include backslash escapes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCommand(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ')
        i++;
    let start = ' ';
    if (i < line.length && line[i] === '"' || line[i] === "'") {
        start = line[i];
        i++;
    }
    let first = "";
    while (i < line.length) {
        if (line[i] === start) {
            if (start !== ' ')
                i++;
            break;
        }
        if (line[i] === '\\' && i < line.length - 1)
            i++;
        first = first + line[i];
        i++;
    }

    while (i < line.length && line[i] === ' ')
        i++;
    return [first, line.slice(i)];
}

/**
 * @param {string} user
 */
function findUserId(user) {
    if (user in serverConnection.users)
        return user;

    for (const id in serverConnection.users) {
        const u = serverConnection.users[id];
        if (u && u.username === user)
            return id;
    }
    return null;
}

commands.msg = {
    parameters: 'user message',
    description: 'send a private message',
    f: (_c, r) => {
        const p = parseCommand(r);
        if (!p[0])
            throw new Error('/msg requires parameters');
        const id = findUserId(p[0]);
        if (!id)
            throw new Error(`Unknown user ${p[0]}`);
        serverConnection.chat('', id, p[1]);
        addToChatbox(serverConnection.id, null, id, serverConnection.username,
                     new Date(), false, false, '', p[1]);
    },
};

/**
   @param {string} c
   @param {string} r
*/
function userCommand(c, r) {
    const p = parseCommand(r);
    if (!p[0])
        throw new Error(`/${c} requires parameters`);
    const id = findUserId(p[0]);
    if (!id)
        throw new Error(`Unknown user ${p[0]}`);
    serverConnection.userAction(c, id, p[1]);
}

function userMessage(c, r) {
    const p = parseCommand(r);
    if (!p[0])
        throw new Error(`/${c} requires parameters`);
    const id = findUserId(p[0]);
    if (!id)
        throw new Error(`Unknown user ${p[0]}`);
    serverConnection.userMessage(c, id, p[1]);
}

commands.kick = {
    parameters: 'user [message]',
    description: 'kick out a user',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.identify = {
    parameters: 'user [message]',
    description: 'identify a user',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.op = {
    parameters: 'user',
    description: 'give operator status',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unop = {
    parameters: 'user',
    description: 'revoke operator status',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.present = {
    parameters: 'user',
    description: 'give user the right to present',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unpresent = {
    parameters: 'user',
    description: 'revoke the right to present',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.shutup = {
    parameters: 'user',
    description: 'revoke the right to send chat messages',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unshutup = {
    parameters: 'user',
    description: 'give the right to send chat messages',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.mute = {
    parameters: 'user',
    description: 'mute a remote user',
    predicate: operatorPredicate,
    f: userMessage,
};

commands.muteall = {
    description: 'mute all remote users',
    predicate: operatorPredicate,
    f: (_c, _r) => {
        serverConnection.userMessage('mute', null, null, true);
    },
};

commands.warn = {
    parameters: 'user message',
    description: 'send a warning to a user',
    predicate: operatorPredicate,
    f: (_c, r) => {
        userMessage('warning', r);
    },
};

commands.wall = {
    parameters: 'message',
    description: 'send a warning to all users',
    predicate: operatorPredicate,
    f: (_c, r) => {
        if (!r)
            throw new Error('empty message');
        serverConnection.userMessage('warning', '', r);
    },
};

commands.raise = {
    description: 'raise hand',
    f: (_c, _r) => {
        serverConnection.userAction(
            "setdata", serverConnection.id, {"raisehand": true},
        );
    },
};

commands.unraise = {
    description: 'unraise hand',
    f: (_c, _r) => {
        serverConnection.userAction(
            "setdata", serverConnection.id, {"raisehand": null},
        );
    },
};

/** @returns {boolean} */
function canFile() {
    const v =
        /** @ts-ignore */
        !!HTMLVideoElement.prototype.captureStream ||
        /** @ts-ignore */
        !!HTMLVideoElement.prototype.mozCaptureStream;
    return v;
}

function presentFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = "audio/*,video/*";
    input.onchange = function(_e) {
        if (!(this instanceof HTMLInputElement))
            throw new Error('Unexpected type for this');
        const files = this.files;
        for (let i = 0; i < files.length; i++) {
            addFileMedia(files[i]).catch (e => {
                console.error(e);
                displayError(e);
            });
        }
    };
    input.click();
}

commands.presentfile = {
    description: 'broadcast a video or audio file',
    f: (_c, _r) => {
        presentFile();
    },
    predicate: () => {
        if (!canFile())
            return 'Your browser does not support presenting arbitrary files';
        if (!serverConnection || !serverConnection.permissions ||
           serverConnection.permissions.indexOf('present') < 0)
            return 'You are not authorised to present.';
        return null;
    },
};


/**
 * @param {string} id
 */
function sendFile(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = function(_e) {
        if (!(this instanceof HTMLInputElement))
            throw new Error('Unexpected type for this');
        const files = this.files;
        for (let i = 0; i < files.length; i++) {
            try {
                serverConnection.sendFile(id, files[i]);
            } catch (e) {
                console.error(e);
                displayError(e);
            }
        }
    };
    input.click();
}

commands.sendfile = {
    parameters: 'user',
    description: 'send a file (this will disclose your IP address)',
    f: (c, r) => {
        const p = parseCommand(r);
        if (!p[0])
            throw new Error(`/${c} requires parameters`);
        const id = findUserId(p[0]);
        if (!id)
            throw new Error(`Unknown user ${p[0]}`);
        sendFile(id);
    },
};

/**
 * Test loopback through a TURN relay.
 *
 * @returns {Promise<number>}
 */
async function relayTest() {
    if (!serverConnection)
        throw new Error('not connected');
    const conf = Object.assign({}, serverConnection.getRTCConfiguration());
    conf.iceTransportPolicy = 'relay';
    const pc1 = new RTCPeerConnection(conf);
    const pc2 = new RTCPeerConnection(conf);
    pc1.onicecandidate = e => {
e.candidate && pc2.addIceCandidate(e.candidate);
};
    pc2.onicecandidate = _e => {
        // ICE candidate handling - not used in loopback test
    };
    try {
        return await new Promise(async (resolve, reject) => {
            const d1 = pc1.createDataChannel('loopbackTest');
            d1.onopen = _e => {
                d1.send(Date.now().toString());
            };

            const offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(pc1.localDescription);
            const answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(pc2.localDescription);

            pc2.ondatachannel = e => {
                const d2 = e.channel;
                d2.onmessage = e => {
                    const t = parseInt(e.data);
                    if (isNaN(t))
                        reject(new Error('corrupt data'));
                    else
                        resolve(Date.now() - t);
                };
            };

            setTimeout(() => reject(new Error('timeout')), 5000);
        });
    } finally {
        pc1.close();
        pc2.close();
    }
}

commands['relay-test'] = {
    f: async (_c, _r) => {
        localMessage('Relay test in progress...');
        try {
            const s = Date.now();
            const rtt = await relayTest();
            const e = Date.now();
            localMessage(`Relay test successful in ${e - s}ms, RTT ${rtt}ms`);
        } catch (e) {
            localMessage(`Relay test failed: ${e}`);
        }
    },
};

function handleInput() {
    const input = /** @type {HTMLTextAreaElement} */
        (document.getElementById('input'));
    const data = input.value;
    input.value = '';
    resizeChatInput(true);

    let message, me;

    if (data.trim() === '')
        return;

    if (data[0] === '/') {
        if (data.length > 1 && data[1] === '/') {
            message = data.slice(1);
            me = false;
        } else {
            let cmd, rest;
            const space = data.indexOf(' ');
            if (space < 0) {
                cmd = data.slice(1);
                rest = '';
            } else {
                cmd = data.slice(1, space);
                rest = data.slice(space + 1);
            }

            if (cmd === 'me') {
                message = rest;
                me = true;
            } else {
                const c = commands[cmd];
                if (!c) {
                    displayError(`Uknown command /${cmd}, type /help for help`);
                    return;
                }
                if (c.predicate) {
                    const s = c.predicate();
                    if (s) {
                        displayError(s);
                        return;
                    }
                }
                try {
                    c.f(cmd, rest);
                } catch (e) {
                    console.error(e);
                    displayError(e);
                }
                return;
            }
        }
    } else {
        message = data;
        me = false;
    }

    if (!serverConnection || !serverConnection.socket) {
        displayError("Not connected.");
        return;
    }

    try {
        serverConnection.chat(me ? 'me' : '', '', message);
    } catch (e) {
        console.error(e);
        displayError(e);
    }
}

document.getElementById('inputform').onsubmit = function(e) {
    e.preventDefault();
    handleInput();
};

document.getElementById('input').onkeydown = function(e) {
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        handleInput();
    }
};

document.getElementById('input').addEventListener('input', function() {
    resizeChatInput();
});

const emojiToggle = document.getElementById('emoji-toggle');
if (emojiToggle) {
    emojiToggle.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleEmojiPicker();
    });
}

const emojiPicker = document.getElementById('emoji-picker');
if (emojiPicker) {
    emojiPicker.addEventListener('click', function(e) {
        e.stopPropagation();
    });
}

document.addEventListener('click', function() {
    closeEmojiPicker();
    closeReactionPickers();
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeEmojiPicker();
        closeReactionPickers();
        closeConferenceFocus();
    }
});

function chatResizer(e) {
    e.preventDefault();
    const full_width = document.getElementById("mainrow").offsetWidth;
    const left = document.getElementById("left");
    const right = document.getElementById("right");
    if (!left || !right)
        return;

    const start_x = e.clientX;
    const start_width = left.offsetWidth;

    function start_drag(e) {
        const left_width = (start_width + e.clientX - start_x) * 100 / full_width;
        // set min chat width to 300px
        const min_left_width = 300 * 100 / full_width;
        if (left_width < min_left_width) {
          return;
        }
        left.style.flex = left_width.toString();
        right.style.flex = (100 - left_width).toString();
    }
    function stop_drag(_e) {
        document.documentElement.removeEventListener(
            'mousemove', start_drag, false,
        );
        document.documentElement.removeEventListener(
            'mouseup', stop_drag, false,
        );
    }

    document.documentElement.addEventListener(
        'mousemove', start_drag, false,
    );
    document.documentElement.addEventListener(
        'mouseup', stop_drag, false,
    );
}

document.getElementById('resizer').addEventListener('mousedown', chatResizer, false);

/**
 * Format error with stack trace for debugging
 * @param {unknown} err
 * @returns {string}
 */
function formatErrorWithStack(err) {
    if (err instanceof Error) {
        let msg = err.message || String(err);
        if (err.stack) {
            // Extract the useful part of the stack trace
            const stack = err.stack;
            // Remove the error message from the stack if it's duplicated
            let lines = stack.split('\n');
            if (lines.length > 0 && lines[0].includes(msg)) {
                lines = lines.slice(1);
            }
            // Add first few lines of stack trace
            const stackPreview = lines.slice(0, 4).join('\n');
            msg += '\n\nStack:\n' + stackPreview;
            if (lines.length > 4) {
                msg += `\n...and ${lines.length - 4} more`;
            }
        }
        return msg;
    }
    return String(err);
}

/**
 * @param {unknown} message
 * @param {string} [level]
 */
function displayError(message, level) {
    if (!level)
        level = "error";
    let position = 'center';
    let gravity = 'top';

    switch (level) {
    case "info":
        position = 'right';
        gravity = 'bottom';
        break;
    case "warning":
        break;
    case "kicked":
        level = "error";
        break;
    }

    const displayMsg = formatErrorWithStack(message);
    console.error('[displayError]', displayMsg);

    /** @ts-ignore */
    Toastify({
        text: displayMsg,
        duration: 6000,
        close: true,
        position: position,
        gravity: gravity,
        className: level,
    }).showToast();
}

/**
 * @param {unknown} message
 */
function displayWarning(message) {
    return displayError(message, "warning");
}

/**
 * @param {unknown} message
 */
function displayMessage(message) {
    return displayError(message, "info");
}

/** @type {MediaStream} */
const loginStream = null;

document.getElementById('loginform').onsubmit = async function(e) {
    e.preventDefault();

    const form = this;
    if (!(form instanceof HTMLFormElement))
        throw new Error('Bad type for loginform');

    setVisibility('passwordform', true);

    // Always enable camera and microphone by default
    presentRequested = 'both';
    updateSettings({cameraOff: false});
    setLocalCameraOff(false, false);
    reconnectPending = false;

    if (isReconnectCooldownActive()) {
        updateReconnectCooldownUi();
        displayWarning('Please wait a few seconds before reconnecting.');
        return;
    }

    if (typeof ensurePersistentClientIdForUsername === 'function')
        ensurePersistentClientIdForUsername(getInputElement('username').value);

    // Connect directly and request camera/microphone during join.
    serverConnect();
};

document.getElementById('disconnectbutton').onclick = function(_e) {
    reconnectPending = false;
    reconnectState = null;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    serverConnection.close();
    closeNav();
};

function openNav(panelName) {
    setToolPanel(panelName || activeToolPanel, true);
}

function closeNav() {
    setToolPanel(activeToolPanel, false);
}

/**
 * Fixed secret key for XOR obfuscation
 * @const {string}
 */
const XOR_SECRET_KEY = 'owly-obfuscate-2024';
const LEGACY_XOR_SECRET_KEY = 'galene-obfuscate-2024';

/**
 * XOR encodes a string with a repeating key pattern
 * The key is the secret XORed with the group name for uniqueness
 * @param {string} str - The string to encode
 * @param {string} salt - The salt (group name) to mix with secret key
 * @returns {string} - XOR encoded string as UTF-16 code units
 */
function xorTransform(str, salt, secret) {
    const key = secret + salt;
    let result = '';
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
}

function xorEncode(str, salt) {
    return xorTransform(str, salt, XOR_SECRET_KEY);
}

/**
 * XOR decodes a string that was encoded with xorEncode
 * @param {string} str - The XOR encoded string
 * @param {string} salt - The salt (group name) used during encoding
 * @returns {string} - The decoded original string
 */
function xorDecode(str, salt) {
    const current = xorTransform(str, salt, XOR_SECRET_KEY);
    const legacy = xorTransform(str, salt, LEGACY_XOR_SECRET_KEY);
    return current.includes('\u0000') ? legacy : current;
}

/**
 * Base64 variant for URLs: replaces + with -, / with _, = with .
 * @param {string} str - String to encode
 * @returns {string} - URL-safe Base64 encoded string
 */
function base64UrlEncode(str) {
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '.');
}

/**
 * Decodes Base64 URL variant back to original string
 * @param {string} str - URL-safe Base64 encoded string
 * @returns {string} - Decoded original string
 */
function base64UrlDecode(str) {
    return atob(str
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .replace(/\./g, '='));
}

/**
 * Encodes a password for use in URL with XOR obfuscation and Base64
 * @param {string} password - The password to encode
 * @param {string} groupName - The group name used as salt
 * @returns {string} - Base64 encoded XOR-obfuscated password
 */
function encodePasswordForUrl(password, groupName) {
    const xorEncoded = xorEncode(password, groupName);
    return base64UrlEncode(xorEncoded);
}

/**
 * Decodes a password from URL with XOR de-obfuscation and Base64
 * @param {string} encoded - The Base64 encoded XOR-obfuscated password
 * @param {string} groupName - The group name used as salt
 * @returns {string|null} - The decoded password, or null if decoding fails
 */
function decodePasswordFromUrl(encoded, groupName) {
    try {
        const base64Decoded = base64UrlDecode(encoded);
        return xorDecode(base64Decoded, groupName);
    } catch (e) {
        console.warn('Failed to decode password from URL:', e);
        return null;
    }
}

/**
 * Generates a shareable URL with encoded password
 * @param {string} groupName - The group name
 * @param {string} password - The group password
 * @returns {string} - Encoded URL like /group/GROUP_NAME/BASE64_PASSWORD
 */
function generateShareableUrl(groupName, password) {
    const encoded = encodePasswordForUrl(password, groupName);
    return `${location.protocol}//${location.host}/group/${groupName}/${encoded}`;
}

/**
 * Copies text to clipboard and shows a message
 * @param {string} text - The text to copy
 */
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        displayMessage('Invite link copied to clipboard!');
    }).catch((_e) => {
        displayError('Failed to copy link');
    });
}

document.getElementById('sharelinkbutton').onclick = function(_e) {
    if (loginPassword && group) {
        const url = generateShareableUrl(group, loginPassword);
        copyToClipboard(url);
    } else {
        displayError('No password available for sharing');
    }
};

document.getElementById('clodeside').onclick = function(e) {
    e.preventDefault();
    closeNav();
};

document.querySelectorAll('.tool-rail-button').forEach(button => {
    button.addEventListener('click', function(e) {
        e.preventDefault();
        if (!(this instanceof HTMLElement))
            return;
        const nextPanel = this.dataset.panel || 'media';
        const panel = document.getElementById('sidebarnav');
        const isOpen = panel && !panel.classList.contains('panel-closed');
        if (isOpen && activeToolPanel === nextPanel) {
            closeNav();
        } else {
            openNav(nextPanel);
        }
    });
});

const closeChatButton = document.getElementById('close-chat');
if (closeChatButton) {
    closeChatButton.onclick = function(e) {
        e.preventDefault();
        setChatOpen(false);
    };
}

const workspaceToggleMobile = document.getElementById('workspace-toggle-mobile');
if (workspaceToggleMobile) {
    workspaceToggleMobile.onclick = function(e) {
        e.preventDefault();
        const panel = document.getElementById('sidebarnav');
        const isOpen = !!(panel && !panel.classList.contains('panel-closed'));
        if (isOpen)
            closeNav();
        else
            openNav(activeToolPanel);
    };
}

const participantsToggle = document.getElementById('participants-toggle');
if (participantsToggle) {
    participantsToggle.onclick = function(e) {
        e.preventDefault();
        const container = getParticipantsContainer();
        const collapsed = !!(
            container && container.classList.contains('chat-users-collapsed')
        );
        setParticipantsCollapsed(!collapsed, true);
    };
}

setToolPanel(activeToolPanel, false);
setChatOpen(false);
updateParticipantsHeader();
updateStageBadge();
updateReconnectCooldownUi();

async function serverConnect() {
    if (serverConnectPromise)
        return serverConnectPromise;

    const promise = (async () => {
        const previousConnection = serverConnection;
        if (previousConnection) {
            // Prevent stale callbacks from old sockets causing duplicate reconnect loops.
            previousConnection.onconnected = null;
            previousConnection.onerror = null;
            previousConnection.onpeerconnection = null;
            previousConnection.onclose = null;
            previousConnection.ondownstream = null;
            previousConnection.onuser = null;
            previousConnection.onjoined = null;
            previousConnection.onchat = null;
            previousConnection.onusermessage = null;
            previousConnection.onfiletransfer = null;
            if (previousConnection.socket)
                previousConnection.close('Replacing stale connection');
        }

        const connection = new ServerConnection();
        serverConnection = connection;
        connection.onconnected = gotConnected;
        connection.onerror = function(e) {
            if (this !== serverConnection)
                return;
            console.error(e);
            // During reconnect loops, avoid spamming duplicate error toasts:
            // gotClose already surfaces reconnect state to the user.
            if (reconnectPending || reconnectAttempts > 0)
                return;
            displayError(e);
        };
        connection.onpeerconnection = onPeerConnection;
        connection.onclose = gotClose;
        connection.ondownstream = gotDownStream;
        connection.onuser = gotUser;
        connection.onjoined = gotJoined;
        connection.onchat = addToChatbox;
        connection.onusermessage = gotUserMessage;
        connection.onfiletransfer = gotFileTransfer;

        let url = groupStatus.endpoint;
        if (!url) {
            console.warn("no endpoint in status");
            url = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws`;
        }

        try {
            await connection.connect(url);
        } catch (e) {
            if (connection !== serverConnection)
                return;
            console.error(e);
            // Enhance error with connection context
            if (e instanceof Error && !e.message.includes(url)) {
                e.message = `Connection to ${url} failed: ${e.message}`;
            }
            displayError(e);
        }
    })();

    serverConnectPromise = promise;
    try {
        return await promise;
    } finally {
        if (serverConnectPromise === promise)
            serverConnectPromise = null;
    }
}

async function start() {
    try {
        const r = await fetch(".status");
        if (!r.ok)
            throw new Error(`${r.status} ${r.statusText}`);
        groupStatus = await r.json();
    } catch (e) {
        console.error(e);
        displayWarning("Couldn't fetch status: " + e);
        groupStatus = {};
    }

    if (groupStatus.name) {
        group = groupStatus.name;
    } else {
        console.warn("no group name in status");
        group = decodeURIComponent(
            location.pathname.replace(/^\/[a-z]*\//, '').replace(/\/$/, ''),
        );
    }

    // Password-in-URL support: Extract encoded password from URL path
    // URL format: /group/GROUP_NAME/BASE64_ENCODED_PASSWORD
    // The password is XOR-obfuscated with the group name as salt before Base64 encoding
    passwordFromUrl = null;
    const pathParts = location.pathname.split('/').filter(p => p);
    if (pathParts.length >= 3 && pathParts[0] === 'group') {
        // Third segment might be an encoded password
        const encodedPassword = pathParts[2];
        // Use the second segment as potential group name for salt
        const potentialGroupName = pathParts[1];
        passwordFromUrl = decodePasswordFromUrl(encodedPassword, potentialGroupName);
    }

    // Disable simulcast on Firefox by default, it's buggy.
    if (isFirefox())
        getSelectElement('simulcastselect').value = 'off';

    const parms = new URLSearchParams(window.location.search);
    if (window.location.search)
        window.history.replaceState(null, '', window.location.pathname);
    setTitle(groupStatus.displayName || capitalise(group));

    // Force early settings normalisation before any optional startup work.
    getSettings();
    await ensureFilterOptionsLoaded(false);
    await setMediaChoices(false);
    reflectSettings();

    if (parms.has('token'))
        token = parms.get('token');

    if (token) {
        await serverConnect();
    } else if (groupStatus.authPortal) {
        window.location.href = groupStatus.authPortal;
    } else {
        setVisibility('login-container', true);
        // If password is in URL, hide password field and pre-fill it
        if (passwordFromUrl) {
            setVisibility('passwordform', false);
            getInputElement('password').value = passwordFromUrl;
            loginPassword = passwordFromUrl;  // Store for share link generation
        }
        // Restore previously saved username from localStorage
        let usernameRestored = false;
        try {
            const savedUsername = getStoredUsername();
            if (savedUsername) {
                getInputElement('username').value = savedUsername;
                usernameRestored = true;
            }
        } catch (e) {
            console.warn('Failed to restore username from localStorage:', e);
        }
        // Avoid programmatic focus on mobile browsers: it can trigger keyboard/autofill
        // viewport shifts and break the fixed-shell layout.
        if (!isMobileBurgerLayout()) {
            if (usernameRestored) {
                document.getElementById('password').focus();
            } else {
                document.getElementById('username').focus();
            }
        }
    }
    setViewportHeight();

    // Add a user interaction handler to enable audio on downstream videos
    // Desktop browsers block autoplay of videos with sound - this enables
    // audio after the user interacts with the page
    const enableAudio = () => {
        if (audioEnabled)
            return;
        audioEnabled = true;
        debugLog('[enableAudio] User interaction detected, enabling audio on downstream videos');
        if (serverConnection) {
            for (const id in serverConnection.down) {
                const c = serverConnection.down[id];
                const media = document.getElementById('media-' + c.localId);
                if (media && c.userMuted === undefined) {
                    const tryResumeDownstream = async () => {
                        if (media.paused && media.srcObject) {
                            try {
                                await media.play();
                            } catch (e) {
                                console.warn('[enableAudio] play() retry failed for', c.localId, e);
                                c.userdata.play = true;
                                return;
                            }
                        }

                        if (media.muted) {
                            debugLog('[enableAudio] Unmuting downstream video', c.localId);
                            media.muted = false;

                            const container = document.getElementById('controls-' + c.localId);
                            if (container) {
                                const volumeBtn = container.getElementsByClassName('volume-mute')[0];
                                const volumeSlider = container.getElementsByClassName('volume-slider')[0];
                                if (volumeBtn && volumeSlider) {
                                    setVolumeButton(false, volumeBtn, volumeSlider);
                                    debugLog('[enableAudio] Volume button UI updated for', c.localId);
                                }
                            }
                        }
                    };
                    tryResumeDownstream();
                } else if (c.userMuted !== undefined) {
                    debugLog('[enableAudio] Skipping', c.localId, '- user has manual mute preference:', c.userMuted);
                }
            }
        }
    };

    // Enable audio on user interaction (click, keydown, etc.)
    document.addEventListener('click', enableAudio, { once: true, passive: true });
    document.addEventListener('keydown', enableAudio, { once: true, passive: true });
}

start();
