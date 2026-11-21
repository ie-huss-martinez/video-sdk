import { defineDependencyRules } from "@hussmartinez/sdk-config/dependency-cruiser";

/**
 * The family's rules, with the one engine this package bundles declared
 * (sdk-core ADR 0061): mediabunny, built into the workers from an exactly
 * pinned devDependency rather than installed by applications
 * (docs/adr/0001). Only src/adapters/mediabunny/ may import it, as a value or
 * as a type; everywhere else in src/, it's a devDependency like any other.
 * `pnpm check:bundled-engines` checks the pin.
 */
const rules = defineDependencyRules({
  bundledEngines: [{ packages: ["mediabunny"], from: "adapters/mediabunny" }],
});

/**
 * The package's imports of its inlined workers (`#hm-video-*`) name built
 * files, which don't exist before a build. tsconfig.json's paths map them to
 * their source, as for typecheck, so the layer rules check those edges too
 * (sdk-core ADR 0060).
 */
// Set on the configuration itself, not on a copy: a spread would drop the
// declaration hm-check-bundled-engines reads from it.
rules.options = { ...rules.options, tsConfig: { fileName: "tsconfig.json" } };

export default rules;
