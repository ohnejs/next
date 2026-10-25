# @ohnejs/next

Renders the pages of an [ohne](https://ohne.dev) CMS in a Next.js site. Each path resolves on the
server, redirects and misses answer with the right status, the metadata comes from the CMS, and
the dashboard's editor previews every change live.

It needs Next 16 with the App Router and React 19.

## Install

```sh
pnpm add @ohnejs/next @ohnejs/client
```

Fetch your CMS's types into `ohne.ts`, as [`@ohnejs/client`](https://github.com/ohnejs/client#types)
shows. They type every page by its collection.

## Connect

Create the connection once:

```ts
// lib/ohne.ts
import { createOhneNext } from '@ohnejs/next';

import type { CMS } from '../ohne';

export const ohne = createOhneNext<CMS>({ api: process.env.OHNE_API ?? 'http://localhost:9001' });
```

`OHNE_API` is the address of your API. The server reads it when it runs, so one build serves every
environment.

Every page request passes through the proxy. It hands the path and query to your pages, keeps a
preview out of caches and search engines, and serves the editor's script:

```ts
// proxy.ts
import { ohne } from './lib/ohne';

export const proxy = ohne.proxy;

export const config = { matcher: '/((?!_next/).*)' };
```

Keep the `matcher` covering `/_ohne/`: the proxy serves the editor's script there. Next reads the
`matcher` when it builds, so it must stay a literal.

## The page

One catch-all page renders every path the CMS answers, `/` included, so delete `app/page.tsx`:

```tsx
// app/[[...slug]]/page.tsx
import { OhneBlocks } from '@ohnejs/next';

import { Hero } from '../../components/hero';
import { Text } from '../../components/text';
import { ohne } from '../../lib/ohne';

export const generateMetadata = ohne.metadata;

export default async function Page() {
  const { page } = await ohne.page();
  return (
    <main lang={page.locale}>
      <h1>{page.record.title}</h1>
      <OhneBlocks blocks={page.record.content} components={{ Hero, Text }} />
    </main>
  );
}
```

`ohne.page()` resolves the current address. A permanent redirect answers `308` and a temporary one
`307`, keeping the query when the CMS does. A miss answers `404`, and a failing API answers `500`.

`ohne.metadata` gives Next the title, description, share tags, robots, canonical and `hreflang`
links. The page, its metadata and its not-found page share one request to the API.

With more than one collection, check `page.collection` to narrow `page.record`.

Put your icon at `app/favicon.ico`. Without it, each request for `/favicon.ico` asks the CMS for a
page.

## Blocks

`OhneBlocks` renders each block through the component named after it, and wraps it in a `<div>`
the editor can select. Pass `as="section"` for another element. Each component takes its block:

```tsx
// components/hero.tsx
import { OhneLink, OhneRichText } from '@ohnejs/next/client';

import type { Block } from '../ohne';

export function Hero({ fields }: Block<'Hero'>) {
  return (
    <section>
      <h2>{fields.heading}</h2>
      <OhneRichText value={fields.body} />
      <OhneLink link={fields.link} className="button">
        Read more
      </OhneLink>
    </section>
  );
}
```

A block the CMS adds fails the typecheck until it has a component. A block that arrives before your
next build renders nothing. A block's component may be async.

## Site data

A layout or a component reads [site data](https://ohne.dev/docs/cms/website#site-data) with
`ohne.read` and `ohne.list`:

```tsx
// app/[[...slug]]/layout.tsx
import { OhneLink } from '@ohnejs/next/client';

import { ohne } from '../../lib/ohne';

export default async function SiteLayout({ children }: LayoutProps<'/[[...slug]]'>) {
  const settings = await ohne.read('Settings');
  return (
    <>
      <nav>
        {settings.menu.map((item) => (
          <OhneLink key={item.label} link={item.link}>
            {item.label}
          </OhneLink>
        ))}
      </nav>
      {children}
      <footer>{settings.copyright}</footer>
    </>
  );
}
```

Reads are cached like the page's, and the webhook drops them with it. Records read in your default
locale unless you pass `locale`.

Only a page receives `searchParams`. A block reads the query with `ohne.searchParams()` instead,
like a page number for its list:

```ts
const page = Number((await ohne.searchParams()).get('page')) || 1;
const posts = await ohne.list('Posts', { order: ['-publishedAt'], page });
```

A layout must not read the query: Next keeps a layout as first rendered when only the query
changes.

## Forms

A form creates a record in a collection your CMS opens to
[visitors](https://ohne.dev/docs/cms/website#forms). Send it from a Server Action with
`ohne.create`:

```ts
// app/contact/actions.ts
'use server';

import type { Creatable } from '../../ohne';

import { ohne } from '../../lib/ohne';

export async function sendMessage(message: Creatable['Messages'], token: string) {
  return ohne.create('Messages', message, { headers: { 'recaptcha-token': token } });
}
```

The header carries a spam check's token, like the one a reCAPTCHA widget adds to the form, to the
middleware on the API that reads it. A create is never cached.

The action answers `{ ok: true, UUID }`, or `{ ok: false, status, message, errors }` when the API
refuses the input. `errors` holds a message per invalid field, so a Client Component shows each one
beside its input:

```tsx
// components/contact-form.tsx
'use client';

import { useState } from 'react';

import { sendMessage } from '../app/contact/actions';

export function ContactForm() {
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [sent, setSent] = useState(false);

  async function send(form: FormData) {
    const field = (name: string) => String(form.get(name));
    const message = { name: field('name'), email: field('email'), message: field('message') };
    const result = await sendMessage(message, field('g-recaptcha-response'));
    if (result.ok) setSent(true);
    else setErrors(result.errors);
  }

  if (sent) return <p>Thanks!</p>;
  return (
    <form action={send}>
      <input name="name" />
      <input name="email" />
      {errors.email && <p>{errors.email}</p>}
      <textarea name="message" />
      <button>Send</button>
    </form>
  );
}
```

Any other failure throws inside the action, like a collection visitors may not create in.

Each create passes the visitor's address and language on, so the API answers in their language. To
give each visitor their own rate limit, list your site's server in
[`api.trustProxy`](https://ohne.dev/docs/production/deployment#behind-a-proxy). Do that only behind
a proxy that sets `X-Forwarded-For`, like your host's: a Next server facing the internet directly
passes on whatever address a visitor claims.

## Rich text and links

`OhneRichText` renders a `richText` field in a `<div>`, escaping every text and address. Clicks on
links to your pages go through Next's router. Pass `inline` for an inline field, which renders in a
`<span>`, so it fits inside a heading.

`OhneLink` renders a `link` field: Next's `Link` for a path on your site, a plain `<a>` for any other
address. A link that opens in a new tab gets `rel="noopener noreferrer"`. A link with no address a
browser may follow renders its children in a `<span>`, keeping its `className`.

## Not found

A miss renders the not-found page beside the catch-all. It reads the `404` record your CMS keeps:

```tsx
// app/[[...slug]]/not-found.tsx
import { OhneBlocks } from '@ohnejs/next';

import { Hero } from '../../components/hero';
import { Text } from '../../components/text';
import { ohne } from '../../lib/ohne';

export default async function NotFound() {
  const { resolved } = await ohne.current();
  const page = resolved.kind === 'notFound' ? resolved.page : undefined;
  return (
    <main>
      <h1>{page?.title ?? 'Page not found'}</h1>
      <OhneBlocks blocks={page?.content} components={{ Hero, Text }} />
    </main>
  );
}
```

Keep it inside `[[...slug]]`. A root `not-found.tsx` that reads the request makes every page of the
app dynamic. Its `<title>` is the layout's.

Remove `cacheComponents` and `partialPrefetching` from `next.config.ts`: with them, redirects and misses answer `200`.

Next renders this page in the browser: the server answers `404` with an almost empty body, so a
crawler that runs no JavaScript sees no content
([vercel/next.js#99287](https://github.com/vercel/next.js/issues/99287)).

## Live preview

Render `OhnePreview` once, in the root layout:

```tsx
// app/layout.tsx
import { OhnePreview } from '@ohnejs/next/client';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>
        {children}
        <OhnePreview />
      </body>
    </html>
  );
}
```

Inside the editor's frame it joins the editor, and each change renders the page again on the server
with your drafts. Anywhere else it does nothing.

The editor keeps the frame on the page you edit, so a click on a link does not leave it. If your
own code navigates inside the frame, the next page renders without the preview token, so it shows
saved content.

## Sitemap and robots

Two route handlers serve the sitemap and `robots.txt` the CMS writes:

```ts
// app/sitemap.xml/route.ts
import { ohne } from '../../lib/ohne';

export const GET = ohne.sitemap;
```

```ts
// app/robots.txt/route.ts
import { ohne } from '../../lib/ohne';

export const GET = ohne.robots;
```

They read the API when they run. A rewrite in `next.config.ts` would fix the API address at build
time instead.

## Caching

By default every page view reads the API. Set `revalidate` to keep each read in Next's data cache
for that many seconds:

```ts
// lib/ohne.ts
import { createOhneNext } from '@ohnejs/next';

import type { CMS } from '../ohne';

export const ohne = createOhneNext<CMS>({
  api: process.env.OHNE_API ?? 'http://localhost:9001',
  revalidate: 300,
});
```

A preview is never cached. Let the CMS drop the cache the moment content changes, with a route for
its webhook:

```ts
// app/api/ohne/route.ts
import { ohne } from '../../../lib/ohne';

export const POST = ohne.webhook(process.env.WEBHOOK_SECRET);
```

Point a `webhooks` entry of your CMS at `/api/ohne` with the same secret. A forged or stale request
answers `401`. Some changes send no webhook, like a scheduled page going live, so `revalidate` is
the longest a page stays stale.

Every `OhneLink` in view prefetches its page, which reads the API. With `revalidate` set, those
reads come from the cache; without it, pass `prefetch={false}` where that matters.

## A private API

`OHNE_API` may be an address only your server reaches, since the browser loads everything through
your site. Set `API_URL` on the CMS to its public address, so the files a page links to carry it.

## Docs

[Frameworks](https://ohne.dev/docs/cms/frameworks#next) walks through a whole site.
[Your website](https://ohne.dev/docs/cms/website) explains pages, blocks and the live preview.
