import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  AA_TEXT_CONTRAST,
  DEFAULT_VALIDATION_OPTIONS,
  contrastRatio,
  createElement,
  plainToRich,
  relativeLuminance,
  type Color,
  type Deck,
  type Element,
  type Fill,
} from '../../src/app/core/model';
import { assetRef, sha256Hex } from '../../src/app/core/persistence/assets';
import { AddAsset, AddElement, DeleteElements, ReorderElements, ResizeElements, SetProps, SetText } from '../../src/app/core/store/commands';
import { MIME_EXTENSIONS } from '../../src/app/library/archive/format';
import { contentProblem } from '../../src/app/library/archive/sniff';
import { resolveInside } from '../paths';
import { elementOf, elementSummary, slideOf } from '../summary';
import { ToolError, defineTool } from '../tool';
import { deckId } from './deck';

const slideId = z.string().describe('Id of a slide (see get_deck).');
const elementId = z.string().describe('Id of an element (see get_deck).');

const geometry = {
  x: z.number().optional().describe('Left edge on the 1920x1080 stage.'),
  y: z.number().optional().describe('Top edge on the 1920x1080 stage.'),
  w: z.number().min(0).optional().describe('Width.'),
  h: z.number().min(0).optional().describe('Height.'),
};

const color = z
  .string()
  .min(1)
  .max(100)
  .describe('A theme colour token (background, text, muted, accent or a custom one) or a CSS colour such as #336699, rgb(...) or a keyword.');

/** A theme token name stays a token (so the theme can restyle it), anything else is a literal colour. */
const toColor = (deck: Deck, value: string): Color => (Object.hasOwn(deck.theme.colors, value) ? { token: value } : value);

const toFill = (deck: Deck, value: string): Fill => ({ kind: 'solid', color: toColor(deck, value) });

/** Only the fields that were given, so defaults of `createElement` survive. */
const given = <T extends object>(values: T): Partial<T> => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;

const ROLE_TOKENS = { title: 'title', heading: 'heading', body: 'body', caption: 'caption' } as const;

/** File extensions an agent may use for images; the mime type must be on the deck's allow-list. */
const IMAGE_MIMES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function resolvedColor(deck: Deck, value: Color | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : deck.theme.colors[value.token];
}

/** WCAG problems the model can see without rendering: missing alt text, empty text, text colour against the background. */
export function accessibilityProblems(deck: Deck) {
  const problems: { slideId: string; elementId?: string; problem: string }[] = [];
  deck.slides.forEach((slide, index) => {
    const label = `Slide ${index + 1}`;
    const background = slide.background?.kind === 'solid' ? resolvedColor(deck, slide.background.color) : slide.background === undefined ? deck.theme.colors['background'] : undefined;
    for (const e of slide.elements) {
      if (e.type === 'image' && e.alt.trim() === '') problems.push({ slideId: slide.id, elementId: e.id, problem: `${label}: image has no alt text. Use set_alt_text.` });
      if (e.type === 'text' && e.text.trim() === '') problems.push({ slideId: slide.id, elementId: e.id, problem: `${label}: text element is empty.` });
      if (e.type === 'text' && e.text.trim() !== '' && background !== undefined && !e.hidden) {
        const text = resolvedColor(deck, e.color);
        if (text !== undefined && relativeLuminance(text) !== null && relativeLuminance(background) !== null) {
          const ratio = contrastRatio(text, background);
          if (ratio < AA_TEXT_CONTRAST) {
            problems.push({ slideId: slide.id, elementId: e.id, problem: `${label}: text contrast is ${ratio.toFixed(2)}:1 against the slide background; WCAG AA needs ${AA_TEXT_CONTRAST}:1.` });
          }
        }
      }
    }
  });
  return problems;
}

