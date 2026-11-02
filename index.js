/** @import { API } from '@ohnejs/client' */
/** @import { ReactNode } from 'react' */
/** @import { BlockValue, Current, Loaded, OhneAPI, OhneAPIOptions, OhneBlocksProps, OhneNext, OhneNextOptions } from './index.d.ts' */
import { createAPI, createOhne, verifyWebhook } from '@ohnejs/client';
import { revalidateTag } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { connection, NextResponse } from 'next/server';
import { createElement } from 'react';

const ADDRESS = 'x-ohne-address';
const TOKEN = 'ohne-preview';
const TAG = 'ohne';
const RELAY = '/_ohne';
const PREVIEW = `${RELAY}/cms/preview.js`;
const SANDBOX_ROUTES = [`${RELAY}/sandbox`, `${RELAY}/sandbox/frame.js`];
const PASSED = ['cache-control', 'content-type'];
const VISITOR = ['x-forwarded-for', 'accept-language'];
const CALLER = ['cookie', ...VISITOR];
const RSC = /^_rsc(=|$)/;
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `search` without Next's `_rsc` cache-buster, every other byte kept, since a raw bracket is structure.
 * Next strips it itself unless `skipProxyUrlNormalize` hands the proxy the raw address.
 *
 * @param {string} search
 * @returns {string}
 */
function withoutRSC(search) {
  const query = search
    .slice(1)
    .split('&')
    .filter((pair) => !RSC.test(pair))
    .join('&');
  return query && `?${query}`;
}

/**
 * The `cookie` header binding a demo visitor to their sandbox copy, or `undefined` for a malformed id.
 *
 * @param {string} name
 * @param {string | undefined} id
 * @returns {string | undefined}
 */
function binding(name, id) {
  return id !== undefined && SANDBOX_ID.test(id) ? `${name}=${id}` : undefined;
}

/**
 * The request's cookies, naming the fix when a server bound to a sandbox regenerates a prerendered page.
 * In `next build` the same throw is how Next learns the page renders per request, so it passes through.
 *
 * @returns {ReturnType<typeof cookies>}
 */
async function requestCookies() {
  try {
    return await cookies();
  } catch (error) {
    if (
      process.env.NEXT_PHASE === 'phase-production-build' ||
      /** @type {{ digest?: unknown }} */ (error)?.digest !== 'DYNAMIC_SERVER_USAGE'
    )
      throw error;
    throw new Error(
      '`@ohnejs/next` binds a demo visitor per request, but `next build` prerendered this page: build with `sandbox` set too',
    );
  }
}

/**
 * Passes the visitor's address and language on to a write, unless the caller set them.
 * Next fills `x-forwarded-for` with the socket peer only when the request carried none.
 *
 * @param {Headers} outgoing
 */
async function visitorHeaders(outgoing) {
  const incoming = await headers();
  for (const name of VISITOR) {
    const value = incoming.get(name);
    if (value !== null && !outgoing.has(name)) outgoing.set(name, value);
  }
}

/**
 * Sets each cookie a response sets on the visitor, where Next lets a request write cookies.
 * It answers each cookie's raw value by name, `undefined` for one the response expired, or nothing.
 *
 * @param {Response} response
 * @returns {Promise<Map<string, string | undefined> | undefined>}
 */
async function relayCookies(response) {
  const set = response.headers.getSetCookie();
  if (set.length === 0) return undefined;
  const jar = await cookies();
  const parsed = new NextResponse(null, { headers: set.map((value) => ['set-cookie', value]) });
  const written = new Map();
  try {
    for (const cookie of parsed.cookies.getAll()) jar.set(cookie);
  } catch {
    // A Server Component renders after the response headers went out, so Next refuses the write.
    return undefined;
  }
  for (const line of set) {
    const pair = line.split(';', 1)[0] ?? '';
    const name = pair.slice(0, pair.indexOf('=')).trim();
    const cookie = parsed.cookies.get(name);
    const expired =
      cookie?.maxAge === 0 || (cookie?.expires !== undefined && +cookie.expires <= Date.now());
    written.set(name, expired ? undefined : pair.slice(pair.indexOf('=') + 1).trim());
  }
  return written;
}

