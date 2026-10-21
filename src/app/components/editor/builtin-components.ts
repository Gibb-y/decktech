import type { ComponentDef } from '../../core/model';
import { COUNTER_COMPONENT } from '../host/examples';

/** Ids are fixed, so a deck that uses a built-in example keeps one shared definition. */
const base = { permissions: [], files: [], libs: [] } satisfies Pick<ComponentDef, 'permissions' | 'files' | 'libs'>;

const FRAME_CSS = `html, body { margin: 0; height: 100%; }
body { font: 40px var(--deck-font-body); color: var(--deck-color-text); }`;

/** A bar chart drawn from a `label:value` list; no library, so it works offline and inside the sandbox as is. */
export const CHART_COMPONENT: ComponentDef = {
  ...base,
  id: 'cp_builtin-chart',
  name: 'Bar chart',
  html: '<figure id="chart"><figcaption id="caption"></figcaption><svg id="plot" role="img" aria-labelledby="caption" viewBox="0 0 800 400" preserveAspectRatio="xMidYMid meet"></svg></figure>',
  css: `${FRAME_CSS}
#chart { margin: 0; height: 100%; display: flex; flex-direction: column; }
#caption { font-size: 48px; text-align: center; padding: 8px; }
#plot { flex: 1; min-height: 0; width: 100%; }
#plot text { font: 20px var(--deck-font-body); fill: currentColor; }`,
  js: `const NS = 'http://www.w3.org/2000/svg';
function parse(text) {
  return String(text).split(',').map((part) => {
    const [label, value] = part.split(':');
    return { label: (label || '').trim(), value: Number(value) };
  }).filter((row) => row.label && Number.isFinite(row.value) && row.value >= 0).slice(0, 24);
}
function draw(props) {
  const rows = parse(props.data);
  const plot = document.getElementById('plot');
  document.getElementById('caption').textContent = props.title;
  plot.replaceChildren();
  const max = Math.max(1, ...rows.map((row) => row.value));
  const slot = 760 / Math.max(1, rows.length);
  rows.forEach((row, i) => {
    const height = (row.value / max) * 300;
    const bar = document.createElementNS(NS, 'rect');
    bar.setAttribute('x', String(20 + i * slot + slot * 0.1));
    bar.setAttribute('y', String(340 - height));
    bar.setAttribute('width', String(slot * 0.8));
    bar.setAttribute('height', String(height));
    bar.setAttribute('fill', props.color);
    const name = document.createElementNS(NS, 'text');
    name.setAttribute('x', String(20 + i * slot + slot / 2));
    name.setAttribute('y', '372');
    name.setAttribute('text-anchor', 'middle');
    name.textContent = row.label;
    const amount = document.createElementNS(NS, 'text');
    amount.setAttribute('x', String(20 + i * slot + slot / 2));
    amount.setAttribute('y', String(332 - height));
    amount.setAttribute('text-anchor', 'middle');
    amount.textContent = String(row.value);
    plot.append(bar, name, amount);
  });
  plot.setAttribute('aria-label', rows.map((row) => row.label + ' ' + row.value).join(', '));
}
deck.ready(({ props }) => {
  draw(props);
  deck.onProps(draw);
});`,
  propSchema: [
    { key: 'title', type: 'string', label: 'Title', default: 'Sales per quarter' },
    { key: 'data', type: 'string', label: 'Data (label:value, comma separated)', default: 'Q1:12, Q2:18, Q3:9, Q4:24' },
    { key: 'color', type: 'color', label: 'Bar colour', default: '#2563eb' },
  ],
};

/** Shows a style sheet taking effect while it is edited; a small demo of live code in a slide. */
export const LIVE_DEMO_COMPONENT: ComponentDef = {
  ...base,
  id: 'cp_builtin-live-demo',
  name: 'Live code demo',
  html: '<div id="demo"><label for="src">CSS for the box</label><textarea id="src" rows="5" spellcheck="false"></textarea><div id="box">Box</div></div>',
  css: `${FRAME_CSS}
#demo { display: grid; gap: 16px; padding: 24px; height: 100%; box-sizing: border-box; grid-template-rows: auto 1fr 1fr; }
#src { font: 28px var(--deck-font-mono); }
#box { display: grid; place-items: center; }`,
  js: `const STYLE = document.createElement('style');
document.head.append(STYLE);
const box = document.getElementById('box');
const src = document.getElementById('src');
function apply(css) {
  STYLE.textContent = '#box { ' + css.replace(/[{}]/g, '') + ' }';
}
deck.ready(({ props }) => {
  src.value = deck.state.get('css') ?? props.css;
  apply(src.value);
  src.addEventListener('input', () => { apply(src.value); deck.state.set('css', src.value); });
  deck.onProps((next) => { if (deck.state.get('css') === undefined) { src.value = next.css; apply(next.css); } });
  box.textContent = props.label;
});`,
  propSchema: [
    { key: 'css', type: 'string', label: 'Starting CSS', default: 'background: #f59e0b; color: #111; border-radius: 24px; font-size: 48px;' },
    { key: 'label', type: 'string', label: 'Box text', default: 'Edit the CSS above' },
  ],
};

