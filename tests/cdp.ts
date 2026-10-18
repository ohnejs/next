import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILES = new URL('.chrome/', import.meta.url).pathname;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The DevTools address of the page Chrome opened with `profile`, retried until `deadline`.
 */
async function pageOf(profile: string, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const response = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(1000),
      });
      const targets = (await response.json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((target) => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome never opened a page it could be driven through');
}

/**
 * A headless Chrome page driven over the DevTools protocol.
 * Every frame runs in one process, so each is reachable.
 */
export async function openBrowser() {
  mkdirSync(PROFILES, { recursive: true });
  const profile = mkdtempSync(PROFILES);
  const chrome = spawn(
    CHROME,
    [
      '--headless',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--password-store=basic',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--disable-site-isolation-trials',
      '--disable-features=IsolateOrigins,site-per-process',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const page = await pageOf(profile, Date.now() + 15000).catch((error) => {
    chrome.kill('SIGKILL');
    throw error;
  });
  const socket = new WebSocket(page);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

  let id = 0;
  const waiting = new Map<number, (value: any) => void>();
  const contexts = new Map<number, { origin: string; isDefault: boolean }>();
  const exceptions: string[] = [];
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id) waiting.get(data.id)?.(data);
    if (data.method === 'Runtime.executionContextCreated') {
      const { id, origin, auxData } = data.params.context;
      contexts.set(id, { origin, isDefault: auxData?.isDefault });
    }
    if (data.method === 'Runtime.executionContextDestroyed')
      contexts.delete(data.params.executionContextId);
    if (data.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (data.method === 'Runtime.exceptionThrown')
      exceptions.push(data.params.exceptionDetails.exception?.description);
  });
  const send = (method: string, params = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression: string, contextId?: number) => {
    const { result } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId && { contextId }),
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  };

  return {
    exceptions,
    evaluate,

    /**
     * Waits until `expression` holds in the frame `contextId`, or the main frame.
     */
    async until(expression: string, contextId?: number, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expression, contextId).catch(() => false)) return;
        await sleep(50);
      }
      const body = await evaluate('document.body?.innerText', contextId).catch(() => '?');
      throw new Error(`timed out waiting for ${expression}: ${body} ${exceptions.join(' | ')}`);
    },

    goto: (url: string) => send('Page.navigate', { url }),

    /**
     * The context of the frame showing `origin`, once it exists.
     */
    async frame(origin: string) {
      for (;;) {
        for (const [id, context] of contexts)
          if (context.origin === origin && context.isDefault) return id;
        await sleep(50);
      }
    },

    async close() {
      socket.close();
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      // A Chrome that hangs ignores `SIGTERM`.
      if (!(await Promise.race([exited.then(() => true), sleep(3000)]))) chrome.kill('SIGKILL');
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
