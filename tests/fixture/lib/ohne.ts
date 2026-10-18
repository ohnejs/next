import { createOhneNext } from '@ohnejs/next';

import type { CMS } from '../ohne';

export const ohne = createOhneNext<CMS>({
  api: process.env.OHNE_API ?? 'http://localhost:9001',
  revalidate: process.env.OHNE_REVALIDATE ? Number(process.env.OHNE_REVALIDATE) : undefined,
});
