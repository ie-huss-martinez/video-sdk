// Removes WebCodecs' audio decoder and encoder from this worker, as a
// browser without them would have it (docs/adr/0008). Imported first, so
// they're gone before anything else is evaluated.
for (const name of ["AudioDecoder", "AudioEncoder"]) {
  Reflect.deleteProperty(globalThis, name);
}

export {};
