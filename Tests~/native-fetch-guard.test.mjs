import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the script emitted by the canonical SDK template, not a copied guard.
const source = readFileSync(process.env.AIT_VITE_FIXTURE || new URL('../WebGLTemplates/AITTemplate/BuildConfig~/vite.config.ts', import.meta.url), 'utf8');
const functionStart = source.indexOf('function aitNativeFetchGuardPlugin(): Plugin {');
assert.ok(functionStart >= 0);
const functionEnd = source.indexOf('//// SDK_PLUGINS_END', functionStart);
const factory = source.slice(functionStart, functionEnd).replace('(): Plugin', '()').replace(/ as const/g, '');
const plugin = runInNewContext(`${factory}; aitNativeFetchGuardPlugin()`);

function host() {
  const calls = [];
  const response = new Response('native');
  const window = { fetch(input, init) { calls.push({ input, init, receiver: this }); return Promise.resolve(response); } };
  const native = window.fetch;
  runInNewContext(plugin.transformIndexHtml.handler()[0].children, { window, console });
  return { window, native, calls, response };
}

test('vConsole-style Proxy assignment delegates once without recursion', async () => {
  const h = host();
  let intercepted = 0;
  h.window.fetch = new Proxy(h.window.fetch, { apply(target, receiver, args) {
    intercepted++;
    return Reflect.apply(target, receiver, args);
  } });
  const options = { method: 'POST' };
  assert.equal(await h.window.fetch('/api/example', options), h.response);
  assert.equal(intercepted, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init, options);
  assert.equal(h.calls[0].receiver, h.window);
});

test('successive wrappers and retained references keep their delegate generation', async () => {
  const h = host();
  const counts = [0, 0];
  const originalGuard = h.window.fetch;
  for (let i = 0; i < 2; i++) {
    h.window.fetch = new Proxy(h.window.fetch, { apply(target, receiver, args) {
      counts[i]++;
      return Reflect.apply(target, receiver, args);
    } });
  }
  await h.window.fetch('/api/example');
  assert.deepEqual(counts, [1, 1]);
  await originalGuard('/api/retained');
  assert.deepEqual(counts, [1, 1]);
  assert.equal(h.calls.length, 2);
});

test('Unity string, Request and URL assets bypass response-wrapping delegates', async () => {
  const h = host();
  let intercepted = 0;
  h.window.fetch = new Proxy(h.window.fetch, { async apply(target, receiver, args) {
    intercepted++;
    return new Proxy(await Reflect.apply(target, receiver, args), {});
  } });
  const inputs = ['/Build/game.data.unityweb', 'https://example.com/game.wasm?v=1',
    new Request('https://example.com/Build/game.data'), new URL('https://example.com/game.wasm')];
  for (const input of inputs) assert.equal(await h.window.fetch(input), h.response);
  assert.equal(intercepted, 0);
  assert.equal(h.calls.length, inputs.length);
  assert.notEqual(await h.window.fetch('/api/example'), h.response);
  assert.equal(intercepted, 1);
});

test('native errors retain their rejection through a Proxy', async () => {
  const error = new Error('network');
  const window = { fetch: () => Promise.reject(error) };
  runInNewContext(plugin.transformIndexHtml.handler()[0].children, { window, console });
  window.fetch = new Proxy(window.fetch, { apply: Reflect.apply });
  await assert.rejects(window.fetch('/api/example'), e => e === error);
});

test('guard and devtools remain excluded from production and preview', () => {
  assert.equal(plugin.apply, 'serve');
  const start = source.indexOf('function isAitDevtoolsEnabled(');
  const end = source.indexOf('\n}', start) + 2;
  const enabled = runInNewContext(source.slice(start, end).replace(': ConfigEnv', '').replace(': boolean', '') + '; isAitDevtoolsEnabled', { process: { env: { AIT_DEVTOOLS: '1' } } });
  assert.equal(enabled({ command: 'build' }), false);
  assert.equal(enabled({ command: 'serve', isPreview: true }), false);
  assert.equal(enabled({ command: 'serve' }), true);
});
