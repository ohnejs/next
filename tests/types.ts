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

export const typed: [
  Same<OhneNext<CMS>['client'], Ohne<CMS>>,
  Same<Loaded<CMS>, { page: ResolvedPage<CMS>; token: string | undefined }>,
  Same<Current<CMS>, { address: string; token: string | undefined; resolved: Resolved<CMS> }>,
  Same<Awaited<ReturnType<typeof ohne.page>>['page']['record'], CMS['pages']['Pages']>,
] = [true, true, true, true];

OhneBlocks({ blocks, components: { Hero, Text } });
OhneBlocks({ blocks, components: { Hero, Text: ({ fields }) => fields.body.length } });
OhneBlocks({ blocks: missing, components: { Hero, Text }, as: 'section' });

// @ts-expect-error A block without a component fails.
OhneBlocks({ blocks, components: { Hero } });

// @ts-expect-error A component for another block fails.
OhneBlocks({ blocks, components: { Hero: Text, Text } });

// @ts-expect-error A component for a block the CMS lacks fails.
OhneBlocks({ blocks, components: { Hero, Text, Gone: Text } });

// @ts-expect-error An inline component reads only its own block's fields.
OhneBlocks({ blocks, components: { Hero, Text: ({ fields }) => fields.heading } });

// @ts-expect-error A wrapper must be an element.
OhneBlocks({ blocks, components: { Hero, Text }, as: 'nope' });

export const record = async () => {
  const { page } = await ohne.page();
  // @ts-expect-error A field the collection lacks fails.
  return page.record.heading;
};
