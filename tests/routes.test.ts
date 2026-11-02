import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createOhneAPI } from '../index.js';
import { openBrowser } from './cdp.ts';
import { build, dev, start } from './site.ts';

const ROUTES = new URL('routes/', import.meta.url).pathname;
const USER = { UUID: 'u1', email: 'ada@example.com', roles: [] };
const SESSION = '__Host-session';

/**
 * A stand-in ohne API under `/api` that keeps every request it gets in `requests`.
 * Signing in with the password `secret` sets the session cookie, and signing out clears it.
 */
async function startAPI() {
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] =
    [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://api');
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const path = url.pathname + url.search;
      requests.push({ method: request.method!, path, headers: request.headers, body });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        const type = { 'content-type': 'application/json', ...headers };
        response.writeHead(status, type).end(JSON.stringify(value));
      };
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        if (JSON.parse(body).password !== 'secret') return json(401, { message: 'Invalid' });
        const cookie = `${SESSION}=s1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
        return json(200, USER, { 'set-cookie': cookie });
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const cleared = `${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
        return json(200, { ok: true }, { 'set-cookie': cleared });
      }
      if (url.pathname === '/api/auth/me') {
        if (request.headers.cookie?.includes(`${SESSION}=s1`)) return json(200, USER);
        return response.writeHead(204).end();
      }
      if (url.pathname === '/api/sites')
        return json(200, [{ code: 'a', name: `Acme ${url.search}` }]);
      json(404, { message: 'Not found' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => server.close() };
}

describe('`createOhneAPI`', () => {
  const api = createOhneAPI({ api: 'http://api.test/api/' });

  it('serves the API at its path on the site, every byte of the query kept', () => {
    const response = api.proxy(new NextRequest('http://site.test/api/sites/%C3%BC?tags=[a%2Cb]'));
    assert.equal(
      response.headers.get('x-middleware-rewrite'),
      'http://api.test/api/sites/%C3%BC?tags=[a%2Cb]',
    );
    assert.equal(
      api.proxy(new NextRequest('http://site.test/api')).headers.get('x-middleware-rewrite'),
      'http://api.test/api',
    );
  });

  it('passes on every other path', () => {
    for (const path of ['/', '/apis', '/about/api/x']) {
      const response = api.proxy(new NextRequest(`http://site.test${path}`));
      assert.equal(response.headers.get('x-middleware-rewrite'), null, path);
      assert.equal(response.headers.get('x-middleware-next'), '1', path);
    }
  });

  it('refuses an address without a path, which the browser could not call', () => {
    for (const address of ['http://api.test', 'http://api.test/', '/api']) {
      assert.throws(() => createOhneAPI({ api: address }), /set `api\.basePath`/, address);
    }
  });
});

describe('a site without a CMS', () => {
  let api: Awaited<ReturnType<typeof startAPI>>;
  let site: Awaited<ReturnType<typeof start>>;
  let output = '';

  before(async () => {
    const built = build(ROUTES);
    output = built.output;
    assert.equal(built.status, 0, output);
    api = await startAPI();
    site = await start(ROUTES, { OHNE_API: `${api.origin}/api` }, '/');
  });

  after(() => {
    site?.close();
    api?.close();
  });

  it('builds a page that calls the API as dynamic', () => {
    assert.match(output, /ƒ \//);
  });

  it("renders with the visitor's cookie, language and address, never their credentials", async () => {
    for (let round = 0; round < 2; round++) {
      api.requests.length = 0;
      const html = await fetch(site.origin, {
        headers: {
          cookie: `${SESSION}=s1; other=1`,
          'accept-language': 'de',
          'x-forwarded-for': '203.0.113.9',
          authorization: 'Bearer x',
        },
      }).then((response) => response.text());
      assert.match(html, /<p class="user">ada@example\.com<\/p>/);
      assert.match(html, /<p class="site">Acme \?client=acme<\/p>/);
      assert.deepEqual(api.requests.map(({ path }) => path).sort(), [
        '/api/auth/me',
        '/api/sites?client=acme',
      ]);
      for (const { headers } of api.requests) {
        assert.equal(headers.cookie, `${SESSION}=s1; other=1`);
        assert.equal(headers['accept-language'], 'de');
        assert.equal(headers['x-forwarded-for'], '203.0.113.9');
        assert.equal(headers.authorization, undefined);
      }
    }
  });

  it('relays a call from the browser and its answer, cookies included', async () => {
    api.requests.length = 0;
    const response = await fetch(`${site.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'other=1' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), USER);
    assert.match(response.headers.get('set-cookie') ?? '', new RegExp(`^${SESSION}=s1; Path=/`));
    const [login] = api.requests;
    assert.deepEqual(
      [login?.method, login?.path, login?.headers.cookie],
      ['POST', '/api/auth/login', 'other=1'],
    );
    assert.deepEqual(JSON.parse(login!.body), { email: 'ada@example.com', password: 'secret' });
  });

  it('keeps every other path away from the API', async () => {
    api.requests.length = 0;
    const response = await fetch(`${site.origin}/apis`);
    await response.body?.cancel();
    assert.equal(response.status, 404);
    assert.deepEqual(api.requests, []);
  });

  it(
    'signs in and out from a Server Action and from a Client Component',
    { timeout: 60_000 },
    async () => {
      const browser = await openBrowser();
      const user = `document.querySelector('.user')?.textContent`;
      const click = (button: string) =>
        browser.evaluate(`document.querySelector('.${button}').click()`);
      try {
        await browser.goto(site.origin);
        await browser.until(`${user} === 'signed out'`);
        for (const [signIn, signOut] of [
          ['in', 'out'],
          ['browser-in', 'browser-out'],
        ]) {
          await click(signIn!);
          await browser.until(`${user} === 'ada@example.com'`, undefined, 15_000);
          await browser.goto(site.origin);
          await browser.until(`${user} === 'ada@example.com'`);
          await click(signOut!);
          await browser.until(`${user} === 'signed out'`, undefined, 15_000);
          await browser.goto(site.origin);
          await browser.until(`${user} === 'signed out'`);
        }
      } finally {
        await browser.close();
      }
    },
  );
});

describe('a site whose API address lost its path', () => {
  it('answers `500` and names the fix', { timeout: 60_000 }, async () => {
    const api = await startAPI();
    const site = await start(ROUTES, { OHNE_API: api.origin }, '/apis');
    try {
      const response = await fetch(site.origin);
      await response.body?.cancel();
      assert.equal(response.status, 500);
      assert.deepEqual(api.requests, []);
      for (let tries = 0; !site.log().includes('api.basePath') && tries < 50; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.match(site.log(), /set `api\.basePath` in your API's `ohne\.config\.ts`/);
    } finally {
      site.close();
      api.close();
    }
  });
});

describe('`next dev` without a CMS', () => {
  let api: Awaited<ReturnType<typeof startAPI>>;
  let site: Awaited<ReturnType<typeof dev>>;

  before(async () => {
    api = await startAPI();
    site = await dev(ROUTES, { OHNE_API: `${api.origin}/api` });
  });

  after(() => {
    site?.close();
    api?.close();
  });

  it('renders with the session and serves the API on the site', { timeout: 60_000 }, async () => {
    const html = await fetch(site.origin, { headers: { cookie: `${SESSION}=s1` } }).then(
      (response) => response.text(),
    );
    assert.match(html, /<p class="user">ada@example\.com<\/p>/);
    const response = await fetch(`${site.origin}/api/auth/me`, {
      headers: { cookie: `${SESSION}=s1` },
    });
    assert.deepEqual(await response.json(), USER);
  });
});
