import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createInclinedPlaneScenario, IRON, type Recording } from "@sandbox/schema";
import { runScenario } from "@sandbox/core";

import { directionAt, Playhead, recordingDuration, snapshotAt } from "../src/playback.js";
import { latticeSiteCount } from "../src/layers/atomic.js";
import { scenarioInventory } from "../src/common.js";

const recording: Recording = runScenario(createInclinedPlaneScenario());

describe("Interpolation der Aufzeichnung", () => {
  it("gibt an den Stuetzstellen genau die aufgezeichneten Werte zurueck", () => {
    for (const snapshot of recording.snapshots.slice(0, 20)) {
      const interpolated = snapshotAt(recording, snapshot.t);
      const a = snapshot.entities["klotz"]?.mechanics;
      const b = interpolated.entities["klotz"]?.mechanics;
      if (!a) continue;
      assert.ok(b, `t=${snapshot.t}: Klotz fehlt`);
      for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(
          Math.abs(b.position[axis]! - a.position[axis]!) < 1e-12,
          `t=${snapshot.t}, Achse ${axis}: ${b.position[axis]} statt ${a.position[axis]}`,
        );
      }
    }
  });

  it("liegt zwischen zwei Stuetzstellen genau in der Mitte", () => {
    const first = recording.snapshots[10]!;
    const second = recording.snapshots[11]!;
    const middle = snapshotAt(recording, (first.t + second.t) / 2);
    const a = first.entities["klotz"]!.mechanics!;
    const b = second.entities["klotz"]!.mechanics!;
    const m = middle.entities["klotz"]!.mechanics!;
    for (let axis = 0; axis < 3; axis += 1) {
      const expected = (a.position[axis]! + b.position[axis]!) / 2;
      assert.ok(
        Math.abs(m.position[axis]! - expected) < 1e-12,
        `Achse ${axis}: ${m.position[axis]} statt ${expected}`,
      );
    }
  });

  it("zeigt am Zeitcursor eines Eingriffs schon dessen Wirkung", () => {
    // 1,24 s und 2,37 s liegen zwischen den Schnappschuessen bei 20 Hz.
    const scenario = createInclinedPlaneScenario();
    scenario.interventions = scenario.interventions.map((intervention) =>
      intervention.op === "add" && intervention.entityId === "klotz" ?{ ...intervention, t: 1.24 } : intervention,
    );
    scenario.interventions.push({ op: "remove", t: 2.37, entityId: "klotz" });
    const edited = runScenario(scenario);
    assert.equal(snapshotAt(edited, 1.239).entities["klotz"], undefined, "Klotz vor dem Einfuegen da");
    assert.ok(snapshotAt(edited, 1.24).entities["klotz"], "Klotz am Einfuegezeitpunkt unsichtbar");
    assert.ok(snapshotAt(edited, 2.369).entities["klotz"], "Klotz vor dem Entfernen schon weg");
    assert.equal(snapshotAt(edited, 2.37).entities["klotz"], undefined, "Klotz am Entfernzeitpunkt noch da");
  });

  it("haelt die Raender, statt zu extrapolieren", () => {
    const before = snapshotAt(recording, -5);
    const after = snapshotAt(recording, 999);
    assert.deepEqual(
      before.entities["klotz"]!.mechanics!.position,
      recording.snapshots[0]!.entities["klotz"]!.mechanics!.position,
    );
    assert.deepEqual(
      after.entities["klotz"]!.mechanics!.position,
      recording.snapshots.at(-1)!.entities["klotz"]!.mechanics!.position,
    );
  });

  it("haelt das interpolierte Quaternion normiert", () => {
    const rotating = runScenario({
      ...createInclinedPlaneScenario(),
      simulation: { dt: 0.001, recordRate: 20, seed: 1 },
      entities: createInclinedPlaneScenario().entities.map((entity) =>
        entity.kind === "body"
          ? { ...entity, velocity: { linear: [0, 0, 0], angular: [4, 2, 7] } }
          : entity,
      ),
      // Endet vor dem Anhalten bei t = 2 s - der Eingriff bleibt stehen, wirkt aber nicht.
      duration: 1,
    });
    for (let t = 0; t < 1; t += 0.00731) {
      const state = snapshotAt(rotating, t).entities["klotz"]?.mechanics;
      if (!state) continue;
      const [x, y, z, w] = state.orientation;
      const length = Math.sqrt(x * x + y * y + z * z + w * w);
      assert.ok(Math.abs(length - 1) < 1e-12, `t=${t}: |q| war ${length}`);
    }
  });

  it("findet die richtige Stuetzstelle auch in einer langen Aufzeichnung", () => {
    // Die binaere Suche muss ueber den ganzen Bereich korrekt sein, nicht nur
    // am Anfang.
    const long = runScenario({
      ...createInclinedPlaneScenario(),
      simulation: { dt: 0.001, recordRate: 200, seed: 1 },
    });
    assert.ok(long.snapshots.length > 700, `nur ${long.snapshots.length} Schnappschuesse`);
    for (const index of [1, 100, 400, long.snapshots.length - 2]) {
      const snapshot = long.snapshots[index]!;
      const found = snapshotAt(long, snapshot.t);
      assert.ok(
        Math.abs(found.entities["klotz"]!.mechanics!.position[0]! -
          snapshot.entities["klotz"]!.mechanics!.position[0]!) < 1e-12,
        `Index ${index} bei t=${snapshot.t} falsch aufgeloest`,
      );
    }
  });
});

