import type { RawDeck } from './migrations';

/**
 * Frozen deck documents, one per released schema version. They are literals, never built with
 * `createDeck`, so they keep describing the version they were written for. When a new schema
 * version ships, add its fixture here and a spec case that migrates the previous one into it.
 */

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const HASH = 'a'.repeat(64);

/** Content shared by every version. */
const baseContent = {
  id: 'dk_fixture',
  title: 'Fixture deck',
  theme: {
    colors: { background: '#ffffff', text: '#111111' },
    fonts: { body: 'sans-serif' },
    typeScale: { body: 40 },
    spacing: { md: 32 },
  },
  layouts: [{ id: 'ly_1', name: 'Blank', placeholders: [] }],
  slides: [
    {
      id: 'sl_1',
      layoutId: 'ly_1',
      notes: 'Speaker notes',
      elements: [
        {
          id: 'el_1', type: 'text', x: 100, y: 100, w: 800, h: 200, rotation: 0,
          text: 'Hello', fontSize: 40, color: { token: 'text' }, align: 'left',
        },
        {
          id: 'el_2', type: 'image', x: 0, y: 0, w: 400, h: 300, rotation: 0,
          assetId: 'img1', alt: 'A picture', fit: 'cover',
        },
      ],
    },
  ],
  assets: { img1: { blobKey: 'blob-1', mime: 'image/png', hash: HASH, size: 10 } },
};

/** v0 (synthetic): no `stage`, no `components`. */
export const DECK_V0: RawDeck = deepFreeze({ schemaVersion: 0, ...structuredClone(baseContent) });

/** v1: the first released schema. */
export const DECK_V1: RawDeck = deepFreeze({
  schemaVersion: 1,
  ...structuredClone(baseContent),
  stage: { width: 1920, height: 1080 },
  components: [],
});
