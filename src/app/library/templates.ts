import { err, generateId, validateDeck, type Deck, type Result } from '../core/model';

export interface DeckTemplate {
  id: string;
  name: string;
  description: string;
  /** Deck JSON as it would be stored; `instantiateTemplate` gives it a fresh deck id and checks it. */
  deck: unknown;
}

const LAYOUT = { id: 'ly_blank', name: 'Blank', placeholders: [] };

const THEME = {
  colors: { background: '#ffffff', text: '#111111', accent: '#2457d6' },
  fonts: { heading: 'sans-serif', body: 'sans-serif', mono: 'monospace' },
  typeScale: { title: 96, heading: 64, body: 40, caption: 28 },
  spacing: { sm: 16, md: 32, lg: 64 },
};

const geometry = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

function text(id: string, box: [number, number, number, number], content: string, fontSize: number, font?: string, align = 'left') {
  return { id, type: 'text', ...geometry(...box), text: content, ...(font ? { font } : {}), fontSize, color: { token: 'text' }, align };
}

function deck(title: string, slides: { id: string; elements: unknown[] }[]) {
  return {
    schemaVersion: 1,
    id: 'dk_template',
    title,
    stage: { width: 1920, height: 1080 },
    theme: THEME,
    layouts: [LAYOUT],
    slides: slides.map((s) => ({ ...s, layoutId: LAYOUT.id, notes: '' })),
    assets: {},
    components: [],
  };
}

export const BUILT_IN_TEMPLATES: readonly DeckTemplate[] = [
  {
    id: 'title-and-bullets',
    name: 'Title and bullets',
    description: 'A title slide followed by a slide with a heading and a bullet list.',
    deck: deck('Title and bullets', [
      {
        id: 'sl_title',
        elements: [
          text('el_title', [160, 380, 1600, 160], 'Presentation title', 96, 'heading', 'center'),
          text('el_subtitle', [160, 580, 1600, 100], 'Subtitle or presenter', 40, undefined, 'center'),
        ],
      },
      {
        id: 'sl_bullets',
        elements: [
          text('el_heading', [120, 100, 1680, 120], 'Heading', 64, 'heading'),
          text('el_list', [120, 260, 1680, 640], '- First point\n- Second point\n- Third point', 40),
        ],
      },
    ]),
  },
  {
    id: 'section-divider',
    name: 'Sections',
    description: 'Three section dividers with room for notes.',
    deck: deck('Sections', [
      { id: 'sl_one', elements: [text('el_one', [160, 420, 1600, 160], '1. First section', 96, 'heading')] },
      { id: 'sl_two', elements: [text('el_two', [160, 420, 1600, 160], '2. Second section', 96, 'heading')] },
      { id: 'sl_three', elements: [text('el_three', [160, 420, 1600, 160], '3. Third section', 96, 'heading')] },
    ]),
  },
  {
    id: 'big-statement',
    name: 'Big statement',
    description: 'A single bold statement on an accent background.',
    deck: {
      ...deck('Big statement', [
        { id: 'sl_statement', elements: [{ ...text('el_statement', [160, 340, 1600, 400], 'One idea per slide', 96, 'heading', 'center'), color: '#ffffff' }] },
      ]),
      layouts: [{ ...LAYOUT, background: { kind: 'solid', color: { token: 'accent' } } }],
    },
  },
];

/** A new deck from `template` (own deck id, so every use is a separate deck); fails if the template is malformed. */
export function instantiateTemplate(template: DeckTemplate): Result<Deck, string> {
  const copy: unknown = structuredClone(template.deck);
  if (typeof copy !== 'object' || copy === null) return err('template is not an object');
  (copy as { id: string }).id = generateId('deck');
  const checked = validateDeck(copy);
  if (checked.ok) return checked;
  return err(`template "${template.id}" is invalid: ${checked.error.map((e) => e.message).join('; ')}`);
}
