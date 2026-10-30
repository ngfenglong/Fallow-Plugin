import { parseRequest, isTrustedSender, MAX_REQUEST_ID_LENGTH, MAX_SCOPE_TAB_IDS } from '../../src/shared/validation';

describe('parseRequest: dispatch and shape', () => {
  it.each([null, 'x', 42, {}, { type: 'NOPE' }, { type: 'GET_SNAPSHOT' }])('rejects %p', (raw) => {
    expect(parseRequest(raw)).toBe(null);
  });

  it('does not throw on hostile input', () => {
    expect(() => parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: '__proto__' }, mode: 'auto' })).not.toThrow();
  });

  it('rejects an unknown eligibility mode', () => {
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'all' }, mode: 'god' })).toBe(null);
  });

  it('rejects a scope of the wrong shape', () => {
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'tab' }, mode: 'auto' })).toBe(null);
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'tabs', tabIds: ['1'] }, mode: 'auto' })).toBe(null);
  });

  it('accepts a well-formed request unchanged', () => {
    const r = { type: 'SET_TAB_PROTECTION', requestId: 'a', tabId: 3, isProtected: true };
    expect(parseRequest(r)).toEqual(r);
  });
});

describe('isTrustedSender', () => {
  it('trusts only this extension pages', () => {
    expect(isTrustedSender({ id: 'me', url: 'chrome-extension://me/dashboard/index.html' }, 'me')).toBe(true);
    expect(isTrustedSender({ id: 'other', url: 'chrome-extension://other/x.html' }, 'me')).toBe(false);
    expect(isTrustedSender({ id: 'me', url: 'https://evil.test/' }, 'me')).toBe(false);
    expect(isTrustedSender({}, 'me')).toBe(false);
  });
});

describe('requestId', () => {
  const get = (requestId: unknown) => ({ type: 'GET_SNAPSHOT', requestId });

  it.each([42, null, undefined, {}, ['a'], true])('rejects a non-string requestId %p', (requestId) => {
    expect(parseRequest(get(requestId))).toBe(null);
  });

  it('rejects an empty requestId', () => {
    expect(parseRequest(get(''))).toBe(null);
  });

  it('rejects a requestId longer than the cap', () => {
    expect(MAX_REQUEST_ID_LENGTH).toBe(128);
    expect(parseRequest(get('a'.repeat(MAX_REQUEST_ID_LENGTH + 1)))).toBe(null);
  });

  it('accepts a requestId at the cap and at one character', () => {
    expect(parseRequest(get('a'))).toEqual({ type: 'GET_SNAPSHOT', requestId: 'a' });
    expect(parseRequest(get('a'.repeat(MAX_REQUEST_ID_LENGTH)))).not.toBe(null);
  });
});

