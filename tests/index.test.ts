import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, describe, it, mock } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OhneLink, OhneRichText } from '../client.js';
import { createOhneNext, OhneBlocks } from '../index.js';

const ohne = createOhneNext({ api: 'http://api.test/' });

afterEach(() => mock.restoreAll());

describe('proxy', () => {
  it('forwards the path and query as the visitor sent them', async () => {
    const response = await ohne.proxy(new NextRequest('http://site.test/de/%C3%BCber?a=1&a=2'));
    assert.equal(
      response.headers.get('x-middleware-request-x-ohne-address'),
      '/de/%C3%BCber?a=1&a=2',
    );
    assert.equal(response.headers.get('cache-control'), null);
    assert.equal(response.headers.get('x-robots-tag'), null);
  });

  it('drops the `_rsc` cache-buster from a raw address and keeps every other byte', async () => {
    const response = await ohne.proxy(
      new NextRequest('http://site.test/old?_rsc=x&tags=[a%2Cb,new]&_rsc&rsc=1'),
    );
    assert.equal(
      response.headers.get('x-middleware-request-x-ohne-address'),
      '/old?tags=[a%2Cb,new]&rsc=1',
    );
  });

  it('drops a query that held only the cache-buster', async () => {
    const response = await ohne.proxy(new NextRequest('http://site.test/about?_rsc=x'));
    assert.equal(response.headers.get('x-middleware-request-x-ohne-address'), '/about');
  });

  it('keeps a preview out of caches and search engines', async () => {
    const response = await ohne.proxy(new NextRequest('http://site.test/about?ohne-preview=t'));
    assert.equal(
      response.headers.get('x-middleware-request-x-ohne-address'),
      '/about?ohne-preview=t',
    );
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  });

  it('serves the preview script from the API', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => {
      const headers = {
        'content-type': 'text/javascript',
        'cache-control': 'no-cache',
        'set-cookie': 'a=b',
      };
      return new Response('export function connect() {}', { headers });
    });
    const response = await ohne.proxy(
      new NextRequest('http://site.test/_ohne/cms/preview.js?auto'),
    );
    assert.deepEqual(fetch.mock.calls[0]?.arguments, [
      'http://api.test/cms/preview.js?auto',
      { cache: 'no-store' },
    ]);
    assert.equal(await response.text(), 'export function connect() {}');
    assert.deepEqual(
      [...response.headers],
      [
        ['cache-control', 'no-cache'],
        ['content-type', 'text/javascript'],
      ],
    );
  });

  it('treats any other `/_ohne/` path as a page', async () => {
    const fetch = mock.method(globalThis, 'fetch');
    const response = await ohne.proxy(new NextRequest('http://site.test/_ohne/collections/users'));
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(
      response.headers.get('x-middleware-request-x-ohne-address'),
      '/_ohne/collections/users',
    );
  });
});

