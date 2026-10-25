import Link from 'next/link';

import type { Block } from '../ohne';

import { ohne } from '../lib/ohne';

export async function Posts({ fields }: Block<'Posts'>) {
  const page = Number((await ohne.searchParams()).get('page')) || 1;
  const posts = await ohne.list('Posts', {
    order: ['-publishedAt'],
    page,
    perPage: fields.perPage,
    select: ['title', 'publishedAt'],
  });
  return (
    <section className="posts">
      {posts.records.map((post) => (
        <article key={post.UUID}>
          <h3>{post.path ? <Link href={post.path}>{post.title}</Link> : post.title}</h3>
        </article>
      ))}
      <nav>
        {posts.page > 1 && <Link href={`?page=${posts.page - 1}`}>Newer</Link>}
        {posts.page < posts.lastPage && (
          <Link href={`?page=${posts.page + 1}`} className="older">
            Older
          </Link>
        )}
      </nav>
    </section>
  );
}
