import { normalizeLocale, translate } from './i18n.js';
import { captureStatusKey, progressStates, retryStatusKey } from './popup-state.js';

const status = document.querySelector('#status');
const connectionLabel = document.querySelector('#connection');
const connect = document.querySelector('#connect');
const send = document.querySelector('#send');
const retry = document.querySelector('#retry');
const pageTitle = document.querySelector('#page-title');
const pageDomain = document.querySelector('#page-domain');
const favicon = document.querySelector('#favicon');
const steps = [...document.querySelectorAll('.step')];
const extensionContext = location.protocol === 'chrome-extension:' && globalThis.chrome?.runtime?.sendMessage;
let locale = 'en-US';
let activeTab = null;
const t = (key) => translate(locale, key);
const sendMessage = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (result) => resolve(chrome.runtime.lastError ? null : result)));

function setStatus(value) { status.textContent = value; }
function setConnection(state) {
  connectionLabel.dataset.state = state || 'idle';
  connectionLabel.textContent = state === 'paired' ? t('connectedShort') : state === 'unavailable' ? t('offlineShort') : t('notConnectedShort');
  connect.dataset.hidden = String(state === 'paired');
  send.disabled = state !== 'paired';
}
function setProgress(active, state = 'active') {
  const states = progressStates(steps.map((step) => step.dataset.step), active, state);
  steps.forEach((step, stepIndex) => { step.dataset.state = states[stepIndex]; });
}
function assetOrigins(assets) { return [...new Set((assets || []).flatMap((asset) => { try { return [`${new URL(asset.originalUrl).origin}/*`]; } catch { return []; } }))]; }
async function requestAssetPermissions(assets) {
  const missing = [];
  for (const origin of assetOrigins(assets)) if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  if (missing.length) try { await chrome.permissions.request({ origins: missing }); } catch {}
}
function applyLocale() {
  document.documentElement.lang = locale;
  connect.textContent = t('connect'); send.textContent = t('savePage'); retry.textContent = t('retryImages');
  document.querySelector('[data-label="extract"]').textContent = t('stageExtract');
  document.querySelector('[data-label="save"]').textContent = t('stageSave');
  document.querySelector('[data-label="images"]').textContent = t('stageImages');
  document.querySelector('[data-label="done"]').textContent = t('stageDone');
}
async function initialize() {
  locale = normalizeLocale(navigator.language); applyLocale();
  if (!extensionContext) { setStatus(t('openFromToolbar')); connect.disabled = true; send.disabled = true; return; }
  const localeResult = await sendMessage({ type:'everroom:locale' }); locale = normalizeLocale(localeResult?.locale || navigator.language); applyLocale();
  [activeTab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (activeTab) {
    pageTitle.textContent = activeTab.title || t('currentPage');
    try { pageDomain.textContent = new URL(activeTab.url).hostname; } catch { pageDomain.textContent = activeTab.url || '-'; }
    if (activeTab.favIconUrl) { const image = document.createElement('img'); image.src = activeTab.favIconUrl; image.alt = ''; image.onerror = () => image.remove(); favicon.replaceChildren(image); }
  }
  const [connection, retryStatus] = await Promise.all([sendMessage({ type:'everroom:connection-status' }), sendMessage({ type:'everroom:retry-status' })]);
  setConnection(connection?.status); setStatus(connection?.status === 'paired' ? t('readyToSave') : connection?.status === 'unavailable' ? t('notRunning') : t('notConnected'));
  retry.dataset.hidden = String(!retryStatus?.available);
}
connect.addEventListener('click', async () => { setStatus(t('connecting')); const result = await sendMessage({ type:'everroom:connect' }); setConnection(result?.status); setStatus(result?.status === 'paired' ? t('readyToSave') : t('notRunning')); });
send.addEventListener('click', async () => {
  if (!extensionContext || !activeTab?.id) return setStatus(t('noActivePage'));
  send.disabled = true; retry.dataset.hidden = 'true'; setProgress('extract'); setStatus(t('extracting'));
  const extracted = await sendMessage({ type:'everroom:extract-capture', tabId:activeTab.id });
  if (!extracted?.ok) return finishError(extracted);
  await requestAssetPermissions(extracted.capture?.assets); setProgress('save'); setStatus(t('savingContent'));
  const progressListener = (message) => {
    if (message?.type !== 'everroom:capture-progress') return;
    if (message.stage === 'images') { setProgress('images'); setStatus(t('uploadingImages').replace('{current}', message.current).replace('{total}', message.total)); }
    if (message.stage === 'finalizing') { setProgress('done'); setStatus(t('finalizing')); }
  };
  chrome.runtime.onMessage.addListener(progressListener);
  const result = await sendMessage({ type:'everroom:submit-capture', tabId:activeTab.id, capture:extracted.capture });
  chrome.runtime.onMessage.removeListener(progressListener);
  if (!result?.ok) return finishError(result);
  setProgress('done', 'done'); setStatus(t(captureStatusKey(result)));
  retry.dataset.hidden = String(!result.capture?.failedAssetCount); send.disabled = false;
});
function finishError(result) { setProgress('done', 'error'); setStatus(result?.code === 'restricted_page' ? t('restrictedPage') : result?.code === 'page_unavailable' ? t('cannotClip') : `${t('saveFailed')} (${result?.code || 'not_paired'}).`); send.disabled = false; retry.dataset.hidden = 'false'; }
retry.addEventListener('click', async () => { retry.disabled = true; setProgress('images'); setStatus(t('retrying')); const stored = await chrome.storage.local.get(['retryCapture']); await requestAssetPermissions(stored.retryCapture?.capture?.assets); const result = await sendMessage({ type:'everroom:retry-last' }); setProgress('done', result?.ok ? 'done' : 'error'); setStatus(result?.ok ? t(retryStatusKey(result)) : `${t(retryStatusKey(result))} (${result?.code || 'unknown'}).`); retry.disabled = false; retry.dataset.hidden = String(!result?.capture?.failedAssetCount); });

void initialize();
