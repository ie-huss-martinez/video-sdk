/**
 * The package's version, set at build time, which the workers announce and
 * the clients check, so a self-hosted worker from another release is refused
 * before any call reaches it (sdk-core ADR 0038).
 *
 * @internal
 */
export const PACKAGE_VERSION: string = __VIDEO_SDK_VERSION__;
