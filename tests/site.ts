import type { AddressInfo } from 'node:net';

import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/**
 * The environment without `OHNE_API`, so a build cannot bake the API address in.
 */
function bare(env: Record<string, string> = {}) {
  const { OHNE_API: _, ...rest } = process.env;
  return { ...rest, NEXT_TELEMETRY_DISABLED: '1', ...env };
}

/**
 * Runs `next build` in `dir` from a clean `.next` with `env`, using the `next` that `bin` installs.
 * It answers the exit status and the output without color, which a run under `FORCE_COLOR` would add.
 */
export function build(dir: string, bin = dir, env: Record<string, string> = {}) {
  rmSync(join(dir, '.next'), { recursive: true, force: true });
  const result = spawnSync(join(bin, 'node_modules/.bin/next'), ['build'], {
    cwd: dir,
    env: bare(env),
    encoding: 'utf8',
  });
  return { status: result.status, output: stripVTControlCharacters(result.stdout + result.stderr) };
}

/**
 * A port nothing listens on.
 */
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Runs `next start` in `dir` with `env` and waits until `ready` answers.
 */
export function start(dir: string, env: Record<string, string>, ready = '/legal') {
  return serve('start', dir, env, ready);
}

/**
 * Runs `next dev` in `dir` with `env` and waits until `ready` answers.
 */
export function dev(dir: string, env: Record<string, string>, ready = '/') {
  return serve('dev', dir, env, ready);
}

/**
 * Runs `next <command>` in `dir` with `env` and waits until `ready` answers.
 */
async function serve(
  command: 'start' | 'dev',
  dir: string,
  env: Record<string, string>,
  ready: string,
) {
  const port = await freePort();
  const child = spawn(
    join(dir, 'node_modules/.bin/next'),
    [command, '-p', String(port), '-H', '127.0.0.1'],
    {
      cwd: dir,
      env: bare(env),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let log = '';
  child.stderr.on('data', (chunk) => (log += chunk));
  const origin = `http://127.0.0.1:${port}`;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next ${command} exited: ${log}`);
    try {
      await (await fetch(`${origin}${ready}`)).body?.cancel();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return { origin, log: () => log, close: () => child.kill() };
}