/**
 * The `cookie` header `raw` with each cookie in `written` replaced, added, or dropped when expired.
 * Every other cookie keeps its bytes.
 *
 * @param {string | null} raw
 * @param {Map<string, string | undefined>} written
 * @returns {string}
 */
function withWritten(raw, written) {
  const kept = (raw ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !written.has(pair.slice(0, pair.indexOf('=')).trim()));
  for (const [name, value] of written) if (value !== undefined) kept.push(`${name}=${value}`);
  return kept.join('; ');
}

/**
 * @param {OhneAPIOptions} options
 * @returns {OhneAPI}
 */
export function createOhneAPI(options) {
  const url = URL.parse(options.api);
  const path = url?.pathname.replace(/\/+$/, '') ?? '';
  if (!url || path === '') {
    throw new Error(
      `\`@ohnejs/next\` calls your API at its path on the site, which \`${options.api}\` lacks: set \`api.basePath\` in your API's \`ohne.config.ts\`, like \`'/api'\`, and name it in \`api\`, like \`'http://localhost:9001/api'\``,
    );
  }
  const { origin } = url;
  /** @type {WeakMap<Headers, Map<string, string | undefined>>} */
  const writes = new WeakMap();

  /**
   * A client that sends the visitor's headers, read before a call so Next sees a page needs them.
   * A cookie an earlier call of the same request set counts, as the browser will send it next.
   *
   * @returns {Promise<API>}
   */
  async function visitor() {
    const incoming = await headers();
    /** @type {Record<string, string>} */
    const forwarded = {};
    for (const name of CALLER) {
      const value = incoming.get(name);
      if (value !== null) forwarded[name] = value;
    }
    const written = writes.get(incoming);
    if (written) forwarded.cookie = withWritten(incoming.get('cookie'), written);
    if (forwarded.cookie === '') delete forwarded.cookie;
    return createAPI({
      api: `${origin}${path}`,
      fetchInit: { headers: forwarded },
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, cache: 'no-store' });
        const set = await relayCookies(response);
        if (set) writes.set(incoming, new Map([...(writes.get(incoming) ?? []), ...set]));
        return response;
      },
    });
  }

  return {
    call: async (route, ...options) => (await visitor()).call(route, ...options),
    login: async (input) => (await visitor()).login(input),
    logout: async () => (await visitor()).logout(),
    user: async () => (await visitor()).user(),

    proxy(request) {
      const { pathname, search } = new URL(request.url);
      if (pathname !== path && !pathname.startsWith(`${path}/`)) return NextResponse.next();
      return NextResponse.rewrite(`${origin}${pathname}${search}`);
    },
  };
}

/**
 * @param {OhneNextOptions} options
 * @returns {OhneNext}
 */
