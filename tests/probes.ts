import type { ResolvedPage } from '@ohnejs/client';

import { createOhne } from '@ohnejs/client';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, it } from 'node:test';

import type { startAPI } from './api.ts';

import { start } from './site.ts';

type API = Awaited<ReturnType<typeof startAPI>>;

const SECRET = 'fixture-webhook-secret';

/**
 * Fetches `path` from the site without following a redirect, the hits it cost alongside.
 */
export async function visit(api: API, origin: string, path: string, init: RequestInit = {}) {
  api.hits.length = 0;
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', ...init });
  const body = await response.text();
  return { response, body, hits: api.hits.map((hit) => hit.path) };
}

/**
 * Each tag of `html` as its name and sorted lowercase attributes, so a tag compares across spellings.
 */
function tags(html: string) {
  return [...html.matchAll(/<(meta|link|title)\b([^>]*)>(?:([^<]*)<\/title>)?/g)].map(
    ([, name, attributes, title]) => {
      const pairs = [...attributes!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(
        ([, key, value]) => `${key!.toLowerCase()}=${value}`,
      );
      return [name, ...pairs.sort(), title ?? ''].join(' ');
    },
  );
}

/**
 * Registers the probes every built site must pass, against the site and API `context` answers.
 */
export function probe(context: () => { api: API; origin: string }) {
  it('renders a page with one API request, the address passed as the visitor sent it', async () => {
    const { api, origin } = context();
    for (const [path, title] of [
      ['/about', 'About'],
      ['/what%3F', 'What'],
      ['/%C3%BCber', 'Umlaut'],
    ]) {
      const { response, body, hits } = await visit(api, origin, path);
      assert.equal(response.status, 200);
      assert.match(body, new RegExp(`<h1>${title}</h1>`));
      assert.deepEqual(hits, [path]);
    }
  });

  it('marks each block, and skips a block without a component', async () => {
    const { api, origin } = context();
    const { body } = await visit(api, origin, '/about');
    assert.match(body, /<div data-ohne-block="hero-\/about"><section><h2>H:About<\/h2>/);
    assert.match(
      body,
      /<div data-ohne-block="text-\/about"><div class="text"><p><a href="\/de\/ueber">to de<\/a>/,
    );
    assert.doesNotMatch(body, /gone-\/about/);
    assert.match(body, /<span class="bad">bad<\/span>/);
    assert.match(
      body,
      /<a class="out" target="_blank" rel="noopener noreferrer" href="https:\/\/example.com">out<\/a>/,
    );
  });

  it('answers a permanent redirect with 308 and a temporary one with 307', async () => {
    const { api, origin } = context();
    for (const [path, status, location] of [
      ['/old?ref=x', 308, '/about?ref=x'],
      ['/index', 308, '/'],
      ['/ext', 308, 'https://example.com/x'],
      ['/temp', 307, '/'],
      ['/t307', 307, '/'],
    ] as const) {
      const { response } = await visit(api, origin, path);
      assert.equal(response.status, status, path);
      assert.equal(
        new URL(response.headers.get('location')!, origin).href,
        new URL(location, origin).href,
      );
    }
  });

  it('answers a miss with 404 and the `404` record, read once', async () => {
    const { api, origin } = context();
    const { response, body, hits } = await visit(api, origin, '/missing');
    assert.equal(response.status, 404);
    assert.match(body, /CMS404:Missing/);
    assert.deepEqual(hits, ['/missing']);
  });

  it('answers 500 when the API fails', async () => {
    const { api, origin } = context();
    const { response } = await visit(api, origin, '/boom');
    assert.equal(response.status, 500);
  });

  it('keeps a preview out of caches and search engines, and reads with its token', async () => {
    const { api, origin } = context();
    const { response, body } = await visit(api, origin, '/about?ohne-preview=tok');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    assert.match(body, /<meta name="robots" content="noindex"\/>/);
    assert.match(body, /<h1>About DRAFT<\/h1>/);
    assert.deepEqual(api.hits, [{ path: '/about?ohne-preview=tok', token: 'tok' }]);
  });

  it('ignores an address header the visitor sends', async () => {
    const { api, origin } = context();
    const { body, hits } = await visit(api, origin, '/about', {
      headers: { 'x-ohne-address': '/de/ueber' },
    });
    assert.match(body, /<h1>About<\/h1>/);
    assert.deepEqual(hits, ['/about']);
  });

  it('writes every tag `renderHead` writes', async () => {
    const { api, origin } = context();
    for (const path of ['/about', '/de/ueber']) {
      const { body } = await visit(api, origin, path);
      const head = createOhne({ api: api.origin }).renderHead(
        api.answer(path, undefined) as ResolvedPage,
      );
      const written = tags(body.slice(0, body.indexOf('</head>')));
      for (const tag of tags(head)) assert.ok(written.includes(tag), `${path} lacks ${tag}`);
    }
    const { body } = await visit(api, origin, '/de/ueber');
    assert.doesNotMatch(body, /og:image/);
  });

  it('serves the preview script from the API the server runs with', async () => {
    const { api, origin } = context();
    api.scripts.length = 0;
    const response = await fetch(`${origin}/_ohne/cms/preview.js?auto`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-middleware-rewrite'), null);
    assert.match(await response.text(), /const DASHBOARD = "http/);
    assert.deepEqual(api.scripts, ['?auto=']);
  });

  it('treats any other `/_ohne/` path as a page', async () => {
    const { api, origin } = context();
    const { response, hits } = await visit(api, origin, '/_ohne/collections/users');
    assert.equal(response.status, 404);
    assert.deepEqual(hits, ['/_ohne/collections/users']);
  });

  it('serves the sitemap and robots.txt from the API the server runs with', async () => {
    const { api, origin } = context();
    const sitemap = await fetch(`${origin}/sitemap.xml`);
    assert.equal(await sitemap.text(), `<urlset api="${api.origin}"/>`);
    assert.equal(sitemap.headers.get('content-type'), 'application/xml');
    assert.equal(sitemap.headers.get('cache-control'), 'public, max-age=60');
    const robots = await fetch(`${origin}/robots.txt`);
    assert.equal(await robots.text(), `Sitemap: ${api.origin}/sitemap.xml`);
    assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
  });

  it('keeps a page outside the catch-all static', async () => {
    const { api, origin } = context();
    const { response, hits } = await visit(api, origin, '/legal');
    assert.equal(response.status, 200);
    assert.deepEqual(hits, []);
  });

  it('throws on a webhook without a secret', async () => {
    const { origin } = context();
    const response = await fetch(`${origin}/api/ohne`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 500);
  });
}

/**
 * Registers the caching probes, against a second server on the site built in `dir`.
 */
export function cache(dir: string, context: () => API) {
  let cached: Awaited<ReturnType<typeof start>>;

  before(async () => {
    cached = await start(dir, {
      OHNE_API: context().origin,
      OHNE_REVALIDATE: '60',
      OHNE_WEBHOOK_SECRET: SECRET,
    });
  });

  after(() => cached?.close());

  const sign = (body: string, secret = SECRET) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('base64url')}`;
  };

  it('reads a page once, until a signed webhook drops the cache', async () => {
    assert.deepEqual((await visit(context(), cached.origin, '/about')).hits, ['/about']);
    assert.deepEqual((await visit(context(), cached.origin, '/about')).hits, []);
    const body = JSON.stringify({ event: 'record.updated' });
    const forged = await fetch(`${cached.origin}/api/ohne`, {
      method: 'POST',
      body,
      headers: { 'ohne-signature': sign(body, 'another-secret') },
    });
    assert.equal(forged.status, 401);
    assert.deepEqual((await visit(context(), cached.origin, '/about')).hits, []);
    const signed = await fetch(`${cached.origin}/api/ohne`, {
      method: 'POST',
      body,
      headers: { 'ohne-signature': sign(body) },
    });
    assert.equal(signed.status, 204);
    assert.deepEqual((await visit(context(), cached.origin, '/about')).hits, ['/about']);
  });

  it('serves the sitemap and robots.txt from the API the server runs with', async () => {
    const sitemap = await fetch(`${cached.origin}/sitemap.xml`);
    assert.equal(await sitemap.text(), `<urlset api="${context().origin}"/>`);
    assert.equal(sitemap.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(sitemap.headers.get('x-nextjs-cache'), null);
    const robots = await fetch(`${cached.origin}/robots.txt`);
    assert.equal(await robots.text(), `Sitemap: ${context().origin}/sitemap.xml`);
  });

  it('never caches a preview', async () => {
    assert.deepEqual((await visit(context(), cached.origin, '/about?ohne-preview=tok')).hits, [
      '/about?ohne-preview=tok',
    ]);
    assert.deepEqual((await visit(context(), cached.origin, '/about?ohne-preview=tok')).hits, [
      '/about?ohne-preview=tok',
    ]);
  });
}
