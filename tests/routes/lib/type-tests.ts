import type { OhneAPI } from '@ohnejs/next';

import type { Routes } from '../ohne';

declare const api: OhneAPI<Routes>;

export async function typed() {
  const sites: { code: string; name: string }[] = await api.call('GET /sites', {
    query: { client: 'acme' },
  });
  // @ts-expect-error `GET /sites` reads a `client`.
  void api.call('GET /sites');
  const site: { name: string } = await api.call('GET /sites/[code]', { params: { code: 'a' } });
  // @ts-expect-error `GET /sites/[code]` names a `code`.
  void api.call('GET /sites/[code]');
  // @ts-expect-error The API serves no `GET /nope`.
  void api.call('GET /nope');
  const email: string | undefined = (await api.user())?.email;
  return [sites, site, email];
}
