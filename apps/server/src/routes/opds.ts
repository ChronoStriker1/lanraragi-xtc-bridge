import { Hono } from "hono";
import { z } from "zod";
import { convertArchiveToXtc } from "../lib/conversion";
import type { AppConfig } from "../lib/config";
import { defaultConversionSettings } from "../lib/settings";
import { streamFileAsResponse } from "../lib/http";
import type { LanraragiConnectionManager } from "../lib/lanraragi-connection";
import { opdsDateFromUnix, xmlEscape } from "../lib/xml";

const querySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(40),
  sortby: z.enum(["title", "progress", "lastreadtime", "size", "time_read", "date_added"]).default("title"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

function qs(input: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === "") continue;
    u.set(k, String(v));
  }
  const rendered = u.toString();
  return rendered ? `?${rendered}` : "";
}

export function createOpdsRouter(config: AppConfig, lanraragi: LanraragiConnectionManager): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.text("Invalid query", 400);
    }

    const { q, page, pageSize, sortby, order } = parsed.data;
    const start = (page - 1) * pageSize;

    const result = await lanraragi.getClient().searchArchives({
      filter: q ?? "",
      start,
      sortby,
      order,
    });

    const entries = result.data.slice(0, pageSize);
    const updated = new Date().toISOString();

    const selfLink = `${config.SERVER_PUBLIC_URL}/opds${qs({ q, page, pageSize, sortby, order })}`;
    const nextLink =
      start + entries.length < result.recordsFiltered
        ? `${config.SERVER_PUBLIC_URL}/opds${qs({ q, page: page + 1, pageSize, sortby, order })}`
        : "";
    const prevLink = page > 1 ? `${config.SERVER_PUBLIC_URL}/opds${qs({ q, page: page - 1, pageSize, sortby, order })}` : "";

    const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(config.SERVER_PUBLIC_URL)}/opds</id>
  <title>LANraragi XTC Catalog</title>
  <updated>${updated}</updated>
  <author><name>lanraragi-xtc-bridge</name></author>
  <link rel="self" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="${xmlEscape(selfLink)}"/>
  ${nextLink ? `<link rel="next" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="${xmlEscape(nextLink)}"/>` : ""}
  ${prevLink ? `<link rel="previous" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="${xmlEscape(prevLink)}"/>` : ""}
  <subtitle>Total ${result.recordsFiltered} archives. Sorted by ${xmlEscape(sortby)} ${xmlEscape(order)}.</subtitle>
  ${entries
    .map((arc) => {
      const id = encodeURIComponent(arc.arcid);
      const title = xmlEscape(arc.title || arc.filename || arc.arcid);
      const summary = xmlEscape(arc.summary || "");
      const tags = xmlEscape(arc.tags || "");
      const thumb = `${config.SERVER_PUBLIC_URL}/api/archives/${id}/thumbnail`;
      const download = `${config.SERVER_PUBLIC_URL}/opds/download/${id}.xtc`;
      const updatedAt = opdsDateFromUnix(arc.lastreadtime);

      return `<entry>
    <id>${xmlEscape(config.SERVER_PUBLIC_URL)}/opds/item/${id}</id>
    <title>${title}</title>
    <updated>${updatedAt}</updated>
    <summary>${summary}</summary>
    <category term="tags" label="${tags}"/>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${xmlEscape(thumb)}"/>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="${xmlEscape(download)}"/>
    <link rel="http://opds-spec.org/acquisition" type="application/octet-stream" href="${xmlEscape(download)}"/>
  </entry>`;
    })
    .join("\n")}
</feed>`;

    return c.body(body, 200, {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/download/:id.xtc", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.text("Missing archive id", 400);

    const artifact = await convertArchiveToXtc({
      config,
      lrr: lanraragi.getClient(),
      archiveId: id,
      settings: defaultConversionSettings,
    });
    return streamFileAsResponse({
      filePath: artifact.filePath,
      downloadName: artifact.downloadName,
      contentType: "application/octet-stream",
      onDone: () => {
        void artifact.dispose();
      },
    });
  });

  return app;
}
