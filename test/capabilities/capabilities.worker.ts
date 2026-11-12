// Measures, in a worker, what WebCodecs offers for each codec in the matrix.
import { type Capabilities, CODECS, WORKER_FEATURES } from "./matrix.js";

type Measured = Pick<Capabilities, "worker" | "decode" | "encode">;

async function supported(api: unknown, config: object): Promise<boolean> {
  if (typeof api !== "function") return false;
  try {
    const codecs = api as unknown as {
      isConfigSupported(c: object): Promise<{ supported?: boolean }>;
    };
    return (await codecs.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

self.onmessage = async () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  const result = { worker: {}, decode: {}, encode: {} } as {
    worker: Record<string, boolean>;
    decode: Record<string, boolean>;
    encode: Record<string, boolean>;
  };
  for (const feature of WORKER_FEATURES)
    result.worker[feature] = typeof scope[feature] === "function";
  for (const { id, kind, codec } of CODECS) {
    if (kind === "video") {
      result.decode[id] = await supported(scope["VideoDecoder"], {
        codec,
        codedWidth: 1280,
        codedHeight: 720,
      });
      result.encode[id] = await supported(scope["VideoEncoder"], {
        codec,
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });
    } else {
      const audio = { codec, sampleRate: 48_000, numberOfChannels: 2 };
      result.decode[id] = await supported(scope["AudioDecoder"], audio);
      result.encode[id] = await supported(scope["AudioEncoder"], { ...audio, bitrate: 128_000 });
    }
  }
  postMessage(result as Measured);
};
