import type { Ohne, Resolved, ResolvedPage } from '@ohnejs/client';

import type { Current, Loaded, OhneNext } from '../index.js';
import type { Block, CMS } from './fixture/ohne.ts';

import { OhneBlocks } from '../index.js';

/**
 * `true` only when `A` and `B` are the same type, so an optional field added on one side fails too.
 */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const ohne: OhneNext<CMS>;
declare const blocks: Block[];
declare const missing: Block[] | undefined;
declare const Hero: (props: Block<'Hero'>) => null;
declare const Text: (props: Block<'Text'>) => Promise<null>;
declare const Posts: (props: Block<'Posts'>) => Promise<null>;

export const typed: [
  Same<OhneNext<CMS>['client'], Ohne<CMS>>,
  Same<Loaded<CMS>, { page: ResolvedPage<CMS>; token: string | undefined }>,
  Same<Current<CMS>, { address: string; token: string | undefined; resolved: Resolved<CMS> }>,
  Same<Awaited<ReturnType<typeof ohne.page>>['page']['record'], CMS['pages']['Pages']>,
  Same<OhneNext<CMS>['read'], Ohne<CMS>['read']>,
  Same<OhneNext<CMS>['list'], Ohne<CMS>['list']>,
  Same<OhneNext<CMS>['create'], Ohne<CMS>['create']>,
  Same<Awaited<ReturnType<typeof ohne.searchParams>>, URLSearchParams>,
] = [true, true, true, true, true, true, true, true];

export const reads = async () => {
  const settings = await ohne.read('Settings');
  const posts = await ohne.list('Posts', { order: ['-publishedAt'], select: ['title'] });
  const post = await ohne.read('Posts', 'uuid');
  return [settings.copyright, posts.records[0]?.title, post?.publishedAt];
};

export const refused = async () => {
  // @ts-expect-error A list reads no singleton.
  await ohne.list('Settings');
  // @ts-expect-error `order` names only the collection's fields.
  await ohne.list('Posts', { order: ['-nope'] });
  const posts = await ohne.list('Posts', { select: ['title'] });
  // @ts-expect-error `select` narrows the record.
  return posts.records[0]?.publishedAt;
};

export const creates = async () => {
  const message = { name: 'Ada', email: 'ada@example.com', message: 'Hello' };
  const result = await ohne.create('Messages', message, { headers: { 'recaptcha-token': 't' } });
  // @ts-expect-error A visitor creates only in a creatable collection.
  await ohne.create('Posts', { title: 'x' });
  // @ts-expect-error A create takes only the collection's fields.
  await ohne.create('Messages', { ...message, status: 'read' });
  return result.ok ? result.UUID : result.errors.email;
};

OhneBlocks({ blocks, components: { Hero, Posts, Text } });
OhneBlocks({ blocks, components: { Hero, Posts, Text: ({ fields }) => fields.body.length } });
OhneBlocks({ blocks: missing, components: { Hero, Posts, Text }, as: 'section' });

// @ts-expect-error A block without a component fails.
OhneBlocks({ blocks, components: { Hero } });

// @ts-expect-error A component for another block fails.
OhneBlocks({ blocks, components: { Hero: Text, Posts, Text } });

// @ts-expect-error A component for a block the CMS lacks fails.
OhneBlocks({ blocks, components: { Hero, Posts, Text, Gone: Text } });

// @ts-expect-error An inline component reads only its own block's fields.
OhneBlocks({ blocks, components: { Hero, Posts, Text: ({ fields }) => fields.heading } });

// @ts-expect-error A wrapper must be an element.
OhneBlocks({ blocks, components: { Hero, Posts, Text }, as: 'nope' });

export const record = async () => {
  const { page } = await ohne.page();
  // @ts-expect-error A field the collection lacks fails.
  return page.record.heading;
};
