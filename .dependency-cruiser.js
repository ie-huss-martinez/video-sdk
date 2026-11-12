import preset from "@hussmartinez/sdk-config/dependency-cruiser";

/**
 * mediabunny is bundled into the workers from an exactly pinned
 * devDependency, rather than installed by applications (docs/adr/0001).
 * Only its adapter may import it; everywhere else in src/, the preset's rule
 * against devDependencies applies as is.
 */
const ENGINE_ADAPTER = "(?:^|/)src/adapters/mediabunny/";
const engine = "(?:^|/)node_modules/mediabunny/";

/** Test files, which may import the test runner from any layer. */
const TEST_FILE = "\\.test\\.[cm]?[jt]sx?$";

const forbidden = preset.forbidden.flatMap((rule) => {
  // TODO(sdk-config): the preset's layer-errors rule also covers tests in
  // core/errors, which import vitest; only the anchored exclude below shows it.
  if (rule.name === "layer-errors")
    return [{ ...rule, from: { ...rule.from, pathNot: TEST_FILE } }];
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

/**
 * The preset excludes any path containing `dist/`, which also drops every
 * import that resolves into a package's `dist/` folder, such as mediabunny's,
 * so no rule sees it. Exclude only this repository's own build and fixture
 * folders. TODO(sdk-config): remove once the preset anchors its exclude.
 */
const exclude = { path: "^(?:coverage|dist|temp)/|(?:^|/)fixtures/" };

export default { ...preset, forbidden, options: { ...preset.options, exclude } };
