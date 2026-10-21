import type { Provider } from '@angular/core';
import { CODE_ELEMENT_VIEW } from '../../renderer';

/**
 * Lets the renderer draw code elements. The view is loaded with `import()` on the first slide
 * that has one, so the sandbox code is a chunk of its own and the initial bundle does not grow.
 */
export function provideCodeComponents(): Provider[] {
  return [{ provide: CODE_ELEMENT_VIEW, useValue: () => import('./code-element-renderer').then((m) => m.CodeElementRenderer) }];
}
