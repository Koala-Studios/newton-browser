export const DEFAULT_PORT_RANGE = Object.freeze({ first: 17321, last: 17340 });
export const DEFAULT_HOST_URLS = Object.freeze(Array.from(
  { length: DEFAULT_PORT_RANGE.last - DEFAULT_PORT_RANGE.first + 1 },
  (_, index) => `ws://127.0.0.1:${DEFAULT_PORT_RANGE.first + index}`,
));
export const OWNER_LABEL = "Newton Browser";
