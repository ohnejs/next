import type { AddressInfo } from 'node:net';

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startAPI } from './api.ts';
import { openBrowser } from './cdp.ts';
import { cache, probe } from './probes.ts';
import { build, start } from './site.ts';

const FIXTURE = new URL('fixture/', import.meta.url).pathname;

let api: Awaited<ReturnType<typeof startAPI>>;
let site: Awaited<ReturnType<typeof start>>;
let output = '';

before(async () => {
  const built = build(FIXTURE, FIXTURE, { OHNE_REVALIDATE: '60' });
  output = built.output;
  assert.equal(built.status, 0, output);
  api = await startAPI();
  site = await start(FIXTURE, { OHNE_API: api.origin });
});

after(() => {
  site?.close();
  api?.close();
});

describe('a site built without `OHNE_API` and with `revalidate`', () => {
  it('builds a page outside the catch-all as static, and the sitemap and robots.txt as dynamic', () => {
    assert.match(output, /○ \/legal/);
    assert.match(output, /ƒ \/robots\.txt/);
    assert.match(output, /ƒ \/sitemap\.xml/);
  });

  probe(() => ({ api, origin: site.origin }));
});

describe('caching', () => cache(FIXTURE, () => api));

describe('a Client Component', () => {
  const app = `${FIXTURE}.use-client/`;

  after(() => rmSync(app, { recursive: true, force: true }));

  it('fails the build when it imports `@ohnejs/next`', () => {
    rmSync(app, { recursive: true, force: true });
    mkdirSync(`${app}app`, { recursive: true });
    cpSync(`${FIXTURE}tsconfig.json`, `${app}tsconfig.json`);
    writeFileSync(
      `${app}next.config.ts`,
      `import { resolve } from 'node:path';
export default { turbopack: { root: resolve(import.meta.dirname, '../../../..') } };`,
    );
    writeFileSync(
      `${app}app/layout.tsx`,
      `import type { ReactNode } from 'react';
export default ({ children }: { children: ReactNode }) => <html><body>{children}</body></html>;`,
    );
    writeFileSync(
      `${app}app/page.tsx`,
      `'use client';
import { createOhneNext } from '@ohnejs/next';
export default () => <p>{typeof createOhneNext}</p>;`,
    );
    const { status, output } = build(app, FIXTURE);
    assert.notEqual(status, 0);
    // Turbopack names a module from its root, the folder that holds the checkout.
    const checkout = basename(new URL('../', import.meta.url).pathname);
    const missing = `createOhneNext was not found in module [project]/${checkout}/server.js`;
    assert.ok(output.includes(missing), output);
  });
});

describe('in a browser', () => {
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  let dashboard: Server;
  const text = (selector: string) => `document.querySelector('${selector}')?.textContent`;

  before(async () => {
    dashboard = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
<iframe src="${site.origin}/about?ohne-preview=tok" width="800" height="600"></iframe>
<script>
  window.received = [];
  addEventListener('message', (event) => event.data?.ohne === 1 && received.push(event.data.type));
  window.send = (type) => frames[0].postMessage({ ohne: 1, type, page: {} }, '${site.origin}');
</script>`);
    });
    await new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve));
    api.state.dashboard = `http://localhost:${(dashboard.address() as AddressInfo).port}`;
    browser = await openBrowser();
  });

  after(async () => {
    dashboard?.close();
    await browser?.close();
  });

  it('joins the editor through `/_ohne` and renders each change on the server, in place', async () => {
    api.state.draft = 'Draft one';
    api.scripts.length = 0;
    await browser.goto(`${api.state.dashboard}/`);
    await browser.until(`received.includes('hello')`);
    assert.deepEqual(api.scripts, ['']);
    const frame = await browser.frame(site.origin);
    await browser.until(`${text('h1')} === 'Draft one'`, frame);
    await browser.evaluate('window.kept = true', frame);
    api.state.draft = 'Draft two';
    await browser.evaluate(`send('data')`);
    await browser.until(`${text('h1')} === 'Draft two'`, frame);
    assert.equal(await browser.evaluate('window.kept', frame), true);
    assert.equal(await browser.evaluate('location.search', frame), '?ohne-preview=tok');
  });

  it('keeps a click on a link inside the editor frame on the page', async () => {
    const frame = await browser.frame(site.origin);
    await browser.evaluate(`document.querySelector('.in').click()`, frame);
    await browser.evaluate(`document.querySelector('.text a').click()`, frame);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await browser.evaluate('location.pathname + location.search', frame),
      '/about?ohne-preview=tok',
    );
  });

  for (const [name, selector] of [
    ['a rich text link', '.text a'],
    ['an `OhneLink`', '.in'],
  ]) {
    it(`follows ${name} through the router, without a reload`, async () => {
      await browser.goto(`${site.origin}/about`);
      await browser.until(`document.body.dataset.hydrated === '' && ${text('h1')} === 'About'`);
      await browser.evaluate('window.kept = true');
      await browser.evaluate(`document.querySelector('${selector}').click()`);
      await browser.until(`${text('h1')} === 'Ueber'`);
      assert.equal(await browser.evaluate('location.pathname'), '/de/ueber');
      assert.equal(await browser.evaluate('window.kept'), true);
    });
  }

  it('shows the `404` record on a miss', async () => {
    await browser.goto(`${site.origin}/missing`);
    await browser.until(`${text('h1')} === 'CMS404:Missing'`);
  });

  it('throws nothing in the page', () => {
    assert.deepEqual(browser.exceptions, []);
  });
});
