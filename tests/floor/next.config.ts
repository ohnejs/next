import type { NextConfig } from 'next';

import { resolve } from 'node:path';

// A linked `@ohnejs/client` lives beside this checkout, so Turbopack must see the parent folder.
export default {
  turbopack: { root: resolve(import.meta.dirname, '../../..') },
} satisfies NextConfig;
