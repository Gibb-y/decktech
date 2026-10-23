import { z } from 'zod';
import {
  BUILT_IN_LAYOUTS,
  BUILT_IN_THEMES,
  DEFAULT_VALIDATION_OPTIONS,
  ELEMENT_SCHEMAS,
  STAGE_HEIGHT,
  STAGE_WIDTH,
} from '../../src/app/core/model';
import guide from '../guide.md';
import { defineTool } from '../tool';

const TOPICS = [
  'guide',
  'overview',
  'elements',
  'layouts',
  'themes',
  'component-api',
  'limits',
] as const;

const COMPONENT_API = {
  summary:
    'A code component is a web page in a sandboxed iframe (opaque origin, no network unless the "network" permission is granted and allowed). It is drawn on the 1920x1080 stage, scaled to fit. The script is an ES module; a global `deck` object is injected.',
  html: 'Markup for the frame body, e.g. <div id="app"></div>. No inline <script> or inline event attributes (content security policy).',
  css: 'Plain CSS. Theme variables: --deck-color-<token> (background, text, muted, accent), --deck-font-<key> (heading, body, mono).',
  js: [
    'deck.ready(({ props, theme, mode, size }) => { ... })  // start here; mode is "edit", "present" or "thumbnail"',
    'deck.onProps((props) => { ... })                         // props changed in the editor',
    'deck.steps(n) / deck.onStep((i) => { ... })              // take part in presenter steps',
    'deck.state.get(key) / deck.state.set(key, value)         // small persisted JSON state per instance',
    'deck.assets.url(name)                                    // blob: URL of a deck asset the component lists in files',
    'deck.log(...)                                            // forwarded to the editor console',
    'deck.fetch(url, init)                                    // only with the "network" permission',
  ],
  propSchema:
    'Array of { key, type: string|number|boolean|color|asset, label, default, min?, max? } or { key, type: "select", label, options: [{ value, label }], default }. Instances store values under the same keys; a stored value that does not fit the declared type falls back to the default.',
  tips: [
    'Make the component read its size from the frame (it is 1920x1080 scaled), not from window.innerWidth.',
    'Use theme variables instead of hard-coded colours so the deck theme restyles the component, and keep text contrast at WCAG AA (4.5:1).',
    'Give the root element a role/aria-label if it conveys information (WCAG AA is a project requirement).',
    'Code written here is untrusted until the person opening the deck accepts it in the trust dialog; validate_component reads the code but never runs it.',
  ],
};

export const schemaTools = [
  defineTool({
    name: 'describe_schema',
    title: 'Describe the deck format',
    description:
      'Explains the deck model so you can write correct input: "overview" (stage, workflow), "elements" (fields of every element type), "layouts" (built-in layouts and placeholders), "themes" (colour tokens, fonts, type scale), "component-api" (how to write a code component), "limits". Call it with topic "component-api" before create_component.',
    input: z.object({ topic: z.enum(TOPICS).default('overview') }),
    readOnly: true,
    run(_workspace, { topic }) {
      switch (topic) {
        case 'guide':
          return guide;
        case 'overview':
          return {
            stage: {
              width: STAGE_WIDTH,
              height: STAGE_HEIGHT,
              note: 'All positions and sizes are in these logical units, origin top-left.',
            },
            workflow: [
              'create_deck (or open_deck) -> deckId',
              'add_slide with a layoutId, then set_text / add_text / add_image / add_shape',
              'create_component -> insert_code_element for interactive or custom visuals',
              'check_accessibility, set_alt_text, set_speaker_notes',
              'export_deck to a .deck file; DeckTech asks the person to review any code before it runs',
            ],
            topics: TOPICS,
            guide:
              'Call describe_schema with topic "guide" for the workflow, accessibility rules, how to write code components and how to read errors.',
            elementTypes: Object.keys(ELEMENT_SCHEMAS),
            zOrder:
              'The element order of a slide is stacking order, DOM order and reading order. Later = in front.',
          };
        case 'elements':
          return Object.fromEntries(
            Object.entries(ELEMENT_SCHEMAS).map(([type, schema]) => [
              type,
              { fields: schema.fields, defaults: schema.defaults },
            ]),
          );
        case 'layouts':
          return BUILT_IN_LAYOUTS.map((l) => ({
            id: l.id,
            name: l.name,
            placeholders: l.placeholders.map(({ kind, x, y, w, h }) => ({ kind, x, y, w, h })),
          }));
        case 'themes':
          return BUILT_IN_THEMES.map((t) => ({
            id: t.id,
            name: t.name,
            ...t.theme,
            note: 'Elements refer to colours as { token } and sizes by sizeToken, so a theme switch restyles them.',
          }));
        case 'component-api':
          return COMPONENT_API;
        case 'limits': {
          const { allowedMimeTypes: _mimes, ...limits } = DEFAULT_VALIDATION_OPTIONS;
          return {
            ...limits,
            imageTypes: ['png', 'jpeg', 'gif', 'webp', 'avif', 'svg'],
            maxComponentSourceChars: 1_000_000,
          };
        }
      }
    },
  }),
];
