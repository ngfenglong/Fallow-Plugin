import type { Request } from '../shared/messages';

// Distributive Omit: a plain Omit over the Request union keeps only the keys every member
// shares, which would erase each request's payload fields from the type.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RequestBody = DistributiveOmit<Request, 'requestId'>;

// Each call gets its own promise, bound by chrome.runtime.sendMessage to the single reply to
// that call; no shared listener routes replies. The requestId check is a second line: a
// reply that names another request, even one that arrived on this call's channel, is refused.
export function sendRequest<T>(req: RequestBody): Promise<T> {
  const requestId = crypto.randomUUID();
  // Built inside the executor so a synchronous throw from sendMessage becomes a rejection.
  return new Promise<unknown>((resolve, reject) => {
    Promise.resolve(chrome.runtime.sendMessage({ ...req, requestId })).then(resolve, reject);
  }).then((reply) => {
    // Chrome does not type-check what a listener sends back: undefined means nothing answered.
    if (typeof reply !== 'object' || reply === null) throw new Error('The worker sent no usable reply.');
    const r = reply as { ok?: unknown; error?: unknown; data?: unknown; requestId?: unknown };
    if (r.requestId !== requestId) throw new Error('The worker replied to a different request.');
    // An error wins over any data that came with it: the shape is inconsistent, so refuse it.
    if (r.ok === false) throw new Error(typeof r.error === 'string' ? r.error : 'The worker refused the request.');
    if (r.ok !== true || !('data' in r)) throw new Error('The worker sent a malformed reply.');
    return r.data as T;
  });
}