describe('UNLOAD_EXECUTE and CANCEL_BATCH: well-formed', () => {
  it('accepts an UNLOAD_EXECUTE with no operationId and adds no such property', () => {
    const r = parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto' });
    expect(r).toEqual({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto' });
    expect(r !== null && 'operationId' in r).toBe(false);
  });

  it('accepts an UNLOAD_EXECUTE with a well-formed operationId', () => {
    const raw = { type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'tab', tabId: 4 }, mode: 'manual-single', operationId: 'batch-2026-10-31_1' };
    expect(parseRequest(raw)).toEqual(raw);
  });

  it('accepts a CANCEL_BATCH with a well-formed operationId', () => {
    const raw = { type: 'CANCEL_BATCH', requestId: 'a', operationId: 'batch-2026-10-31_1' };
    expect(parseRequest(raw)).toEqual(raw);
  });

  it('rejects a CANCEL_BATCH with no operationId', () => {
    expect(parseRequest({ type: 'CANCEL_BATCH', requestId: 'a' })).toBe(null);
  });
});

describe('operationId must be one the history layer can store', () => {
  const unstorable = ['a b', 'a/b', 'a?b', 'a#b', 'a\tb', 'a\nb', '', 'a'.repeat(129)];

  it.each(unstorable.map((v) => [v]))('refuses an UNLOAD_EXECUTE whose operationId is %j', (operationId) => {
    expect(parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto', operationId })).toBe(null);
  });

  it.each(unstorable.map((v) => [v]))('refuses a CANCEL_BATCH whose operationId is %j', (operationId) => {
    expect(parseRequest({ type: 'CANCEL_BATCH', requestId: 'a', operationId })).toBe(null);
  });

  it.each([[42], [null], [{}], [['batch']]])('refuses a non-string operationId %j on UNLOAD_EXECUTE', (operationId) => {
    expect(parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto', operationId })).toBe(null);
  });

  it('accepts an operationId at exactly 128 characters', () => {
    const operationId = 'a'.repeat(128);
    expect(parseRequest({ type: 'CANCEL_BATCH', requestId: 'a', operationId })).not.toBe(null);
  });
});

describe('prototype keys, inherited and throwing properties', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('refuses %s as the message type', (type) => {
    expect(parseRequest({ type, requestId: 'a' })).toBe(null);
  });

  it('refuses a type that is only inherited, not an own property', () => {
    const raw = Object.create({ type: 'GET_SNAPSHOT' }) as Record<string, unknown>;
    raw.requestId = 'a';
    expect(parseRequest(raw)).toBe(null);
  });

  it('refuses an own __proto__ key, which JSON.parse creates as data', () => {
    expect(parseRequest(JSON.parse('{"type":"GET_SNAPSHOT","requestId":"a","__proto__":{"x":1}}'))).toBe(null);
  });

  it('refuses a throwing getter without letting the throw escape', () => {
    const raw = { get type(): string { throw new Error('hostile'); }, requestId: 'a' };
    expect(() => parseRequest(raw)).not.toThrow();
    expect(parseRequest(raw)).toBe(null);
  });

  it('does not trust an inherited sender id', () => {
    const sender = Object.create({ id: 'me' }) as { id?: string; url?: string };
    sender.url = 'chrome-extension://me/x.html';
    expect(isTrustedSender(sender, 'me')).toBe(false);
  });

  it('treats a throwing sender getter as untrusted', () => {
    const sender = { id: 'me', get url(): string { throw new Error('hostile'); } };
    expect(() => isTrustedSender(sender, 'me')).not.toThrow();
    expect(isTrustedSender(sender, 'me')).toBe(false);
  });
});

describe('UPDATE_SETTINGS, GET_HISTORY, CLEAR_HISTORY', () => {
  it('accepts a history read and a history clear with only type and requestId', () => {
    expect(parseRequest({ type: 'GET_HISTORY', requestId: 'a' })).toEqual({ type: 'GET_HISTORY', requestId: 'a' });
    expect(parseRequest({ type: 'CLEAR_HISTORY', requestId: 'a' })).toEqual({ type: 'CLEAR_HISTORY', requestId: 'a' });
  });

  it('requires the patch field to be present on UPDATE_SETTINGS', () => {
    expect(parseRequest({ type: 'UPDATE_SETTINGS', requestId: 'a' })).toBe(null);
    expect(parseRequest({ type: 'UPDATE_SETTINGS', requestId: 'a', patch: undefined })).toBe(null);
    expect(parseRequest({ type: 'UPDATE_SETTINGS', requestId: 'a', patch: null })).toBe(null);
  });

  it('passes the patch through by reference, without validating its contents', () => {
    const patch = { inactivityMinutes: -5 };
    const r = parseRequest({ type: 'UPDATE_SETTINGS', requestId: 'a', patch });
    expect(r).not.toBe(null);
    expect(r !== null && r.type === 'UPDATE_SETTINGS' && r.patch).toBe(patch);
  });
});

describe('extra properties are refused, not stripped', () => {
  const base: Array<Record<string, unknown>> = [
    { type: 'GET_SNAPSHOT', requestId: 'a' },
    { type: 'UPDATE_SETTINGS', requestId: 'a', patch: {} },
    { type: 'SET_TAB_PROTECTION', requestId: 'a', tabId: 3, isProtected: true },
    { type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'all' }, mode: 'auto' },
    { type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto' },
    { type: 'CANCEL_BATCH', requestId: 'a', operationId: 'op-1' },
    { type: 'GET_HISTORY', requestId: 'a' },
    { type: 'CLEAR_HISTORY', requestId: 'a' },
  ];

  it.each(base.map((r) => [r.type, r] as const))('refuses an extra field on %s', (_name, raw) => {
    expect(parseRequest({ ...raw, extra: 1 })).toBe(null);
  });

  it('refuses an extra field inside a scope', () => {
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'tab', tabId: 1, extra: 1 }, mode: 'auto' })).toBe(null);
  });

  it('refuses an extra field that is keyed by a symbol', () => {
    const raw = { type: 'GET_SNAPSHOT', requestId: 'a', [Symbol('x')]: 1 };
    expect(parseRequest(raw)).toBe(null);
  });

  it('refuses an extra non-enumerable own field', () => {
    const raw = { type: 'GET_SNAPSHOT', requestId: 'a' };
    Object.defineProperty(raw, 'hidden', { value: 1, enumerable: false });
    expect(parseRequest(raw)).toBe(null);
  });
});

