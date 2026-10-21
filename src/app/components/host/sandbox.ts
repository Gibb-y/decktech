/**
 * The sandbox policy of a code component frame (arc42 §8.2, ADR-001). `allow-scripts` alone gives
 * the frame an opaque origin: no host DOM, cookies, localStorage or IndexedDB. Everything else is
 * absent on purpose; in particular the same-origin flag would let the frame remove its own sandbox.
 */
export const SANDBOX_TOKENS: readonly string[] = ['allow-scripts'];

/** Tokens that must never appear. A test and `npm run lint:boundaries` both check this list. */
export const FORBIDDEN_SANDBOX_TOKENS: readonly string[] = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals',
  'allow-downloads',
  'allow-presentation',
  'allow-pointer-lock',
  'allow-orientation-lock',
];

/** Throws if `tokens` is anything but the approved list. */
export function assertSafeSandbox(tokens: readonly string[]): void {
  const forbidden = tokens.filter((token) => FORBIDDEN_SANDBOX_TOKENS.includes(token));
  if (forbidden.length > 0) throw new Error(`Unsafe sandbox flag: ${forbidden.join(', ')}`);
  if (tokens.length !== SANDBOX_TOKENS.length || tokens.some((token, i) => token !== SANDBOX_TOKENS[i])) {
    throw new Error(`Sandbox must be exactly "${SANDBOX_TOKENS.join(' ')}"`);
  }
}

/**
 * Creates the frame element. It is built here, not in an Angular template, because Angular
 * refuses to bind `sandbox` and sanitises `srcdoc` (which would strip the scripts).
 */
export function createSandboxFrame(doc: Document, srcdoc: string, title: string): HTMLIFrameElement {
  assertSafeSandbox(SANDBOX_TOKENS);
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', SANDBOX_TOKENS.join(' '));
  // No camera, microphone, geolocation, fullscreen, ... (arc42 §8.2).
  frame.setAttribute('allow', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', title);
  frame.srcdoc = srcdoc;
  return frame;
}
