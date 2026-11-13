import preset from "@hussmartinez/sdk-config/dependency-cruiser";

/**
 * mediabunny is bundled into the workers from an exactly pinned
 * devDependency, rather than installed by applications (docs/adr/0001).
 * Only its adapter may import it; everywhere else in src/, the preset's rule
 * against devDependencies applies as is.
 */
const ENGINE_ADAPTER = "(?:^|/)src/adapters/mediabunny/";
const engine = "(?:^|/)node_modules/mediabunny/";

const forbidden = preset.forbidden.flatMap((rule) => {
  if (rule.name !== "not-to-dev-dep") return [rule];
  return [
    { ...rule, from: { ...rule.from, pathNot: [rule.from.pathNot, ENGINE_ADAPTER].flat() } },
    {
      ...rule,
      name: "not-to-dev-dep-except-mediabunny",
      comment:
        "Only src/adapters/mediabunny/ may import mediabunny, the bundled engine (docs/adr/0001).",
      from: { ...rule.from, path: ENGINE_ADAPTER },
      to: { ...rule.to, pathNot: [rule.to.pathNot, engine].flat().filter(Boolean) },
    },
  ];
});

export default { ...preset, forbidden };
