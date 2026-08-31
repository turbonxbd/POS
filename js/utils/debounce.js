/**
 * debounce.js - timing utilities.
 */

export function debounce(fn, wait = 200) {
  let t;
  const debounced = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(t);
  debounced.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return debounced;
}

export function throttle(fn, wait = 200) {
  let last = 0;
  let timer;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  };
}

export function raf(fn) {
  let scheduled = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/** Simple async mutex so critical sections (checkout) can't interleave. */
export function createMutex() {
  let chain = Promise.resolve();
  return function runExclusive(task) {
    const result = chain.then(() => task());
    chain = result.catch(() => {});
    return result;
  };
}
