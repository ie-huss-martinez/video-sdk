/** The editor with its workers inlined, started from blob: URLs, under worker-src blob:. */
import { VideoEditor } from "@hussmartinez/video-sdk/react";
import { connection } from "next/server";

export default async function Page() {
  await connection();
  return (
    <main>
      <h1>The video editor, with its workers inlined</h1>
      <div className="example-frame">
        <VideoEditor />
      </div>
    </main>
  );
}
