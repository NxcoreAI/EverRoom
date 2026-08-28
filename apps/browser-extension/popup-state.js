export function progressStates(stageNames, active, state = 'active') {
  const activeIndex = stageNames.indexOf(active);
  return stageNames.map((_name, index) => index < activeIndex ? 'done' : index === activeIndex ? state : '');
}

export function captureStatusKey(result) {
  if (!result?.ok) return 'saveFailed';
  return result.capture?.failedAssetCount ? 'savedPartial' : 'saved';
}

export function retryStatusKey(result) {
  return result?.ok ? 'retryFinished' : 'retryFailed';
}
