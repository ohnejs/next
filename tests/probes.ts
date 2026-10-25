import type { ResolvedPage } from '@ohnejs/client';

import { createOhne } from '@ohnejs/client';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';

import type { startAPI } from './api.ts';

import { start } from './site.ts';

type API = Awaited<ReturnType<typeof startAPI>>;

const SECRET = 'fixture-webhook-secret';

/**
 * A message the stand-in API stores.
 */
export const MESSAGE = { name: 'Ada', email: 'ada@example.com', message: 'Hello' };

/**
 * Calls the contact page's `sendMessage` action on the site at `origin`, built in `dir`, as Next's router does.
 * It answers the response and the value the action returned, if the stream holds one.
 */
export async function submit(
  dir: string,
  origin: string,
  args: unknown[] = [MESSAGE, 'human'],
  headers: Record<string, string> = {},
) {
  const manifest = JSON.parse(
    readFileSync(`${dir}.next/server/server-reference-manifest.json`, 'utf8'),
  ) as { node: Record<string, { exportedName?: string }> };
  const [id] = Object.entries(manifest.node).find(
    ([, entry]) => entry.exportedName === 'sendMessage',
  )!;
  const response = await fetch(`${origin}/contact`, {
    method: 'POST',
    headers: {
      'next-action': id,
      'content-type': 'text/plain;charset=UTF-8',
      accept: 'text/x-component',
      origin,
      ...headers,
    },
    body: JSON.stringify(args),
  });
  const row = (await response.text()).match(/^\w+:(\{"ok":.*)$/m)?.[1];
  return { response, result: row === undefined ? undefined : (JSON.parse(row) as unknown) };
}

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
  it('resolves a page once, the address passed as the visitor sent it', async () => {
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

  it("renders the site's settings in the layout", async () => {
    const { api, origin } = context();
    api.requests.length = 0;
    const { body } = await visit(api, origin, '/about');
    assert.match(body, /<nav class="menu"><a href="\/about">About<\/a><\/nav>/);
    assert.match(body, /<footer>Acme<\/footer>/);
    assert.ok(api.requests.some(({ path }) => path === '/cms/records/Settings'));
  });

  it("lists a block's records, paged by the address's query", async () => {
    const { api, origin } = context();
    for (const [query, titles, older] of [
      ['', ['Post 5', 'Post 4'], true],
      ['?page=2', ['Post 3', 'Post 2'], true],
      ['?page=3', ['Post 1'], false],
    ] as const) {
      api.requests.length = 0;
      const { body } = await visit(api, origin, `/blog${query}`);
      const listed = [...body.matchAll(/<h3>(?:<a href="[^"]*">)?([^<]*)/g)].map(([, t]) => t);
      assert.deepEqual(listed, titles, query);
      assert.equal(body.includes('class="older"'), older, query);
      const page = query ? query.slice(6) : '1';
      assert.ok(
        api.requests.some(
          ({ path }) =>
            path ===
            `/cms/records/Posts?order=[-publishedAt]&select=[title,publishedAt]&page=${page}&perPage=2`,
        ),
        JSON.stringify(api.requests),
      );
    }
    const { body } = await visit(api, origin, '/blog');
    assert.match(body, /<h3>Post 5<\/h3>/);
    assert.match(body, /<h3><a href="\/blog\/post-4">Post 4<\/a><\/h3>/);
  });

  it("relays no visitor's cookie or credentials to the API", async () => {
    const { api, origin } = context();
    api.requests.length = 0;
    const { response } = await visit(api, origin, '/blog', {
      headers: { cookie: 'ohne_sandbox=copy-1; session=secret', authorization: 'Bearer x' },
    });
    assert.equal(response.headers.get('x-robots-tag'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.ok(api.requests.length > 0);
    for (const request of api.requests) assert.deepEqual(Object.keys(request), ['path']);
  });

  it('treats the sandbox routes as pages', async () => {
    const { api, origin } = context();
    api.requests.length = 0;
    const { response, hits } = await visit(api, origin, '/_ohne/sandbox/frame.js');
    assert.equal(response.status, 404);
    assert.deepEqual(hits, ['/_ohne/sandbox/frame.js']);
    assert.ok(!api.requests.some(({ path }) => path.startsWith('/sandbox')));
  });

  it('throws on a webhook without a secret', async () => {
    const { origin } = context();
    const response = await fetch(`${origin}/api/ohne`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 500);
  });
}

/**
 * Registers the probes of a form's Server Action, against the site built in `dir` that `context` answers.
 */
export function form(dir: string, context: () => { api: API; origin: string; log: () => string }) {
  const created = () => context().api.creates.length;

  it('creates through `ohne.create`, passing the spam check header and answering the result', async () => {
    const { api, origin } = context();
    const { response, result } = await submit(dir, origin);
    assert.equal(response.status, 200);
    assert.deepEqual(result, { ok: true, UUID: `m-${created()}` });
    const { path, headers, body } = api.creates.at(-1)!;
    assert.equal(path, '/collections/messages');
    assert.deepEqual(body, MESSAGE);
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['recaptcha-token'], 'human');
  });

  it("passes on the visitor's address and language, and no credential", async () => {
    const { api, origin } = context();
    await submit(dir, origin, undefined, {
      'x-forwarded-for': '203.0.113.7, 198.51.100.2',
      'accept-language': 'de',
      cookie: 'session=secret; ohne_sandbox=copy-1',
      authorization: 'Bearer x',
    });
    const { headers } = api.creates.at(-1)!;
    assert.equal(headers['x-forwarded-for'], '203.0.113.7, 198.51.100.2');
    assert.equal(headers['accept-language'], 'de');
    for (const name of ['cookie', 'authorization', 'ohne-preview', 'origin', 'x-forwarded-host'])
      assert.equal(headers[name], undefined, name);
  });

  it('passes on the socket peer for a visitor without a proxy', async () => {
    const { api, origin } = context();
    await submit(dir, origin);
    assert.match(
      String(api.creates.at(-1)!.headers['x-forwarded-for']),
      /^(::ffff:)?127\.0\.0\.1$/,
    );
  });

  it('answers a refusal as a result, for the form to show', async () => {
    const { origin } = context();
    assert.deepEqual((await submit(dir, origin, [MESSAGE, 'bot'])).result, {
      ok: false,
      status: 403,
      message: 'The spam check failed. Please try again.',
      errors: {},
    });
    assert.deepEqual((await submit(dir, origin, [{ ...MESSAGE, email: 'ada' }, 'human'])).result, {
      ok: false,
      status: 422,
      message: 'Check the form.',
      errors: { email: 'Enter a valid email address.' },
    });
  });

  it('throws inside the action when the API takes no create there', async () => {
    const { api, origin, log } = context();
    api.state.messages = false;
    try {
      const { response, result } = await submit(dir, origin);
      assert.equal(response.status, 500);
      assert.equal(result, undefined);
    } finally {
      api.state.messages = true;
    }
    assert.match(log(), /ohne answered 404 for \/collections\/messages/);
  });

  it('refuses a call from another site before it reaches the API', async () => {
    const before = created();
    const { response } = await submit(dir, context().origin, undefined, {
      origin: 'http://evil.test',
    });
    assert.equal(response.status, 500);
    assert.equal(created(), before);
    assert.match(context().log(), /does not match `origin` header with value `evil\.test`/);
  });

  it("refuses a body over Next's limit before it reaches the API", async () => {
    const before = created();
    const long = { ...MESSAGE, message: 'x'.repeat(1024 * 1024) };
    const { response } = await submit(dir, context().origin, [long, 'human']);
    assert.equal(response.status, 500);
    assert.equal(created(), before);
    assert.match(context().log(), /Body exceeded 1 MB limit/);
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

  it("keeps a page's record reads in the cache with its resolve", async () => {
    await visit(context(), cached.origin, '/blog?page=2');
    context().requests.length = 0;
    await visit(context(), cached.origin, '/blog?page=2');
    assert.deepEqual(context().requests, []);
  });

  it('never caches a create', async () => {
    const before = context().creates.length;
    await submit(dir, cached.origin);
    await submit(dir, cached.origin);
    assert.equal(context().creates.length, before + 2);
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
