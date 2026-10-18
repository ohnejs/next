/** @import { ReactNode } from 'react' */
/** @import { BlockValue, Current, Loaded, OhneBlocksProps, OhneNext, OhneNextOptions } from './index.d.ts' */
import { createOhne, verifyWebhook } from '@ohnejs/client';
import { revalidateTag } from 'next/cache';
import { headers } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { connection, NextResponse } from 'next/server';
import { createElement } from 'react';

const ADDRESS = 'x-ohne-address';
const TOKEN = 'ohne-preview';
const TAG = 'ohne';
const PREVIEW = '/_ohne/cms/preview.js';
const PASSED = ['cache-control', 'content-type'];

/**
 * @param {OhneNextOptions} options
 * @returns {OhneNext}
 */
export function createOhneNext({ api, revalidate }) {
  const origin = api.replace(/\/+$/, '');

  /**
   * @param {boolean} preview
   * @returns {RequestInit}
   */
  const caching = (preview) =>
    revalidate === undefined || preview
      ? { cache: 'no-store' }
      : { next: { revalidate, tags: [TAG] } };

  const client = createOhne({
    api: origin,
    fetch: (input, init) =>
      fetch(input, { ...init, ...caching(new Headers(init?.headers).has(TOKEN)) }),
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

  /** @returns {Promise<Current>} */
  async function current() {
    const address = (await headers()).get(ADDRESS);
    if (address === null) {
      throw new Error(
        '`@ohnejs/next` reads the address its proxy forwards: export `ohne.proxy` from `proxy.ts`',
      );
    }
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

    async metadata() {
      const {
        page: { seo, alternates },
        token,
      } = await page();
      return {
        title: { absolute: seo.title },
        description: seo.description,
        openGraph: { title: seo.title, description: seo.description, images: seo.image },
        robots: token ? 'noindex' : seo.robots,
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
      const forwarded = new Headers(request.headers);
      forwarded.set(ADDRESS, pathname + search);
      const response = NextResponse.next({ request: { headers: forwarded } });
      if (searchParams.has(TOKEN)) {
        for (const [name, value] of Object.entries(client.previewHeaders()))
          response.headers.set(name, value);
      }
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
