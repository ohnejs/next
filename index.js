/** @import { ReactNode } from 'react' */
/** @import { BlockValue, Current, Loaded, OhneBlocksProps, OhneNext, OhneNextOptions } from './index.d.ts' */
import { createOhne, verifyWebhook } from '@ohnejs/client';
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
