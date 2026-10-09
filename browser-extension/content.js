(() => {
  const messageType = 'maple-scout/maplescouter-import';
  const nickname = new URL(location.href).searchParams.get('name')?.trim();
  if (!nickname || !window.opener || window.opener.closed) return;

  const startedAt = Date.now();
  let delivered = false;
  let intervalId;
  let timeoutId;
  let observer;

  function cleanup() {
    if (intervalId) window.clearInterval(intervalId);
    if (timeoutId) window.clearTimeout(timeoutId);
    observer?.disconnect();
  }

  function send(payload) {
    if (delivered) return;
    delivered = true;
    cleanup();
    if (!window.opener || window.opener.closed) return;
    window.opener.postMessage({ type: messageType, payload }, '*');
  }

  function readMultipliers() {
    const seenBossIds = new Set();
    return [...document.querySelectorAll('img[src*="/bossIcon/"], img[alt="boss"]')]
      .flatMap((image) => {
        const source = image.currentSrc || image.getAttribute('src') || '';
        const filename = new URL(source, location.href).pathname.split('/').pop() || '';
        const bossId = filename.replace(/\.[^.]+$/, '').trim().toLowerCase();
        if (!/^[a-z]+_[a-z]+$/.test(bossId) || seenBossIds.has(bossId)) return [];

        const card = image.closest('div.bg-surface-gray-surface-0');
        const infoArea = card?.querySelector('div.relative.z-10');
        const percentages = [...(infoArea?.children || [])].flatMap((element) => (
          (element.textContent || '').match(/\d+(?:\.\d+)?%/g) || []
        ));
        const multiplier = Number(percentages.at(-1)?.replace('%', ''));
        if (!Number.isFinite(multiplier)) return [];

        seenBossIds.add(bossId);
        return [{ bossId, multiplier }];
      });
  }

  function readBoss380HexaScore() {
    for (const card of document.querySelectorAll('div.bg-surface-gray-surface-0')) {
      const badge = [...card.querySelectorAll('span')]
        .find((element) => element.textContent?.trim() === '보스380');
      if (!badge) continue;

      let section = badge.parentElement;
      while (section && card.contains(section)) {
        const hexaLabel = [...section.querySelectorAll('span')]
          .find((element) => element.textContent?.trim() === '헥사');
        const value = hexaLabel && [...(hexaLabel.parentElement?.children || [])]
          .find((element) => element.tagName === 'SPAN' && element !== hexaLabel);
        if (value) {
          const score = Number((value.textContent || '').replace(/[^\d]/g, ''));
          return Number.isSafeInteger(score) ? score : null;
        }
        section = section.parentElement;
      }
    }
    return null;
  }

  function checkResult() {
    if (delivered) return;
    const boss380HexaScore = readBoss380HexaScore();
    if (!Number.isSafeInteger(boss380HexaScore)) return;

    const multipliers = readMultipliers();
    if (multipliers.length || Date.now() - startedAt >= 15_000) {
      send({ nickname, boss380HexaScore, multipliers });
    }
  }

  observer = new MutationObserver(checkResult);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  intervalId = window.setInterval(checkResult, 750);
  timeoutId = window.setTimeout(() => {
    send({ nickname, error: 'MapleScouter 결과에서 보스380 헥사 점수를 찾지 못했습니다.' });
  }, 60_000);
  checkResult();
})();
