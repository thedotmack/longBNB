"use strict";

/** Read Airbnb's public search payload, including its own pagination cursors. */
function parseSearchPage(html) {
  const match = html.match(/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("search response missing data");
  const root = JSON.parse(match[1]);
  const results = [], cursors = new Set();
  let hasSearch = false;
  (function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.staysSearch?.results) hasSearch = true;
    if (value.demandStayListing) results.push(value);
    if (value.paginationInfo?.pageCursors) {
      for (const cursor of value.paginationInfo.pageCursors) if (typeof cursor === "string" && cursor.length <= 2000) cursors.add(cursor);
    }
    for (const child of Object.values(value)) walk(child);
  })(root);
  if (!hasSearch && !results.length) throw new Error("search payload has no listing results");
  return { results, cursors: [...cursors] };
}

module.exports = { parseSearchPage };
