export const messages = {
  'zh-CN': {
    checking: '正在检查本地连接...',
    connect: '连接 EverRoom',
    savePage: '裁剪当前网页',
    retryImages: '重试缺失图片',
    openFromToolbar: '请在浏览器中加载扩展后，从工具栏打开 EverRoom。',
    connected: '已连接 EverRoom。',
    notRunning: 'EverRoom 尚未运行。',
    notConnected: '尚未连接 EverRoom。',
    connecting: '正在连接...',
    noActivePage: '没有可用的当前网页。',
    extracting: '正在提取网页内容...',
    cannotClip: '无法裁剪这个页面。',
    restrictedPage: '浏览器内部页面不允许扩展裁剪，请打开普通网页后重试。',
    saved: '已保存到 EverRoom。',
    savedPartial: '网页已保存，部分图片可重试。',
    saveFailed: '保存失败',
    retrying: '正在重试缺失图片...',
    retryFinished: '图片重试完成。',
    retryFailed: '重试失败',
    contextSave: '保存网页到 EverRoom',
    actionSaved: '已保存到 EverRoom',
    actionSavedPartial: '已保存，部分图片缺失',
    actionSaveFailed: 'EverRoom 网页裁剪失败',
  },
  'en-US': {
    checking: 'Checking local connection...',
    connect: 'Connect to EverRoom',
    savePage: 'Save current page',
    retryImages: 'Retry missing images',
    openFromToolbar: 'Load the extension, then open EverRoom from the browser toolbar.',
    connected: 'Connected to EverRoom.',
    notRunning: 'EverRoom is not running.',
    notConnected: 'Not connected to EverRoom.',
    connecting: 'Connecting...',
    noActivePage: 'No active page found.',
    extracting: 'Extracting page...',
    cannotClip: 'This page cannot be clipped.',
    restrictedPage: 'Browser internal pages cannot be clipped. Open a regular webpage and try again.',
    saved: 'Saved to EverRoom.',
    savedPartial: 'Page saved. Some images can be retried.',
    saveFailed: 'Save failed',
    retrying: 'Retrying missing images...',
    retryFinished: 'Image retry finished.',
    retryFailed: 'Retry failed',
    contextSave: 'Save page to EverRoom',
    actionSaved: 'Saved to EverRoom',
    actionSavedPartial: 'Saved with some images missing',
    actionSaveFailed: 'EverRoom page capture failed',
  },
};

export function normalizeLocale(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function translate(locale, key) {
  return messages[normalizeLocale(locale)][key] || messages['en-US'][key] || key;
}
