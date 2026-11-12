import { type ExposeWorkerOptions, exposeWorker } from "@hussmartinez/sdk-core";
import type { ExportWorkerContract } from "./contract.js";
import { exportPlan } from "./export-plan.js";

/**
 * Answers the export worker's contract (docs/adr/0002). It does nothing on
 * import, so the worker announces itself at once.
 */
export function exposeExportWorker(options?: ExposeWorkerOptions): void {
  exposeWorker<ExportWorkerContract>(
    {
      export: (request, { signal, progress }) =>
        exportPlan(request, progress, signal, (limit) => progress({ warning: limit })),
    },
    options,
  );
}
