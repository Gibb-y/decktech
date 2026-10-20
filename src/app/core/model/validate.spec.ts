import { createDeck, createElement, createSlide } from './factory';
import type { CodeEl, Deck } from './types';
import { validateDeck, type ValidationOptions } from './validate';

/** A deck exercising every element type and every kind of reference. */
function richDeck(): Deck {
  const deck = createDeck('Rich');
  deck.assets['img1'] = { blobKey: 'k1', mime: 'image/png', hash: 'a'.repeat(64), size: 10 };
  deck.assets['vid1'] = { blobKey: 'k2', mime: 'video/mp4', hash: 'b'.repeat(64), size: 20 };
  deck.components.push({
    id: 'cmp1',
    name: 'Counter',
    html: '<div></div>',
    css: '',
    js: 'deck.ready(() => {});',
    propSchema: [
      { key: 'start', type: 'number', label: 'Start', default: 0, min: 0, max: 10 },
      { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], default: 'a' },
    ],
    permissions: ['storage'],
    files: ['img1'],
    libs: [],
  });
  const layoutId = deck.layouts[0].id;
  deck.layouts[0].placeholders.push({ id: 'ph1', kind: 'title', x: 0, y: 0, w: 100, h: 100 });
  const slide = createSlide(layoutId);
  slide.background = { kind: 'image', assetId: 'img1', fit: 'cover' };
  slide.transition = { type: 'fade', durationMs: 300 };
  slide.elements.push(
    createElement('text', { text: 'Hello', step: 1 }),
    createElement('image', { assetId: 'img1' }),
    createElement('shape', { fill: { kind: 'gradient', angle: 90, stops: [{ offset: 0, color: '#000' }] } }),
    createElement('line'),
    createElement('table'),
    createElement('video', { assetId: 'vid1' }),
    createElement('code', { componentId: 'cmp1', props: { start: 3, nested: { list: [1, 'a', null, true] } } }),
  );
  deck.slides.push(slide);
  return deck;
}

/** Deep-cloned mutable view for tampering with a deck in tests. */
function tamper(mutate: (d: any) => void): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
  const d = structuredClone(richDeck());
  mutate(d);
  return d;
}

function errorsOf(input: unknown, limits?: Partial<ValidationOptions>) {
  const r = validateDeck(input, limits);
  return r.ok ? [] : r.error;
}

function expectErrorAt(input: unknown, path: string, limits?: Partial<ValidationOptions>) {
  const errors = errorsOf(input, limits);
  expect(errors.map((e) => e.path)).toContain(path);
}

