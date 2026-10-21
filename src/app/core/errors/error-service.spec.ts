import { ERROR_CAPACITY, ErrorService } from './error-service';

describe('ErrorService', () => {
  it('collects host and component errors tagged by component id', () => {
    const errors = new ErrorService();
    errors.report('host', 'The component stopped responding', 'cp_a');
    errors.report('component', 'boom', 'cp_b');
    errors.report('host', 'storage failed');
    expect(errors.entries().map((e) => [e.seq, e.source, e.componentId, e.message])).toEqual([
      [1, 'host', 'cp_a', 'The component stopped responding'],
      [2, 'component', 'cp_b', 'boom'],
      [3, 'host', undefined, 'storage failed'],
    ]);
    expect('componentId' in errors.entries()[2]).toBe(false);
    expect(errors.forComponent('cp_b').map((e) => e.message)).toEqual(['boom']);
    expect(errors.forComponent('toString')).toEqual([]);
  });

  it('keeps only the newest entries and truncates huge messages', () => {
    const errors = new ErrorService();
    for (let i = 0; i < ERROR_CAPACITY + 50; i++) errors.report('component', `e${i}`, 'cp');
    expect(errors.entries()).toHaveLength(ERROR_CAPACITY);
    expect(errors.entries()[0].message).toBe('e50');
    errors.report('component', 'x'.repeat(10_000));
    expect(errors.entries()[ERROR_CAPACITY - 1].message).toHaveLength(2000);
  });

  it('clears', () => {
    const errors = new ErrorService();
    errors.report('host', 'x');
    errors.clear();
    expect(errors.entries()).toEqual([]);
  });
});