describe("Abspielkopf", () => {
  it("laeuft nur, wenn er spielt", () => {
    const head = new Playhead(recording);
    head.advance(0.5);
    assert.equal(head.t, 0, "ohne play darf sich nichts bewegen");
    head.play();
    head.advance(0.5);
    assert.ok(Math.abs(head.t - 0.5) < 1e-12);
  });

  it("beruecksichtigt die Zeitstreckung", () => {
    const head = new Playhead(recording);
    head.setTimeScale(0.25);
    head.play();
    head.advance(1);
    assert.ok(Math.abs(head.t - 0.25) < 1e-12, `t war ${head.t}`);
  });

  it("haelt am Ende an, statt darueber hinauszulaufen", () => {
    const head = new Playhead(recording);
    head.play();
    head.advance(1000);
    assert.equal(head.t, recordingDuration(recording));
    assert.equal(head.isPlaying, false);
  });

  it("startet am Ende wieder von vorn", () => {
    // Ohne diesen Sprung passiert bei einem Klick auf Play scheinbar nichts,
    // und der Abspieler wirkt kaputt.
    const head = new Playhead(recording);
    head.seek(recordingDuration(recording));
    head.play();
    assert.equal(head.t, 0);
    assert.equal(head.isPlaying, true);
  });

  it("begrenzt seek auf den aufgezeichneten Bereich", () => {
    const head = new Playhead(recording);
    head.seek(-10);
    assert.equal(head.t, 0);
    head.seek(1e6);
    assert.equal(head.t, recordingDuration(recording));
  });

  it("lehnt eine nicht positive Zeitstreckung ab", () => {
    const head = new Playhead(recording);
    assert.throws(() => head.setTimeScale(0), /positiv/);
    assert.throws(() => head.setTimeScale(-1), /positiv/);
  });
});

