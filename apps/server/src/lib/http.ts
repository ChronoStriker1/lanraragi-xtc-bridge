import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function streamFileAsResponse(params: {
  filePath: string;
  downloadName: string;
  contentType?: string;
  onDone?: () => void;
}): Promise<Response> {
  const fileInfo = await stat(params.filePath);
  const stream = createReadStream(params.filePath);
  if (params.onDone) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      params.onDone?.();
    };
    stream.on("close", finish);
    stream.on("error", finish);
  }

  return new Response(stream as unknown as BodyInit, {
    headers: {
      "content-type": params.contentType ?? "application/octet-stream",
      "content-length": String(fileInfo.size),
      "content-disposition": `attachment; filename=\"${params.downloadName}\"`,
      "cache-control": "no-store",
    },
  });
}
