import '@testing-library/jest-dom/vitest';

// jsdom does not implement scrollIntoView at all (the property is undefined), so any test
// that needs to assert a component called it -- e.g. the dashboard's #settings fragment
// scroll -- has nothing to spy on without this. A shared no-op here means every test file
// gets a stable, spy-able method rather than each one reaching for its own ad hoc patch.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    // no-op: jsdom has no layout, so there is nothing to actually scroll.
  };
}
