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
