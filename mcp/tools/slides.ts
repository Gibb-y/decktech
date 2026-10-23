import { z } from 'zod';
import { createSlide, generateId, instantiateLayout } from '../../src/app/core/model';
import { AddSlide, DeleteSlide, DuplicateSlide, ReorderSlides, SetNotes, SetSlideLayout } from '../../src/app/core/store/commands';
import { slideOf, slideSummary } from '../summary';
import { ToolError, defineTool } from '../tool';
import { deckId } from './deck';

const slideId = z.string().describe('Id of a slide (see get_deck).');

export const slideTools = [
  defineTool({
    name: 'add_slide',
    title: 'Add slide',
    description:
      'Adds a slide. With a layout that has placeholders (title, body, ...) the slide gets a text element with sample text ("Title", bullets, ...) in each; replace it with set_text. Appended at the end unless index is given.',
    input: z.object({
      deckId,
      layoutId: z.string().optional().describe('Layout id from describe_schema / get_deck; the Blank layout when omitted.'),
      index: z.number().int().min(0).optional().describe('Position, 0 = first. Appended when omitted.'),
      notes: z.string().max(100_000).optional().describe('Speaker notes.'),
    }),
    run(workspace, { deckId, layoutId, index, notes }) {
      const session = workspace.get(deckId);
      const { deck } = session;
      const layout = layoutId === undefined ? deck.layouts[0] : deck.layouts.find((l) => l.id === layoutId);
      if (!layout) throw new ToolError(`Layout "${layoutId}" does not exist. Layouts: ${deck.layouts.map((l) => `${l.id} (${l.name})`).join(', ')}`);
      const slide = { ...instantiateLayout(createSlide(layout.id), layout, deck.theme), ...(notes ? { notes } : {}) };
      const next = session.apply('AddSlide', new AddSlide(slide, index));
      const at = next.slides.findIndex((s) => s.id === slide.id);
      return slideSummary(next, next.slides[at], at);
    },
  }),

  defineTool({
    name: 'duplicate_slide',
    title: 'Duplicate slide',
    description: 'Inserts a copy of a slide (new ids for the slide and its elements) right after it. Code elements keep sharing their component definitions.',
    input: z.object({ deckId, slideId }),
    run(workspace, { deckId, slideId }) {
      const session = workspace.get(deckId);
      const copyId = generateId('slide');
      const next = session.apply('DuplicateSlide', new DuplicateSlide(slideId, copyId));
      const at = next.slides.findIndex((s) => s.id === copyId);
      return slideSummary(next, next.slides[at], at);
    },
  }),

  defineTool({
    name: 'delete_slide',
    title: 'Delete slide',
    description: 'Deletes a slide. A deck always keeps at least one slide. Component definitions the slide used stay in the deck.',
    input: z.object({ deckId, slideId }),
    run(workspace, { deckId, slideId }) {
      const next = workspace.get(deckId).apply('DeleteSlide', new DeleteSlide(slideId));
      return { slides: next.slides.map((s) => s.id) };
    },
  }),

  defineTool({
    name: 'move_slide',
    title: 'Move slide',
    description: 'Moves a slide to a new position (0 = first). The index is the final position of the slide.',
    input: z.object({ deckId, slideId, toIndex: z.number().int().min(0) }),
    run(workspace, { deckId, slideId, toIndex }) {
      const session = workspace.get(deckId);
      if (toIndex >= session.deck.slides.length) throw new ToolError(`Position ${toIndex} is out of range; the deck has ${session.deck.slides.length} slides (0 to ${session.deck.slides.length - 1})`);
      const next = session.apply('ReorderSlides', new ReorderSlides([slideId], toIndex));
      return { slides: next.slides.map((s) => s.id) };
    },
  }),

  defineTool({
    name: 'set_layout',
    title: 'Set slide layout',
    description:
      'Switches a slide to another layout. Elements that fill a placeholder move into the new layout\'s placeholder of the same kind; other elements stay where they are and none is deleted.',
    input: z.object({ deckId, slideId, layoutId: z.string() }),
    run(workspace, { deckId, slideId, layoutId }) {
      const session = workspace.get(deckId);
      const next = session.apply('SetSlideLayout', new SetSlideLayout(slideId, layoutId));
      return slideSummary(next, slideOf(next, slideId), next.slides.findIndex((s) => s.id === slideId));
    },
  }),

  defineTool({
    name: 'set_speaker_notes',
    title: 'Set speaker notes',
    description: 'Replaces the speaker notes of a slide (plain text). An empty string clears them.',
    input: z.object({ deckId, slideId, notes: z.string().max(100_000) }),
    run(workspace, { deckId, slideId, notes }) {
      workspace.get(deckId).apply('SetNotes', new SetNotes(slideId, notes));
      return { slideId, characters: notes.length };
    },
  }),
];