describe('proxy in a live demo', () => {
  const demo = createOhneNext({ api: 'http://api.test', sandbox: 'ohne_sandbox' });
  const visit = (path: string, cookie?: string) =>
    demo.proxy(new NextRequest(`http://site.test${path}`, cookie ? { headers: { cookie } } : {}));

  it('asks search engines to skip every page, and keeps a bound one out of caches', async () => {
    const unbound = await visit('/about');
    assert.equal(unbound.headers.get('x-robots-tag'), 'noindex');
    assert.equal(unbound.headers.get('cache-control'), null);
    const bound = await visit('/about', 'session=secret; ohne_sandbox=copy-1');
    assert.equal(bound.headers.get('x-robots-tag'), 'noindex');
    assert.equal(bound.headers.get('cache-control'), 'private, no-store');
  });

  it('binds no visitor whose cookie is not a sandbox id', async () => {
    for (const id of ['', 'a.b', 'a b', '%2e', 'x'.repeat(65)]) {
      const response = await visit('/about', `ohne_sandbox=${id}`);
      assert.equal(response.headers.get('cache-control'), null, id);
    }
  });

  it('relays the sandbox routes with the binding cookie alone, and passes no cookie back', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => {
      const headers = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': 'ohne_sandbox=; Max-Age=0',
      };
      return new Response('{}', { headers });
    });
    const response = await demo.proxy(
      new NextRequest('http://site.test/_ohne/sandbox', {
        headers: { cookie: 'session=secret; ohne_sandbox=copy-1', authorization: 'Bearer x' },
      }),
    );
    assert.deepEqual(fetch.mock.calls[0]?.arguments, [
      'http://api.test/sandbox',
      { cache: 'no-store', headers: { cookie: 'ohne_sandbox=copy-1' } },
    ]);
    assert.deepEqual(
      [...response.headers],
      [
        ['cache-control', 'private, no-store'],
        ['content-type', 'application/json'],
      ],
    );
    await visit('/_ohne/sandbox/frame.js', 'ohne_sandbox=a.b');
    assert.deepEqual(fetch.mock.calls[1]?.arguments, [
      'http://api.test/sandbox/frame.js',
      { cache: 'no-store', headers: {} },
    ]);
  });

  it('treats the sandbox routes as pages on a real site', async () => {
    const fetch = mock.method(globalThis, 'fetch');
    for (const path of ['/_ohne/sandbox', '/_ohne/sandbox/frame.js']) {
      const response = await ohne.proxy(
        new NextRequest(`http://site.test${path}`, { headers: { cookie: 'ohne_sandbox=copy-1' } }),
      );
      assert.equal(response.headers.get('x-middleware-request-x-ohne-address'), path);
      assert.equal(response.headers.get('x-robots-tag'), null);
      assert.equal(response.headers.get('cache-control'), null);
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('reads `OHNE_SANDBOX` on each request', async () => {
    const request = () => new NextRequest('http://site.test/about');
    assert.equal((await ohne.proxy(request())).headers.get('x-robots-tag'), null);
    process.env.OHNE_SANDBOX = 'ohne_sandbox';
    try {
      assert.equal((await ohne.proxy(request())).headers.get('x-robots-tag'), 'noindex');
    } finally {
      delete process.env.OHNE_SANDBOX;
    }
  });
});

describe('read and list', () => {
  const settings = { UUID: 's', menu: [], copyright: 'Acme' };
  const answer = (body: unknown, status = 200) =>
    mock.method(globalThis, 'fetch', async () => Response.json(body, { status }));
  const init = (fetch: ReturnType<typeof answer>) =>
    fetch.mock.calls[0]?.arguments[1] as RequestInit & { next?: unknown };

  it('reads under `revalidate`, tagged so `webhook` drops it, and never reads a cookie', async () => {
    const cached = createOhneNext({ api: 'http://api.test', revalidate: 60 });
    const fetch = answer(settings);
    assert.deepEqual(await cached.read('Settings', { locale: 'en' }), settings);
    assert.equal(
      fetch.mock.calls[0]?.arguments[0],
      'http://api.test/cms/records/Settings?locale=en',
    );
    assert.deepEqual(init(fetch).next, { revalidate: 60, tags: ['ohne'] });
    assert.equal(init(fetch).cache, undefined);
    assert.equal(new Headers(init(fetch).headers).has('cookie'), false);
  });

  it('lists a page of records, and reads every request without `revalidate`', async () => {
    const page = { records: [], total: 0, page: 2, perPage: 3, lastPage: 1 };
    const fetch = answer(page);
    assert.deepEqual(
      await ohne.list('Posts', { order: ['-publishedAt'], page: 2, perPage: 3 }),
      page,
    );
    assert.equal(
      fetch.mock.calls[0]?.arguments[0],
      'http://api.test/cms/records/Posts?order=[-publishedAt]&page=2&perPage=3',
    );
    assert.equal(init(fetch).cache, 'no-store');
  });

  it('reads a record a visitor may not see as `undefined`', async () => {
    answer({}, 404);
    assert.equal(await ohne.read('Posts', '0192f0c4-0000-7000-8000-000000000001'), undefined);
  });

  it('reads the sandbox cookie in a live demo, warning once', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const fetch = answer(settings);
    process.env.OHNE_SANDBOX = 'ohne_sandbox';
    try {
      // Outside a Next request `cookies()` throws: reaching it proves the read asks for the binding.
      await assert.rejects(ohne.read('Settings'), /`cookies` was called outside a request scope/);
      await assert.rejects(ohne.read('Settings'), /`cookies` was called outside a request scope/);
    } finally {
      delete process.env.OHNE_SANDBOX;
    }
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /relays the `ohne_sandbox` cookie/);
  });
});

