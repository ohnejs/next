import { OhneBlocks } from '@ohnejs/next';

import { Hero } from '../../components/hero';
import { Posts } from '../../components/posts';
import { Text } from '../../components/text';
import { ohne } from '../../lib/ohne';

export default async function NotFound() {
  const { resolved } = await ohne.current();
  const page = resolved.kind === 'notFound' ? resolved.page : undefined;
  return (
    <main>
      <h1>{page ? `CMS404:${page.title}` : 'Page not found'}</h1>
      <OhneBlocks blocks={page?.content} components={{ Hero, Posts, Text }} />
    </main>
  );
}
