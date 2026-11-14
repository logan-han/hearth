/** A stand-in for next/headers' cookies(): the routes and pages read and write `store`, which a test can set or clear. */
const store = new Map<string, string>()

export const jar = {
  store,
  cookies: async () => ({
    get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
    set: (k: string, v: string) => void store.set(k, v),
    delete: (k: string) => void store.delete(k),
  }),
}
