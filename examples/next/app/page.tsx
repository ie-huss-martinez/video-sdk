/**
 * A Server Component, rendered for each request so it carries the request's
 * nonce. It renders the editor from the client entry directly, which only
 * works if its "use client" directive survived the build (sdk-core ADR 0007).
 * The workers start from public/video-sdk/, under worker-src 'self'.
 */
import { VideoEditor } from "@hussmartinez/video-sdk/react";
import { connection } from "next/server";

export default async function Page() {
  await connection();
  return (
    <main>
      <h1>The video editor, with its workers self-hosted</h1>
      <div className="example-frame">
        <VideoEditor assetsUrl="/video-sdk/" />
      </div>
    </main>
  );
}
