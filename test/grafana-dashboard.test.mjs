import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = JSON.parse(
  await readFile(new URL("../helm/openstreamgrid/dashboards/openstreamgrid.json", import.meta.url), "utf8"),
);
const trackerSource = await readFile(new URL("../tracker/src/server.ts", import.meta.url), "utf8");

test("Grafana panels query only metrics the tracker exports", () => {
  const referenced = new Set();
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      for (const [name] of String(target.expr).matchAll(/openstreamgrid_[a-z0-9_]+/g)) {
        referenced.add(name.replace(/_(bucket|sum|count)$/, ""));
      }
    }
  }
  assert.ok(referenced.size > 0);
  // The tracker writes each metric name literally, as a metric() argument or
  // in a sample line followed by its labels or value.
  const missing = [...referenced].filter(
    (name) =>
      !trackerSource.includes(`"${name}"`) &&
      !trackerSource.includes(`${name}{`) &&
      !trackerSource.includes(`${name} `),
  );
  assert.deepEqual(missing, []);
});

test("Grafana panel ids are unique", () => {
  const ids = dashboard.panels.map((panel) => panel.id);
  assert.equal(new Set(ids).size, ids.length);
});
