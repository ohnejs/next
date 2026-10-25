import type { AddressInfo } from 'node:net';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';

import { SANDBOX, startAPI } from './api.ts';
import { openBrowser } from './cdp.ts';
import { cache, form, MESSAGE, probe, submit, visit } from './probes.ts';
import { build, start } from './site.ts';

const FIXTURE = new URL('fixture/', import.meta.url).pathname;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  it('builds each page outside the catch-all as static, and the sitemap and robots.txt as dynamic', () => {
    assert.match(output, /○ \/legal/);
    assert.match(output, /○ \/contact/);
    assert.match(output, /ƒ \/robots\.txt/);
    assert.match(output, /ƒ \/sitemap\.xml/);
  });

  probe(() => ({ api, origin: site.origin }));
});

describe('a form', () => form(FIXTURE, () => ({ api, origin: site.origin, log: site.log })));

describe('caching', () => cache(FIXTURE, () => api));

describe('a live demo', () => {
  let demo: Awaited<ReturnType<typeof start>>;
  const BOUND = `${SANDBOX}=copy-1`;

  before(async () => {
    demo = await start(FIXTURE, {
      OHNE_API: api.origin,
      OHNE_REVALIDATE: '60',
      OHNE_SANDBOX: SANDBOX,
    });
  });

  after(() => demo?.close());

  it("renders the visitor's copy, relaying the binding cookie alone", async () => {
    api.requests.length = 0;
    const { response, body } = await visit(api, demo.origin, '/about', {
      headers: { cookie: `session=secret; ${BOUND}`, authorization: 'Bearer x' },
    });
    assert.equal(response.status, 200);
    assert.match(body, /<footer>Copy one<\/footer>/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(body, /<meta name="robots" content="noindex"\/>/);
    assert.ok(api.requests.length > 1);
    for (const request of api.requests) assert.deepEqual(Object.keys(request), ['path', 'cookie']);
    assert.ok(api.requests.every(({ cookie }) => cookie === BOUND));
  });

  it('reads a bound page every time, and an unbound one from the cache', async () => {
    const bound = { headers: { cookie: BOUND } };
    assert.deepEqual((await visit(api, demo.origin, '/de/ueber', bound)).hits, ['/de/ueber']);
    assert.deepEqual((await visit(api, demo.origin, '/de/ueber', bound)).hits, ['/de/ueber']);
    assert.deepEqual((await visit(api, demo.origin, '/de/ueber')).hits, ['/de/ueber']);
    assert.deepEqual((await visit(api, demo.origin, '/de/ueber')).hits, []);
  });

  it('asks search engines to skip a page without a copy, and relays no malformed id', async () => {
    for (const cookie of [undefined, `${SANDBOX}=a.b`, `${SANDBOX}=${'x'.repeat(65)}`]) {
      api.requests.length = 0;
      const { response, body } = await visit(api, demo.origin, '/blog', {
        headers: cookie ? { cookie } : {},
      });
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
      assert.notEqual(response.headers.get('cache-control'), 'private, no-store');
      assert.match(body, /<meta name="robots" content="noindex"\/>/);
      assert.match(body, /<footer>Acme<\/footer>/);
      assert.ok(api.requests.every((request) => !('cookie' in request)));
    }
  });

  it('relays the sandbox routes, and passes no cookie back', async () => {
    api.requests.length = 0;
    const status = await fetch(`${demo.origin}/_ohne/sandbox`, { headers: { cookie: BOUND } });
    assert.deepEqual(await status.json(), { phase: 'live', changedAt: 1 });
    assert.equal(status.headers.get('cache-control'), 'private, no-store');
    assert.equal(status.headers.get('set-cookie'), null);
    assert.deepEqual(api.requests, [{ path: '/sandbox', cookie: BOUND }]);
    const script = await fetch(`${demo.origin}/_ohne/sandbox/frame.js`);
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(script.headers.get('cache-control'), 'no-cache');
    assert.match(await script.text(), /export function connect/);
  });

  it('relays the binding cookie alone on a create, and passes no cookie back', async () => {
    api.requests.length = 0;
    const { response, result } = await submit(FIXTURE, demo.origin, undefined, {
      cookie: `session=secret; ${BOUND}`,
      authorization: 'Bearer x',
    });
    assert.deepEqual(result, { ok: true, UUID: `m-${api.creates.length}` });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(api.requests, [{ path: '/collections/messages', cookie: BOUND }]);
  });

  it('warns once that the server runs as a demo', () => {
    const warnings = demo.log().match(/relays the `ohne_sandbox` cookie/g);
    assert.equal(warnings?.length, 1, demo.log());
  });

  describe('in a browser', () => {
    let browser: Awaited<ReturnType<typeof openBrowser>>;
    let page: Server;
    const footer = `document.querySelector('footer')?.textContent`;

    before(async () => {
      // Same host as the site, so the cookie the page sets rides in the frame as a demo's does.
      page = createServer((request, response) => {
        const target = request.url === '/real' ? site.origin : demo.origin;
        const name = request.url === '/unnamed' ? '' : 'name="ohne-sandbox"';
        response.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': `${BOUND}; Path=/; SameSite=Lax`,
        });
        response.end(`<!doctype html>
<iframe ${name} src="${target}/blog" width="800" height="600"></iframe>
<script>
  window.received = [];
  const envelope = { ohne: 'embed', v: 1 };
  addEventListener('message', (event) => {
    if (event.data?.ohne !== 'embed' || event.origin !== '${target}') return;
    received.push(event.data.type);
    if (event.data.type !== 'hello') return;
    frames[0].postMessage({ ...envelope, type: 'theme', scheme: 'dark' }, '${target}');
  });
  window.show = () => frames[0].postMessage({ ...envelope, type: 'shown' }, '${target}');
</script>`);
      });
      await new Promise<void>((resolve) => page.listen(0, '127.0.0.1', resolve));
      api.state.frameAncestors = [`http://127.0.0.1:${(page.address() as AddressInfo).port}`];
      browser = await openBrowser();
    });

    after(async () => {
      page?.close();
      await browser?.close();
    });

    const parent = () => api.state.frameAncestors[0]!;
    const fetched = () => api.requests.filter(({ path }) => path === '/sandbox/frame.js').length;

    it('greets the page that frames it, and renders a change to the copy in place', async () => {
      api.requests.length = 0;
      await browser.goto(`${parent()}/`);
      await browser.until(`received.join() === 'hello,ready'`);
      const frame = await browser.frame(demo.origin);
      await browser.until(`${footer} === 'Copy one'`, frame);
      await browser.until(`document.body.dataset.hydrated === ''`, frame);
      assert.equal(fetched(), 1);
      await browser.evaluate(
        `window.kept = true; document.body.style.minHeight = '4000px'; scrollTo(0, 500)`,
        frame,
      );
      while (!api.requests.some(({ path }) => path === '/sandbox')) await sleep(50);
      api.state.sandbox.copyright = 'Copy two';
      api.state.sandbox.changedAt = 2;
      await browser.evaluate('show()');
      await browser.until(`${footer} === 'Copy two'`, frame);
      assert.equal(await browser.evaluate('window.kept', frame), true);
      assert.equal(await browser.evaluate('scrollY', frame), 500);
    });

    it('loads nothing in a frame without the demo name', async () => {
      api.requests.length = 0;
      await browser.goto(`${parent()}/unnamed`);
      await browser.until(`location.pathname === '/unnamed'`);
      const frame = await browser.frame(demo.origin);
      await browser.until(`document.body.dataset.hydrated === ''`, frame);
      await sleep(500);
      assert.equal(fetched(), 0);
      assert.deepEqual(await browser.evaluate('received'), []);
    });

    it('stays quiet on a real site framed as a demo', async () => {
      api.requests.length = 0;
      await browser.goto(`${parent()}/real`);
      await browser.until(`location.pathname === '/real'`);
      const frame = await browser.frame(site.origin);
      await browser.until(`document.body.dataset.hydrated === ''`, frame);
      await sleep(500);
      assert.deepEqual(await browser.evaluate('received'), []);
      assert.ok(api.requests.every((request) => !('cookie' in request)));
    });

    it('throws nothing in the page', () => {
      assert.deepEqual(browser.exceptions, []);
    });
  });
});

