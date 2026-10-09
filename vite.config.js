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
              throw new Error('Maplescouter가 이 실행 환경의 자동화 요청을 차단했습니다. 차단을 우회하지 않고 종료합니다.');
            }
            await page.waitForFunction(() => {
              return [...document.querySelectorAll('img[alt="boss"]')].some((image) => {
                let node = image;
                for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
                  if (/\d+(?:\.\d+)?\s*%/.test(node.innerText || '')) return true;
                }
                return false;
              });
            }, null, { timeout: 30_000 });

            const multipliers = await page.locator('img[alt="boss"]').evaluateAll((images) => images.flatMap((image) => {
              let node = image;
              let percentage = null;
              for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
                const match = (node.innerText || '').match(/(\d+(?:\.\d+)?)\s*%/);
                if (match) {
                  percentage = Number(match[1]);
                  break;
                }
              }
              const source = image.getAttribute('src') || '';
              const bossId = source.split('/').pop()?.replace(/\.png(?:\?.*)?$/, '');
              return bossId && percentage !== null ? [{ bossId, multiplier: percentage }] : [];
            }));
            if (!multipliers.length) throw new Error('보스 배율을 찾지 못했습니다. 캐릭터 공개 설정과 Maplescouter 결과를 확인해 주세요.');
            return sendJson(response, 200, { nickname, multipliers });
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
  },
})
