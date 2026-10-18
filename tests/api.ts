import type { Resolved, RichText } from '@ohnejs/client';
import type { AddressInfo } from 'node:net';

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PREVIEW = readFileSync(
  new URL('../node_modules/@ohnejs/cms/preview/browser.js', import.meta.url),
  'utf8',
);

const text = (value: string, href?: string): RichText => [
  {
    kind: 'paragraph',
    content: [{ text: value, ...(href && { link: { collection: 'Pages', record: 'r', href } }) }],
  },
];

/**
 * The page the mock cms resolves at `path`, titled `title`.
 */
function page(path: string, title: string, locale = 'en', image?: string): Resolved {
  return {
    kind: 'page',
    collection: 'Pages',
    UUID: `u-${path}`,
    locale,
    path,
    record: {
      UUID: `u-${path}`,
      title,
      content: [
        {
          block: 'Hero',
          UUID: `hero-${path}`,
          fields: { heading: `H:${title}`, body: text('hero body') },
        },
        { block: 'Text', UUID: `text-${path}`, fields: { body: text('to de', '/de/ueber') } },
        { block: 'Gone', UUID: `gone-${path}`, fields: {} },
      ],
    },
    seo: {
      title: `${title} | Site`,
      description: `About ${title}`,
      canonical: `https://example.com${path}`,
      ...(image && { image }),
    },
    alternates:
      path === '/about'
        ? [
            { hreflang: 'en', href: 'https://example.com/about' },
            { hreflang: 'de', href: 'https://example.com/de/ueber' },
            { hreflang: 'x-default', href: 'https://example.com/about' },
          ]
        : [],
  };
}

/**
 * A stand-in for the ohne API: it resolves a fixed set of paths and serves the real preview script.
 * Each resolve lands in `hits`, and `draft` is the title `/about` carries under a preview token.
 */
export async function startAPI() {
  const hits: { path: string; token: string | undefined }[] = [];
  const scripts: string[] = [];
  const state = { draft: 'About DRAFT', dashboard: 'http://dashboard.invalid' };

  const answer = (raw: string, token: string | undefined): Resolved | 500 => {
    const url = new URL(raw, 'http://site');
    const path = url.pathname;
    if (path === '/') return page('/', 'Home');
    if (path === '/about')
      return page('/about', token ? state.draft : 'About', 'en', 'https://example.com/og.png');
    if (path === '/de/ueber') return page('/de/ueber', 'Ueber', 'de');
    if (path === '/what%3F') return page(path, 'What');
    if (path === '/%C3%BCber') return page(path, 'Umlaut');
    if (path === '/old') return { kind: 'redirect', to: `/about${url.search}`, code: 301 };
    if (path === '/temp') return { kind: 'redirect', to: '/', code: 302 };
    if (path === '/t307') return { kind: 'redirect', to: '/', code: 307 };
    if (path === '/ext') return { kind: 'redirect', to: 'https://example.com/x', code: 308 };
    if (path === '/index') return { kind: 'redirect', to: '/', code: 301 };
    if (path === '/boom') return 500;
    return { kind: 'notFound', page: { title: 'Missing', content: [] } };
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://api');
    if (url.pathname === '/cms/preview.js') {
      scripts.push(url.search);
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      });
      response.end(PREVIEW.replace("'__OHNE_DASHBOARD_ORIGIN__'", JSON.stringify(state.dashboard)));
      return;
    }
    if (url.pathname === '/cms/sitemap.xml') {
      response.writeHead(200, {
        'content-type': 'application/xml',
        'cache-control': 'public, max-age=60',
      });
      response.end(`<urlset api="${origin}"/>`);
      return;
    }
    if (url.pathname === '/cms/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Sitemap: ${origin}/sitemap.xml`);
      return;
    }
    const path = url.searchParams.get('path') ?? '';
    const token = request.headers['ohne-preview'] as string | undefined;
    hits.push({ path, token });
    const body = answer(path, token);
    if (body === 500) {
      response.writeHead(500).end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, hits, scripts, state, answer, close: () => server.close() };
}
