// Profiles dragging one element on the 100-element stress deck (quality scenario Q9, arc42 section 10.2).
//
//   npx ng serve --port 4300      # dev server: the /dev/stress route exists only in dev mode
//   node scripts/profile-drag.mjs http://localhost:4300/dev/stress [cpuThrottle=1] [drag|idle] [movesPerStep=1]
//
// Drives a headless Chromium browser (Edge or Chrome; set BROWSER to its path) over the DevTools
// protocol: opens the stress deck, drags an element along a path for 300 pointer moves with optional
// CPU throttling, and prints frame timing, long tasks and the main-thread cost per pointer move.
// Headless rendering is capped at 60 fps, so what to read is "no frame over 18.2 ms" (= 55 fps).
// Needs Node 22+ (global WebSocket and fetch) and no packages.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, throttleArg = '1', modeArg = 'drag', burstArg = '1'] = process.argv.slice(2);
const burst = Number(burstArg);
const throttle = Number(throttleArg);
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const edge = process.env.BROWSER ?? CANDIDATES.find((p) => existsSync(p));
if (!edge) throw new Error('No Chromium browser found; set BROWSER to its path');
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'edge-profile-'));
const proc = spawn(edge, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu-vsync', '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path, init) {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}${path}`, init)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('no devtools');
}

const target = await json('/json/new?about:blank', { method: 'PUT' });
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  // /dev/stress creates the deck and redirects to the editor.
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if ((await evaluate('document.querySelectorAll(".hit").length')) === 100) break;
  }
  const count = await evaluate('document.querySelectorAll(".hit").length');
  if (count !== 100) throw new Error(`expected 100 hit targets, found ${count}`);
  await sleep(1000);
  if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle });
  // Calibration: the same busy loop must take ~throttle times longer when throttling works.
  const busyMs = await evaluate('(() => { const s = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += i % 7; return performance.now() - s; })()');
  await send('Performance.enable');
  const m0 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await evaluate('window.__moves = 0; document.querySelector(".viewport").addEventListener("pointermove", () => window.__moves++)');

  await evaluate(`(() => {
    window.__dt = { frames: [], long: [], last: performance.now(), run: true };
    const tick = (t) => { if (!window.__dt.run) return; window.__dt.frames.push(t - window.__dt.last); window.__dt.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__dt.long.push(e.duration))).observe({ entryTypes: ['longtask'] });
  })()`);

  const rect = await evaluate(`(() => { const r = document.querySelectorAll('.hit')[11].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const steps = 300;
  const stepMs = 16;
  const started = Date.now();
  if (modeArg === 'drag') {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      // A wide, slow path across the slide.
      const x = rect.x + Math.sin(i / 30) * 120 + i * 0.5;
      const y = rect.y + Math.cos(i / 25) * 60;
      for (let b = 0; b < burst; b++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + b * 0.1, y, button: 'left', buttons: 1 });
      await sleep(stepMs);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  } else {
    await sleep(steps * stepMs);
  }
  const elapsed = (Date.now() - started) / 1000;
  const m1 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const moves = await evaluate('window.__moves');
  const per = (k) => Number((((m1[k] - m0[k]) * 1000) / Math.max(moves, 1)).toFixed(2));
  const data = await evaluate('window.__dt.run = false, ({ frames: window.__dt.frames, long: window.__dt.long })');
  const frames = data.frames.slice(1).sort((a, b) => a - b);
  const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
  const over = frames.filter((f) => f > 1000 / 55).length;
  const result = {
    mode: modeArg,
    movesPerStep: burst,
    cpuThrottle: throttle,
    seconds: Number(elapsed.toFixed(1)),
    frames: frames.length,
    fps: Number((frames.length / elapsed).toFixed(1)),
    frameMs: { p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1), max: +frames[frames.length - 1].toFixed(1) },
    framesOver18_2ms: `${over} (${((over / frames.length) * 100).toFixed(1)}%)`,
    longTasks: { count: data.long.length, maxMs: data.long.length ? Math.round(Math.max(...data.long)) : 0 },
    busyLoopMs: Math.round(busyMs),
    pointerMovesSeen: moves,
    msPerMove: { script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration'), task: per('TaskDuration') },
    moved: modeArg === 'drag' ? await evaluate(`(() => { const r = document.querySelectorAll('.hit')[11].getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`) : null,
    startedAt: modeArg === 'drag' ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  ws.close();
  proc.kill();
}
