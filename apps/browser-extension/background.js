import { normalizeLocale, translate } from './i18n.js';

const BRIDGE = 'http://127.0.0.1:47831';

async function getLocale() {
  try {
    const response = await fetch(`${BRIDGE}/v1/browser/preferences`);
    if (response.ok) {
      const locale = normalizeLocale((await response.json()).locale);
      await chrome.storage.local.set({ everroomLocale: locale });
      return locale;
    }
  } catch {}
  const stored = await chrome.storage.local.get(['everroomLocale']);
  return normalizeLocale(stored.everroomLocale || chrome.i18n?.getUILanguage?.());
}

async function localized(key) { return translate(await getLocale(), key); }

async function discoverAndClaim() {
  const claimResponse = await fetch(`${BRIDGE}/v1/browser/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      extensionId: chrome.runtime.id,
      extensionName: chrome.runtime.getManifest().name,
    }),
  });
  if (!claimResponse.ok) throw new Error('EverRoom pairing claim failed');
  const result = await claimResponse.json();
  if (!result.accessToken) throw new Error('EverRoom pairing did not return an access token');
  await chrome.storage.local.set({ accessToken: result.accessToken });
  await chrome.storage.local.remove(['pairingSessionId', 'extensionPublicKeyJwk', 'extensionPrivateKeyJwk']);
  return { status: 'paired' };
}

async function connectionStatus() {
  const stored = await chrome.storage.local.get(['accessToken']);
  if (!stored.accessToken) return { status: 'idle' };
  try {
    const response = await fetch(`${BRIDGE}/v1/browser/session`, {
      headers: { 'Authorization': `Bearer ${stored.accessToken}` },
    });
    if (response.ok) return { status: 'paired' };
    if (response.status === 401 || response.status === 403) await chrome.storage.local.remove(['accessToken']);
    return { status: 'idle' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function sendToEverRoom(type, payload) {
  const stored = await chrome.storage.local.get(['accessToken']);
  if (!stored.accessToken) return { ok: false, code: 'not_paired' };
  const response = await fetch(`${BRIDGE}/v1/browser/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${stored.accessToken}`,
    },
    body: JSON.stringify({ type, payload }),
  });
  return response.ok ? { ok: true } : { ok: false, code: 'bridge_error' };
}

async function uploadPendingAssets(tabId, capture, accessToken, result) {
  const pending = new Set(result.pendingAssetIds || []);
  const failures = [];
  for (const asset of capture.assets || []) {
    if (!pending.has(asset.id)) continue;
    const payload = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'everroom:read-asset', asset }, (value) => {
        if (chrome.runtime.lastError) resolve({ ok: false, code: 'page_unavailable' });
        else resolve(value || { ok: false, code: 'asset_unavailable' });
      });
    });
    if (!payload.ok || !payload.data) {
      failures.push({ assetId: asset.id, code: payload.code || 'asset_unavailable' });
      continue;
    }
    const upload = await fetch(`${BRIDGE}/v1/browser/captures/${encodeURIComponent(capture.captureId)}/assets/${encodeURIComponent(asset.id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ data: payload.data }),
    });
    if (!upload.ok) {
      const body = await upload.json().catch(() => ({}));
      failures.push({ assetId: asset.id, code: body.code || 'asset_upload_failed' });
    }
  }
  const finalized = await fetch(`${BRIDGE}/v1/browser/captures/${encodeURIComponent(capture.captureId)}/finalize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ failures }),
  });
  const captureResult = await finalized.json().catch(() => result.capture || {});
  if (!finalized.ok) return { ok: false, code: captureResult.code || 'capture_finalize_failed' };
  if (captureResult.failedAssetCount > 0) await chrome.storage.local.set({ retryCapture: {
    tabId,
    capture: { captureId: capture.captureId, assets: capture.assets || [] },
  } });
  else await chrome.storage.local.remove(['retryCapture']);
  return { ok: true, ...result, capture: captureResult };
}

async function captureToEverRoom(tabId, capture) {
  const stored = await chrome.storage.local.get(['accessToken']);
  if (!stored.accessToken) return { ok: false, code: 'not_paired' };
  if (!Number.isInteger(tabId)) return { ok: false, code: 'page_unavailable' };
  const response = await fetch(`${BRIDGE}/v1/browser/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${stored.accessToken}` },
    body: JSON.stringify(capture),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, code: result.code || 'bridge_error' };
  return uploadPendingAssets(tabId, capture, stored.accessToken, result);
}

async function retryLastCapture() {
  const stored = await chrome.storage.local.get(['accessToken', 'retryCapture']);
  if (!stored.accessToken) return { ok: false, code: 'not_paired' };
  if (!stored.retryCapture) return { ok: false, code: 'nothing_to_retry' };
  const { tabId, capture } = stored.retryCapture;
  const response = await fetch(`${BRIDGE}/v1/browser/captures/${encodeURIComponent(capture.captureId)}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${stored.accessToken}` },
    body: '{}',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, code: result.code || 'capture_retry_failed' };
  return uploadPendingAssets(tabId, capture, stored.accessToken, result);
}

async function captureFromTab(tabId, selectionText = '') {
  if (!Number.isInteger(tabId)) return { ok: false, code: 'page_unavailable' };
  const send = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'everroom:capture', selectionText }, (result) => {
      resolve(chrome.runtime.lastError ? { delivered: false, result: null } : { delivered: true, result });
    });
  });
  let response = await send();
  if (!response.delivered) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/Readability.js', 'content-script.js'] });
      response = await send();
    } catch {
      return { ok: false, code: 'restricted_page' };
    }
  }
  const capture = response.result;
  if (!capture) return { ok: false, code: 'page_unavailable' };
  return captureToEverRoom(tabId, capture);
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'everroom-save-page',
      title: translate('en-US', 'contextSave'),
      contexts: ['page', 'selection'],
    });
    void refreshContextMenuLocale();
  });
}

async function refreshContextMenuLocale() {
  const locale = await getLocale();
  try {
    await chrome.contextMenus.update('everroom-save-page', { title: translate(locale, 'contextSave') });
  } catch {}
  return locale;
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  void discoverAndClaim().catch(() => undefined);
});

chrome.runtime.onStartup?.addListener(createContextMenus);
chrome.contextMenus.onShown?.addListener(() => {
  void refreshContextMenuLocale().then(() => chrome.contextMenus.refresh?.());
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'everroom-save-page' || !tab?.id) return;
  void captureFromTab(tab.id, info.selectionText || '').then(async (outcome) => {
    const partial = outcome.ok && outcome.capture?.failedAssetCount > 0;
    chrome.action.setBadgeBackgroundColor({ color: outcome.ok ? (partial ? '#b7791f' : '#256f65') : '#b42318' });
    chrome.action.setBadgeText({ text: outcome.ok && !partial ? 'OK' : '!' });
    chrome.action.setTitle({ title: outcome.ok ? await localized(partial ? 'actionSavedPartial' : 'actionSaved') : await localized(outcome.code === 'restricted_page' ? 'restrictedPage' : 'actionSaveFailed') });
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'everroom:connect') {
    void discoverAndClaim().then((result) => sendResponse(result)).catch((error) => sendResponse({ status: 'error', message: error.message }));
    return true;
  }
  if (message?.type === 'everroom:connection-status') {
    void connectionStatus().then(sendResponse);
    return true;
  }
  if (message?.type === 'everroom:locale') {
    void refreshContextMenuLocale().then((locale) => sendResponse({ locale }));
    return true;
  }
  if (message?.type === 'everroom:send') {
    void sendToEverRoom(message.eventType, message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === 'everroom:capture') {
    void captureFromTab(message.tabId, message.selectionText || '').then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === 'everroom:retry-status') {
    void chrome.storage.local.get(['retryCapture']).then((stored) => sendResponse({ available: Boolean(stored.retryCapture) }));
    return true;
  }
  if (message?.type === 'everroom:retry-last') {
    void retryLastCapture().then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  return false;
});
