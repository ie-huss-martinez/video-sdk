# video-sdk

A client-side video SDK: trim, split, arrange, rotate, crop and export videos entirely in the browser. Videos never leave the device. It offers a headless core, a React editor (`VideoEditor`) and a `<hm-video-editor>` custom element.

This repository will publish **`@hussmartinez/video-sdk`**. It follows the family standards in [`sdk-core`'s `STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md), and in particular the decisions on [hostile input and no network](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md), [workers and assets](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0011-worker-messaging-and-assets.md) and [ports and adapters](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md).

> Status: being bootstrapped. No packages are published yet.

## Development

The repository root is the published package, laid out as in the family's [standard layout](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md#repository-layout): the source is in [`src`](src). The pnpm workspace also holds the test applications ([ADR 0039](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0039-test-applications-in-each-repository.md)): [`examples/vite`](examples/vite) and [`examples/next`](examples/next), which run the built editor with its workers inlined and self-hosted, each under its Content Security Policy, and the [`e2e`](e2e) Playwright suite that tests them.

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. The exact pnpm version is pinned in `package.json`, and pnpm switches to it automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs
pnpm verify:fast   # the subset the pre-push hook runs
```

Browser tests, the end-to-end tests and the screenshots run in the pinned browser image of `ci/Dockerfile`, as CI's do, through `hm-in-image` from [`@hussmartinez/sdk-config`](https://www.npmjs.com/package/@hussmartinez/sdk-config) ([sdk-core ADR 0049](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0049-local-browser-tests-in-the-pinned-image.md)). So they need Docker, and no browsers installed on the machine: the host's own libraries and network changes can't affect them. Pass a test file to run only it, such as `pnpm test:browser test/playback.browser.test.ts`, and use `pnpm test:browser:all` for all three engines. The [capability matrix](docs/capabilities.md) is checked there too.

`pnpm verify` runs, in order:

| Step | Script | Tool |
|---|---|---|
| Format and lint | `lint` | Biome |
| CSS rules | `lint:css` | stylelint, with the `hm-` namespace and token rules |
| Types | `typecheck` | TypeScript |
| Dependency rules | `lint:deps` | dependency-cruiser, through `hm-lint-deps` |
| Build | `build` | Vite, then api-extractor for the type declarations |
| Unit tests | `test` | Vitest |
| Browser tests | `test:browser` | Vitest in the browser image, in Chromium, and in Firefox and WebKit too in CI |
| Example builds | `build:examples` | Vite and Next.js, on the workspace's build of the package |
| End-to-end tests | `test:e2e` | Playwright in the browser image, against the built examples, in Chromium, and all three engines in CI |
| Screenshots | `test:visual` | Playwright, in the pinned browser image through Docker; `test:visual:update` rewrites the baselines ([sdk-core ADR 0048](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0048-visual-regression-for-sdk-editors.md)) |
| Size budgets | `check:size` | size-limit, brotli size of each entry point |
| API reports | `check:api` | api-extractor, one report per entry point in [`api`](api) |
| Package checks | `check:package` | publint and Are the Types Wrong? |

The configuration extends the shared presets in [`@hussmartinez/sdk-config`](https://www.npmjs.com/package/@hussmartinez/sdk-config). The git hooks ([ADR 0016](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0016-git-hooks-and-merge-guards.md)) run automatically: a secret scan and lint of staged files on commit, a Conventional Commits check of the message, and `pnpm verify:fast` on push.

When a change alters the public API on purpose, update the reports with `pnpm api:update` and commit them.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Coding agents also start with [`AGENTS.md`](AGENTS.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in the [security policy](SECURITY.md).

## License

[Apache-2.0](LICENSE)
