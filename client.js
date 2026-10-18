'use client';

/** @import { ReactNode } from 'react' */
/** @import { OhneLinkProps, OhneRichTextProps } from './client.d.ts' */
import { connect, interceptLinks, linkHref, richTextToHTML } from '@ohnejs/client';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { createElement, useEffect, useRef } from 'react';

const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' };

/**
 * @returns {null}
 */
export function OhnePreview() {
  const router = useRouter();
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('ohne-preview')) return;
    return connect({ api: '/_ohne', keepToken: true, onRefresh: router.refresh }).dispose;
  }, [router]);
  return null;
}

/**
 * @param {OhneRichTextProps} props
 * @returns {ReactNode}
 */
export function OhneRichText({ value, inline = false, ...rest }) {
  const router = useRouter();
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  useEffect(
    () => interceptLinks(/** @type {HTMLElement} */ (root.current), (path) => router.push(path)),
    [router],
  );
  return createElement(inline ? 'span' : 'div', {
    ...rest,
    ref: root,
    dangerouslySetInnerHTML: { __html: richTextToHTML(value, { inline }) },
  });
}

/**
 * @param {OhneLinkProps} props
 * @returns {ReactNode}
 */
export function OhneLink({ link, children, prefetch, replace, scroll, ...rest }) {
  const href = linkHref(link);
  if (href === undefined) return createElement('span', rest, children);
  const props = { ...rest, ...(link?.newTab === true ? NEW_TAB : {}), href };
  return href.startsWith('/')
    ? createElement(NextLink, { ...props, prefetch, replace, scroll }, children)
    : createElement('a', props, children);
}
