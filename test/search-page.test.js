const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSearchPage } = require("../lib/search-page");

function html(results) { return '<script id="data-deferred-state-0">' + JSON.stringify({ data: { presentation: { staysSearch: { results } } } }) + "</script>"; }

test("extracts listings and unique server-advertised pagination cursors", () => {
  const page = parseSearchPage(html({ searchResults: [{ demandStayListing: { id: "one" } }], paginationInfo: { pageCursors: ["first", "next", "next"] } }));
  assert.equal(page.results.length, 1);
  assert.deepEqual(page.cursors, ["first", "next"]);
});

test("a valid empty result is distinguishable from a challenge or broken response", () => {
  assert.deepEqual(parseSearchPage(html({ searchResults: [], paginationInfo: { pageCursors: [] } })).results, []);
  for (const value of ["<html>blocked</html>", '<script id="data-deferred-state-0">broken</script>', '<script id="data-deferred-state-0">{}</script>']) assert.throws(() => parseSearchPage(value));
});
