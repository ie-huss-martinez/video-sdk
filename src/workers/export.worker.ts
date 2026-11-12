// The export worker (docs/adr/0002, docs/adr/0005): decodes, composes, mixes
// and encodes a plan into a file, behind the family's worker RPC, reading and
// writing containers with mediabunny (docs/adr/0001). It makes no requests.
import { exposeExportWorker } from "../adapters/export-worker/expose.js";

exposeExportWorker();
