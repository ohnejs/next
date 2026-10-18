import { OhneLink, OhneRichText } from '@ohnejs/next/client';

import type { Block } from '../ohne';

export async function Hero({ fields }: Block<'Hero'>) {
  return (
    <section>
      <h2>{fields.heading}</h2>
      <OhneRichText value={fields.body} className="body" />
      <OhneLink link={{ url: '/de/ueber' }} className="in">
        in
      </OhneLink>
      <OhneLink link={{ url: 'https://example.com', newTab: true }} className="out">
        out
      </OhneLink>
      <OhneLink link={{ url: 'javascript:alert(1)' }} className="bad">
        bad
      </OhneLink>
    </section>
  );
}