describe('scope.tabIds', () => {
  const preview = (scope: unknown) => ({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope, mode: 'manual-bulk' });

  it.each([
    ['an empty array', []],
    ['a non-array', 1],
    ['a string', '1'],
    ['an object', { 0: 1, length: 1 }],
    ['a string element', [1, '2']],
    ['a duplicate', [1, 1, 1]],
    ['a negative id', [-1]],
    ['a fractional id', [1.5]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a sparse hole', [1, , 3]], // eslint-disable-line no-sparse-arrays
    ['a list over the cap', Array.from({ length: MAX_SCOPE_TAB_IDS + 1 }, (_, i) => i)],
  ])('refuses %s', (_label, tabIds) => {
    expect(parseRequest(preview({ kind: 'tabs', tabIds }))).toBe(null);
  });

  it('accepts a list of distinct ids and copies it rather than keeping the caller array', () => {
    expect(MAX_SCOPE_TAB_IDS).toBe(1000);
    const tabIds = [1, 2, 3];
    const r = parseRequest(preview({ kind: 'tabs', tabIds }));
    expect(r).toEqual(preview({ kind: 'tabs', tabIds: [1, 2, 3] }));
    expect(r !== null && r.type === 'UNLOAD_PREVIEW' && r.scope.kind === 'tabs' && r.scope.tabIds).not.toBe(tabIds);
  });

  it('accepts a list exactly at the cap', () => {
    const tabIds = Array.from({ length: MAX_SCOPE_TAB_IDS }, (_, i) => i);
    expect(parseRequest(preview({ kind: 'tabs', tabIds }))).not.toBe(null);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null])('refuses a single tab scope with tabId %p', (tabId) => {
    expect(parseRequest(preview({ kind: 'tab', tabId }))).toBe(null);
  });

  it('accepts tab id zero, which Chrome can report', () => {
    expect(parseRequest(preview({ kind: 'tab', tabId: 0 }))).not.toBe(null);
  });
});

describe('REGISTER_DASHBOARD_ORIGIN.originTabId and SET_TAB_PROTECTION.tabId', () => {
  const reg = (extra: Record<string, unknown>) => ({ type: 'REGISTER_DASHBOARD_ORIGIN', requestId: 'a', ...extra });

  it('keeps originTabId null as an explicit null, distinct from a missing field', () => {
    const r = parseRequest(reg({ originTabId: null }));
    expect(r).not.toBe(null);
    expect(r !== null && r.type === 'REGISTER_DASHBOARD_ORIGIN' && 'originTabId' in r && r.originTabId).toBe(null);
  });

  it('accepts a numeric originTabId', () => {
    expect(parseRequest(reg({ originTabId: 7 }))).toEqual({ type: 'REGISTER_DASHBOARD_ORIGIN', requestId: 'a', originTabId: 7 });
  });

  it.each([{}, { originTabId: undefined }])('refuses a missing originTabId %p', (extra) => {
    expect(parseRequest(reg(extra))).toBe(null);
  });

  it.each([-1, 1.5, Number.NaN, '7', true])('refuses originTabId %p', (originTabId) => {
    expect(parseRequest(reg({ originTabId }))).toBe(null);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3'])('refuses SET_TAB_PROTECTION tabId %p', (tabId) => {
    expect(parseRequest({ type: 'SET_TAB_PROTECTION', requestId: 'a', tabId, isProtected: true })).toBe(null);
  });

  it.each([1, 'true', null, undefined])('refuses a non-boolean isProtected %p', (isProtected) => {
    expect(parseRequest({ type: 'SET_TAB_PROTECTION', requestId: 'a', tabId: 3, isProtected })).toBe(null);
  });
});

describe('RECORD_MEMORY_SAMPLE.sample', () => {
  const rec = (sample: unknown) => ({ type: 'RECORD_MEMORY_SAMPLE', requestId: 'a', sample });
  const good = { at: 1000, capacityBytes: 16_000, availableBytes: 4_000 };

  it('accepts a well-formed sample and copies it', () => {
    const r = parseRequest(rec(good));
    expect(r).toEqual(rec(good));
    expect(r !== null && r.type === 'RECORD_MEMORY_SAMPLE' && r.sample).not.toBe(good);
  });

  it('accepts available equal to capacity, and available zero', () => {
    expect(parseRequest(rec({ ...good, availableBytes: good.capacityBytes }))).not.toBe(null);
    expect(parseRequest(rec({ ...good, availableBytes: 0 }))).not.toBe(null);
  });

  it.each(['at', 'capacityBytes', 'availableBytes'])('refuses a non-finite %s', (field) => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseRequest(rec({ ...good, [field]: bad }))).toBe(null);
    }
  });

  it('refuses a negative timestamp and negative bytes', () => {
    expect(parseRequest(rec({ ...good, at: -1 }))).toBe(null);
    expect(parseRequest(rec({ ...good, availableBytes: -1 }))).toBe(null);
  });

  it('refuses a zero capacity, which is what an unavailable measurement would look like', () => {
    expect(parseRequest(rec({ ...good, capacityBytes: 0, availableBytes: 0 }))).toBe(null);
  });

  it('refuses available memory greater than capacity', () => {
    expect(parseRequest(rec({ ...good, availableBytes: good.capacityBytes + 1 }))).toBe(null);
  });

  it.each([
    ['a string field', { ...good, at: '1000' }],
    ['a missing field', { at: 1000, capacityBytes: 16_000 }],
    ['an extra field', { ...good, pageTitle: 'x' }],
    ['null', null],
    ['a number', 42],
  ])('refuses a sample that is %s', (_label, sample) => {
    expect(parseRequest(rec(sample))).toBe(null);
  });
});

