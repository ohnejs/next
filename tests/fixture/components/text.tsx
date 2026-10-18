import { OhneRichText } from '@ohnejs/next/client';

import type { Block } from '../ohne';

export function Text({ fields }: Block<'Text'>) {
  return <OhneRichText value={fields.body} className="text" />;
}
