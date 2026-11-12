// The media worker (docs/adr/0002): checks and probes files behind the
// family's worker RPC, reading them with mediabunny (docs/adr/0001). It makes
// no requests.
import { exposeMediaWorker } from "../adapters/media-worker/expose.js";

exposeMediaWorker();
