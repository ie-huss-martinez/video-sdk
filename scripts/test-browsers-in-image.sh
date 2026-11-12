#!/usr/bin/env bash
# Runs the browser tests on Chromium, Firefox and WebKit in the pinned browser
# image of ci/Dockerfile, as CI does (ADR 0025 in sdk-core), against this
# checkout. The capability matrix (docs/capabilities.md) is checked only
# there, because another machine's browsers can differ: Playwright's WebKit
# on Linux takes its codecs from the system's GStreamer plugins.
# Run `pnpm install` first. Extra arguments go to Vitest.
set -euo pipefail
cd "$(dirname "$0")/.."
image="$(sed -n 's/^FROM //p' ci/Dockerfile)"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env CI=1 \
  --ipc=host \
  --volume "$PWD:/work" \
  --workdir /work \
  "$image" \
  node node_modules/vitest/vitest.mjs run --project browser "$@"
