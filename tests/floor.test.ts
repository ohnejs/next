import assert from 'node:assert/strict';
import { cpSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { startAPI } from './api.ts';
import { cache, probe } from './probes.ts';
import { build, start } from './site.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const FIXTURE = `${ROOT}tests/fixture/`;
const FLOOR = `${ROOT}tests/floor/`;
const SHARED = ['app', 'components', 'lib', 'ohne.ts', 'proxy.ts'];
const { files } = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { files: string[] };

let api: Awaited<ReturnType<typeof startAPI>>;
let site: Awaited<ReturnType<typeof start>>;
let output = '';

before(async () => {
  // A symlink would resolve `next` from the fixture, so the floor builds a copy.
  for (const entry of SHARED) {
    rmSync(`${FLOOR}${entry}`, { recursive: true, force: true });
    cpSync(`${FIXTURE}${entry}`, `${FLOOR}${entry}`, { recursive: true });
  }
  const built = build(FLOOR, FLOOR, { OHNE_REVALIDATE: '60' });
  output = built.output;
  assert.equal(built.status, 0, output);
  api = await startAPI();
  site = await start(FLOOR, { OHNE_API: api.origin });
});

after(() => {
  site?.close();
  api?.close();
});

describe('the oldest Next and React the peers allow', () => {
  it('builds against the package as it is now', () => {
    const installed = realpathSync(`${FLOOR}node_modules/@ohnejs/next`);
    for (const file of files) {
      const current =
        readFileSync(`${ROOT}${file}`, 'utf8') === readFileSync(`${installed}/${file}`, 'utf8');
      assert.ok(current, `the floor holds an old \`${file}\`: run \`pnpm install\``);
    }
    assert.match(output, /Next\.js 16\.0\.0/);
    assert.match(output, /○ \/legal/);
    assert.match(output, /ƒ \/robots\.txt/);
    assert.match(output, /ƒ \/sitemap\.xml/);
  });

  probe(() => ({ api, origin: site.origin }));
});

describe('caching on the oldest Next', () => cache(FLOOR, () => api));
