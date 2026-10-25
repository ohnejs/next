import type { Resolved, RichText } from '@ohnejs/client';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PREVIEW = readFileSync(
  new URL('../node_modules/@ohnejs/cms/preview/browser.js', import.meta.url),
  'utf8',
);

/**
 * The cookie that binds a demo visitor to a sandbox copy, as a site in demo mode names it.
 */
export const SANDBOX = 'ohne_sandbox';

/**
 * A stand-in for the sandbox layer's `frame.js`: the framed side of embed v1, as a demo's page speaks it.
 * The API writes the pages it trusts in, and each `shown` refreshes once the copy's `changedAt` moved.
 */
const FRAME = `const ALLOWED = '__ORIGINS__';
const ENVELOPE = { ohne: 'embed', v: 1 };
const changedAt = () =>
  fetch(new URL('../sandbox', import.meta.url), { cache: 'no-store' })
    .then((response) => response.json())
    .then((status) => status.changedAt);

export function connect({ onRefresh }) {
  if (window.parent === window) return { dispose() {} };
  let locked;
  let last = changedAt();
  const onMessage = async (event) => {
    if (event.source !== window.parent || !ALLOWED.includes(event.origin)) return;
    if (event.data?.ohne !== 'embed' || event.data.v !== 1) return;
    if (event.data.type === 'theme' && locked === undefined) {
      locked = event.origin;
      window.parent.postMessage({ ...ENVELOPE, type: 'ready', signedIn: false }, locked);
    }
    if (event.data.type === 'shown' && event.origin === locked) {
      const before = await last;
      last = changedAt();
      if ((await last) !== before) onRefresh();
    }
  };
  window.addEventListener('message', onMessage);
  for (const origin of ALLOWED) window.parent.postMessage({ ...ENVELOPE, type: 'hello' }, origin);
  return { dispose: () => window.removeEventListener('message', onMessage) };
}
`;

/**
 * The posts the mock cms lists, newest first.
 */
const POSTS = [5, 4, 3, 2, 1].map((n) => ({
  UUID: `0192f0c4-0000-7000-8000-00000000000${n}`,
  ...(n !== 5 && { path: `/blog/post-${n}` }),
  title: `Post ${n}`,
  publishedAt: n,
}));

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
        ...(path === '/blog' ? [{ block: 'Posts', UUID: 'posts', fields: { perPage: 2 } }] : []),
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
 * A create the stand-in API received, with every header it carried.
 */
export interface Create {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/**
 * A stand-in for the ohne API: it resolves a fixed set of paths and serves the real preview script.
 * Each resolve lands in `hits`, and `draft` is the title `/about` carries under a preview token.
 * It reads `Settings` and lists `Posts` as `GET /cms/records` does, and plays the sandbox layer's routes.
 * It takes a create in `Messages` while `state.messages` holds, each one landing in `creates`.
 * Every request lands in `requests` with the credentials it carried.
 * A request whose `ohne_sandbox` cookie names `sandbox.id` reads the visitor's copy.
 */
export async function startAPI() {
  const hits: { path: string; token: string | undefined }[] = [];
  const scripts: string[] = [];
  const requests: { path: string; cookie?: string; authorization?: string }[] = [];
  const creates: Create[] = [];
  const state = {
    draft: 'About DRAFT',
    dashboard: 'http://dashboard.invalid',
    frameAncestors: [] as string[],
    sandbox: { id: 'copy-1', copyright: 'Copy one', changedAt: 1 },
    messages: true,
  };

  const answer = (raw: string, token: string | undefined): Resolved | 500 => {
    const url = new URL(raw, 'http://site');
    const path = url.pathname;
    if (path === '/') return page('/', 'Home');
    if (path === '/about')
      return page('/about', token ? state.draft : 'About', 'en', 'https://example.com/og.png');
    if (path === '/de/ueber') return page('/de/ueber', 'Ueber', 'de');
    if (path === '/blog') return page('/blog', 'Blog');
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

  /**
   * The `GET /cms/records` answer at `url`, read in the visitor's copy when `bound`.
   */
  const records = (url: URL, bound: boolean): object | undefined => {
    const [collection, uuid, ...rest] = url.pathname.split('/').slice(3);
    if (rest.length > 0) return undefined;
    if (collection === 'Settings' && uuid === undefined) {
      return {
        UUID: 'settings',
        menu: [
          { label: 'About', link: { collection: 'Pages', record: 'u-/about', href: '/about' } },
        ],
        copyright: bound ? state.sandbox.copyright : 'Acme',
      };
    }
    if (collection !== 'Posts') return undefined;
    if (uuid !== undefined) return POSTS.find((post) => post.UUID === uuid);
    const page = Number(url.searchParams.get('page') ?? 1);
    const perPage = Number(url.searchParams.get('perPage') ?? 20);
    return {
      records: POSTS.slice((page - 1) * perPage, page * perPage),
      total: POSTS.length,
      page,
      perPage,
      lastPage: Math.ceil(POSTS.length / perPage),
    };
  };

  /**
   * Answers a create with the framework's error bodies.
   * The spam check refuses one without the `human` token, and validation an email without `@`.
   */
  const create = async (path: string, request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { email: string };
    creates.push({ path, headers: request.headers, body });
    const send = (statusCode: number, answer: object) =>
      response
        .writeHead(statusCode, {
          'content-type': 'application/json',
          'set-cookie': `${SANDBOX}=; Path=/; Max-Age=0`,
        })
        .end(JSON.stringify(answer));
    if (path !== '/collections/messages' || !state.messages)
      return send(404, { statusCode: 404, message: 'Not found' });
    if (request.headers['recaptcha-token'] !== 'human')
      return send(403, { statusCode: 403, message: 'The spam check failed. Please try again.' });
    if (!body.email.includes('@')) {
      const errors = { email: 'Enter a valid email address.' };
      return send(422, { statusCode: 422, message: 'Check the form.', data: { errors } });
    }
    send(201, { UUID: `m-${creates.length}`, ...body });
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://api');
    const { cookie, authorization } = request.headers;
    requests.push({
      path: url.pathname + url.search,
      ...(cookie && { cookie }),
      ...(authorization && { authorization }),
    });
    if (request.method === 'POST' && url.pathname.startsWith('/collections/')) {
      void create(url.pathname, request, response);
      return;
    }
    const bound = cookie === `${SANDBOX}=${state.sandbox.id}`;
    // The sandbox layer drops an unknown id, which a site must never pass back to its visitor.
    const dropped = { 'set-cookie': `${SANDBOX}=; Path=/; Max-Age=0` };
    if (url.pathname === '/sandbox/frame.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      });
      response.end(FRAME.replace("'__ORIGINS__'", JSON.stringify(state.frameAncestors)));
      return;
    }
    if (url.pathname === '/sandbox') {
      const status = bound
        ? { phase: 'live', changedAt: state.sandbox.changedAt }
        : { phase: 'open' };
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': bound ? 'private, no-store' : 'no-store',
        ...dropped,
      });
      response.end(JSON.stringify(status));
      return;
    }
    if (url.pathname.startsWith('/cms/records/')) {
      const body = records(url, bound);
      response.writeHead(body ? 200 : 404, { 'content-type': 'application/json', ...dropped });
      response.end(JSON.stringify(body ?? {}));
      return;
    }
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
  return {
    origin,
    hits,
    scripts,
    requests,
    creates,
    state,
    answer,
    close: () => server.close(),
  };
}
