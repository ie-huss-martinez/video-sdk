import { defineReactLint } from "@hussmartinez/sdk-config/eslint-react";

// React's own lint plugin, and nothing else: Biome stays the linter and
// formatter (sdk-core ADR 0063). Every rule is on.
export default await defineReactLint();
