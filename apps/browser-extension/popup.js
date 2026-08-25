import { normalizeLocale, translate } from './i18n.js';

const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const send = document.querySelector('#send');
const retry = document.querySelector('#retry');
const extensionContext = location.protocol === 'chrome-extension:' && globalThis.chrome?.runtime?.sendMessage;
let locale = 'en-US';
const t = (key) => translate(locale, key);
const setStatus = (value) => { status.textContent = value; };
const sendMessage = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (result) => resolve(chrome.runtime.lastError ? null : result));
});

function applyLocale() {
  document.documentElement.lang = locale;
  connect.textContent = t('connect');
  send.textContent = t('savePage');
  retry.textContent = t('retryImages');
}

async function initialize() {
  if (!extensionContext) {
    locale = normalizeLocale(navigator.language);
    applyLocale();
    setStatus(t('openFromToolbar'));
    connect.disabled = true;
    send.disabled = true;
    retry.disabled = true;
    return;
  }
  const localeResult = await sendMessage({ type: 'everroom:locale' });
  locale = normalizeLocale(localeResult?.locale || navigator.language);
  applyLocale();
  const [connection, retryStatus] = await Promise.all([
    sendMessage({ type: 'everroom:connection-status' }),
    sendMessage({ type: 'everroom:retry-status' }),
  ]);
  setStatus(connection?.status === 'paired' ? t('connected') : connection?.status === 'unavailable' ? t('notRunning') : t('notConnected'));
  retry.disabled = !retryStatus?.available;
}

connect.addEventListener('click', async () => {
  if (!extensionContext) return;
  setStatus(t('connecting'));
  const result = await sendMessage({ type: 'everroom:connect' });
  setStatus(result?.status === 'paired' ? t('connected') : t('notRunning'));
});

send.addEventListener('click', async () => {
  if (!extensionContext) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus(t('noActivePage'));
  setStatus(t('extracting'));
  const result = await sendMessage({ type: 'everroom:capture', tabId: tab.id });
  setStatus(result?.ok
    ? result.capture?.failedAssetCount ? t('savedPartial') : t('saved')
    : result?.code === 'restricted_page'
      ? t('restrictedPage')
      : result?.code === 'page_unavailable'
        ? t('cannotClip')
        : `${t('saveFailed')} (${result?.code || 'not_paired'}).`);
  retry.disabled = !result?.capture?.failedAssetCount;
});

retry.addEventListener('click', async () => {
  if (!extensionContext || retry.disabled) return;
  retry.disabled = true;
  setStatus(t('retrying'));
  const result = await sendMessage({ type: 'everroom:retry-last' });
  setStatus(result?.ok ? t('retryFinished') : `${t('retryFailed')} (${result?.code || 'unknown'}).`);
  retry.disabled = !result?.capture?.failedAssetCount;
});

void initialize();
