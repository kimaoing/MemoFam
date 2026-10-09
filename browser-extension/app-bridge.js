(() => {
  const requestType = 'maple-scout/extension-check';
  const responseType = 'maple-scout/extension-status';

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type !== requestType || typeof event.data.requestId !== 'string') return;

    window.postMessage({
      type: responseType,
      requestId: event.data.requestId,
      installed: true,
    }, location.origin);
  });
})();
