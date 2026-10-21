import type { ComponentDef } from '../../core/model';

/** Id of the built-in counter; fixed so a deck that uses it keeps one definition. */
export const COUNTER_COMPONENT_ID = 'cp_builtin-counter';

/**
 * The example component of the host (arc42 §5.3, `ComponentLibrary`): a button that counts. It
 * starts from the `start` prop, keeps the count in `deck.state` (so it survives reloads of the
 * frame and of the app) and follows the `label` prop and the theme.
 */
export const COUNTER_COMPONENT: ComponentDef = {
  id: COUNTER_COMPONENT_ID,
  name: 'Counter',
  html: '<div id="app"><button id="inc" type="button"></button> <output id="n"></output></div>',
  css: `#app { display: flex; align-items: center; gap: 32px; height: 100%; justify-content: center; font: 64px var(--deck-font-body); color: var(--deck-color-text); }
#inc { font: inherit; padding: 8px 32px; }
#n { min-width: 3ch; text-align: center; }`,
  js: `deck.ready(({ props }) => {
  const button = document.getElementById('inc');
  const output = document.getElementById('n');
  let n = deck.state.get('n') ?? props.start;
  const render = () => { output.textContent = String(n); };
  button.textContent = props.label;
  button.onclick = () => { n++; deck.state.set('n', n); render(); };
  deck.onProps((next) => { button.textContent = next.label; });
  render();
});`,
  propSchema: [
    { key: 'start', type: 'number', label: 'Start value', default: 0, min: -1000000, max: 1000000 },
    { key: 'label', type: 'string', label: 'Button label', default: 'Add one' },
  ],
  permissions: [],
  files: [],
  libs: [],
};
