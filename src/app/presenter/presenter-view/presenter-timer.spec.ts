import { PresenterTimer } from './presenter-timer';

function setup() {
  let time = 1000;
  const timer = new PresenterTimer(() => time);
  return { timer, advance: (ms: number) => (time += ms), setTime: (ms: number) => (time = ms) };
}

describe('PresenterTimer', () => {
  it('starts stopped at zero', () => {
    expect(setup().timer.snapshot()).toEqual({ running: false, elapsedMs: 0 });
  });

  it('counts while running and not while paused', () => {
    const { timer, advance } = setup();
    timer.apply('start');
    advance(5000);
    expect(timer.snapshot()).toEqual({ running: true, elapsedMs: 5000 });
    timer.apply('pause');
    advance(9000);
    expect(timer.snapshot()).toEqual({ running: false, elapsedMs: 5000 });
    timer.apply('start');
    advance(1000);
    expect(timer.snapshot().elapsedMs).toBe(6000);
  });

  it('keeps counting when started twice', () => {
    const { timer, advance } = setup();
    timer.apply('start');
    advance(2000);
    timer.apply('start');
    advance(1000);
    expect(timer.snapshot().elapsedMs).toBe(3000);
  });

  it('pausing a stopped timer changes nothing', () => {
    const { timer, advance } = setup();
    timer.apply('pause');
    advance(1000);
    expect(timer.snapshot()).toEqual({ running: false, elapsedMs: 0 });
  });

  it('reset clears the time and stops, from running and from paused', () => {
    const { timer, advance } = setup();
    timer.apply('start');
    advance(4000);
    timer.apply('reset');
    expect(timer.snapshot()).toEqual({ running: false, elapsedMs: 0 });
    timer.apply('start');
    advance(1000);
    timer.apply('pause');
    timer.apply('reset');
    expect(timer.snapshot()).toEqual({ running: false, elapsedMs: 0 });
  });

  it('never goes backwards when the clock does', () => {
    const { timer, setTime } = setup();
    timer.apply('start');
    setTime(0);
    expect(timer.snapshot().elapsedMs).toBe(0);
  });
});
