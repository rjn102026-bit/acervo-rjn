import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

// Compile the actual pure module, using the same TypeScript dependency as the app.
const source = await readFile(
  new URL("../src/catalog.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const {
  searchCaptures,
  groupReviewItems,
  filterReviewItems,
  reviewBaseline,
  reviewDraftChanged,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const asset = (id, recorded_at) => ({
  asset_id: id,
  original_name: `${id}.mp4`,
  original_relative_path: `${id}.mp4`,
  copy_relative_path: `originals/${id}.mp4`,
  status: "verified",
  metadata: { kind: "video", recorded_at },
});
const capture = (id, name, assets) => ({
  capture_id: id,
  workspace_id: "pessoal",
  capture_name: name,
  brief: "",
  visited_locations: [],
  created_at: "2026-10-24T12:00:00Z",
  verified_count: assets.length,
  failed_count: 0,
  manifest_path: "manifest.json",
  assets,
});
const item = (id, matter, status = "confirmed") => ({
  asset_id: id,
  original_name: `${id}.mp4`,
  evidence: [],
  suggestion: null,
  history: [],
  decision: {
    event_id: id,
    status,
    location: status === "confirmed" ? "Shopping Vitória" : null,
    matter,
    category: "Comércio",
    tags: ["lojas"],
    note: "",
    reviewed_at: "2026-10-24T12:00:00Z",
  },
  organization: {
    event_id: id,
    source: "human",
    location: status === "confirmed" ? "Shopping Vitória" : null,
    category: "Comércio",
    matter,
    tags: ["lojas"],
    requires_review: false,
    reason: "Revisado",
  },
});

test("a tag in another capture cannot hide a capture-name match", () => {
  const captures = [
    capture("A", "Comércio", [asset("a")]),
    capture("B", "Praia", [asset("b")]),
  ];
  const index = [
    {
      capture_id: "B",
      asset_id: "b",
      status: "pending",
      location: null,
      matter: "",
      tags: ["comércio"],
    },
  ];
  assert.deepEqual(
    searchCaptures(captures, index, "comercio").map(
      (value) => value.capture.capture_id,
    ),
    ["A", "B"],
  );
});
test("recorded dates locate the matching media, without unrelated files", () => {
  const result = searchCaptures(
    [
      capture("A", "Praia", [
        asset("a", "2026-09-18T12:00:00Z"),
        asset("b", "2026-09-19T12:00:00Z"),
      ]),
    ],
    [],
    "18/09/2026",
  );
  assert.deepEqual(
    result[0].assets.map((value) => value.asset_id),
    ["a"],
  );
});
test("location and matter are both part of the grouping key", () => {
  const groups = [
    ...groupReviewItems(
      [item("a", "Vendas"), item("b", "Empregos")],
      "Captura",
    ).values(),
  ];
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((value) => value.location),
    ["Shopping Vitória", "Shopping Vitória"],
  );
  assert.deepEqual(
    groups.map((value) => value.matter),
    ["Vendas", "Empregos"],
  );
});
test("unidentified location stays distinct from confirmed and suggested", () => {
  const unknown = item("u", "Vendas", "unidentified");
  assert.equal(
    [...groupReviewItems([unknown], "Captura").values()][0].state,
    "unidentified",
  );
  assert.equal(
    [...groupReviewItems([unknown], "Captura").values()][0].location,
    "Local não identificado",
  );
  const suggested = {
    ...item("s", "Vendas"),
    decision: null,
    organization: null,
    suggestion: { location: "Praia", reason: "GPS", confidence: 0.8 },
  };
  assert.equal(
    [...groupReviewItems([suggested], "Captura").values()][0].state,
    "suggested",
  );
});
test("AI location does not create a human confirmation in the editor", () => {
  const value = item("ai", "Vendas");
  value.decision = null;
  value.organization.source = "ai";
  assert.equal(reviewBaseline(value).status, "pending");
  assert.equal(filterReviewItems([value], "confirmed").length, 0);
  assert.equal(filterReviewItems([value], "high").length, 1);
});

test("human and AI takes share one local-and-matter group without hiding uncertainty", () => {
  const human = item("human", "Vendas");
  const ai = item("ai", "Vendas");
  ai.decision = null;
  ai.organization.source = "ai";
  const groups = [...groupReviewItems([human, ai], "Captura").values()];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].state, "ai");
});

test("an intentionally empty matter is not replaced with the capture title", () => {
  const value = item("a", "");
  assert.equal(
    [...groupReviewItems([value], "Pauta geral").values()][0].matter,
    "Sem matéria identificada",
  );
});
test("draft comparison preserves empty corrections and detects actual changes", () => {
  const value = item("a", "Vendas");
  const baseline = reviewBaseline(value);
  assert.equal(
    reviewDraftChanged(value, { ...baseline, tags: " lojas " }),
    false,
  );
  assert.equal(reviewDraftChanged(value, { ...baseline, matter: "" }), true);
  assert.equal(
    reviewDraftChanged(value, { ...baseline, status: "pending" }),
    true,
  );
});
