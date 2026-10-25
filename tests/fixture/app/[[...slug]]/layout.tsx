import { OhneLink } from '@ohnejs/next/client';

import { ohne } from '../../lib/ohne';

export default async function SiteLayout({ children }: LayoutProps<'/[[...slug]]'>) {
  const settings = await ohne.read('Settings');
  return (
    <>
      <nav className="menu">
        {settings.menu.map((item) => (
          <OhneLink key={item.label} link={item.link}>
            {item.label}
          </OhneLink>
        ))}
      </nav>
      {children}
      <footer>{settings.copyright}</footer>
    </>
  );
}
