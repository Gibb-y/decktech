import type { Fetcher } from '../src/app/components/editor/vendor';

/**
 * A stand-in for React that keeps the property that matters here: hooks only work when
 * the renderer and the component use the SAME copy of the library (a module-level "current
 * component"). The tests run offline, so the CDN is faked with these files.
 */
export const MINI_REACT = `
let current = null;
export const __internals = { enter(c) { current = c; }, leave() { current = null; } };
export function createElement(type, props, ...children) { return { type, props: props || {}, children }; }
export function useState(initial) {
  if (current === null) throw new Error('Invalid hook call. Hooks can only be called inside of the body of a function component.');
  const c = current;
  const i = c.index++;
  if (!(i in c.state)) c.state[i] = initial;
  return [c.state[i], (value) => { c.state[i] = value; c.rerender(); }];
}
export default { createElement, useState };
`;

/** The renderer: imports React from a CDN path, like the bundle esm.sh serves for react-dom/client. */
export const MINI_REACT_DOM = `
import { __internals } from "/react@1.0.0/es2022/react.mjs";
function build(node) {
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
  const el = document.createElement(node.type);
  for (const [key, value] of Object.entries(node.props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value);
  }
  for (const child of node.children) el.append(build(child));
  return el;
}
export function createRoot(container) {
  return {
    render(component) {
      const instance = { index: 0, state: {}, rerender() { draw(); } };
      const draw = () => {
        instance.index = 0;
        __internals.enter(instance);
        let tree;
        try { tree = component(); } finally { __internals.leave(); }
        container.replaceChildren(build(tree));
      };
      draw();
    },
  };
}
`;

/** A renderer with its own copy of React inlined (what a bundle without peers looks like): hooks from the other copy cannot work. */
export const MINI_REACT_DOM_WITH_OWN_REACT = MINI_REACT.replace('export default { createElement, useState };', '') +
  MINI_REACT_DOM.replace('import { __internals } from "/react@1.0.0/es2022/react.mjs";', '');

export const REACT_COUNTER_JS = `
import React from "react";
import { createRoot } from "react-dom/client";
deck.ready(({ props }) => {
  const h = React.createElement;
  function Counter() {
    const [n, setN] = React.useState(props.start);
    deck.log("count " + n);
    return h("button", { onClick: () => setN(n + 1) }, "Clicked " + n);
  }
  createRoot(document.getElementById("app")).render(Counter);
  document.querySelector("button").click();
});
`;

export interface FakeCdn {
  fetcher: Fetcher;
  /** Addresses that were asked for, in order. */
  calls: string[];
}

const response = (body: string, status = 200): Awaited<ReturnType<Fetcher>> => ({
  ok: status === 200,
  status,
  headers: { get: (name: string) => (name === 'content-type' ? 'text/javascript' : null) },
  blob: async () => new Blob([body]),
});

/** Answers the addresses of `files` (full URL -> body) and 404 for anything else. */
export function fakeCdn(files: Record<string, string>): FakeCdn {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url) => {
      calls.push(url);
      return Object.hasOwn(files, url) ? response(files[url]) : response('', 404);
    },
  };
}

/** esm.sh as the tools see it: a stub per package address that re-exports one bundle file. */
export const REACT_CDN: Record<string, string> = {
  'https://esm.sh/react@1.0.0?bundle&target=es2022': 'export * from "/react@1.0.0/es2022/react.bundle.mjs";',
  'https://esm.sh/react@1.0.0/es2022/react.bundle.mjs': MINI_REACT,
  'https://esm.sh/react-dom@1.0.0/client?bundle&target=es2022': 'export * from "/react-dom@1.0.0/es2022/client.bundle.mjs";',
  'https://esm.sh/react-dom@1.0.0/es2022/client.bundle.mjs': MINI_REACT_DOM,
};
