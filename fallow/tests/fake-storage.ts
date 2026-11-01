// Scriptable test double for a chrome.storage area. Not a mock library: an in-memory
// key/value store whose behaviour a test steers through plain fields. Values are
// stored by reference, not cloned, so a test can plant hostile raw values (getters
// that throw, prototype keys) exactly as a corrupt store might hold them.
import type { StorageArea } from '../src/platform/storage';

export type FakeArea = StorageArea & {
  data: Map<string, unknown>;
  /** number of set() calls, including seeding through set() */
  writes: number;
  /** number of get() calls */
  gets: number;
  /** number of remove() calls */
  removes: number;
  /** key -> error thrown synchronously by get/set. Use 'get:key' or 'set:key' to target one op. */
  throwOn: Map<string, Error>;
  /** key -> error the get/set promise rejects with. Use 'get:key' or 'set:key' to target one op. */
  rejectOn: Map<string, Error>;
};

export type FakeStorage = { local: FakeArea; session: FakeArea };

function createArea(): FakeArea {
  const area: FakeArea = {
    data: new Map(),
    writes: 0,
    gets: 0,
    removes: 0,
    throwOn: new Map(),
    rejectOn: new Map(),
    get(key: string): Promise<unknown> {
      area.gets++;
      const thrown = area.throwOn.get(`get:${key}`) ?? area.throwOn.get(key);
      if (thrown) throw thrown;
      const rejected = area.rejectOn.get(`get:${key}`) ?? area.rejectOn.get(key);
      if (rejected) return Promise.reject(rejected);
      return Promise.resolve(area.data.get(key));
    },
    set(key: string, value: unknown): Promise<void> {
      area.writes++;
      const thrown = area.throwOn.get(`set:${key}`) ?? area.throwOn.get(key);
      if (thrown) throw thrown;
      const rejected = area.rejectOn.get(`set:${key}`) ?? area.rejectOn.get(key);
      if (rejected) return Promise.reject(rejected);
      area.data.set(key, value);
      return Promise.resolve();
    },
    remove(key: string): Promise<void> {
      area.removes++;
      const thrown = area.throwOn.get(`remove:${key}`) ?? area.throwOn.get(key);
      if (thrown) throw thrown;
      const rejected = area.rejectOn.get(`remove:${key}`) ?? area.rejectOn.get(key);
      if (rejected) return Promise.reject(rejected);
      // A real delete, so `data.has(key)` goes false. Storing undefined would leave the key
      // present and make a "cleared" assertion pass while nothing was cleared.
      area.data.delete(key);
      return Promise.resolve();
    },
  };
  return area;
}

export function createFakeStorage(): FakeStorage {
  return { local: createArea(), session: createArea() };
}
