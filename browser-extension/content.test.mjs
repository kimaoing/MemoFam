import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import test from 'node:test';

const contentScript = await readFile(new URL('./content.js', import.meta.url), 'utf8');
const appBridgeScript = await readFile(new URL('./app-bridge.js', import.meta.url), 'utf8');

test('responds to extension checks from supported app pages', async () => {
  const dom = new JSDOM('', { runScripts: 'outside-only', url: 'https://memo-fam.vercel.app/' });
  const responses = [];
  dom.window.addEventListener('message', (event) => {
    if (event.data?.type === 'maple-scout/extension-status') responses.push(event.data);
  });

  dom.window.eval(appBridgeScript);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window,
    origin: dom.window.location.origin,
    data: { type: 'maple-scout/extension-check', requestId: 'check-1' },
  }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    type: 'maple-scout/extension-status',
    requestId: 'check-1',
    installed: true,
  }]);
  dom.window.close();
});

test('reads the MapleScouter score and multipliers and sends them to the opener', () => {
  const dom = new JSDOM(`
    <div class="bg-surface-gray-surface-0">
      <img src="/bossIcon/normal_kaling.png" alt="boss">
      <div class="relative z-10"><span>25.5%</span></div>
      <div><span>보스380</span><div><span>헥사</span><span>70,000</span></div></div>
    </div>
  `, {
    runScripts: 'outside-only',
    url: 'https://maplescouter.com/ko/result?name=%EC%95%84%EC%9E%89%EB%8A%90',
  });
  const messages = [];
  Object.defineProperty(dom.window, 'opener', {
    configurable: true,
    value: { closed: false, postMessage: (...message) => messages.push(message) },
  });

  dom.window.eval(contentScript);

  assert.equal(messages.length, 1);
  assert.equal(messages[0][1], '*');
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0][0])), {
    type: 'maple-scout/maplescouter-import',
    payload: {
      nickname: '아잉느',
      boss380HexaScore: 70000,
      multipliers: [{ bossId: 'normal_kaling', multiplier: 25.5 }],
    },
  });
  dom.window.close();
});