describe('a demo built without `sandbox`', () => {
  const app = `${FIXTURE}.prerendered/`;
  let demo: Awaited<ReturnType<typeof start>>;
  let output = '';

  before(async () => {
    rmSync(app, { recursive: true, force: true });
    mkdirSync(`${app}app`, { recursive: true });
    cpSync(`${FIXTURE}tsconfig.json`, `${app}tsconfig.json`);
    symlinkSync(`${FIXTURE}node_modules`, `${app}node_modules`);
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
      `import { createOhneNext } from '@ohnejs/next';
import type { CMS } from '../../ohne';
const ohne = createOhneNext<CMS>({ api: process.env.OHNE_API!, revalidate: 1 });
export default async () => <footer>{(await ohne.read('Settings')).copyright}</footer>;`,
    );
    // Asynchronous, since the build reads the API this process serves.
    const built = await promisify(execFile)(`${app}node_modules/.bin/next`, ['build'], {
      cwd: app,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', OHNE_API: api.origin },
    });
    output = stripVTControlCharacters(built.stdout);
    demo = await start(app, { OHNE_API: api.origin, OHNE_SANDBOX: SANDBOX });
  });

  after(() => {
    demo?.close();
    rmSync(app, { recursive: true, force: true });
  });

  it('prerenders a page that reads through ohne, since no read asks for a cookie', () => {
    assert.match(output, /○ \/ +1s/);
  });

  it('names the fix when it regenerates that page for a visitor', async () => {
    const named = /`next build` prerendered this page: build with `sandbox` set too/;
    await sleep(1100);
    for (let tries = 0; !named.test(demo.log()); tries++) {
      assert.ok(tries < 50, demo.log());
      await (await fetch(demo.origin, { headers: { cookie: `${SANDBOX}=copy-1` } })).text();
      await sleep(100);
    }
  });
});

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

  it('pages a list through the router, reading the new query', async () => {
    const titles = `[...document.querySelectorAll('.posts h3')].map((h) => h.textContent).join()`;
    await browser.goto(`${site.origin}/blog`);
    await browser.until(`document.body.dataset.hydrated === '' && ${titles} === 'Post 5,Post 4'`);
    await browser.evaluate('window.kept = true');
    await browser.evaluate(`document.querySelector('.older').click()`);
    await browser.until(`${titles} === 'Post 3,Post 2'`);
    assert.equal(await browser.evaluate('location.search'), '?page=2');
    assert.equal(await browser.evaluate('window.kept'), true);
  });

  it("submits a form through its Server Action, showing the API's answer", async () => {
    const before = api.creates.length;
    await browser.goto(`${site.origin}/contact`);
    await browser.until(`document.body.dataset.hydrated === ''`);
    await browser.evaluate(`document.querySelector('[name=email]').value = 'ada'`);
    await browser.evaluate(`document.querySelector('button').click()`);
    await browser.until(`${text('.email-error')} === 'Enter a valid email address.'`);
    assert.equal(await browser.evaluate(text('.failure')), 'Check the form.');
    await browser.evaluate(`document.querySelector('[name=email]').value = '${MESSAGE.email}'`);
    await browser.evaluate(`document.querySelector('button').click()`);
    await browser.until(`${text('.sent')} === 'Thanks'`);
    assert.deepEqual(
      api.creates.slice(before).map(({ body }) => body),
      [{ ...MESSAGE, email: 'ada' }, MESSAGE],
    );
  });

  it('shows the `404` record on a miss', async () => {
    await browser.goto(`${site.origin}/missing`);
    await browser.until(`${text('h1')} === 'CMS404:Missing'`);
  });

  it('throws nothing in the page', () => {
    assert.deepEqual(browser.exceptions, []);
  });
});
