import type { Provider } from '@angular/core';
import { CODE_ELEMENT_VIEW, COMPONENT_TOOLS } from '../../renderer';

/**
 * Lets the renderer draw code elements and the editor open the code editor and the component
 * library. Both are loaded with `import()` on first use, so the sandbox code and CodeMirror are
 * chunks of their own and the initial bundle does not grow.
 */
export function provideCodeComponents(): Provider[] {
  return [
    { provide: CODE_ELEMENT_VIEW, useValue: () => import('./code-element-renderer').then((m) => m.CodeElementRenderer) },
    { provide: COMPONENT_TOOLS, useValue: () => import('../editor/component-tools').then((m) => m.ComponentTools) },
  ];
}
