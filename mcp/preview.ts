import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Browser } from 'playwright';
import type { Deck } from '../src/app/core/model';
import { ToolError } from './tool';

/** Mirrors `PreviewReport` of `src/app/preview-page.ts`. */
export interface PreviewReport {
  errors: { source: string; componentId?: string; message: string }[];
  console: { componentId: string; level: string; text: string }[];
  frames: { elementId: string; running: boolean; notice?: string }[];
}

export interface PreviewRequest {
  deck: Deck;
  slideId: string;
  assets: ReadonlyMap<string, Uint8Array>;
  /** CSS pixel width of the picture. */
  width: number;
  /** How long the components may run before the picture is taken. */
  settleMs: number;
  /** Crop to this element instead of the whole slide. */
  elementId?: string;
}

export interface PreviewResult {
  png: Uint8Array;
  width: number;
  height: number;
  report: PreviewReport;
}

export interface PreviewOptions {
  /** `DECKTECH_PREVIEW=1`: whoever configured the server allows agent-written code to run in a browser. */
  enabled: boolean;
  /** The built app (`ng build`), served on a local port for the browser. */
  appDir: string;
}

declare global {
  interface Window {
    decktechPreview?: {
      show(request: unknown): Promise<void>;
      report(): unknown;
    };
  }
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const RENDER_TIMEOUT_MS = 45_000;
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Serves the files of the built app on 127.0.0.1 only; anything outside `root` is a 404. */
function serveApp(root: string): Promise<{ server: Server; origin: string }> {
  const base = resolve(root);
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    let file = resolve(join(base, normalize(path)));
    if (file !== base && !file.startsWith(base + sep)) {
      response.writeHead(404).end();
      return;
    }
    // Routes of the single-page app have no extension: they get index.html.
    if (!existsSync(file) || statSync(file).isDirectory())
      file = extname(path) === '' ? join(base, 'index.html') : file;
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolveListening({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    );
  });
}

/**
 * Draws slides in a headless Chromium with the real app (route `preview`), so a picture shows what
 * DeckTech shows. This is the one place where the server lets code written by an agent run: inside
 * the sandboxed frames of the app, in a fresh browser context per picture (no stored data, no
 * service worker), with every request outside the local app server refused. It is opt-in
 * (`DECKTECH_PREVIEW=1`, ADR-013).
 */
export class Previewer {
  private started: Promise<{ browser: Browser; server: Server; origin: string }> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PreviewOptions) {}

  /** Why previews are unavailable, or `undefined` when they can run. */
  problem(): string | undefined {
    if (!this.options.enabled) {
      return "Previews run the deck's code in a headless browser, which is switched off. The person who configured this server enables it with the environment variable DECKTECH_PREVIEW=1.";
    }
    if (!existsSync(join(this.options.appDir, 'index.html'))) {
      return `The built app was not found in ${this.options.appDir}. Run "npm run build" in the DeckTech repository, or set DECKTECH_APP_DIR to its output (dist/decktech/browser).`;
    }
    return undefined;
  }

  render(request: PreviewRequest): Promise<PreviewResult> {
    const problem = this.problem();
    if (problem) return Promise.reject(new ToolError(problem));
    // One picture at a time: they share a browser and the machine's CPU.
    const run = this.queue.then(() => this.draw(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    const started = await this.started?.catch(() => undefined);
    this.started = undefined;
    await started?.browser.close().catch(() => undefined);
    started?.server.close();
  }

  private start(): Promise<{ browser: Browser; server: Server; origin: string }> {
    this.started ??= (async () => {
      let playwright: typeof import('playwright');
      try {
        playwright = await import('playwright');
      } catch {
        throw new ToolError(
          'Previews need the "playwright" package next to the server (npm install) and a Chromium (npx playwright install chromium).',
        );
      }
      const { server, origin } = await serveApp(this.options.appDir);
      try {
        const browser = await playwright.chromium.launch();
        return { browser, server, origin };
      } catch (e) {
        server.close();
        throw new ToolError(
          `The browser could not be started. Install it with "npx playwright install chromium". ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
        );
      }
    })();
    this.started.catch(() => (this.started = undefined));
    return this.started;
  }

  private async draw(request: PreviewRequest): Promise<PreviewResult> {
    const { browser, origin } = await this.start();
    const { stage } = request.deck;
    const width = request.width;
    const height = Math.round((width * stage.height) / stage.width);
    const context = await browser.newContext({
      viewport: { width: width + 32, height: height + 240 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const timer = setTimeout(() => void context.close().catch(() => undefined), RENDER_TIMEOUT_MS);
    try {
      // The frames have no network anyway (their CSP); this also stops the page itself from reaching out.
      await context.route('**/*', (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`${origin}/preview`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.decktechPreview !== undefined, undefined, {
        timeout: 15_000,
      });
      const assets = Object.fromEntries(
        [...request.assets].map(([id, bytes]) => [id, toBase64(bytes)]),
      );
      await page.evaluate((r) => window.decktechPreview!.show(r), {
        deck: request.deck,
        slideId: request.slideId,
        assets,
        width,
      });
      await page.waitForTimeout(request.settleMs);
      const report = (await page.evaluate(() => window.decktechPreview!.report())) as PreviewReport;
      const box = await page.locator('app-slide-renderer').boundingBox();
      if (!box) throw new ToolError('The slide was not drawn');
      let clip = { x: box.x, y: box.y, width: box.width, height: box.height };
      if (request.elementId !== undefined) {
        const slide = request.deck.slides.find((s) => s.id === request.slideId);
        const element = slide?.elements.find((e) => e.id === request.elementId);
        if (!element)
          throw new ToolError(
            `Element "${request.elementId}" is not on slide "${request.slideId}"`,
          );
        const k = width / stage.width;
        const x = Math.max(0, element.x * k);
        const y = Math.max(0, element.y * k);
        clip = {
          x: box.x + x,
          y: box.y + y,
          width: Math.max(1, Math.min(element.w * k, box.width - x)),
          height: Math.max(1, Math.min(element.h * k, box.height - y)),
        };
      }
      const png = await page.screenshot({ clip, type: 'png' });
      return {
        png: new Uint8Array(png),
        width: Math.round(clip.width),
        height: Math.round(clip.height),
        report,
      };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(
        `The preview failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      );
    } finally {
      clearTimeout(timer);
      await context.close().catch(() => undefined);
    }
  }
}
