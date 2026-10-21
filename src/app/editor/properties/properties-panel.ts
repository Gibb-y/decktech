import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, linkedSignal, untracked } from '@angular/core';
import { FormField, form, validate } from '@angular/forms/signals';
import { ELEMENT_SCHEMAS, type CodeEl, type Color, type Element, type Fill, type TextEl } from '../../core/model';
import { CommandError, DeckStore, SetProps, SetSlideBackground, type Command } from '../../core/store';
import { LiveAnnouncer } from '../../shared';
import { describeElement } from '../describe';
import { InsertActions } from '../insert-actions';
import { ReadingOrder } from '../reading-order';
import { SlideActions } from '../slide-actions';
import { TextFormat } from '../text/text-format';
import { CodeProps } from './code-props';
import { ColorControl } from './color-control';
import { BASE_FIELDS, fieldsOf, sectionsOf, typeFields, type FieldDef } from './field-defs';
import { FillControl } from './fill-control';
import { EMPTY_VALUES, changesFrom, numberProblem, valuesOf, type PanelValues } from './panel-values';

/** Every number field of any element type; the form's validators are declared once for all of them. */
const NUMBER_FIELDS: readonly FieldDef[] = [
  ...new Map(
    [...BASE_FIELDS, ...Object.keys(ELEMENT_SCHEMAS).flatMap((t) => typeFields(t as Element['type']))].filter((f) => f.control === 'number').map((f) => [f.key, f] as const),
  ).values(),
];

/**
 * The contextual properties panel (arc42 §5.4). With one element selected it shows that element's
 * fields in sections built from `ELEMENT_SCHEMAS` (so a new element type needs no panel code);
 * with nothing selected it edits the slide (layout, background). Scalar fields are a Signal Form
 * whose values are mirrored from the selection and turned into `SetProps` commands, so the panel
 * never writes state itself; colours and fills have their own controls that dispatch the same way.
 */
@Component({
  selector: 'app-properties-panel',
  imports: [ColorControl, FillControl, ReadingOrder, FormField, TextFormat, CodeProps],
  templateUrl: './properties-panel.html',
  styleUrl: './properties-panel.css',
})
export class PropertiesPanel {
  protected readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly insert = inject(InsertActions);
  private readonly slideActions = inject(SlideActions);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly selected = this.store.selectedElements;
  protected readonly single = computed<Element | null>(() => (this.selected().length === 1 ? this.selected()[0] : null));
  protected readonly fields = computed(() => {
    const element = this.single();
    return element ? fieldsOf(element) : [];
  });
  protected readonly sections = computed(() => sectionsOf(this.fields()));
  protected readonly title = computed(() => {
    const element = this.single();
    return element ? describeElement(element) : '';
  });
  protected readonly theme = computed(() => this.store.deck().theme);
  protected readonly fontNames = computed(() => Object.keys(this.theme().fonts));
  protected readonly layouts = computed(() => this.store.deck().layouts);
  protected readonly locked = computed(() => this.single()?.locked === true);

  /** Form values, refilled from the element whenever it (or the selection) changes. */
  protected readonly model = linkedSignal<PanelValues>(() => {
    const element = this.single();
    return element ? valuesOf(element, this.fields()) : EMPTY_VALUES;
  });
  protected readonly form = form(this.model, (path) => {
    for (const f of NUMBER_FIELDS) {
      validate(path.numbers[f.key], ({ value }) => {
        const message = numberProblem(value(), f);
        return message ? { kind: 'range', message } : undefined;
      });
    }
  });

  constructor() {
    effect(() => {
      const values = this.model();
      const element = this.single();
      if (element) untracked(() => this.commit(values, element));
    });

    let handled = this.insert.focusRequest()?.seq ?? 0; // a request from before this panel existed is not ours
    effect(() => {
      const request = this.insert.focusRequest();
      if (!request || request.seq <= handled) return;
      handled = request.seq;
      afterNextRender(() => this.host.querySelector<HTMLElement>(`#prop-${CSS.escape(request.field)}`)?.focus(), { injector: this.injector });
    });
  }

  // ------------------------------------------------------------ element edits

  private commit(values: PanelValues, element: Element): void {
    const skip = new Set<string>();
    for (const f of this.fields()) {
      if (element.locked && f.section !== 'arrange') skip.add(f.key);
      else if (f.control === 'number' && this.form.numbers[f.key]().invalid()) skip.add(f.key);
    }
    const changes = changesFrom(values, element, this.fields(), skip);
    this.setProps(element, changes);
  }

  protected setColorOrFill(element: Element, key: string, value: Color | Fill | undefined): void {
    if (element.locked) return;
    this.setProps(element, { [key]: value });
  }

  protected textElement(element: Element): TextEl | null {
    return element.type === 'text' ? element : null;
  }

  protected codeElement(element: Element): CodeEl | null {
    return element.type === 'code' ? element : null;
  }

  protected hasRich(element: Element): boolean {
    return element.type === 'text' && element.rich !== undefined;
  }

  protected valueOf(element: Element, key: string): unknown {
    return (element as unknown as Record<string, unknown>)[key];
  }

  protected asColor(value: unknown): Color | undefined {
    return value as Color | undefined;
  }

  protected asFill(value: unknown): Fill | undefined {
    return value as Fill | undefined;
  }

  private setProps(element: Element, changes: Record<string, unknown>): void {
    const keys = Object.keys(changes);
    if (keys.length === 0) return;
    this.run(new SetProps([element.id], changes, { coalesceKey: `panel:${element.id}:${keys.join(',')}` }));
  }

  // -------------------------------------------------------------- slide edits

  protected setLayout(event: Event): void {
    this.slideActions.setLayout(this.store.currentSlideId(), (event.target as HTMLSelectElement).value);
  }

  protected setBackground(fill: Fill | undefined): void {
    this.run(new SetSlideBackground(this.store.currentSlideId(), fill));
  }

  private run(command: Command): void {
    try {
      this.store.execute(command);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(e.message);
    }
  }
}
