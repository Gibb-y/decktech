import { err, ok, type Result } from '../../core/model';

/**
 * The wire protocol between the host and a code component frame (arc42 §8.3). The frame is
 * hostile by assumption, so everything it sends is parsed here into a closed set of typed
 * messages; whatever does not parse is dropped by the bridge and never reaches a capability.
 */

/** Current major version of the component API. The host also accepts the previous major. */
export const API_VERSION = 1;

/** Majors the host speaks: the current one and the one before it (arc42 §8.3, risk R6). */
export const supportedApiVersions = (current: number = API_VERSION): readonly number[] =>
  current > 1 ? [current - 1, current] : [current];

export const isSupportedApiVersion = (version: unknown): version is number =>
  typeof version === 'number' && Number.isInteger(version) && supportedApiVersions().includes(version);

export const BRIDGE_LIMITS = {
  /** Estimated JSON size of any message from the frame. */
  maxMessageBytes: 64 * 1024,
  /** Total JSON size of a component instance's persisted state. */
  maxStateBytes: 64 * 1024,
  maxStateKeys: 64,
  maxKeyLength: 64,
  maxLogArgs: 10,
  maxErrorLength: 4000,
  maxSnapshotBytes: 2 * 1024 * 1024,
  maxFetchResponseBytes: 5 * 1024 * 1024,
  maxPendingFetches: 4,
  maxPendingAssets: 8,
  maxStepCount: 1000,
  maxJsonDepth: 32,
  /** Messages accepted per window; the rest are dropped. */
  messagesPerWindow: 200,
  windowMs: 1000,
  /** Heartbeats accepted per window on top of the message budget. */
  heartbeatsPerWindow: 20,
  /** Dropped messages in one window that end the frame (a flood, not a busy component). */
  floodDrops: 1000,
  /** Malformed or unknown messages in one window that end the frame. */
  maxRejectsPerWindow: 50,
} as const;

export const SNAPSHOT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export const LOG_LEVELS = ['log', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FrameMessage =
  | { type: 'heartbeat' }
  | { type: 'steps'; count: number }
  | { type: 'state-set'; key: string; value: JsonValue }
  | { type: 'state-remove'; key: string }
  | { type: 'navigate'; action: 'next' | 'prev' }
  | { type: 'navigate'; action: 'goTo'; slideId: string }
  | { type: 'asset-request'; id: number; assetId: string }
  | { type: 'log'; level: LogLevel; args: JsonValue[] }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'snapshot'; blob: Blob }
  | { type: 'fetch'; id: number; url: string; init: FetchInit }
  | { type: 'link'; url: string };

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface LibPayload {
  /** Asset id; the bare specifier of the import map. */
  id: string;
  mime: string;
  data: ArrayBuffer;
}

export type HostMessage =
  | {
      type: 'init';
      apiVersion: number;
      props: Record<string, unknown>;
      /** `--deck-*` custom properties, already checked by `themeVars`. */
      theme: Record<string, string>;
      mode: 'edit' | 'present';
      size: { w: number; h: number };
      state: Record<string, JsonValue>;
      libs: LibPayload[];
      /** The internal step the component should show (0 when none was requested). */
      step?: number;
      permissions: { network: boolean };
    }
  | { type: 'props'; props: Record<string, unknown> }
  | { type: 'theme'; theme: Record<string, string> }
  | { type: 'size'; size: { w: number; h: number } }
  | { type: 'step'; index: number }
  | { type: 'asset'; id: number; mime: string; data: ArrayBuffer | null }
  | { type: 'fetch-result'; id: number; ok: boolean; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null; error?: string };

const HOSTILE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

/**
 * Estimated size in bytes of a structured-clone payload that must be plain JSON, or `null` if it
 * is not: only null, booleans, finite numbers, strings, arrays and plain objects, nested at most
 * `maxDepth`, without hostile keys, and no larger than `maxBytes`. Walks the value once and stops
 * as soon as the budget is spent, so a cycle or a huge value costs at most the cap.
 */
