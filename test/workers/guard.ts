// Replaces every way a worker could reach the network or start code of its
// own, before anything else in the worker is evaluated (ADR 0028). A call
// is recorded, then throws.

export const forbiddenCalls: string[] = [];

function trap(name: string) {
  return function forbidden(): never {
    forbiddenCalls.push(name);
    throw new Error(`${name} is forbidden in the media worker.`);
  };
}

const scope = globalThis as unknown as Record<string, unknown>;
for (const name of [
  "fetch",
  "XMLHttpRequest",
  "importScripts",
  "Worker",
  "WebSocket",
  "WebTransport",
  "EventSource",
]) {
  Object.defineProperty(scope, name, { value: trap(name), configurable: true, writable: true });
}
URL.createObjectURL = trap("URL.createObjectURL");