describe('frozen, null-prototype and Symbol-valued input', () => {
  it('accepts a frozen well-formed request', () => {
    const raw = Object.freeze({ type: 'GET_SNAPSHOT', requestId: 'a' });
    expect(parseRequest(raw)).toEqual({ type: 'GET_SNAPSHOT', requestId: 'a' });
  });

  it('accepts a null-prototype well-formed request', () => {
    const raw = Object.assign(Object.create(null) as Record<string, unknown>, { type: 'GET_SNAPSHOT', requestId: 'a' });
    expect(parseRequest(raw)).toEqual({ type: 'GET_SNAPSHOT', requestId: 'a' });
  });

  it('refuses a Symbol as the message type without throwing', () => {
    const raw = { type: Symbol('GET_SNAPSHOT'), requestId: 'a' };
    expect(() => parseRequest(raw)).not.toThrow();
    expect(parseRequest(raw)).toBe(null);
  });

  it('refuses a Symbol in each string position without throwing', () => {
    const sym = Symbol('x');
    expect(() => parseRequest({ type: 'GET_SNAPSHOT', requestId: sym })).not.toThrow();
    expect(parseRequest({ type: 'GET_SNAPSHOT', requestId: sym })).toBe(null);
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: sym }, mode: 'auto' })).toBe(null);
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'all' }, mode: sym })).toBe(null);
    expect(parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope: { kind: 'all' }, mode: 'auto', operationId: sym })).toBe(null);
  });

  it('trusts a frozen or null-prototype sender only when its own fields match', () => {
    expect(isTrustedSender(Object.freeze({ id: 'me', url: 'chrome-extension://me/x.html' }), 'me')).toBe(true);
    const sender = Object.assign(Object.create(null) as object, { id: 'me', url: 'chrome-extension://me/x.html' });
    expect(isTrustedSender(sender as { id?: string; url?: string }, 'me')).toBe(true);
  });
});

describe('mode and scope must be a coherent pairing', () => {
  const bulkScopes: Array<[string, unknown]> = [
    ['all', { kind: 'all' }],
    ['window', { kind: 'window', windowId: 1 }],
    ['group', { kind: 'group', groupId: 2 }],
    ['tabs of two', { kind: 'tabs', tabIds: [1, 2] }],
    ['tabs of one', { kind: 'tabs', tabIds: [1] }],
  ];

  it.each(bulkScopes)('refuses manual-single on the %s scope, for preview and execute', (_label, scope) => {
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope, mode: 'manual-single' })).toBe(null);
    expect(parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope, mode: 'manual-single' })).toBe(null);
  });

  it('accepts manual-single on a single tab', () => {
    const scope = { kind: 'tab', tabId: 4 };
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope, mode: 'manual-single' })).not.toBe(null);
    expect(parseRequest({ type: 'UNLOAD_EXECUTE', requestId: 'a', scope, mode: 'manual-single' })).not.toBe(null);
  });

  it.each(bulkScopes)('accepts manual-bulk and auto on the %s scope', (_label, scope) => {
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope, mode: 'manual-bulk' })).not.toBe(null);
    expect(parseRequest({ type: 'UNLOAD_PREVIEW', requestId: 'a', scope, mode: 'auto' })).not.toBe(null);
  });
});

