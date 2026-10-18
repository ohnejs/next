import type { Ohne, Resolved, ResolvedPage, Schema, UntypedSchema } from '@ohnejs/client';
import type { Metadata } from 'next';
import type { NextRequest } from 'next/server';
import type { JSX, ReactNode } from 'react';

/**
 * Options for `createOhneNext`.
 */
export interface OhneNextOptions {
  /**
   * The origin of your ohne API, like `'https://api.example.com'`.
   * Only the server reads it, so it may be an address on a private network.
   * The browser loads the editor's script from the site's own `/_ohne/cms/preview.js`, which `proxy` serves.
   */
  api: string;

  /**
   * Seconds a read stays in Next's data cache, tagged so `webhook` can drop it at once.
   * Omitted, every read goes to the API.
   * A preview is never cached.
   * Some changes send no webhook, like a scheduled page going live.
   * So this is the longest a page stays stale.
   */
  revalidate?: number;
}

/**
 * What the address of the current request resolves to.
 */
export interface Current<S extends Schema = UntypedSchema> {
  /**
   * The path and query the visitor asked for, as the proxy forwarded them, like `'/old?ref=x'`.
   */
  address: string;

  /**
   * The preview token in the address, or `undefined` outside the editor.
   */
  token: string | undefined;

  /**
   * What the cms resolved the address to: a page, a redirect, or a miss.
   */
  resolved: Resolved<S>;
}

/**
 * The page the address of the current request shows.
 */
export interface Loaded<S extends Schema = UntypedSchema> {
  /**
   * The resolved page; checking `collection` narrows `record`.
   */
  page: ResolvedPage<S>;

  /**
   * The preview token in the address, or `undefined` outside the editor.
   */
  token: string | undefined;
}

/**
 * A Next.js site's connection to one ohne API.
 * Every read starts from the address `proxy` forwards.
 * So a page, its metadata and its `not-found.tsx` share one request to the API.
 */
export interface OhneNext<S extends Schema = UntypedSchema> {
  /**
   * The `@ohnejs/client` it reads with, under the same caching, for a path other than the current one.
   */
  client: Ohne<S>;

  /**
   * Resolves the address of the current request without acting on the answer.
   * Reach for it in a layout or `not-found.tsx`, which receive neither the path nor the query.
   * It throws when `proxy` did not run, and a failed request throws, so Next answers `500`.
   */
  current(): Promise<Current<S>>;

  /**
   * Resolves the address of the current request for a page.
   * A permanent redirect answers `308` and a temporary one `307`, keeping the query when the cms does.
   * A miss calls `notFound()`, so `not-found.tsx` renders with a `404`.
   */
  page(): Promise<Loaded<S>>;

  /**
   * The page's metadata: title, description, share tags, robots, canonical and `hreflang` links.
   * The title is absolute, since the cms already ran it through the site's title template.
   * With a preview token it asks search engines to stay away.
   * Export it as `generateMetadata`.
   */
  metadata(): Promise<Metadata>;

  /**
   * The proxy every page request passes through, exported as `proxy` from `proxy.ts`.
   * It forwards the path and query to the server, and keeps a preview out of caches and search engines.
   * It also serves the editor's script at `/_ohne/cms/preview.js`, read from the API.
   */
  proxy(request: NextRequest): Promise<Response>;

  /**
   * A route handler that serves the cms sitemap, exported as `GET` from `app/sitemap.xml/route.ts`.
   * It reads the API when it runs, so one build serves every environment.
   */
  sitemap(): Promise<Response>;

  /**
   * A route handler that serves the cms `robots.txt`, exported as `GET` from `app/robots.txt/route.ts`.
   */
  robots(): Promise<Response>;

  /**
   * A route handler for the cms webhook, exported as `POST`.
   * It checks the signature against `secret` and drops every cached read.
   * It answers `401` to a forged or stale request and `204` otherwise.
   * While `secret` is empty it throws on each request, naming the fix.
   */
  webhook(secret: string | undefined): (request: Request) => Promise<Response>;
}

/**
 * Connects a Next.js site to the ohne API at `options.api`.
 * Pass the `CMS` type the API generates, as `createOhneNext<CMS>`, to type each page by its collection.
 * Import it in Server Components, `proxy.ts` and route handlers.
 * A Client Component imports `@ohnejs/next/client` instead.
 *
 * @example
 * ```ts
 * const ohne = createOhneNext<CMS>({ api: 'http://localhost:9001' })
 *
 * await ohne.page() // -> { page: { kind: 'page', collection: 'Pages', ... }, token: undefined }
 * ```
 */
export function createOhneNext<S extends Schema = UntypedSchema>(
  options: OhneNextOptions,
): OhneNext<S>;

/**
 * A block as a page carries it, before its name narrows it.
 */
export interface BlockValue {
  /**
   * The block's name, like `'Hero'`.
   */
  block: string;

  /**
   * The block's `UUID`, its React key and its `data-ohne-block` mark.
   */
  UUID: string;
}

/**
 * A component for each block name in `B`, taking that block as its props.
 */
export type BlockComponents<B extends BlockValue> = {
  [K in B['block']]: (props: Extract<B, { block: K }>) => ReactNode | Promise<ReactNode>;
};

/**
 * Props for `OhneBlocks`.
 */
export interface OhneBlocksProps<B extends BlockValue> {
  /**
   * The blocks to render, like `page.record.content`; `null` and `undefined` render nothing.
   */
  blocks: readonly B[] | null | undefined;

  /**
   * A component for each block name.
   * A block the CMS adds fails the typecheck until it has one here.
   */
  components: NoInfer<BlockComponents<B>>;

  /**
   * The element that wraps each block and carries its `data-ohne-block` mark.
   *
   * @default
   * 'div'
   */
  as?: keyof JSX.IntrinsicElements;
}

/**
 * Renders blocks through their components, each wrapped in an element the editor can select.
 * A block without a component renders nothing, as one the CMS added after the build.
 * It renders on the server, so a block's component may be async.
 *
 * @example
 * ```tsx
 * <OhneBlocks blocks={page.record.content} components={{ Hero, Text }} />
 * // -> <div data-ohne-block="01a1...">...</div><div data-ohne-block="01a2...">...</div>
 * ```
 */
export function OhneBlocks<B extends BlockValue>(props: OhneBlocksProps<B>): ReactNode;
