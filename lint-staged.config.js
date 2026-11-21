import { withReactLint } from "@hussmartinez/sdk-config/lint-staged";

// The family's preset, with the React lint after Biome (sdk-core ADR 0063).
export default withReactLint();
