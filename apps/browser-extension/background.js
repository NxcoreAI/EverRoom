import { normalizeLocale, translate } from './i18n.js';

const BRIDGE = 'http://127.0.0.1:47831';
const SOFT_ASSET_BYTES = 2 * 1024 * 1024;
const SOFT_TOTAL_ASSET_BYTES = 15 * 1024 * 1024;
const EMERGENCY_ASSET_BYTES = 20 * 1024 * 1024;
const EMERGENCY_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;

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

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function assetOriginPattern(asset) {
  try { return `${new URL(asset.originalUrl).origin}/*`; } catch { return null; }
}

async function requestImageHostPermissions(assets) {
  const origins = [...new Set((assets || []).map(assetOriginPattern).filter(Boolean))];
  const granted = new Set();
  const missing = [];
  for (const origin of origins) {
    if (await chrome.permissions.contains({ origins: [origin] })) granted.add(origin);
    else missing.push(origin);
  }
  if (missing.length > 0) {
    try {
      if (await chrome.permissions.request({ origins: missing })) missing.forEach((origin) => granted.add(origin));
    } catch { /* Page-context fallback remains available. */ }
  }
  return granted;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readAssetInBackground(asset, permittedOrigins, pageUrl) {
  const origin = assetOriginPattern(asset);
  if (!origin || !permittedOrigins.has(origin)) return { ok: false, code: 'host_permission_denied' };
  let lastCode = 'asset_fetch_failed';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(asset.originalUrl, {
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-cache',
        referrer: pageUrl,
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        lastCode = `http_${response.status}`;
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await wait(350);
          continue;
        }
        return { ok: false, code: lastCode };
      }
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > EMERGENCY_ASSET_BYTES) return { ok: false, code: 'asset_emergency_limit' };
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) return { ok: false, code: 'asset_empty' };
      if (buffer.byteLength > EMERGENCY_ASSET_BYTES) return { ok: false, code: 'asset_emergency_limit' };
      return { ok: true, data: bytesToBase64(new Uint8Array(buffer)), byteSize: buffer.byteLength };
    } catch (error) {
      lastCode = error?.name === 'TimeoutError' ? 'asset_timeout' : 'asset_fetch_failed';
      if (attempt === 0) await wait(350);
    }
  }
  return { ok: false, code: lastCode };
}

async function readAssetFromPage(tabId, asset) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'everroom:read-asset', asset }, (value) => {
      if (chrome.runtime.lastError) resolve({ ok: false, code: 'page_unavailable' });
      else resolve(value || { ok: false, code: 'asset_unavailable' });
    });
  });
}

async function confirmLargeImages(tabId, assetBytes, totalBytes) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'everroom:confirm-large-images', assetBytes, totalBytes }, (value) => {
      if (chrome.runtime.lastError) resolve(false);
      else resolve(Boolean(value?.confirmed));
    });
  });
}

async function uploadPendingAssets(tabId, capture, accessToken, result, permittedOrigins = new Set()) {
  const pending = new Set(result.pendingAssetIds || []);
  const failureByAsset = new Map();
  let totalBytes = 0;
  let largeImagesDecision = null;
  let largeImagesConfirmation = null;
  const pendingAssets = (capture.assets || []).filter((asset) => pending.has(asset.id));
  const retryCapture = { tabId, capture: { captureId: capture.captureId, assets: capture.assets || [] } };
  if (pendingAssets.length > 0) await chrome.storage.local.set({ retryCapture });
  const fail = (asset, code) => failureByAsset.set(asset.id, { assetId: asset.id, code: code || 'asset_unavailable' });
  let uploadQueue = Promise.resolve();
  const uploadAsset = (asset, data) => {
    const task = uploadQueue.then(async () => {
      try {
        const upload = await fetch(`${BRIDGE}/v1/browser/captures/${encodeURIComponent(capture.captureId)}/assets/${encodeURIComponent(asset.id)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ data }),
        });
        if (!upload.ok) {
          const body = await upload.json().catch(() => ({}));
          fail(asset, body.code || 'asset_upload_failed');
        }
      } catch {
        fail(asset, 'asset_upload_failed');
      }
    });
    uploadQueue = task.catch(() => undefined);
    return task;
  };
  let nextAsset = 0;
  const workers = Array.from({ length: Math.min(4, pendingAssets.length) }, async () => {
    while (nextAsset < pendingAssets.length) {
      const asset = pendingAssets[nextAsset++];
      try {
        let payload = await readAssetInBackground(asset, permittedOrigins, capture.url || capture.canonicalUrl);
        if (!payload.ok && payload.code !== 'asset_emergency_limit') payload = await readAssetFromPage(tabId, asset);
        if (!payload.ok || !payload.data) {
          fail(asset, payload.code);
          continue;
        }
        const byteSize = payload.byteSize || Math.floor(payload.data.length * 3 / 4);
        totalBytes += byteSize;
        if (totalBytes > EMERGENCY_TOTAL_ASSET_BYTES) {
          fail(asset, 'assets_emergency_limit');
          continue;
        }
        if (byteSize > SOFT_ASSET_BYTES || totalBytes > SOFT_TOTAL_ASSET_BYTES) {
          if (largeImagesDecision === null) {
            largeImagesConfirmation ||= confirmLargeImages(tabId, byteSize, totalBytes).then((confirmed) => {
              largeImagesDecision = confirmed;
              return confirmed;
            });
            await largeImagesConfirmation;
          }
          if (!largeImagesDecision) {
            fail(asset, 'asset_user_declined');
            continue;
          }
        }
        await uploadAsset(asset, payload.data);
      } catch {
        fail(asset, 'asset_processing_failed');
      }
    }
  });
  await Promise.all(workers);
  await uploadQueue;
  const failures = [...failureByAsset.values()];
  let finalized;
  try {
    finalized = await fetch(`${BRIDGE}/v1/browser/captures/${encodeURIComponent(capture.captureId)}/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ failures }),
    });
  } catch {
    return { ok: false, code: 'capture_finalize_failed', ...result };
  }
  const captureResult = await finalized.json().catch(() => result.capture || {});
  if (!finalized.ok) return { ok: false, code: captureResult.code || 'capture_finalize_failed' };
  if (captureResult.failedAssetCount > 0) await chrome.storage.local.set({ retryCapture });
  else await chrome.storage.local.remove(['retryCapture']);
  return { ok: true, ...result, capture: captureResult };
}

async function captureToEverRoom(tabId, capture, permittedOrigins) {
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
  return uploadPendingAssets(tabId, capture, stored.accessToken, result, permittedOrigins);
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
  const permittedOrigins = await requestImageHostPermissions(capture.assets);
  return uploadPendingAssets(tabId, capture, stored.accessToken, result, permittedOrigins);
}

async function extractFromTab(tabId, selectionText = '') {
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
  return { ok: true, capture };
}

async function captureFromTab(tabId, selectionText = '') {
  const extracted = await extractFromTab(tabId, selectionText);
  if (!extracted.ok) return extracted;
  const capture = extracted.capture;
  const permittedOrigins = await requestImageHostPermissions(capture.assets);
  return captureToEverRoom(tabId, capture, permittedOrigins);
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
  if (message?.type === 'everroom:extract-capture') {
    void extractFromTab(message.tabId, message.selectionText || '').then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === 'everroom:submit-capture') {
    void requestImageHostPermissions(message.capture?.assets).then((permittedOrigins) =>
      captureToEverRoom(message.tabId, message.capture, permittedOrigins)
    ).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
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

export { assetOriginPattern, readAssetInBackground, requestImageHostPermissions, uploadPendingAssets };
