import { BrowserSignIn } from '../components/browser-sign-in';
import { api } from '../lib/api';
import { signIn, signOut } from './actions';

export default async function Home() {
  const user = await api.user();
  const sites = await api.call('GET /sites', { query: { client: 'acme' } });
  return (
    <main>
      <p className="user">{user ? user.email : 'signed out'}</p>
      {sites.map((site) => (
        <p key={site.code} className="site">
          {site.name}
        </p>
      ))}
      <form action={signIn}>
        <input name="email" defaultValue="ada@example.com" />
        <input name="password" defaultValue="secret" />
        <button className="in">Sign in</button>
      </form>
      <form action={signOut}>
        <button className="out">Sign out</button>
      </form>
      <BrowserSignIn />
    </main>
  );
}
