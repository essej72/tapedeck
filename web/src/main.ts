// Boot: load the data files, mount the three views, wire the tabs.

import { mountDeck, type Preset } from "./deck.ts";
import { METHOD, mountEvidence, type AfterwardsSummary, type BuildersSummary, type Conformance, type Evidence, type MigrationSummary, type ProbeSummary } from "./evidence.ts";
import { $, getJson, type Library } from "./util.ts";

const VIEWS = ["deck", "evidence", "method"] as const;
function show(view: (typeof VIEWS)[number]): void {
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== view;
    $(`tab-${v}`).setAttribute("aria-selected", String(v === view));
  }
  // canvases measure themselves when visible
  window.dispatchEvent(new Event("resize"));
}

const [lib, evidence, conformance, probe, builders, migration, afterwards] = await Promise.all([getJson<Library>("data/tapes.json"), getJson<Evidence & { presets: Preset[] }>("data/evidence.json"), getJson<Conformance>("data/conformance.json"), getJson<ProbeSummary>("data/probe.json"), getJson<BuildersSummary>("data/builders.json"), getJson<MigrationSummary>("data/migration.json"), getJson<AfterwardsSummary>("data/afterwards.json")]);

$("method").innerHTML = METHOD;
mountEvidence(evidence, conformance, lib, probe, builders, migration, afterwards);
if (lib?.tapes.length) mountDeck(lib, evidence?.presets ?? []);
else $("view-deck").replaceChildren("The tape library is not part of this build. Run node src/flows/library.ts, then npm run build.");

for (const v of VIEWS) $(`tab-${v}`).onclick = () => {
  show(v);
  history.replaceState(null, "", v === "deck" ? location.pathname : `#${v}`);
};
const wanted = location.hash.slice(1) as (typeof VIEWS)[number];
if (VIEWS.includes(wanted) && wanted !== "deck") show(wanted);