describe('isTrustedSender URL hardening', () => {
  it('refuses an id that is a prefix of another id', () => {
    expect(isTrustedSender({ id: 'me', url: 'chrome-extension://mex/x.html' }, 'me')).toBe(false);
  });

  it('refuses a URL with no trailing slash after the id', () => {
    expect(isTrustedSender({ id: 'me', url: 'chrome-extension://me' }, 'me')).toBe(false);
  });

  it('refuses a URL whose scheme or id is in the wrong case', () => {
    expect(isTrustedSender({ id: 'me', url: 'CHROME-EXTENSION://ME/x.html' }, 'me')).toBe(false);
    expect(isTrustedSender({ id: 'me', url: 'chrome-extension://ME/x.html' }, 'me')).toBe(false);
  });

  it.each([
    'chrome-extension://me/../x.html',
    'chrome-extension://me/%2e%2e/x.html',
    'chrome-extension://me/./x.html',
    'chrome-extension://me/dashboard/../../x.html',
  ])('refuses a path with dot segments: %s', (url) => {
    expect(isTrustedSender({ id: 'me', url }, 'me')).toBe(false);
  });

  it('accepts a canonical URL with a query and a fragment', () => {
    expect(isTrustedSender({ id: 'me', url: 'chrome-extension://me/dashboard/index.html?view=1#top' }, 'me')).toBe(true);
  });

  it('refuses everything when the extension id itself is empty', () => {
    expect(isTrustedSender({ id: '', url: 'chrome-extension:///x.html' }, '')).toBe(false);
  });
});

describe('parseRequest and isTrustedSender never throw', () => {
  const trap = (): never => { throw new Error('hostile trap'); };
  const throwingProxy = new Proxy({ type: 'GET_SNAPSHOT', requestId: 'a' }, {
    get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap,
  });
  const revocable = Proxy.revocable({ type: 'GET_SNAPSHOT', requestId: 'a' }, {});
  revocable.revoke();
  const cyclic: Record<string, unknown> = { type: 'GET_SNAPSHOT', requestId: 'a' };
  cyclic.self = cyclic;
  const throwingArray = [1, 2];
  Object.defineProperty(throwingArray, 0, { get: trap, enumerable: true });

  const hostile: unknown[] = [
    undefined, Symbol('s'), 1n, () => 1, new Date(0), new Map(), new Set(), /x/, cyclic,
    throwingProxy, revocable.proxy, throwingArray,
    { type: 1n, requestId: 'a' }, { type: 'GET_SNAPSHOT', requestId: 1n },
    { type: 'UNLOAD_PREVIEW', requestId: 'a', scope: throwingProxy, mode: 'auto' },
    { type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'tabs', tabIds: throwingArray }, mode: 'auto' },
    { type: 'UNLOAD_PREVIEW', requestId: 'a', scope: { kind: 'all' }, mode: throwingProxy },
    { type: 'RECORD_MEMORY_SAMPLE', requestId: 'a', sample: throwingProxy },
  ];

  it('presence-checks a patch without reading into it, so a revoked patch does not throw', () => {
    const raw = { type: 'UPDATE_SETTINGS', requestId: 'a', patch: revocable.proxy };
    expect(() => parseRequest(raw)).not.toThrow();
  });

  it.each(hostile.map((value, index) => [index, value] as const))('parseRequest does not throw on hostile value %i', (_i, value) => {
    expect(() => parseRequest(value)).not.toThrow();
    expect(parseRequest(value)).toBe(null);
  });

  it.each(hostile.map((value, index) => [index, value] as const))('isTrustedSender does not throw on hostile sender %i', (_i, value) => {
    expect(() => isTrustedSender(value as { id?: string; url?: string }, 'me')).not.toThrow();
    expect(isTrustedSender(value as { id?: string; url?: string }, 'me')).toBe(false);
  });

  it('isTrustedSender does not throw on a non-string selfId', () => {
    expect(() => isTrustedSender({ id: 'me', url: 'chrome-extension://me/x' }, undefined as unknown as string)).not.toThrow();
    expect(isTrustedSender({ id: 'me', url: 'chrome-extension://me/x' }, undefined as unknown as string)).toBe(false);
  });
});