export function createOhneNext(options) {
  const { revalidate } = options;
  const origin = options.api.replace(/\/+$/, '');
  let warned = false;

  const sandbox = () => options.sandbox ?? process.env.OHNE_SANDBOX ?? '';

  /**
   * The visitor's sandbox binding in a live demo, or `undefined`.
   * A real site never calls `cookies()`, so its static pages stay static.
   *
   * @returns {Promise<string | undefined>}
   */
  async function boundCookie() {
    const name = sandbox();
    if (!name) return undefined;
    if (!warned) {
      warned = true;
      console.warn(
        `\`@ohnejs/next\` relays the \`${name}\` cookie to the API and asks search engines to skip every page: \`sandbox\` is for a live demo, never a real site`,
      );
    }
    return binding(name, (await requestCookies()).get(name)?.value);
  }

  /**
   * @param {boolean} fresh
   * @returns {RequestInit}
   */
  const caching = (fresh) =>
    revalidate === undefined || fresh
      ? { cache: 'no-store' }
      : { next: { revalidate, tags: [TAG] } };

  const client = createOhne({
    api: origin,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const cookie = await boundCookie();
      if (cookie) headers.set('cookie', cookie);
      // Only a write asks for the request's headers, so a page that only reads stays static.
      const write = init?.method === 'POST';
      if (write) await visitorHeaders(headers);
      const fresh = write || headers.has(TOKEN) || Boolean(cookie);
      return fetch(input, { ...init, headers, ...caching(fresh) });
    },
  });

  /**
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function forward(path, init = caching(false)) {
    const response = await fetch(`${origin}${path}`, init);
    const passed = new Headers();
    for (const name of PASSED) {
      const value = response.headers.get(name);
      if (value !== null) passed.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: passed });
  }

  /** @returns {Promise<string>} */
  async function forwarded() {
    const address = (await headers()).get(ADDRESS);
    if (address === null) {
      throw new Error(
        '`@ohnejs/next` reads the address its proxy forwards: export `ohne.proxy` from `proxy.ts`',
      );
    }
    return address;
  }

  /** @returns {Promise<Current>} */
  async function current() {
    if (process.env.__NEXT_CACHE_COMPONENTS) {
      throw new Error(
        '`@ohnejs/next` answers redirects and misses with their status, which `cacheComponents` prevents: remove it and `partialPrefetching` from `next.config.ts`',
      );
    }
    const address = await forwarded();
    const token = client.token(address);
    return { address, token, resolved: await client.resolve(address, { token }) };
  }

  /** @returns {Promise<Loaded>} */
  async function page() {
    const { resolved, token } = await current();
    if (resolved.kind === 'redirect') {
      if (resolved.code === 301 || resolved.code === 308) permanentRedirect(resolved.to);
      redirect(resolved.to);
    }
    if (resolved.kind === 'notFound') notFound();
    return { page: resolved, token };
  }

  return {
    client,
    current,
    page,
    read: client.read,
    list: client.list,
    create: client.create,

    async searchParams() {
      const address = await forwarded();
      const query = address.indexOf('?');
      return new URLSearchParams(query === -1 ? '' : address.slice(query));
    },

    async metadata() {
      const {
        page: { seo, alternates },
        token,
      } = await page();
      return {
        title: { absolute: seo.title },
        description: seo.description,
        openGraph: { title: seo.title, description: seo.description, images: seo.image },
        robots: token || sandbox() ? 'noindex' : seo.robots,
        alternates: {
          canonical: seo.canonical,
          languages: Object.fromEntries(alternates.map(({ hreflang, href }) => [hreflang, href])),
        },
      };
    },

    async proxy(request) {
      const { pathname, search, searchParams } = request.nextUrl;
      // Served from the site, so the API may stay private and never needs CORS.
      if (pathname === PREVIEW) return forward(`/cms/preview.js${search}`, { cache: 'no-store' });
      const name = sandbox();
      const cookie = name ? binding(name, request.cookies.get(name)?.value) : undefined;
      if (name && SANDBOX_ROUTES.includes(pathname)) {
        const relayed = await forward(pathname.slice(RELAY.length), {
          cache: 'no-store',
          headers: cookie ? { cookie } : {},
        });
        if (cookie) relayed.headers.set('cache-control', 'private, no-store');
        return relayed;
      }
      const passed = new Headers(request.headers);
      passed.set(ADDRESS, pathname + withoutRSC(search));
      const response = NextResponse.next({ request: { headers: passed } });
      if (searchParams.has(TOKEN) || cookie) {
        for (const [header, value] of Object.entries(client.previewHeaders()))
          response.headers.set(header, value);
      } else if (name) response.headers.set('x-robots-tag', 'noindex');
      return response;
    },

    // A cached read alone would let `next build` prerender both from the build's API.
    sitemap: () => connection().then(() => forward('/cms/sitemap.xml')),
    robots: () => connection().then(() => forward('/cms/robots.txt')),

    webhook: (secret) => async (request) => {
      if (!secret)
        throw new Error(
          '`ohne.webhook` has no secret: pass the one your cms `webhooks` entry names',
        );
      if ((await verifyWebhook(request, secret)) === null)
        return new Response(null, { status: 401 });
      revalidateTag(TAG, { expire: 0 });
      return new Response(null, { status: 204 });
    },
  };
}

/**
 * @param {OhneBlocksProps<BlockValue>} props
 * @returns {ReactNode}
 */
export function OhneBlocks({ blocks, components, as = 'div' }) {
  const lookup = /** @type {Record<string, (props: BlockValue) => ReactNode>} */ (components);
  return (blocks ?? []).map((block) =>
    Object.hasOwn(lookup, block.block)
      ? createElement(
          as,
          { key: block.UUID, 'data-ohne-block': block.UUID },
          createElement(lookup[block.block], block),
        )
      : null,
  );
}
