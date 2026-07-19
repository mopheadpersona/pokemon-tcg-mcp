import { TtlLruCache } from "./cache.js";
import { LIMITLESS_BASE, META_TTL_MS } from "./config.js";
import { httpGetText } from "./http.js";

/**
 * DATA SOURCE NOTE — clearly marked fallback per project spec:
 * Limitless TCG's documented API (docs.limitlesstcg.com) covers its online
 * tournament platform, but there is no public JSON endpoint for the
 * aggregated metagame-share table on limitlesstcg.com/decks. As sanctioned
 * by the spec ("a light fetch of public deck list pages is acceptable as
 * fallback"), this module performs a single, cached (1h), identified GET of
 * that public page and parses its one stats table. No crawling, no
 * pagination, no aggressive scraping.
 */

export interface MetaRow {
  rank: number;
  name: string;
  points: number;
  share: string;
  url: string;
}

export interface MetaSnapshot {
  format: string;
  sourceUrl: string;
  rows: MetaRow[];
}

const cache = new TtlLruCache(10);

const ROW_RE =
  /<tr>\s*<td>(\d+)<\/td>.*?<a href="(\/decks\/[^"]+)">(.*?)<\/a>.*?<td>([\d,]+)<\/td>\s*<td>([\d.]+)%<\/td>/gs;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchMetaSnapshot(format: string): Promise<MetaSnapshot> {
  const sourceUrl =
    format === "standard" ? `${LIMITLESS_BASE}/decks` : `${LIMITLESS_BASE}/decks?format=${encodeURIComponent(format)}`;
  return cache.getOrLoad(`meta:${format}`, META_TTL_MS, async () => {
    const html = await httpGetText(sourceUrl);
    const rows: MetaRow[] = [];
    for (const match of html.matchAll(ROW_RE)) {
      rows.push({
        rank: Number(match[1]),
        url: `${LIMITLESS_BASE}${match[2]}`,
        name: stripTags(match[3]),
        points: Number(match[4].replace(/,/g, "")),
        share: `${match[5]}%`,
      });
    }
    if (rows.length === 0) {
      throw new Error(`could not find the deck stats table at ${sourceUrl} (page layout may have changed)`);
    }
    return { format, sourceUrl, rows };
  });
}
