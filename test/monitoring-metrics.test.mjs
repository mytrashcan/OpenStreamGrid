import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = JSON.parse(
  await readFile(new URL("../helm/openstreamgrid/dashboards/openstreamgrid.json", import.meta.url), "utf8"),
);
const trackerSource = await readFile(new URL("../tracker/src/server.ts", import.meta.url), "utf8");
const prometheusRule = await readFile(
  new URL("../helm/openstreamgrid/templates/prometheus-rule.yaml", import.meta.url),
  "utf8",
);

// The tracker writes metric names literally (as a metric() argument, or in a
// sample line followed by labels or a value) or as template strings such as
// `openstreamgrid_event_loop_delay_${name}_seconds`.
const templatedNames = [...trackerSource.matchAll(/openstreamgrid_[a-z0-9_]*\$\{[^}]+\}[a-z0-9_]*/g)].map(
  ([template]) => new RegExp(`^${template.replace(/\$\{[^}]+\}/g, "[a-z0-9]+")}$`),
);
const unexported = (names) =>
  [...names].filter(
    (name) =>
      !trackerSource.includes(`"${name}"`) &&
      !trackerSource.includes(`${name}{`) &&
      !trackerSource.includes(`${name} `) &&
      !templatedNames.some((pattern) => pattern.test(name)),
  );

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
  assert.deepEqual(unexported(referenced), []);
});

test("Prometheus alert rules query only metrics the tracker exports", () => {
  const referenced = new Set(
    [...prometheusRule.matchAll(/openstreamgrid_[a-z0-9_]+/g)].map(([name]) => name),
  );
  assert.ok(referenced.size > 0);
  assert.deepEqual(unexported(referenced), []);
});

test("Grafana panel ids are unique", () => {
  const ids = dashboard.panels.map((panel) => panel.id);
  assert.equal(new Set(ids).size, ids.length);
});
