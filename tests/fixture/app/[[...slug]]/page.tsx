import { OhneBlocks } from '@ohnejs/next';

import { Hero } from '../../components/hero';
import { Posts } from '../../components/posts';
import { Text } from '../../components/text';
import { ohne } from '../../lib/ohne';

export const generateMetadata = ohne.metadata;

export default async function Page() {
  const { page } = await ohne.page();
  return (
    <main lang={page.locale}>
      <h1>{page.record.title}</h1>
      <OhneBlocks blocks={page.record.content} components={{ Hero, Posts, Text }} />
    </main>
  );
}