export function measureJson(value: unknown, maxBytes: number, maxDepth: number = BRIDGE_LIMITS.maxJsonDepth): number | null {
  let bytes = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (depth > maxDepth) return null;
    if (current === null || typeof current === 'boolean') bytes += 4;
    else if (typeof current === 'number') {
      if (!Number.isFinite(current)) return null;
      bytes += 8;
    } else if (typeof current === 'string') bytes += current.length + 2;
    else if (Array.isArray(current)) {
      bytes += 2 + current.length;
      if (bytes > maxBytes) return null;
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
    } else if (typeof current === 'object') {
      const proto = Object.getPrototypeOf(current);
      if (proto !== Object.prototype && proto !== null) return null;
      bytes += 2;
      for (const key of Object.keys(current)) {
        if (HOSTILE_KEYS.has(key)) return null;
        bytes += key.length + 3;
        if (bytes > maxBytes) return null;
        stack.push({ value: (current as Record<string, unknown>)[key], depth: depth + 1 });
      }
    } else return null;
    if (bytes > maxBytes) return null;
  }
  return bytes;
}

type Fields = Record<string, unknown>;
type Parser = (data: Fields) => Result<FrameMessage, string>;

const isPlain = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const KEY = /^[^\u0000-\u001f]{1,64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const int = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const str = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const stateKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value) && !HOSTILE_KEYS.has(value);

/** Fails if `data` has a field other than `allowed` (plus `type`). */
function onlyKeys(data: Fields, allowed: readonly string[]): string | null {
  for (const key of Object.keys(data)) if (key !== 'type' && !allowed.includes(key)) return `unexpected field "${key}"`;
  return null;
}

const parser =
  (allowed: readonly string[], build: (data: Fields) => Result<FrameMessage, string>): Parser =>
  (data) => {
    const extra = onlyKeys(data, allowed);
    return extra ? err(extra) : build(data);
  };