describe("Regiespur", () => {
  it("liefert die zuletzt angewiesene Ebene", () => {
    assert.equal(directionAt(recording, 0).layer, "macroscopic");
    assert.equal(directionAt(recording, 1.0).layer, "macroscopic");
    assert.equal(directionAt(recording, 1.5).layer, "kinematic");
    assert.equal(directionAt(recording, 3.9).layer, "kinematic");
  });

  it("zeigt Annotationen nur in ihrem Zeitfenster", () => {
    // Erste Annotation: t = 0,05 bis 1,25
    assert.equal(directionAt(recording, 0.02).annotations.length, 0);
    assert.equal(directionAt(recording, 0.5).annotations.length, 1);
    assert.ok(directionAt(recording, 0.5).annotations[0]!.text.includes("Fall"));
    assert.equal(directionAt(recording, 1.3).annotations.some((a) => a.text.includes("Fall")), false);
  });

  it("heftet eine Annotation an die genannte Entitaet", () => {
    assert.equal(directionAt(recording, 0.5).annotations[0]!.entityId, "klotz");
  });

  it("aendert die Physik nicht - die Regie ist nur ein Vorschlag", () => {
    // Zwei Laeufe, einer mit leerer Regiespur: die Schnappschuesse muessen
    // identisch sein. Genau das unterscheidet eine Aufzeichnung von einem Video.
    const withDirection = runScenario(createInclinedPlaneScenario());
    const withoutDirection = runScenario({ ...createInclinedPlaneScenario(), directionTrack: [] });
    assert.equal(
      JSON.stringify(withDirection.snapshots),
      JSON.stringify(withoutDirection.snapshots),
    );
  });
});

describe("Atomares Gitter", () => {
  it("haelt die Obergrenze fuer die Kugelzahl ein", () => {
    // Ein langer, duenner Koerper wuerde ohne die Begrenzung Zehntausende
    // Instanzen erzeugen.
    const count = latticeSiteCount([0.01, 0.01, 5], "fcc", 4, 4000);
    assert.ok(count <= 4000, `Gitter erzeugte ${count} Kugeln`);
    assert.ok(count > 10, `Gitter erzeugte nur ${count} Kugeln - zu grob`);
  });

  it("erzeugt bei raumzentriertem Gitter mehr Atome als bei einfach kubischem", () => {
    const cubic = latticeSiteCount([0.1, 0.1, 0.1], "cubic", 4);
    const bcc = latticeSiteCount([0.1, 0.1, 0.1], "bcc", 4);
    const fcc = latticeSiteCount([0.1, 0.1, 0.1], "fcc", 4);
    assert.equal(cubic, 125, "5^3 Rasterknoten bei 4 Zellen je Achse");
    assert.equal(bcc, 125 + 64, "plus ein Zellmittelpunkt je Zelle");
    assert.equal(fcc, 125 + 3 * 64, "plus drei Flaechenmittelpunkte je Zelle");
  });

  it("taeuscht bei amorphen Materialien keine Fernordnung vor", () => {
    // Holz hat kein Kristallgitter. Das Raster ohne Zusatzatome ist weniger
    // falsch als ein vorgetaeuschtes Gitter.
    assert.equal(latticeSiteCount([0.1, 0.1, 0.1], "amorphous", 4), 125);
  });
});

describe("Inventar des Szenarios", () => {
  it("findet alle Koerper und Randbedingungen, auch spaeter hinzugefuegte", () => {
    const inventory = scenarioInventory(createInclinedPlaneScenario());
    assert.equal(inventory.bodies.length, 1);
    assert.equal(inventory.bodies[0]!.spec.id, "klotz");
    assert.equal(inventory.bodies[0]!.material.id, IRON.id);
    // Zwei Instanzen derselben "Festen Ebene" - der Durchstich baut die Rampe
    // daraus zusammen.
    assert.deepEqual(
      inventory.constraints.map((entry) => entry.spec.id),
      ["schiefe-ebene", "auslauf"],
    );
    for (const entry of inventory.constraints) {
      assert.equal(entry.constraint.id, "ebene");
    }
  });

  it("meldet einen fehlenden Bibliothekseintrag, statt still nichts zu zeichnen", () => {
    const scenario = createInclinedPlaneScenario();
    scenario.library = scenario.library.filter((entry) => entry.definition.id !== "eisen");
    assert.throws(() => scenarioInventory(scenario), /fehlt in der Bibliothek/);
  });
});