describe('create', () => {
  it("reads the visitor's address and language, which only a request carries", async () => {
    const fetch = mock.method(globalThis, 'fetch');
    // Outside a Next request `headers()` throws: reaching it proves a write asks for the visitor's.
    await assert.rejects(
      ohne.create('Messages', {}),
      /`headers` was called outside a request scope/,
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe('current', () => {
  it('refuses to run under `cacheComponents`, naming the fix', async () => {
    process.env.__NEXT_CACHE_COMPONENTS = 'true';
    try {
      await assert.rejects(ohne.current(), /`cacheComponents` prevents/);
    } finally {
      delete process.env.__NEXT_CACHE_COMPONENTS;
    }
  });
});

describe('webhook', () => {
  const post = (signature?: string) =>
    new Request('http://site.test/api/ohne', {
      method: 'POST',
      body: '{}',
      headers: signature ? { 'ohne-signature': signature } : {},
    });

  it('refuses a forged request', async () => {
    const response = await ohne.webhook('0123456789abcdef')(post('t=1,v1=x'));
    assert.equal(response.status, 401);
  });

  it('drops the cache on a signed request', async () => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', 'secret').update(`${t}.{}`).digest('base64url');
    // Outside a Next server `revalidateTag` throws for want of a store: reaching it proves the signature.
    await assert.rejects(
      ohne.webhook('secret')(post(`t=${t},v1=${v1}`)),
      /store missing in revalidateTag\("ohne"\)/,
    );
  });

  it('throws without a secret, naming the fix', async () => {
    for (const secret of ['', undefined]) {
      await assert.rejects(ohne.webhook(secret)(post()), /`ohne.webhook` has no secret/);
    }
  });
});

describe('OhneBlocks', () => {
  const Hero = ({ fields }: { fields: { title: string } }) =>
    createElement('h1', null, fields.title);
  const render = (props: object) => renderToStaticMarkup(createElement(OhneBlocks, props as never));

  it('wraps each block in an element carrying its mark', () => {
    const blocks = [
      { block: 'Hero', UUID: 'a', fields: { title: 'One' } },
      { block: 'Hero', UUID: 'b', fields: { title: 'Two' } },
    ];
    assert.equal(
      render({ blocks, components: { Hero } }),
      '<div data-ohne-block="a"><h1>One</h1></div><div data-ohne-block="b"><h1>Two</h1></div>',
    );
    assert.equal(
      render({ blocks: blocks.slice(0, 1), components: { Hero }, as: 'section' }),
      '<section data-ohne-block="a"><h1>One</h1></section>',
    );
  });

  it('skips a block without a component, even one named after an object key', () => {
    const blocks = [
      { block: 'Gone', UUID: 'a', fields: {} },
      { block: 'constructor', UUID: 'b', fields: {} },
    ];
    assert.equal(render({ blocks, components: { Hero } }), '');
  });

  it('renders nothing for `null` and `undefined`', () => {
    assert.equal(render({ blocks: null, components: {} }), '');
    assert.equal(render({ blocks: undefined, components: {} }), '');
  });
});

describe('client components', () => {
  const router = { push() {}, refresh() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const render = <P extends object>(component: (props: P) => ReactNode, props: P) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: router as never },
        createElement(component, props),
      ),
    );

  it('`OhneLink` renders a path on the site through Next', () => {
    assert.equal(
      render(OhneLink, { link: { url: '/about' }, className: 'x', children: 'a' }),
      '<a class="x" href="/about">a</a>',
    );
    assert.equal(
      render(OhneLink, { link: { collection: 'Pages', record: 'u', href: '/b' }, children: 'b' }),
      '<a href="/b">b</a>',
    );
  });

  it('`OhneLink` opens another address in a new tab when asked', () => {
    assert.equal(
      render(OhneLink, { link: { url: 'https://e.test', newTab: true }, children: 'a' }),
      '<a target="_blank" rel="noopener noreferrer" href="https://e.test">a</a>',
    );
  });

  it('`OhneLink` renders a `<span>` for an address a browser may not follow', () => {
    for (const link of [
      { url: 'javascript:alert(1)' },
      { url: '//evil.test' },
      { collection: 'Pages', record: 'u' },
      null,
      undefined,
    ]) {
      assert.equal(
        render(OhneLink, { link, className: 'x', children: 'a' }),
        '<span class="x">a</span>',
      );
    }
  });

  it('`OhneRichText` renders escaped HTML in a `<div>`, or a `<span>` when inline', () => {
    const value = [
      { kind: 'paragraph' as const, content: [{ text: '<b>' }] },
      { kind: 'paragraph' as const, content: [{ text: 'two' }] },
    ];
    assert.equal(
      render(OhneRichText, { value, className: 'x' }),
      '<div class="x"><p>&lt;b&gt;</p><p>two</p></div>',
    );
    assert.equal(render(OhneRichText, { value, inline: true }), '<span>&lt;b&gt;<br>two</span>');
    assert.equal(render(OhneRichText, { value: null }), '<div></div>');
  });
});