const FRAME_MESSAGES: Record<string, Parser> = {
  heartbeat: parser([], () => ok({ type: 'heartbeat' })),
  steps: parser(['count'], (d) =>
    int(d['count'], 0, BRIDGE_LIMITS.maxStepCount) ? ok({ type: 'steps', count: d['count'] }) : err('steps.count must be a whole number from 0 to 1000'),
  ),
  'state-set': parser(['key', 'value'], (d) =>
    stateKey(d['key']) && hasOwn(d, 'value') ? ok({ type: 'state-set', key: d['key'], value: d['value'] as JsonValue }) : err('state-set needs a key of 1 to 64 characters and a value'),
  ),
  'state-remove': parser(['key'], (d) => (stateKey(d['key']) ? ok({ type: 'state-remove', key: d['key'] }) : err('state-remove needs a key of 1 to 64 characters'))),
  navigate: parser(['action', 'slideId'], (d) => {
    if (d['action'] === 'next' || d['action'] === 'prev') return hasOwn(d, 'slideId') ? err('navigate.slideId only goes with goTo') : ok({ type: 'navigate', action: d['action'] });
    if (d['action'] === 'goTo') return typeof d['slideId'] === 'string' && ID.test(d['slideId']) ? ok({ type: 'navigate', action: 'goTo', slideId: d['slideId'] }) : err('navigate.slideId must be a slide id');
    return err('navigate.action must be next, prev or goTo');
  }),
  'asset-request': parser(['id', 'assetId'], (d) =>
    int(d['id'], 0, Number.MAX_SAFE_INTEGER) && typeof d['assetId'] === 'string' && ID.test(d['assetId'])
      ? ok({ type: 'asset-request', id: d['id'], assetId: d['assetId'] })
      : err('asset-request needs a request id and an asset id'),
  ),
  log: parser(['level', 'args'], (d) => {
    const level = (LOG_LEVELS as readonly unknown[]).includes(d['level']) ? (d['level'] as LogLevel) : null;
    if (!level || !Array.isArray(d['args']) || d['args'].length > BRIDGE_LIMITS.maxLogArgs) return err('log needs a level and at most 10 arguments');
    return ok({ type: 'log', level, args: d['args'] as JsonValue[] });
  }),
  error: parser(['message', 'stack'], (d) => {
    if (!str(d['message'], BRIDGE_LIMITS.maxErrorLength)) return err('error.message must be a string of at most 4000 characters');
    if (hasOwn(d, 'stack') && !str(d['stack'], BRIDGE_LIMITS.maxErrorLength)) return err('error.stack must be a string of at most 4000 characters');
    return ok(hasOwn(d, 'stack') ? { type: 'error', message: d['message'], stack: d['stack'] as string } : { type: 'error', message: d['message'] });
  }),
  link: parser(['url'], (d) => (str(d['url'], 2048) ? ok({ type: 'link', url: d['url'] }) : err('link.url must be a string of at most 2048 characters'))),
  fetch: parser(['id', 'url', 'init'], (d) => {
    if (!int(d['id'], 0, Number.MAX_SAFE_INTEGER) || !str(d['url'], 2048)) return err('fetch needs a request id and a url');
    const init: FetchInit = {};
    if (hasOwn(d, 'init') && d['init'] !== undefined) {
      const raw = d['init'];
      if (!isPlain(raw)) return err('fetch.init must be an object');
      const extra = Object.keys(raw).find((key) => !['method', 'headers', 'body'].includes(key));
      if (extra) return err(`fetch.init has unexpected field "${extra}"`);
      if (hasOwn(raw, 'method')) {
        if (!str(raw['method'], 16)) return err('fetch.init.method must be a string');
        init.method = raw['method'];
      }
      if (hasOwn(raw, 'body')) {
        if (!str(raw['body'], BRIDGE_LIMITS.maxMessageBytes)) return err('fetch.init.body must be a string');
        init.body = raw['body'];
      }
      if (hasOwn(raw, 'headers')) {
        const headers = raw['headers'];
        if (!isPlain(headers)) return err('fetch.init.headers must be an object');
        const checked: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
          if (!str(name, 128) || !str(value, 1024)) return err('fetch.init.headers must map names to strings');
          checked[name] = value;
        }
        init.headers = checked;
      }
    }
    return ok({ type: 'fetch', id: d['id'], url: d['url'], init });
  }),
  snapshot: parser(['blob'], (d) => {
    const blob = d['blob'];
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) return err('snapshot.blob must be a Blob');
    if (!SNAPSHOT_TYPES.includes(blob.type)) return err('snapshot.blob must be a PNG, JPEG or WebP image');
    if (blob.size === 0 || blob.size > BRIDGE_LIMITS.maxSnapshotBytes) return err('snapshot.blob must be between 1 byte and 2 MiB');
    return ok({ type: 'snapshot', blob });
  }),
};

/**
 * Turns whatever arrived on the port into a `FrameMessage`. Unknown types (including inherited
 * names such as `toString`), extra fields, wrong types, oversized or non-JSON payloads and
 * hostile keys are all errors with a reason fit for the console.
 */
export function parseFrameMessage(data: unknown): Result<FrameMessage, string> {
  if (!isPlain(data)) return err('message must be an object');
  const type = data['type'];
  if (typeof type !== 'string' || !hasOwn(FRAME_MESSAGES, type)) return err('unknown message type');
  if (type === 'snapshot') {
    // A Blob is not JSON; the envelope is checked by the parser, the payload by its size.
    const rest = Object.keys(data).filter((key) => key !== 'blob');
    return rest.length === 1 && rest[0] === 'type' ? FRAME_MESSAGES[type](data) : err('unexpected field in snapshot');
  }
  if (measureJson(data, BRIDGE_LIMITS.maxMessageBytes) === null) return err('payload is not plain JSON within 64 KiB and 32 levels');
  return FRAME_MESSAGES[type](data);
}

/** Origins a component may reach: `https://host[:port]` or `http://localhost[:port]`, no path. */
export function normalizeOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  try {
    const url = new URL(origin);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password || url.hostname === '') return null;
    return url.origin;
  } catch {
    return null;
  }
}
