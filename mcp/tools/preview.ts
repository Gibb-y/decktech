import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  createDeck,
  createElement,
  resolveProps,
  type ComponentDef,
  type Deck,
} from '../../src/app/core/model';
import { resolveInside } from '../paths';
import type { PreviewResult } from '../preview';
import { elementOf, slideOf } from '../summary';
import { ToolError, ToolImages, defineTool } from '../tool';
import type { Workspace } from '../workspace';
import { deckId } from './deck';

export const previewWidth = z
  .number()
  .int()
  .min(320)
  .max(1920)
  .default(1280)
  .describe('Width of the picture in pixels; the height follows the 16:9 stage.');
export const settleMs = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .default(1000)
  .describe('How long code components may run before the picture is taken.');

/** Errors and console output as the agent should read them. */
export function runtimeSummary(result: PreviewResult) {
  const { errors, console: logged, frames } = result.report;
  return { errors, console: logged, frames, width: result.width, height: result.height };
}

/** A one-slide deck that shows `def` over the whole stage, with the theme and assets of `base` (or defaults). */
export function scratchDeckFor(
  def: ComponentDef,
  base?: Deck,
): { deck: Deck; slideId: string; elementId: string } {
  const start = base ?? createDeck('Component check');
  const element = createElement('code', {
    x: 0,
    y: 0,
    w: start.stage.width,
    h: start.stage.height,
    componentId: def.id,
    props: resolveProps(def, {}),
  });
  const slide = {
    ...start.slides[0],
    id: 'sl_check',
    layoutId: start.layouts[0].id,
    elements: [element],
    notes: '',
  };
  const others = start.components.filter((c) => c.id !== def.id);
  return {
    deck: { ...start, slides: [slide], components: [def, ...others] },
    slideId: slide.id,
    elementId: element.id,
  };
}

export async function savePng(workspace: Workspace, path: string, png: Uint8Array): Promise<void> {
  const full = resolveInside(workspace.root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, png);
}

export const previewTools = [
  defineTool({
    name: 'render_preview',
    title: 'Render a slide to an image',
    description:
      "Returns a PNG of a slide, or of one element when elementId is given, drawn by DeckTech's own renderer in a headless browser, so you can check layout, contrast and code components visually. Also returns what the code components logged and the errors they raised. This RUNS the deck's code components (in their sandboxed frames, offline, in a throwaway browser profile), so it only works when the person who configured the server enabled it (DECKTECH_PREVIEW=1); otherwise it says so.",
    input: z.object({
      deckId,
      slideId: z.string().describe('Id of the slide to draw.'),
      elementId: z.string().optional().describe('Crop to this element.'),
      width: previewWidth,
      settleMs,
      path: z
        .string()
        .regex(/\.png$/i, 'must end in .png')
        .optional()
        .describe('Also save the PNG here (relative to the workspace folder).'),
    }),
    readOnly: true,
    async run(workspace, { deckId, slideId, elementId, width, settleMs, path }) {
      const session = workspace.get(deckId);
      slideOf(session.deck, slideId);
      if (elementId !== undefined) {
        const { slide } = elementOf(session.deck, elementId);
        if (slide.id !== slideId)
          throw new ToolError(`Element "${elementId}" is on slide "${slide.id}", not "${slideId}"`);
      }
      const result = await workspace.previewer.render({
        deck: session.deck,
        slideId,
        assets: session.assets,
        width,
        settleMs,
        ...(elementId ? { elementId } : {}),
      });
      if (path !== undefined) await savePng(workspace, path, result.png);
      return new ToolImages({ ...runtimeSummary(result), ...(path ? { path } : {}) }, [result.png]);
    },
  }),
];
