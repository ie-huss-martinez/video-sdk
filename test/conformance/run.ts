import { conforms } from "@hussmartinez/sdk-config/testing/conformance";
import {
  createVideoReducer,
  readVideoPlanDocument,
  toVideoPlanDocument,
  type VideoCommand,
  type VideoPlanDocument,
} from "../../src/index.js";

/**
 * How the TypeScript SDK runs each conformance subject: what a port in
 * another language implements too (sdk-core ADR 0045). There's one runner
 * per subject, shared by the generator that writes the cases and the tests
 * that check them.
 */

/** `hm-video-plan`: a document read and written back, as a reader normalises it. */
export function readAndWrite(document: unknown): VideoPlanDocument {
  const { plan, sources } = readVideoPlanDocument(document);
  return toVideoPlanDocument(plan, sources);
}

/**
 * `hm-video-commands`: a command applied to a plan document, giving the new
 * document. Its inverse must restore the plan exactly, though the inverse's
 * own shape is internal and isn't compared.
 */
export function applyToDocument(input: { plan: unknown; command: unknown }): VideoPlanDocument {
  const { plan, sources } = readVideoPlanDocument(input.plan);
  const reduce = createVideoReducer((id) => {
    const source = sources.get(id);
    return (
      source && {
        duration: source.duration,
        video: { width: source.width, height: source.height, rotation: source.rotation },
      }
    );
  });
  const { state, inverse } = reduce(plan, input.command as VideoCommand);
  const undone = reduce(state, inverse).state;
  if (!conforms(toVideoPlanDocument(undone, sources), toVideoPlanDocument(plan, sources))) {
    throw new Error("The command's inverse didn't restore the plan.");
  }
  return toVideoPlanDocument(state, sources);
}
