import type { Link, RichText } from '@ohnejs/client';
import type { LinkProps } from 'next/link';
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/**
 * Connects the site to the ohne editor that frames it.
 * On each change, it renders the page again on the server.
 * Render it once, in the root layout: the editor's script keeps one connection per page.
 * In a live demo's frame, named `ohne-sandbox`, it renders the page again when the visitor's copy changes.
 * Anywhere else it does nothing.
 *
 * @example
 * ```tsx
 * <body>
 *   {children}
 *   <OhnePreview />
 * </body>
 * ```
 */
export function OhnePreview(): ReactNode;

/**
 * Props for `OhneRichText`.
 * Any other attribute lands on the element, like `className`.
 */
export interface OhneRichTextProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'dangerouslySetInnerHTML'
> {
  /**
   * The value of a `richText` field; `null` and `undefined` render an empty element.
   */
  value: RichText | null | undefined;

  /**
   * Renders an `inline` field in a `<span>`: no block tags, and a `<br>` at each block boundary.
   *
   * @default
   * false
   */
  inline?: boolean;
}

/**
 * Renders a rich text value in a `<div>`, and sends clicks on links to your pages through Next's router.
 * Every text and address is escaped, and a link a browser could run renders as text.
 *
 * @example
 * ```tsx
 * <OhneRichText value={block.fields.body} className="prose" />
 * // -> <div class="prose"><p>Read <a href="/about">about us</a></p></div>
 * ```
 */
export function OhneRichText(props: OhneRichTextProps): ReactNode;

/**
 * Props for `OhneLink`.
 * Any other attribute lands on the element, like `className`.
 * `prefetch`, `replace` and `scroll` reach Next's `Link` for a path on the site.
 */
export interface OhneLinkProps
  extends
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>,
    Pick<LinkProps, 'prefetch' | 'replace' | 'scroll'> {
  /**
   * The value of a `link` field.
   */
  link: Link | null | undefined;

  /**
   * What the link shows.
   */
  children?: ReactNode;
}

/**
 * Renders a `link` field: Next's `Link` for a path on the site, an `<a>` for any other address.
 * A link without an address a browser may follow renders its children in a `<span>`.
 * A link that opens in a new tab gets `rel="noopener noreferrer"`.
 *
 * @example
 * ```tsx
 * <OhneLink link={{ url: '/about' }}>About</OhneLink>              // -> <a href="/about">About</a>
 * <OhneLink link={{ url: 'javascript:alert(1)' }}>About</OhneLink> // -> <span>About</span>
 * ```
 */
export function OhneLink(props: OhneLinkProps): ReactNode;