describe('validateDeck', () => {
  it('accepts a freshly created deck', () => {
    expect(validateDeck(createDeck()).ok).toBe(true);
  });

  it('accepts a deck with every element type and reference kind', () => {
    const r = validateDeck(richDeck());
    expect(r.ok ? [] : r.error).toEqual([]);
  });

  it('survives a JSON round trip', () => {
    expect(validateDeck(JSON.parse(JSON.stringify(richDeck()))).ok).toBe(true);
  });

  describe('wrong types', () => {
    it.each([null, undefined, 42, 'deck', [], true])('rejects non-object root %s', (input) => {
      expectErrorAt(input, '');
    });

    it('rejects a wrong schemaVersion', () => {
      expectErrorAt(tamper((d) => (d.schemaVersion = 999)), 'schemaVersion');
    });

    it('rejects a non-string title', () => {
      expectErrorAt(tamper((d) => (d.title = 5)), 'title');
    });

    it('rejects non-array slides', () => {
      expectErrorAt(tamper((d) => (d.slides = {})), 'slides');
    });

    it('rejects a wrong-typed element field with its path', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].text = 7)), 'slides[1].elements[0].text');
    });

    it('rejects a malformed id', () => {
      expectErrorAt(tamper((d) => (d.slides[0].id = 'has space')), 'slides[0].id');
    });

    it('rejects an invalid fill kind', () => {
      expectErrorAt(tamper((d) => (d.slides[1].background = { kind: 'plaid' })), 'slides[1].background.kind');
    });

    it('rejects an unknown permission', () => {
      expectErrorAt(tamper((d) => (d.components[0].permissions = ['root'])), 'components[0].permissions[0]');
    });
  });

  describe('unknown element types', () => {
    it('rejects an unknown element type', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].type = 'script')), 'slides[1].elements[0].type');
    });

    it('rejects a missing element type', () => {
      expectErrorAt(tamper((d) => delete d.slides[1].elements[0].type), 'slides[1].elements[0].type');
    });
  });

  describe('non-finite numbers', () => {
    it.each([NaN, Infinity, -Infinity])('rejects %s geometry', (n) => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].x = n)), 'slides[1].elements[0].x');
    });

    it('rejects negative size', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].w = -1)), 'slides[1].elements[0].w');
    });

    it('rejects non-finite numbers inside component props', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[6].props.start = NaN)), 'slides[1].elements[6].props.start');
    });

    it('rejects a non-integer step', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].step = 1.5)), 'slides[1].elements[0].step');
    });
  });

  describe('oversize input', () => {
    it('rejects strings over the limit', () => {
      expectErrorAt(
        tamper((d) => (d.slides[1].elements[0].text = 'x'.repeat(11))),
        'slides[1].elements[0].text',
        { maxStringLength: 10 },
      );
    });

    it('rejects too many slides', () => {
      expectErrorAt(richDeck(), 'slides', { maxSlides: 1 });
    });

    it('rejects too many elements on a slide', () => {
      expectErrorAt(richDeck(), 'slides[1].elements', { maxElementsPerSlide: 3 });
    });

    it('rejects too many components', () => {
      expectErrorAt(richDeck(), 'components', { maxComponents: 0 });
    });

    it('rejects too many assets', () => {
      expectErrorAt(richDeck(), 'assets', { maxAssets: 1 });
    });

    it('rejects oversize tables', () => {
      expectErrorAt(richDeck(), 'slides[1].elements[4].rows', { maxTableCells: 2 });
    });

    it('rejects deeply nested props', () => {
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 40; i++) cursor = (cursor['n'] = {}) as Record<string, unknown>;
      expectErrorAt(tamper((d) => (d.slides[1].elements[6].props = deep)), 'slides[1].elements[6].props.n.n.n.n.n.n.n.n.n.n.n.n.n.n.n.n.n');
    });
  });

  describe('duplicate ids', () => {
    it('rejects duplicate slide ids', () => {
      expectErrorAt(tamper((d) => (d.slides[1].id = d.slides[0].id)), 'slides[1].id');
    });

    it('rejects duplicate element ids across slides', () => {
      expectErrorAt(
        tamper((d) => {
          d.slides[0].elements.push({ ...d.slides[1].elements[0] });
        }),
        'slides[1].elements[0].id',
      );
    });

    it('rejects duplicate component ids', () => {
      expectErrorAt(
        tamper((d) => d.components.push({ ...d.components[0] })),
        'components[1].id',
      );
    });

    it('rejects duplicate layout ids', () => {
      expectErrorAt(
        tamper((d) => d.layouts.push({ ...d.layouts[0] })),
        'layouts[5].id',
      );
    });

    it('rejects duplicate prop keys', () => {
      expectErrorAt(
        tamper((d) => d.components[0].propSchema.push({ ...d.components[0].propSchema[0] })),
        'components[0].propSchema[2].key',
      );
    });
  });

  describe('dangling references', () => {
    it('rejects a CodeEl.componentId missing from Deck.components', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[6].componentId = 'nope')), 'slides[1].elements[6].componentId');
    });

    it('rejects an unknown layoutId', () => {
      expectErrorAt(tamper((d) => (d.slides[0].layoutId = 'nope')), 'slides[0].layoutId');
    });

    it('rejects an unknown image asset', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[1].assetId = 'nope')), 'slides[1].elements[1].assetId');
    });

    it('rejects an unknown video asset', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[5].assetId = 'nope')), 'slides[1].elements[5].assetId');
    });

    it('rejects an unknown background asset', () => {
      expectErrorAt(tamper((d) => (d.slides[1].background.assetId = 'nope')), 'slides[1].background.assetId');
    });

    it('rejects an unknown component file or lib asset', () => {
      expectErrorAt(tamper((d) => (d.components[0].files = ['nope'])), 'components[0].files[0]');
      expectErrorAt(tamper((d) => (d.components[0].libs = ['nope'])), 'components[0].libs[0]');
    });

    it('rejects an empty (unset) reference', () => {
      expectErrorAt(
        { ...createDeck(), slides: [{ ...createSlide('x'), elements: [createElement('code')] }] },
        'slides[0].elements[0].componentId',
      );
    });
  });

  describe('unknown fields', () => {
    it('rejects extra code on a CodeEl', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[6].js = 'alert(1)')), 'slides[1].elements[6].js');
    });

    it('rejects a field belonging to another element type', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].componentId = 'cmp1')), 'slides[1].elements[0].componentId');
    });

    it('rejects extra fields on the deck, slides, components and assets', () => {
      expectErrorAt(tamper((d) => (d.extra = 1)), 'extra');
      expectErrorAt(tamper((d) => (d.slides[1].extra = 1)), 'slides[1].extra');
      expectErrorAt(tamper((d) => (d.components[0].extra = 1)), 'components[0].extra');
      expectErrorAt(tamper((d) => (d.assets['img1'].extra = 1)), 'assets.img1.extra');
    });
  });

  describe('theme tokens and colours', () => {
    it('accepts token references and literal colours', () => {
      const r = validateDeck(
        tamper((d) => {
          d.slides[1].elements[0].color = { token: 'accent' };
          d.slides[1].elements[0].font = 'heading';
          d.slides[1].elements[2].stroke = 'rgb(0, 0, 0)';
        }),
      );
      expect(r.ok).toBe(true);
    });

    it('rejects an unknown colour token', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].color = { token: 'nope' })), 'slides[1].elements[0].color.token');
    });

    it('rejects an unknown font token', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[0].font = 'nope')), 'slides[1].elements[0].font');
    });

    it('rejects colours that could smuggle other CSS', () => {
      expectErrorAt(
        tamper((d) => (d.slides[1].elements[0].color = 'red; background: url(//evil)')),
        'slides[1].elements[0].color',
      );
      expectErrorAt(tamper((d) => (d.theme.colors.accent = 'url(x)')), 'theme.colors.accent');
    });
  });

  describe('stage', () => {
    it('accepts other ratios that keep a 1920 width or a 1080 height', () => {
      expect(validateDeck(tamper((d) => (d.stage = { width: 1440, height: 1080 }))).ok).toBe(true);
      expect(validateDeck(tamper((d) => (d.stage = { width: 1920, height: 1200 }))).ok).toBe(true);
    });

    it('rejects a stage keeping neither side', () => {
      expectErrorAt(tamper((d) => (d.stage = { width: 1000, height: 500 })), 'stage');
    });

    it('rejects non-integer or missing stage values', () => {
      expectErrorAt(tamper((d) => (d.stage = { width: 1920.5, height: 1080 })), 'stage.width');
      expectErrorAt(tamper((d) => delete d.stage), 'stage');
    });
  });

  describe('assets', () => {
    it('rejects a mime type outside the allow-list', () => {
      expectErrorAt(tamper((d) => (d.assets['img1'].mime = 'text/html')), 'assets.img1.mime');
    });

    it('honours a custom allow-list', () => {
      expectErrorAt(richDeck(), 'assets.img1.mime', { allowedMimeTypes: ['video/mp4'] });
    });

    it('rejects a hash that is not a SHA-256 digest', () => {
      expectErrorAt(tamper((d) => (d.assets['img1'].hash = 'abc')), 'assets.img1.hash');
    });
  });

  describe('component prop specs', () => {
    it('rejects a default that does not match the type', () => {
      expectErrorAt(tamper((d) => (d.components[0].propSchema[0].default = 'x')), 'components[0].propSchema[0].default');
    });

    it('rejects a number default outside min/max', () => {
      expectErrorAt(tamper((d) => (d.components[0].propSchema[0].default = 99)), 'components[0].propSchema[0].default');
    });

    it('rejects a select default that is not an option', () => {
      expectErrorAt(tamper((d) => (d.components[0].propSchema[1].default = 'zzz')), 'components[0].propSchema[1].default');
    });

    it('rejects min greater than max', () => {
      expectErrorAt(
        tamper((d) => {
          d.components[0].propSchema[0].min = 10;
          d.components[0].propSchema[0].max = 1;
        }),
        'components[0].propSchema[0].min',
      );
    });
  });

  it('rejects duplicate placeholder ids within a layout', () => {
    expectErrorAt(
      tamper((d) => d.layouts[0].placeholders.push({ ...d.layouts[0].placeholders[0] })),
      'layouts[0].placeholders[1].id',
    );
  });

  describe('slide sections', () => {
    it('accepts a named section start', () => {
      expect(validateDeck(tamper((d) => (d.slides[1].section = 'Introduction'))).ok).toBe(true);
    });

    it.each([
      ['an empty name', ''],
      ['a name that is not a string', 7],
      ['a name that is too long', 'x'.repeat(1_001)],
    ])('rejects %s', (_label, value) => {
      expectErrorAt(tamper((d) => ((d.slides[1] as unknown as Record<string, unknown>)['section'] = value)), 'slides[1].section');
    });
  });

  describe('hostile input', () => {
    it('rejects __proto__ keys in props', () => {
      const props = JSON.parse('{"__proto__": {"polluted": true}}');
      expectErrorAt(tamper((d) => (d.slides[1].elements[6].props = props)), 'slides[1].elements[6].props.__proto__');
    });

    it('rejects __proto__ keys in theme maps', () => {
      const colors = JSON.parse('{"__proto__": "red"}');
      expectErrorAt(tamper((d) => (d.theme.colors = colors)), 'theme.colors.__proto__');
    });

    it('rejects functions and symbols in props', () => {
      expectErrorAt(tamper((d) => (d.slides[1].elements[6].props.f = () => 1)), 'slides[1].elements[6].props.f');
    });

    it('reports every problem, not just the first', () => {
      const errors = errorsOf(
        tamper((d) => {
          d.title = 1;
          d.slides[1].elements[0].x = NaN;
        }),
      );
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('keeps component code out of CodeEl', () => {
    const el = createElement('code', { componentId: 'cmp1' }) as CodeEl;
    expect(Object.keys(el)).not.toEqual(expect.arrayContaining(['html', 'css', 'js']));
  });
});
