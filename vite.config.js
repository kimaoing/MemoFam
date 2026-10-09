import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('요청 크기가 너무 큽니다.');
  }
  return JSON.parse(body || '{}');
}

function localGameApi() {
  return {
    name: 'local-game-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (!pathname.startsWith('/api/')) return next();
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'POST 요청만 허용됩니다.' });
        if (request.headers.origin && request.headers.host) {
          try {
            if (new URL(request.headers.origin).host !== request.headers.host) {
              return sendJson(response, 403, { error: '다른 출처의 요청은 허용되지 않습니다.' });
            }
          } catch {
            return sendJson(response, 403, { error: '요청 출처를 확인할 수 없습니다.' });
          }
        }

        let browser;
        try {
          const body = await readJson(request);
          if (pathname === '/api/maplescouter/multipliers') {
            const nickname = String(body.nickname || '').trim();
            if (!nickname || nickname.length > 24) return sendJson(response, 400, { error: '캐릭터 닉네임을 확인해 주세요.' });

            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            const targetUrl = `https://maplescouter.com/ko/result?name=${encodeURIComponent(nickname)}`;
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            const pageTitle = await page.title();
            const initialText = await page.locator('body').innerText().catch(() => '');
            if (/cloudflare|attention required/i.test(pageTitle) || /you have been blocked/i.test(initialText)) {
              throw new Error('MapleScouter가 로컬 실행 환경의 요청을 차단했습니다. 차단을 우회하지 않고 종료합니다.');
            }
            await page.waitForFunction(() => {
              const cards = [...document.querySelectorAll('div.bg-surface-gray-surface-0')];
              const hasHexaScore = cards.some((card) => {
                const badge = [...card.querySelectorAll('span')]
                  .find((element) => element.textContent?.trim() === '보스380');
                if (!badge) return false;
                let section = badge.parentElement;
                while (section && card.contains(section)) {
                  const hexaLabel = [...section.querySelectorAll('span')]
                    .find((element) => element.textContent?.trim() === '헥사');
                  const value = hexaLabel && [...(hexaLabel.parentElement?.children || [])]
                    .find((element) => element.tagName === 'SPAN' && element !== hexaLabel);
                  if (value) return /\d/.test(value.textContent || '');
                  section = section.parentElement;
                }
                return false;
              });
              const hasMultiplier = [...document.querySelectorAll('img[alt="boss"], img[src*="/bossIcon/"]')]
                .some((image) => {
                let node = image;
                for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
                  if (/\d+(?:\.\d+)?\s*%/.test(node.innerText || '')) return true;
                }
                return false;
              });
              return hasHexaScore || hasMultiplier;
            }, null, { timeout: 30_000 });

            const { boss380HexaScore, multipliers } = await page.evaluate(() => {
              const cards = [...document.querySelectorAll('div.bg-surface-gray-surface-0')];
              const scrapedMultipliers = [...document.querySelectorAll('img[alt="boss"], img[src*="/bossIcon/"]')]
                .flatMap((image) => {
                  const source = image.getAttribute('src') || '';
                  const filename = new URL(source, location.origin).pathname.split('/').pop() || '';
                  const bossId = filename.replace(/\.[^.]+$/, '').trim().toLowerCase();
                  const card = image.closest('div.bg-surface-gray-surface-0');
                  const infoArea = card?.querySelector('div.relative.z-10');
                  const percentages = [...(infoArea?.children || [])].flatMap((element) => (
                    (element.textContent || '').match(/\d+(?:\.\d+)?%/g) || []
                  ));
                  const multiplier = Number(percentages.at(-1)?.replace('%', ''));
                  return bossId && Number.isFinite(multiplier) ? [{ bossId, multiplier }] : [];
                });

              let score = null;
              for (const card of cards) {
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
                    const parsedScore = Number((value.textContent || '').replace(/[^\d]/g, ''));
                    score = Number.isSafeInteger(parsedScore) ? parsedScore : null;
                    break;
                  }
                  section = section.parentElement;
                }
                break;
              }
              return { boss380HexaScore: score, multipliers: scrapedMultipliers };
            });
            if (!Number.isSafeInteger(boss380HexaScore)) {
              throw new Error('보스380 헥사 점수를 찾지 못했습니다. MapleScouter 결과가 표시됐는지 확인해 주세요.');
            }
            return sendJson(response, 200, { nickname, boss380HexaScore, multipliers });
          }

          return sendJson(response, 404, { error: '지원하지 않는 API 요청입니다.' });
        } catch (error) {
          return sendJson(response, 500, { error: error.message || '로컬 요청을 처리하지 못했습니다.' });
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), localGameApi()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
  },
})