export const elementTools = [
  defineTool({
    name: 'add_text',
    title: 'Add text',
    description:
      'Adds a text box. Lines starting with "- " become a bullet list. role sets the size from the theme type scale (title 96, heading 64, body 40, caption 28); the colour defaults to the theme text colour. Use set_text to change the text of an existing element, including the sample text in placeholders.',
    input: z.object({
      deckId,
      slideId,
      text: z.string().max(100_000),
      role: z.enum(['title', 'heading', 'body', 'caption']).default('body'),
      align: z.enum(['left', 'center', 'right']).optional(),
      color: color.optional(),
      ...geometry,
    }),
    run(workspace, { deckId, slideId, text, role, align, color: c, x, y, w, h }) {
      const session = workspace.get(deckId);
      const { deck } = session;
      slideOf(deck, slideId);
      const token = ROLE_TOKENS[role];
      const element = createElement('text', {
        ...given({ x, y, w, h, align }),
        ...(Object.hasOwn(deck.theme.typeScale, token) ? { sizeToken: token, fontSize: deck.theme.typeScale[token] } : {}),
        ...(Object.hasOwn(deck.theme.fonts, 'heading') && (role === 'title' || role === 'heading') ? { font: 'heading' } : {}),
        ...(c !== undefined ? { color: toColor(deck, c) } : {}),
      });
      const next = session.apply('AddText', new AddElement(slideId, element), new SetText(element.id, plainToRich(text, role === 'title' || role === 'heading')));
      return elementSummary(elementOf(next, element.id).element);
    },
  }),

  defineTool({
    name: 'set_text',
    title: 'Set text',
    description: 'Replaces the text of a text element. Lines starting with "- " become a bullet list. Use heading: true for a title or heading (one heading paragraph).',
    input: z.object({ deckId, elementId, text: z.string().max(100_000), heading: z.boolean().default(false) }),
    run(workspace, { deckId, elementId, text, heading }) {
      const session = workspace.get(deckId);
      const next = session.apply('SetText', new SetText(elementId, plainToRich(text, heading)));
      return elementSummary(elementOf(next, elementId).element);
    },
  }),

  defineTool({
    name: 'add_image',
    title: 'Add image',
    description:
      'Adds an image from a file in the workspace folder (png, jpeg, gif, webp, avif or svg). alt text is required because the project must meet WCAG AA: describe the image, or pass decorative: true with an empty alt for a purely decorative one. The file is embedded in the deck.',
    input: z.object({
      deckId,
      slideId,
      path: z.string().min(1).describe('Image file, relative to the workspace folder.'),
      alt: z.string().max(1000).describe('Text alternative for screen readers.'),
      decorative: z.boolean().default(false),
      fit: z.enum(['cover', 'contain', 'stretch']).default('contain'),
      ...geometry,
    }),
    async run(workspace, { deckId, slideId, path, alt, decorative, fit, x, y, w, h }) {
      if (alt.trim() === '' && !decorative) throw new ToolError('Give alt text that describes the image, or pass decorative: true if it carries no information');
      if (alt.trim() !== '' && decorative) throw new ToolError('A decorative image has an empty alt text; remove alt or decorative');
      const session = workspace.get(deckId);
      slideOf(session.deck, slideId);
      const mime = Object.hasOwn(IMAGE_MIMES, extname(path).toLowerCase()) ? IMAGE_MIMES[extname(path).toLowerCase()] : undefined;
      if (!mime) throw new ToolError(`"${path}" is not a supported image type; use ${Object.keys(IMAGE_MIMES).join(', ')}`);
      const full = resolveInside(workspace.root, path);
      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        throw new ToolError(`The file "${path}" does not exist`);
      }
      const limit = 64 * 1024 * 1024;
      if (size > limit) throw new ToolError(`The image is larger than ${limit / 1024 / 1024} MiB`);
      const bytes = new Uint8Array(await readFile(full));
      const problem = contentProblem(bytes, mime);
      if (problem) throw new ToolError(`"${path}" is not a valid ${mime} file: ${problem}`);
      if (!DEFAULT_VALIDATION_OPTIONS.allowedMimeTypes.includes(mime) || !Object.hasOwn(MIME_EXTENSIONS, mime)) throw new ToolError(`Images of type ${mime} are not allowed`);
      const hash = await sha256Hex(bytes as BufferSource);
      const element = createElement('image', { assetId: hash, alt: alt.trim(), fit, w: 960, h: 540, ...given({ x, y, w, h }) });
      const next = session.apply('AddImage', new AddAsset(hash, assetRef(hash, mime, bytes.length)), new AddElement(slideId, element));
      // Bytes are kept only once the deck accepted the asset, so a refused change leaves nothing behind.
      session.assets.set(hash, bytes);
      return { ...elementSummary(elementOf(next, element.id).element), assetId: hash, bytes: bytes.length };
    },
  }),

  defineTool({
    name: 'add_shape',
    title: 'Add shape',
    description: 'Adds a rectangle, ellipse or triangle. fill and stroke are theme colour tokens or CSS colours; the fill defaults to the theme accent colour.',
    input: z.object({
      deckId,
      slideId,
      shape: z.enum(['rect', 'ellipse', 'triangle']).default('rect'),
      fill: color.optional(),
      stroke: color.optional(),
      strokeWidth: z.number().min(0).max(1000).optional(),
      ...geometry,
    }),
    run(workspace, { deckId, slideId, shape, fill, stroke, strokeWidth, x, y, w, h }) {
      const session = workspace.get(deckId);
      const { deck } = session;
      slideOf(deck, slideId);
      const element = createElement('shape', {
        shape,
        ...given({ x, y, w, h, strokeWidth }),
        ...(fill !== undefined ? { fill: toFill(deck, fill) } : {}),
        ...(stroke !== undefined ? { stroke: toColor(deck, stroke), strokeWidth: strokeWidth ?? 4 } : {}),
      });
      const next = session.apply('AddShape', new AddElement(slideId, element));
      return elementSummary(elementOf(next, element.id).element);
    },
  }),

  defineTool({
    name: 'update_element',
    title: 'Update element properties',
    description:
      'Sets properties of one element. Allowed keys depend on the type (see describe_schema): the shared x, y, w, h, rotation, hidden, locked, step plus type-specific ones such as fontSize, align, color, fill, stroke, fit. A value of null removes an optional property. Text content has its own tool (set_text), image alt text too (set_alt_text), code props too (update_code_element_props).',
    input: z.object({ deckId, elementId, changes: z.record(z.string(), z.unknown()).describe('Property name to new value.') }),
    run(workspace, { deckId, elementId, changes }) {
      const session = workspace.get(deckId);
      const { element } = elementOf(session.deck, elementId);
      const forbidden = ['text', 'rich', 'alt', 'props', 'componentId', 'assetId'].filter((k) => Object.hasOwn(changes, k));
      if (forbidden.length > 0) {
        throw new ToolError(`Use the dedicated tool for ${forbidden.join(', ')}: set_text, set_alt_text, update_code_element_props. Assets and components cannot be re-pointed; add a new element instead.`);
      }
      const prepared: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) prepared[key] = undefined;
        else if (['color', 'stroke'].includes(key) && typeof value === 'string') prepared[key] = toColor(session.deck, value);
        else if (key === 'fill' && typeof value === 'string') prepared[key] = toFill(session.deck, value);
        else prepared[key] = value;
      }
      const next = session.apply('SetProps', new SetProps([element.id], prepared));
      return elementSummary(elementOf(next, elementId).element);
    },
  }),

  defineTool({
    name: 'move_element',
    title: 'Move or resize element',
    description: 'Sets the position and/or size of an element on the 1920x1080 stage. Only the values you give change.',
    input: z.object({ deckId, elementId, ...geometry }),
    run(workspace, { deckId, elementId, x, y, w, h }) {
      if (x === undefined && y === undefined && w === undefined && h === undefined) throw new ToolError('Give at least one of x, y, w, h');
      const session = workspace.get(deckId);
      const { element } = elementOf(session.deck, elementId);
      const next = session.apply('ResizeElements', new ResizeElements([{ id: elementId, x: x ?? element.x, y: y ?? element.y, w: w ?? element.w, h: h ?? element.h }]));
      return elementSummary(elementOf(next, elementId).element);
    },
  }),

  defineTool({
    name: 'delete_element',
    title: 'Delete element',
    description: 'Deletes elements. A code element\'s component definition stays in the deck.',
    input: z.object({ deckId, elementIds: z.array(z.string()).min(1).max(500) }),
    run(workspace, { deckId, elementIds }) {
      const next = workspace.get(deckId).apply('DeleteElements', new DeleteElements(elementIds));
      return { deleted: elementIds.length, slides: next.slides.length };
    },
  }),

  defineTool({
    name: 'set_z_order',
    title: 'Set z-order / reading order',
    description:
      'Moves an element within its slide: front, back, forward or backward. The element order of a slide is its stacking order and also its reading and tab order for assistive technology, so put the title first (back) and content after it.',
    input: z.object({ deckId, elementId, move: z.enum(['front', 'back', 'forward', 'backward']) }),
    run(workspace, { deckId, elementId, move }) {
      const session = workspace.get(deckId);
      const { slide } = elementOf(session.deck, elementId);
      const next = session.apply('ReorderElements', new ReorderElements(slide.id, [elementId], move));
      return { slideId: slide.id, order: slideOf(next, slide.id).elements.map((e: Element) => e.id) };
    },
  }),

  defineTool({
    name: 'set_alt_text',
    title: 'Set alt text',
    description: 'Sets the text alternative of an image element. An empty string marks the image as decorative.',
    input: z.object({ deckId, elementId, alt: z.string().max(1000) }),
    run(workspace, { deckId, elementId, alt }) {
      const session = workspace.get(deckId);
      const { element } = elementOf(session.deck, elementId);
      if (element.type !== 'image') throw new ToolError(`Element "${elementId}" is a ${element.type} element; only images have alt text`);
      session.apply('SetProps', new SetProps([elementId], { alt: alt.trim() }));
      return { elementId, alt: alt.trim() };
    },
  }),

  defineTool({
    name: 'check_accessibility',
    title: 'Check accessibility',
    description: 'Lists WCAG AA problems found in the document without rendering it: images without alt text, empty text elements and text whose colour has too little contrast against the slide background. Empty list = nothing found (it does not prove the deck is accessible).',
    input: z.object({ deckId }),
    readOnly: true,
    run(workspace, { deckId }) {
      const problems = accessibilityProblems(workspace.get(deckId).deck);
      return { problems, count: problems.length };
    },
  }),
];
