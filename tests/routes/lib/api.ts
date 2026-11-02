import { createOhneAPI } from '@ohnejs/next';

import type { Routes } from '../ohne';

export const api = createOhneAPI<Routes>({
  api: process.env.OHNE_API ?? 'http://localhost:9001/api',
});