/** A multiple choice question; the choice is kept in `deck.state` and announced to assistive technology. */
export const QUIZ_COMPONENT: ComponentDef = {
  ...base,
  id: 'cp_builtin-quiz',
  name: 'Quiz',
  html: '<section id="quiz"><h2 id="q"></h2><div id="options" role="group" aria-labelledby="q"></div><p id="result" role="status"></p></section>',
  css: `${FRAME_CSS}
#quiz { padding: 24px; }
h2 { margin: 0 0 24px; font-size: 56px; }
#options { display: grid; gap: 12px; }
button { font: inherit; text-align: left; padding: 12px 24px; cursor: pointer; }
button[aria-pressed="true"] { outline: 4px solid currentColor; }
#result { min-height: 1.5em; font-weight: bold; }`,
  js: `function setup(props) {
  const options = props.options.split('\\n').map((line) => line.trim()).filter(Boolean).slice(0, 8);
  const correct = Math.round(props.answer) - 1;
  const list = document.getElementById('options');
  const result = document.getElementById('result');
  document.getElementById('q').textContent = props.question;
  list.replaceChildren();
  const show = (choice) => {
    [...list.children].forEach((button, i) => button.setAttribute('aria-pressed', String(i === choice)));
    result.textContent = choice === undefined ? '' : choice === correct ? 'Correct!' : 'Not quite.';
  };
  options.forEach((text, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () => { deck.state.set('choice', i); show(i); });
    list.append(button);
  });
  show(deck.state.get('choice'));
}
deck.ready(({ props }) => {
  setup(props);
  deck.onProps(setup);
});`,
  propSchema: [
    { key: 'question', type: 'string', label: 'Question', default: 'Which element holds a slide title?' },
    { key: 'options', type: 'string', label: 'Choices (one per line)', default: 'h1\nfooter\nimg' },
    { key: 'answer', type: 'number', label: 'Correct choice (1 is the first)', default: 1, min: 1, max: 8 },
  ],
};

/** A poll that counts votes made on this machine; the tally is part of the instance's `deck.state`. */
export const POLL_COMPONENT: ComponentDef = {
  ...base,
  id: 'cp_builtin-poll',
  name: 'Poll',
  html: '<section id="poll"><h2 id="q"></h2><ul id="rows"></ul></section>',
  css: `${FRAME_CSS}
#poll { padding: 24px; }
h2 { margin: 0 0 24px; font-size: 56px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
li { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; position: relative; }
button { font: inherit; text-align: left; padding: 12px 24px; cursor: pointer; background: color-mix(in srgb, currentColor 12%, transparent); border: 0; color: inherit; }
.bar { position: absolute; inset: 0 auto 0 0; background: var(--deck-color-accent, #2563eb); opacity: 0.35; pointer-events: none; }
output { min-width: 2ch; text-align: right; }`,
  js: `function setup(props) {
  const choices = props.options.split('\\n').map((line) => line.trim()).filter(Boolean).slice(0, 8);
  const votes = choices.map((_, i) => Number((deck.state.get('votes') || [])[i]) || 0);
  const rows = document.getElementById('rows');
  document.getElementById('q').textContent = props.question;
  const render = () => {
    const total = Math.max(1, votes.reduce((a, b) => a + b, 0));
    rows.replaceChildren();
    choices.forEach((text, i) => {
      const item = document.createElement('li');
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.width = Math.round((votes[i] / total) * 100) + '%';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', () => { votes[i]++; deck.state.set('votes', votes); render(); });
      const count = document.createElement('output');
      count.textContent = String(votes[i]);
      item.append(bar, button, count);
      rows.append(item);
    });
  };
  render();
}
deck.ready(({ props }) => {
  setup(props);
  deck.onProps(setup);
});`,
  propSchema: [
    { key: 'question', type: 'string', label: 'Question', default: 'Where should we go for lunch?' },
    { key: 'options', type: 'string', label: 'Choices (one per line)', default: 'Pizza\nSushi\nSalad' },
  ],
};

/**
 * A card for a web page. A frame may not load other pages (its policy has no `frame-src`, 8.2), so
 * the card offers the address instead: the button asks the host, which confirms before opening a tab.
 */
export const EMBED_COMPONENT: ComponentDef = {
  ...base,
  id: 'cp_builtin-embed',
  name: 'Web page link',
  html: '<a id="card" href="#"><span id="title"></span><span id="host"></span></a>',
  css: `${FRAME_CSS}
#card { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; height: 100%; color: inherit; text-decoration: none; border: 4px solid currentColor; box-sizing: border-box; padding: 24px; }
#title { font-size: 64px; font-weight: bold; }
#host { text-decoration: underline; }`,
  js: `function setup(props) {
  const card = document.getElementById('card');
  let host = props.url;
  try { host = new URL(props.url).host; } catch { /* shown as typed */ }
  document.getElementById('title').textContent = props.title;
  document.getElementById('host').textContent = host;
  card.href = props.url;
  card.target = '_blank';
}
deck.ready(({ props }) => {
  setup(props);
  deck.onProps(setup);
});`,
  propSchema: [
    { key: 'title', type: 'string', label: 'Title', default: 'Open the demo' },
    { key: 'url', type: 'string', label: 'Address (https://…)', default: 'https://example.com/' },
  ],
};

/** What the library offers before the author has saved anything, in the order shown. */
export const BUILT_IN_COMPONENTS: readonly ComponentDef[] = [
  COUNTER_COMPONENT,
  CHART_COMPONENT,
  LIVE_DEMO_COMPONENT,
  QUIZ_COMPONENT,
  POLL_COMPONENT,
  EMBED_COMPONENT,
];
