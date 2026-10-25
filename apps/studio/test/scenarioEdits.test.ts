import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  createEmptyScenario,
  createInclinedPlaneScenario,
  eulerDegreesFromQuaternion,
  RAMP_ORIENTATION,
  STANDARD,
  WOOD,
  type LibraryEntry,
} from "@sandbox/schema";
import { runScenario, summarizeEntity } from "@sandbox/core";

import {
  addChangeAt,
  addConstraint,
  addEntityAt,
  changeValueAt,
  constraintSizeOf,
  addBody,
  addLibraryEntry,
  listMaterials,
  setEntityMaterial,
  addLoad,
  deleteEntity,
  entityRotationDegrees,
  findEntity,
  interventionMarks,
  isEntityPresent,
  listEntities,
  listInterventions,
  orientationFromNormal,
  removeEntityAt,
  removeIntervention,
  renameEntity,
  roundInterventionTime,
  setEntityOpacity,
  renameScenario,
  setAxesVisible,
  setViewCamera,
  setViewLayer,
  setConstraintSize,
  setBodyHalfExtents,
  setBodyInitialAngularVelocity,
  setBodyInitialVelocity,
  setBodyMass,
  setEntityPose,
  setEntityRotationDegrees,
  setInterventionChange,
  setInterventionTime,
  setLoadDirection,
  setLoadMagnitude,
  setTotalDuration,
  uniqueId,
  usedIds,
  validateScenario,
} from "../src/scenarioEdits.js";
import { describeIntervention } from "../src/entityProperties.js";
import { parseScenario, scenarioFileName, serializeScenario } from "../src/scenarioFile.js";

/**
 * Die Bearbeitungslogik ist absichtlich ohne React geschrieben, damit genau
 * dieser Teil - der, in dem die Fehler stecken - ohne Browser pruefbar ist.
 *
 * Der Pruefstein jedes Tests ist nicht "das Szenario sieht richtig aus",
 * sondern "das bearbeitete Szenario laeuft und verhaelt sich wie erwartet". Ein
 * Szenario, das sauber aussieht, aber den Simulator nicht passiert, ist nichts
 * wert.
 */

const empty = createEmptyScenario();
const durchstich = createInclinedPlaneScenario();

/** Position des `add` eines Objekts in `Scenario.interventions`. */
function indexOfAdd(scenario: typeof durchstich, entityId: string): number {
  return scenario.interventions.findIndex(
    (intervention) => intervention.op === "add" && intervention.entityId === entityId,
  );
}

describe("Ids", () => {
  it("sammelt alle vergebenen Ids", () => {
    const ids = usedIds(durchstich);
    assert.ok(ids.has("klotz"));
    assert.ok(ids.has("schiefe-ebene"));
    assert.ok(ids.has("auslauf"));
    assert.ok(ids.has("eisen"), "Bibliothekseintraege gehoeren dazu");
  });

  it("weicht einer belegten Id aus", () => {
    assert.equal(uniqueId(durchstich, "neu"), "neu");
    assert.equal(uniqueId(durchstich, "klotz"), "klotz-2");
  });
});

describe("Leeres Startszenario", () => {
  it("laeuft, obwohl es leer ist", () => {
    // Ein leeres Szenario muss durch den Simulator gehen - sonst zeigt die
    // Oberflaeche beim Start eine Fehlermeldung statt eines leeren Raums.
    assert.equal(validateScenario(empty).ok, true);
    const recording = runScenario(empty);
    assert.ok(recording.snapshots.length > 50, `nur ${recording.snapshots.length} Schnappschuesse`);
    assert.deepEqual(recording.snapshots.at(-1)!.entities, {});
  });

  it("dauert fuenf Sekunden", () => {
    assert.equal(empty.duration, 5);
    // Die einzige Entitaet ist die Standard-Schwerkraft - kein Koerper, keine Flaeche.
    assert.equal(listEntities(empty).length, 1);
    assert.equal(listEntities(empty)[0]!.spec.kind, "load");
    // Das Hinzufuegen der Schwerkraft ist der einzige Eingriff.
    assert.deepEqual(
      listInterventions(empty).map((entry) => entry.intervention.op),
      ["add"],
    );
  });
});

describe("Objekte platzieren", () => {
  it("fuegt einen Koerper hinzu, und das Szenario laeuft weiter", () => {
    const next = addBody(durchstich, {
      t: 0,
      bodyId: "quader",
      materialId: "aluminium",
      position: [-1, 0, 3],
      halfExtents: [0.08, 0.08, 0.08],
      name: "Alu-Klotz",
    });
    assert.equal(validateScenario(next).ok, true);
    const summary = summarizeEntity(runScenario(next), "alu-klotz");
    assert.ok(summary.pathLength > 0.5, `der neue Koerper bewegte sich nur ${summary.pathLength} m`);
  });

  it("berechnet die Masse aus Dichte und Volumen, wenn keine angegeben ist", () => {
    const next = addBody(durchstich, {
      t: 0,
      bodyId: "quader",
      materialId: "aluminium",
      position: [-1, 0, 5],
      halfExtents: [0.1, 0.1, 0.1],
      name: "Alu",
    });
    // Aluminium: 2700 kg/m^3 * 0.008 m^3 = 21,6 kg.
    const recording = runScenario(next);
    const sample = recording.snapshots.find((snapshot) => snapshot.t >= 0.1)!;
    const force = sample.entities["alu"]!.mechanics!.force[2]!;
    assert.ok(Math.abs(force - -21.6 * 9.81) < 1e-6, `F_z war ${force}`);
  });

  it("lehnt ein Material ab, das nicht in der Bibliothek des Szenarios steht", () => {
    assert.throws(
      () =>
        addBody(durchstich, {
          t: 0,
          bodyId: "quader",
          materialId: "unobtainium",
          position: [0, 0, 1],
          halfExtents: [0.1, 0.1, 0.1],
        }),
      /nicht in der Bibliothek/,
    );
  });

  it("gibt einem neuen Koerper das erste Material und die Kanten des Eintrags", () => {
    const next = addBody(empty, { t: 0, bodyId: "quader", position: [0, 0, 1] });
    const spec = listEntities(next).find(({ spec }) => spec.kind === "body")!.spec;
    assert.equal(spec.kind, "body");
    if (spec.kind !== "body") return;
    assert.equal(spec.bodyId, "quader");
    assert.equal(spec.materialId, listMaterials(empty)[0]!.id);
    assert.deepEqual(spec.phase.shape, { type: "box", halfExtents: [0.1, 0.1, 0.1] });
  });

  it("gibt Koerper und Ebene nach dem Anlegen das Material Standard", () => {
    assert.equal(listMaterials(empty)[0]!.id, STANDARD.id);
    assert.equal(STANDARD.mechanical.density, 1000);
    let next = addBody(empty, { t: 0, bodyId: "quader", position: [0, 0, 1] });
    next = addConstraint(next, { t: 0, constraintId: "ebene" });
    for (const { spec } of listEntities(next)) {
      if (spec.kind !== "load") assert.equal(spec.materialId, STANDARD.id, spec.id);
    }
  });

  it("wechselt das Material einer Ebene", () => {
    let next = addConstraint(empty, { t: 0, constraintId: "ebene", name: "Platte" });
    next = setEntityMaterial(next, "platte", WOOD.id);
    const spec = findEntity(next, "platte")!.spec;
    assert.equal(spec.kind === "constraint" && spec.materialId, WOOD.id);
    assert.throws(
      () => addConstraint(empty, { t: 0, constraintId: "ebene", materialId: "gibtsnicht" }),
      /nicht in der Bibliothek/,
    );
  });

  it("lehnt einen Koerper ab, der nicht in der Bibliothek des Szenarios steht", () => {
    assert.throws(
      () => addBody(empty, { t: 0, bodyId: "kugel", position: [0, 0, 1] }),
      /nicht in der Bibliothek/,
    );
    // Ein Material ist kein Koerper, auch wenn es in der Bibliothek steht.
    assert.throws(
      () => addBody(empty, { t: 0, bodyId: "eisen", position: [0, 0, 1] }),
      /nicht in der Bibliothek/,
    );
  });

  it("aendert mit dem Material die Masse ueber die Dichte", () => {
    let next = addBody(empty, {
      t: 0,
      bodyId: "quader",
      position: [0, 0, 5],
      name: "Probe",
    });
    next = setEntityMaterial(next, "probe", WOOD.id);
    // Holz: 700 kg/m^3 * (0,2 m)^3 = 5,6 kg; F_z = m * g.
    const sample = runScenario(next).snapshots.find((snapshot) => snapshot.t >= 0.1)!;
    const force = sample.entities["probe"]!.mechanics!.force[2]!;
    assert.ok(Math.abs(force - -5.6 * 9.81) < 1e-6, `F_z war ${force}`);
  });

  it("lehnt einen Materialwechsel auf etwas ab, das kein Material ist", () => {
    const next = addBody(empty, { t: 0, bodyId: "quader", position: [0, 0, 1], name: "Probe" });
    assert.throws(() => setEntityMaterial(next, "probe", "ebene"), /nicht in der Bibliothek/);
    assert.throws(() => setEntityMaterial(next, "schwerkraft", "eisen"), /kein Material/);
  });

  it("platziert eine Ebene und laesst sie als Flaeche wirken", () => {
    let next = addConstraint(empty, {
      t: 0,
      constraintId: "ebene",
      position: [0, 0, 0],
      size: [3, 3],
    });
    next = addBody(next, {
      t: 0,
      bodyId: "quader",
      materialId: "eisen",
      position: [0, 0, 2],
      halfExtents: [0.1, 0.1, 0.1],
      name: "Probe",
    });
    const summary = summarizeEntity(runScenario(next), "probe");
    assert.ok(summary.contactIntervals.length > 0, "der Koerper fand keine Flaeche");
    assert.ok(
      Math.abs(summary.endPosition[2]! - 0.1) < 1e-3,
      `der Koerper kam bei z=${summary.endPosition[2]} zur Ruhe, erwartet 0,1`,
    );
  });

  it("vergibt bei mehreren Objekten desselben Eintrags verschiedene Ids", () => {
    let next = addConstraint(empty, { t: 0, constraintId: "ebene" });
    next = addConstraint(next, { t: 0, constraintId: "ebene" });
    const ids = listEntities(next).map((entry) => entry.spec.id);
    assert.equal(new Set(ids).size, ids.length, `Ids kollidieren: ${ids.join(", ")}`);
    assert.doesNotThrow(() => runScenario(next));
  });
});

describe("Ausrichtung nach Oberflaechennormale", () => {
  const close = (a: number[], b: number[]) =>
    a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < 1e-9, `${a} != ${b}`));

  it("laesst eine senkrechte Normale ungedreht", () => {
    close(orientationFromNormal([0, 0, 1]), [0, 0, 0, 1]);
  });

  it("ergibt fuer die Normale der schiefen Ebene deren Drehung", () => {
    // Normale einer um 30 Grad um y gekippten Flaeche: (sin 30, 0, cos 30).
    const half = Math.sqrt(3) / 2;
    close(orientationFromNormal([0.5, 0, half]), RAMP_ORIENTATION);
  });

  it("dreht die z-Achse auf die Normale", () => {
    const n = [0.3, -0.4, Math.sqrt(1 - 0.09 - 0.16)];
    const [x, y, z, w] = orientationFromNormal([n[0], n[1], n[2]]);
    // Bild von (0, 0, 1) unter dem Quaternion: dritte Spalte der Drehmatrix.
    close(
      [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
      n,
    );
  });

  it("dreht bei nach unten zeigender Normale um 180 Grad", () => {
    close(orientationFromNormal([0, 0, -1]), [1, 0, 0, 0]);
  });
});

describe("Objekteigenschaften", () => {
  it("fuehrt alle Objekte unabhaengig von der Zeit auf", () => {
    // Ein Objekt gehoert dem Szenario, nicht einem Zeitpunkt. Wann es
    // erscheint, steht in den Eingriffen.
    const listing = listEntities(durchstich);
    assert.deepEqual(
      listing.map((entry) => entry.spec.id),
      ["schwerkraft", "schiefe-ebene", "auslauf", "klotz"],
    );
  });

  it("fuehrt auch ein Objekt auf, das nie hinzugefuegt wird", () => {
    const next = removeIntervention(durchstich, indexOfAdd(durchstich, "auslauf"));
    assert.ok(listEntities(next).some((entry) => entry.spec.id === "auslauf"));
  });

  it("setzt die Opazität jeder Objektklasse und lässt den Standard bei 1", () => {
    for (const id of ["klotz", "schiefe-ebene", "schwerkraft"]) {
      assert.equal(findEntity(durchstich, id)!.spec.opacity, 1);
      const next = setEntityOpacity(durchstich, id, 0.25);
      assert.equal(findEntity(next, id)!.spec.opacity, 0.25);
      assert.equal(findEntity(durchstich, id)!.spec.opacity, 1);
      assert.equal(validateScenario(next).ok, true);
    }
    assert.throws(() => setEntityOpacity(durchstich, "klotz", 1.5), /zwischen 0 und 1/);
    assert.throws(() => setEntityOpacity(durchstich, "klotz", -0.1), /zwischen 0 und 1/);
  });

  it("benennt ein Objekt um", () => {
    const next = renameEntity(durchstich, "klotz", "Prüfkörper");
    assert.equal(findEntity(next, "klotz")!.spec.name, "Prüfkörper");
    assert.equal(validateScenario(next).ok, true);
  });

  it("lehnt einen leeren Namen ab", () => {
    assert.throws(() => renameEntity(durchstich, "klotz", "   "), /nicht leer/);
  });

  it("aendert die Startlage und der Koerper faellt von dort", () => {
    const next = setEntityPose(durchstich, "klotz", { position: [-1.732, 0, 4] });
    const recording = runScenario(next);
    assert.deepEqual(recording.snapshots[0]!.entities["klotz"]!.mechanics!.position, [-1.732, 0, 4]);
  });

  it("setzt die Drehung in Grad und liest sie wieder als Grad", () => {
    // Der Rundweg, an dem die Oberflaeche haengt: wer 30 eintippt, soll 30
    // wiedersehen.
    let placed = addConstraint(empty, { t: 0, constraintId: "ebene" });
    const id = listEntities(placed).find((entry) => entry.spec.kind === "constraint")!.spec.id;
    for (const angles of [[0, 0, -30], [15, -40, 65], [0, 90, 0]] as const) {
      placed = setEntityRotationDegrees(placed, id, [angles[0], angles[1], angles[2]]);
      const back = entityRotationDegrees(findEntity(placed, id)!.spec);
      // Bei 90 Grad um y greift Gimbal Lock; dann muss wenigstens die
      // y-Drehung stimmen.
      const axes = Math.abs(angles[1]) > 89.9 ? [1] : [0, 1, 2];
      for (const axis of axes) {
        assert.ok(
          Math.abs(back[axis]! - angles[axis]!) < 1e-6,
          `${angles.join(", ")} kam als ${back.map((v) => v.toFixed(3)).join(", ")} zurueck`,
        );
      }
    }
  });

  it("liest die Drehung der schiefen Ebene als 30 Grad um y", () => {
    // Geneigt wird um y, nicht um z: z ist die Hochachse, eine Drehung um sie
    // wuerde die Flaeche nur herumschwenken.
    const incline = findEntity(durchstich, "schiefe-ebene")!;
    const [, ey, ez] = entityRotationDegrees(incline.spec);
    assert.ok(Math.abs(ez) < 1e-9);
    assert.ok(Math.abs(ey - 30) < 1e-9, `y war ${ey}`);
    assert.deepEqual(incline.spec.pose.orientation, RAMP_ORIENTATION);
  });

  it("aendert die Groesse einer Flaeche, und die Physik folgt", () => {
    // Der Klotz gleitet ueber den Auslauf. Wird der Auslauf kurz, faellt er
    // hinten herunter - der Nachweis, dass die Instanzgroesse wirklich wirkt.
    const short = setConstraintSize(durchstich, "auslauf", [0.5, 1]);
    const summary = summarizeEntity(runScenario(short), "klotz");
    assert.ok(
      summary.endPosition[2]! < -1,
      `der Klotz blieb bei z=${summary.endPosition[2]} liegen, statt herunterzufallen`,
    );
  });

  it("lehnt eine Flaechengroesse von null ab", () => {
    assert.throws(() => setConstraintSize(durchstich, "auslauf", [0, 1]), /positiv/);
  });

  it("lehnt eine Groessenangabe an einem Koerper ab", () => {
    assert.throws(() => setConstraintSize(durchstich, "klotz", [1, 1]), /keine Randbedingung/);
  });

  it("aendert die Kantenlaenge eines Koerpers", () => {
    const next = setBodyHalfExtents(durchstich, "klotz", [0.25, 0.25, 0.25]);
    const spec = findEntity(next, "klotz")!.spec;
    assert.ok(spec.kind === "body" && spec.phase.shape.type === "box");
    assert.deepEqual(spec.phase.shape.halfExtents, [0.25, 0.25, 0.25]);
    // Grosser Klotz: die Masse waechst mit dem Volumen.
    const recording = runScenario(next);
    const sample = recording.snapshots.find((snapshot) => snapshot.t >= 0.1)!;
    const expected = -7874 * (0.5 ** 3) * 9.81;
    assert.ok(
      Math.abs(sample.entities["klotz"]!.mechanics!.force[2]! - expected) < 1e-6,
      `F_z war ${sample.entities["klotz"]!.mechanics!.force[2]}, erwartet ${expected}`,
    );
  });

  it("setzt eine Masse und nimmt sie wieder zurueck", () => {
    const heavy = setBodyMass(durchstich, "klotz", 500);
    const spec = findEntity(heavy, "klotz")!.spec;
    assert.equal(spec.kind === "body" && spec.mass, 500);

    const back = setBodyMass(heavy, "klotz", undefined);
    const spec2 = findEntity(back, "klotz")!.spec;
    assert.equal(spec2.kind === "body" && spec2.mass, undefined, "Masse muss wieder berechnet werden");
    // Und sie wird tatsaechlich wieder aus der Dichte berechnet.
    const recording = runScenario(back);
    const sample = recording.snapshots.find((snapshot) => snapshot.t >= 0.1)!;
    assert.ok(
      Math.abs(sample.entities["klotz"]!.mechanics!.force[2]! - -7874 * 0.008 * 9.81) < 1e-6,
    );
  });

  it("setzt eine Startgeschwindigkeit, und der Koerper fliegt los", () => {
    const next = setBodyInitialVelocity(durchstich, "klotz", [5, 0, 0]);
    const recording = runScenario(next);
    assert.deepEqual(recording.snapshots[0]!.entities["klotz"]!.mechanics!.linearVelocity, [5, 0, 0]);
  });

  it("setzt eine Startwinkelgeschwindigkeit, und der Koerper dreht sich von Anfang an", () => {
    const next = setBodyInitialAngularVelocity(durchstich, "klotz", [0, 0, 2]);
    const recording = runScenario(next);
    const omega = recording.snapshots[0]!.entities["klotz"]!.mechanics!.angularVelocity;
    assert.ok(Math.abs(omega[2]! - 2) < 1e-9, `omega = ${omega}`);
  });

  it("lehnt eine nicht positive Masse ab", () => {
    assert.throws(() => setBodyMass(durchstich, "klotz", 0), /positiv/);
  });
});

describe("Objekte loeschen und entfernen", () => {
  it("nimmt ein Objekt ab einer Zeit aus der Szene", () => {
    const next = removeEntityAt(durchstich, 2, "klotz");
    const recording = runScenario(next);
    const before = recording.snapshots.find((snapshot) => snapshot.t >= 1.5)!;
    const after = recording.snapshots.find((snapshot) => snapshot.t >= 2.5)!;
    assert.ok(before.entities["klotz"], "vor dem Eingriff muss der Klotz da sein");
    assert.equal(after.entities["klotz"], undefined, "nach dem Eingriff muss er weg sein");
  });

  it("legt keinen doppelten remove-Eingriff an", () => {
    const twice = removeEntityAt(removeEntityAt(durchstich, 2, "klotz"), 2, "klotz");
    const removals = listInterventions(twice).filter((entry) => entry.intervention.op === "remove");
    assert.equal(removals.length, 1);
  });

  it("loescht ein Objekt samt aller Eingriffe auf es", () => {
    // Bleibt ein Eingriff stehen, der auf ein nicht mehr vorhandenes Objekt
    // verweist, bricht der Lauf ab.
    const next = deleteEntity(durchstich, "klotz");
    assert.equal(validateScenario(next).ok, true);
    assert.doesNotThrow(() => runScenario(next));
    assert.equal(findEntity(next, "klotz"), undefined);
    for (const entry of listInterventions(next)) {
      if (entry.intervention.op === "setEnvironment") continue;
      assert.notEqual(entry.intervention.entityId, "klotz");
    }
  });

  it("raeumt beim Loeschen auch die Regieanweisungen auf", () => {
    const next = deleteEntity(durchstich, "klotz");
    for (const cue of next.directionTrack) {
      if ("entityId" in cue) assert.notEqual(cue.entityId, "klotz");
    }
  });
});

describe("Eingriffsliste", () => {
  it("enthaelt auch das Hinzufuegen von Objekten, nach Zeit geordnet", () => {
    const listing = listInterventions(durchstich);
    const adds = listing.filter((entry) => entry.intervention.op === "add");
    assert.ok(adds.length >= 1);
    assert.ok(adds.every((entry) => entry.intervention.t === 0));
    const stop = listing.find((entry) => entry.intervention.op === "change")!;
    assert.equal(stop.intervention.t, 2);
    assert.equal(listing.at(-1), stop);
  });

  it("legt beim Platzieren einen add-Eingriff zur angegebenen Zeit an", () => {
    const before = listInterventions(durchstich).length;
    const next = addBody(durchstich, {
      t: 2,
      bodyId: "quader",
      materialId: "aluminium",
      position: [0, 0, 1],
      halfExtents: [0.1, 0.1, 0.1],
    });
    assert.equal(listInterventions(next).length, before + 1);
    const added = listInterventions(next).filter((entry) => entry.intervention.t === 2);
    assert.ok(added.some((entry) => entry.intervention.op === "add"));
  });

  it("haengt einen neuen Eingriff hinter die Eingriffe derselben Zeit", () => {
    // Gleiche Zeit heisst gleicher Zeitschritt, in Listenreihenfolge - der neue
    // wirkt also nach den schon vorhandenen.
    const next = removeEntityAt(durchstich, 2, "klotz");
    const atTwo = next.interventions.filter((intervention) => intervention.t === 2);
    assert.deepEqual(
      atTwo.map((intervention) => intervention.op),
      ["change", "remove"],
    );
  });

  it("rundet die Zeit eines neuen Eingriffs auf hundertstel Sekunden", () => {
    // Nach einer Pause steht der Zeitcursor irgendwo; ungerundet laege der
    // Eingriff in einer eigenen Raute neben einer, die dieselbe Zeit zeigt.
    const next = removeEntityAt(durchstich, 2.0049, "klotz");
    const removal = next.interventions.find((intervention) => intervention.op === "remove")!;
    assert.equal(removal.t, 2);
    assert.equal(roundInterventionTime(0.07), 0.07);
    assert.equal(roundInterventionTime(1.2347), 1.23);
    assert.throws(() => roundInterventionTime(-1), /negativ/);
  });

  it("beschreibt einen Eingriff mit dem Namen des Objekts", () => {
    const listing = listInterventions(durchstich).filter((e) => e.intervention.op === "change");
    const text = describeIntervention(durchstich, listing[0]!.intervention);
    assert.ok(text.includes("Eisenklotz"), `Beschreibung war "${text}"`);
    assert.equal(text, "Eisenklotz: Geschwindigkeit ändern");
  });

  it("entfernt einen einzelnen Eingriff", () => {
    const entry = listInterventions(durchstich).find(
      (candidate) => candidate.intervention.op === "change",
    )!;
    const next = removeIntervention(durchstich, entry.index);
    assert.ok(!listInterventions(next).some((e) => e.intervention.op === "change"));
    // Ohne das Anhalten gleitet der Klotz bis zum Ende weiter.
    assert.ok(summarizeEntity(runScenario(next), "klotz").endSpeed > 3);
  });

  it("laesst beim Entfernen eines add das Objekt stehen", () => {
    const next = removeIntervention(durchstich, indexOfAdd(durchstich, "klotz"));
    assert.ok(findEntity(next, "klotz"));
    assert.equal(runScenario(next).snapshots.some((snapshot) => snapshot.entities["klotz"]), false);
  });

  it("raeumt Eingriffe auf, die nach dem entfernten add ins Leere liefen", () => {
    const next = removeIntervention(durchstich, indexOfAdd(durchstich, "klotz"));
    assert.ok(!listInterventions(next).some((entry) => entry.intervention.op === "change"));
    assert.doesNotThrow(() => runScenario(next));
  });

  it("fuegt ein Objekt spaeter wieder hinzu", () => {
    const removed = removeEntityAt(durchstich, 2, "klotz");
    const readded = addEntityAt(setTotalDuration(removed, 6), 4, "klotz");
    assert.equal(readded.entities.length, durchstich.entities.length);
    assert.equal(isEntityPresent(readded, "klotz", 1), true);
    assert.equal(isEntityPresent(readded, "klotz", 2.5), false);
    assert.equal(isEntityPresent(readded, "klotz", 4.5), true);
    assert.doesNotThrow(() => runScenario(readded));
  });

  it("liest den Zustand zu einer Zeit einschliesslich der Eingriffe genau dann", () => {
    // Das ist der Zustand, auf den ein neuer Eingriff am Zeitcursor aufsetzt.
    const removed = removeEntityAt(durchstich, 2, "klotz");
    assert.equal(isEntityPresent(removed, "klotz", 0), true);
    assert.equal(isEntityPresent(removed, "klotz", 1.99), true);
    assert.equal(isEntityPresent(removed, "klotz", 2), false);
  });

  it("lehnt das Hinzufuegen eines unbekannten Objekts ab", () => {
    assert.throws(() => addEntityAt(durchstich, 2, "gibts-nicht"), /existiert nicht/);
  });

  it("meldet einen Eingriff, den es nicht gibt", () => {
    assert.throws(() => removeIntervention(durchstich, 99), /Position 99/);
  });
});

describe("Zeit eines Eingriffs", () => {
  const stopIndex = durchstich.interventions.findIndex(
    (intervention) => intervention.op === "change",
  );

  it("verschiebt einen Eingriff, und der Lauf folgt", () => {
    const next = setInterventionTime(durchstich, stopIndex, 1.5);
    const stop = next.interventions.find((intervention) => intervention.op === "change")!;
    assert.equal(stop.t, 1.5);
    // Angehalten bei 1,5 s statt 2 s: kurz danach ist der Klotz schon langsam,
    // waehrend er im unveraenderten Szenario noch gleitet.
    const speedAt = (scenario: typeof durchstich, t: number): number => {
      const [vx, vy, vz] = runScenario(scenario).snapshots.find((snapshot) => snapshot.t >= t)!
        .entities["klotz"]!.mechanics!.linearVelocity;
      return Math.sqrt(vx * vx + vy * vy + vz * vz);
    };
    assert.ok(speedAt(durchstich, 1.55) > 2, "ohne Verschieben muesste er noch gleiten");
    assert.ok(speedAt(next, 1.55) < 0.5, `v war ${speedAt(next, 1.55)}`);
  });

  it("haelt die Liste nach dem Verschieben nach Zeit sortiert", () => {
    const next = setInterventionTime(setTotalDuration(durchstich, 6), stopIndex, 5);
    const times = next.interventions.map((intervention) => intervention.t);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it("rundet die neue Zeit wie beim Anlegen", () => {
    const next = setInterventionTime(durchstich, stopIndex, 1.23456);
    assert.equal(next.interventions.find((intervention) => intervention.op === "change")!.t, 1.23);
  });

  it("begrenzt ein Verschieben, das ein Objekt vor seinem Hinzufuegen anspraeche", () => {
    // Das add des Klotzes hinter sein Anhalten zu schieben liesse den Lauf an
    // "unbekannte Entitaet" scheitern. Die Zeit springt stattdessen knapp vor
    // das Anhalten, und die Meldung geht an `report`.
    const messages: string[] = [];
    const addIndex = indexOfAdd(durchstich, "klotz");
    const next = setInterventionTime(durchstich, addIndex, 3, (message) => messages.push(message));
    const add = next.interventions.find((i) => i.op === "add" && i.entityId === "klotz")!;
    assert.equal(add.t, 1.99);
    assert.equal(messages.length, 1);
    const stop = next.interventions.find((i) => i.op === "change")!;
    assert.equal(stop.t, 2);
    runScenario(next);
  });

  it("begrenzt ein zweites Hinzufuegen auf die Zeit des Entfernens", () => {
    const readded = addEntityAt(removeEntityAt(durchstich, 2, "klotz"), 3, "klotz");
    const lateAdd = readded.interventions.findIndex(
      (intervention) => intervention.op === "add" && intervention.t === 3,
    );
    const messages: string[] = [];
    const next = setInterventionTime(readded, lateAdd, 1, (message) => messages.push(message));
    assert.equal(messages.length, 1);
    const adds = next.interventions.filter((i) => i.op === "add" && i.entityId === "klotz");
    assert.deepEqual(adds.map((i) => i.t), [0, 2]);
    runScenario(next);
  });

  it("laesst Eingriffe anderer Objekte beim Verschieben unberuehrt", () => {
    const withAlu = addBody(durchstich, {
      t: 3,
      bodyId: "quader",
      materialId: "aluminium",
      position: [-1, 0, 3],
      name: "Alu",
    });
    const messages: string[] = [];
    const next = setInterventionTime(withAlu, indexOfAdd(withAlu, "alu"), 1, (m) => messages.push(m));
    assert.deepEqual(messages, []);
    assert.equal(next.interventions.find((i) => i.op === "add" && i.entityId === "alu")!.t, 1);
    assert.equal(next.interventions.find((i) => i.op === "change")!.t, 2);
  });
});

describe("Gesamtdauer", () => {
  it("verlaengert das Szenario, ohne einen Eingriff zu verschieben", () => {
    const next = setTotalDuration(durchstich, 8);
    assert.equal(next.duration, 8);
    assert.deepEqual(next.interventions, durchstich.interventions);
    assert.ok(runScenario(next).snapshots.at(-1)!.t >= 7.9);
  });

  it("laesst einen Eingriff hinter dem Ende stehen, er wirkt nur nicht", () => {
    const shorter = setTotalDuration(durchstich, 1.5);
    const stop = listInterventions(shorter).find((entry) => entry.intervention.op === "change")!;
    assert.equal(stop.effective, false);
    assert.equal(shorter.interventions.length, durchstich.interventions.length);
    // Wieder verlaengert, wirkt er wieder.
    const restored = setTotalDuration(shorter, 4);
    assert.equal(
      listInterventions(restored).find((entry) => entry.intervention.op === "change")!.effective,
      true,
    );
  });

  it("zaehlt einen Eingriff genau am Ende nicht als wirksam", () => {
    // Der letzte Zeitschritt beginnt vor dem Ende - einer bei t = Dauer wird
    // nie erreicht.
    const atEnd = setTotalDuration(durchstich, 2);
    assert.equal(
      listInterventions(atEnd).find((entry) => entry.intervention.op === "change")!.effective,
      false,
    );
  });

  it("lehnt eine Gesamtdauer von null ab", () => {
    assert.throws(() => setTotalDuration(durchstich, 0), /positiv/);
    assert.throws(() => setTotalDuration(durchstich, -1), /positiv/);
  });
});

describe("Rauten der Zeitleiste", () => {
  it("fasst Eingriffe derselben Zeit zu einer Raute zusammen", () => {
    const marks = interventionMarks(durchstich);
    assert.deepEqual(
      marks.map((mark) => mark.t),
      [0, 2],
    );
    assert.equal(marks[0]!.interventions.length, 4);
    assert.equal(marks[1]!.interventions[0]!.op, "change");
  });

  it("zeigt keine Raute hinter dem Ende", () => {
    const marks = interventionMarks(setTotalDuration(durchstich, 1.5));
    assert.deepEqual(
      marks.map((mark) => mark.t),
      [0],
    );
  });
});

describe("Lasten", () => {
  it("schaltet die Schwerkraft ab und der Klotz bleibt in der Luft", () => {
    const next = setLoadMagnitude(durchstich, "schwerkraft", 0);
    const spec = findEntity(next, "schwerkraft")!.spec;
    assert.ok(spec.kind === "load" && spec.magnitude === 0);
    const summary = summarizeEntity(runScenario(next), "klotz");
    assert.ok(summary.pathLength < 1e-9, `der Klotz bewegte sich um ${summary.pathLength} m`);
  });

  it("behaelt die Richtung, wenn nur die Staerke geaendert wird", () => {
    const stronger = setLoadMagnitude(durchstich, "schwerkraft", 20);
    const spec = findEntity(stronger, "schwerkraft")!.spec;
    assert.ok(spec.kind === "load");
    assert.equal(spec.magnitude, 20);
    assert.deepEqual(spec.direction, [0, 0, -1]);
  });

  it("lehnt eine negative Staerke ab", () => {
    assert.throws(() => setLoadMagnitude(durchstich, "schwerkraft", -1), /nicht negativ/);
  });

  it("aendert die Richtung unabhaengig von der Staerke", () => {
    const sideways = setLoadDirection(durchstich, "schwerkraft", [1, 0, 0]);
    const spec = findEntity(sideways, "schwerkraft")!.spec;
    assert.ok(spec.kind === "load");
    assert.deepEqual(spec.direction, [1, 0, 0]);
    assert.equal(spec.magnitude, 9.81);
  });

  it("laesst eine Mondschwerkraft laufen und der Klotz faellt langsamer", () => {
    const moon = runScenario(setLoadMagnitude(durchstich, "schwerkraft", 1.62));
    const earth = runScenario(durchstich);
    assert.ok(
      summarizeEntity(moon, "klotz").maxSpeed < summarizeEntity(earth, "klotz").maxSpeed,
      "auf dem Mond muesste der Klotz langsamer sein",
    );
  });

  it("fuegt eine zweite Last hinzu, die sich mit der ersten addiert", () => {
    // Zwei Gravitations-Lasten zugleich - der Kern summiert ihre Beitraege.
    const doubled = addLoad(durchstich, {
      t: 0,
      loadId: "gravitation",
      magnitude: 9.81,
      direction: [0, 0, -1],
    });
    const single = runScenario(durchstich);
    const double = runScenario(doubled);
    assert.ok(
      summarizeEntity(double, "klotz").maxSpeed > summarizeEntity(single, "klotz").maxSpeed,
      "zwei gleich gerichtete Lasten muessten staerker beschleunigen als eine",
    );
  });

  it("lehnt eine Last ab, die nicht in der Bibliothek des Szenarios steht", () => {
    assert.throws(
      () => addLoad(durchstich, { t: 0, loadId: "unbekannt" }),
      /nicht in der Bibliothek/,
    );
  });
});

describe("Bibliothek und Name", () => {
  it("nimmt einen neuen Eintrag auf", () => {
    const entry: LibraryEntry = {
      definition: WOOD,
      provenance: { source: "librarian", correctedFields: [], warnings: [] },
    };
    const next = addLibraryEntry({ ...createEmptyScenario(), library: [] }, entry);
    assert.equal(next.library.length, 1);
    assert.equal(next.library[0]!.definition.id, "holz");
  });

  it("ersetzt einen Eintrag mit derselben Id statt ihn zu verdoppeln", () => {
    const once = addLibraryEntry(durchstich, {
      definition: WOOD,
      provenance: { source: "builtin", correctedFields: [], warnings: [] },
    });
    const twice = addLibraryEntry(once, {
      definition: { ...WOOD, name: "Buchenholz" },
      provenance: { source: "librarian", correctedFields: [], warnings: [] },
    });
    const matching = twice.library.filter((candidate) => candidate.definition.id === "holz");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.definition.name, "Buchenholz");
  });

  it("benennt das Szenario um", () => {
    assert.equal(renameScenario(durchstich, "Mein Versuch").name, "Mein Versuch");
    assert.throws(() => renameScenario(durchstich, "  "), /nicht leer/);
  });
});

describe("Speichern und Laden", () => {
  it("ist ein Rundweg: schreiben, lesen, wieder schreiben", () => {
    // Die Grundlage des Dateiformats. Geht das verloren, merkt der Benutzer es
    // erst, wenn seine Datei anders zurueckkommt, als er sie gespeichert hat.
    const text = serializeScenario(durchstich);
    const parsed = parseScenario(text);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
    if (!parsed.ok) return;
    assert.equal(serializeScenario(parsed.scenario), text);
  });

  it("laedt ein bearbeitetes Szenario und es laeuft weiter", () => {
    const stopIndex = durchstich.interventions.findIndex(
      (intervention) => intervention.op === "change",
    );
    const edited = setInterventionTime(
      setConstraintSize(renameScenario(durchstich, "Bearbeitet"), "auslauf", [3, 1.5]),
      stopIndex,
      1.5,
    );
    const parsed = parseScenario(serializeScenario(edited));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.scenario.name, "Bearbeitet");
    assert.deepEqual(
      parsed.scenario.interventions.map((intervention) => intervention.t),
      [0, 0, 0, 0, 1.5],
    );
    assert.doesNotThrow(() => runScenario(parsed.scenario));
  });

  it("lehnt Text ab, der kein JSON ist", () => {
    const result = parseScenario("{ kaputt");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors[0]!.includes("JSON"));
  });

  it("lehnt JSON ab, das kein Szenario ist", () => {
    const result = parseScenario(JSON.stringify({ hallo: "welt" }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.length > 0);
  });

  it("lehnt eine Datei ab, deren Bibliothekseintraege fehlen", () => {
    // Ueber das Schema hinaus: sonst scheitert erst der Lauf, und die
    // Fehlermeldung kommt an der falschen Stelle.
    const stripped = { ...durchstich, library: [] };
    const result = parseScenario(JSON.stringify(stripped));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors[0]!.includes("eisen"), result.ok ? "" : result.errors[0]);
  });

  it("lehnt eine Datei mit Etappen ab - etwa aus einer aelteren Datei", () => {
    // Das alte Format hatte Etappen mit Dauern statt Eingriffen mit Zeiten und
    // einer Gesamtdauer. Eine solche Datei muss sauber abgelehnt werden und
    // nicht halb geladen.
    const { duration: _duration, interventions: _interventions, ...rest } = durchstich;
    const alt = { ...rest, stages: [{ id: "alt", duration: 2, interventions: [] }] };
    const result = parseScenario(JSON.stringify(alt));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((error) => error.includes("duration")));
  });

  it("macht aus dem Szenarionamen einen brauchbaren Dateinamen", () => {
    assert.equal(scenarioFileName(durchstich), "klotz-auf-der-schiefen-ebene.scenario.json");
    assert.equal(
      scenarioFileName({ ...durchstich, name: "Mein Versuch: Öl & Wasser" }),
      "mein-versuch-oel-wasser.scenario.json",
    );
    assert.equal(scenarioFileName({ ...durchstich, name: "***" }), "szenario.scenario.json");
  });
});

describe("Unveraenderlichkeit", () => {
  it("laesst das urspruengliche Szenario unberuehrt", () => {
    // Reine Funktionen: Szenario rein, Szenario raus. Sonst waeren die
    // React-Aktualisierungen nicht nachvollziehbar.
    const before = JSON.stringify(durchstich);
    setLoadMagnitude(durchstich, "schwerkraft", 0);
    deleteEntity(durchstich, "klotz");
    renameEntity(durchstich, "klotz", "Anders");
    setConstraintSize(durchstich, "auslauf", [1, 1]);
    setTotalDuration(durchstich, 9);
    setInterventionTime(durchstich, 4, 1);
    addChangeAt(durchstich, 0, "klotz", { key: "position", value: [0, 0, 9] });
    addChangeAt(durchstich, 2, "klotz");
    setInterventionChange(durchstich, 4, { key: "opacity", value: 0.5 });
    removeIntervention(durchstich, 0);
    assert.equal(JSON.stringify(durchstich), before);
  });
});

describe("Wirksame Flaechengroesse", () => {
  it("liest bei fehlender Instanzgroesse die des Bibliothekseintrags", () => {
    // Eine fest eingetippte Rueckfallzahl waere nur meist richtig: eine per
    // Bibliothekar erzeugte Flaeche hat eine andere Standardgroesse als die
    // mitgelieferte.
    const placed = addConstraint(empty, {
      t: 0,
      constraintId: "ebene",
    });
    const spec = listEntities(placed).find((entry) => entry.spec.kind === "constraint")!.spec;
    assert.equal(spec.kind === "constraint" && spec.size, undefined, "ohne eigene Groesse angelegt");
    // Die Ebene ist im Eintrag 1 x 2 (halbe Ausdehnungen), also 2 m lang
    // und 4 m breit.
    assert.deepEqual(constraintSizeOf(placed, spec), [1, 2]);
  });

  it("bevorzugt die Instanzgroesse, wenn es eine gibt", () => {
    const runout = findEntity(durchstich, "auslauf")!.spec;
    assert.deepEqual(constraintSizeOf(durchstich, runout), [4.125, 1]);
  });

  it("gibt fuer einen Koerper keine Flaechengroesse zurueck", () => {
    assert.equal(constraintSizeOf(durchstich, findEntity(durchstich, "klotz")!.spec), undefined);
  });
});

describe("Darstellung im Szenario", () => {
  it("ein neues Szenario blendet die Achsen ein und zeigt die Standardebene", () => {
    const view = createEmptyScenario().view;
    assert.equal(view.showAxes, true);
    assert.equal(view.layer, "macroscopic");
    assert.equal(view.camera, undefined);
  });

  it("Ebene, Achsen und Kamera aendern das Original nicht und aendern die Physik nicht", () => {
    const base = createEmptyScenario();
    const changed = setViewCamera(
      setAxesVisible(setViewLayer(base, "kinematic"), false),
      { position: [1, 2, 3], target: [0, 0, 1] },
    );
    assert.equal(base.view.layer, "macroscopic");
    assert.deepEqual(changed.view, {
      layer: "kinematic",
      showAxes: false,
      camera: { position: [1, 2, 3], target: [0, 0, 1] },
    });
    assert.deepEqual(runScenario(changed).snapshots, runScenario(base).snapshots);
  });
});

describe("Ändern", () => {
  const stopIndex = durchstich.interventions.findIndex((intervention) => intervention.op === "change");

  it("haelt einen Koerper ohne Angabe an - die Geschwindigkeit, mit null vorbelegt", () => {
    const base = removeIntervention(durchstich, stopIndex);
    const next = addChangeAt(base, 2.004, "klotz");
    const added = next.interventions.find((intervention) => intervention.op === "change")!;
    assert.deepEqual(added, {
      op: "change",
      t: 2,
      entityId: "klotz",
      change: { key: "linearVelocity", value: [0, 0, 0] },
    });
    // Und es wirkt wie das Anhalten im Startszenario.
    assert.ok(summarizeEntity(runScenario(next), "klotz").endSpeed < 1e-9);
  });

  it("nimmt fuer ein zweites Ändern zur selben Zeit die naechste Eigenschaft", () => {
    const next = addChangeAt(durchstich, 2, "klotz");
    const keys = next.interventions
      .filter((intervention) => intervention.op === "change" && intervention.t === 2)
      .map((intervention) => (intervention.op === "change" ? intervention.change.key : ""));
    assert.deepEqual(keys, ["linearVelocity", "position"]);
  });

  it("ersetzt den Wert, wenn dieselbe Eigenschaft zur selben Zeit schon geaendert wird", () => {
    const next = addChangeAt(durchstich, 2, "klotz", { key: "linearVelocity", value: [1, 0, 0] });
    const changes = next.interventions.filter((intervention) => intervention.op === "change");
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0]!.op === "change" && changes[0]!.change.value, [1, 0, 0]);
  });

  it("belegt Eingabeeigenschaften mit dem Wert zur Eingriffszeit vor", () => {
    const resized = addChangeAt(durchstich, 1, "klotz", { key: "halfExtents", value: [0.3, 0.3, 0.3] });
    assert.deepEqual(changeValueAt(resized, "klotz", "halfExtents", 0.5), {
      key: "halfExtents",
      value: [0.1, 0.1, 0.1],
    });
    assert.deepEqual(changeValueAt(resized, "klotz", "halfExtents", 1), {
      key: "halfExtents",
      value: [0.3, 0.3, 0.3],
    });
    // Die Groesse einer Ebene ohne Instanzdicke kommt aus dem Bibliothekseintrag.
    const dimensions = changeValueAt(durchstich, "auslauf", "dimensions", 1);
    assert.equal(dimensions.key, "dimensions");
    assert.deepEqual(dimensions.value.slice(0, 2), [4.125, 1]);
  });

  it("lehnt eine Eigenschaft ab, die das Objekt nicht hat", () => {
    assert.throws(
      () => addChangeAt(durchstich, 1, "auslauf", { key: "linearVelocity", value: [1, 0, 0] }),
      /keine Eigenschaft/,
    );
    assert.throws(() => changeValueAt(durchstich, "schwerkraft", "position", 1), /keine Eigenschaft/);
  });

  it("aendert Wert und Eigenschaft eines vorhandenen Eingriffs, Zeit und Platz bleiben", () => {
    const faster = setInterventionChange(durchstich, stopIndex, { key: "linearVelocity", value: [0, 0, 5] });
    const changed = faster.interventions[stopIndex]!;
    assert.equal(changed.t, 2);
    assert.deepEqual(changed.op === "change" && changed.change.value, [0, 0, 5]);
    // Der Klotz wird bei 2 s nach oben geworfen statt angehalten.
    const at = (scenario: typeof durchstich) =>
      runScenario(scenario).snapshots.find((snapshot) => snapshot.t > 2.05)!.entities["klotz"]!.mechanics!;
    assert.ok(at(faster).linearVelocity[2] > 4);

    const faded = setInterventionChange(durchstich, stopIndex, { key: "opacity", value: 0.25 });
    const fadedChange = faded.interventions[stopIndex]!;
    assert.deepEqual(fadedChange.op === "change" && fadedChange.change, { key: "opacity", value: 0.25 });
  });

  it("lehnt einen Eigenschaftswechsel auf eine schon zur selben Zeit geaenderte ab", () => {
    const two = addChangeAt(durchstich, 2, "klotz", { key: "opacity", value: 0.5 });
    assert.throws(
      () => setInterventionChange(two, stopIndex, { key: "opacity", value: 0.1 }),
      /zur selben Zeit schon/,
    );
    assert.throws(() => setInterventionChange(durchstich, 0, { key: "opacity", value: 0.1 }), /kein/);
  });

  it("raeumt Änderungen mit dem Objekt ab", () => {
    const next = deleteEntity(addChangeAt(durchstich, 1, "auslauf", { key: "opacity", value: 0.5 }), "auslauf");
    assert.ok(!next.interventions.some((i) => i.op === "change" && i.entityId === "auslauf"));
    assert.doesNotThrow(() => runScenario(next));
  });

  it("schiebt eine Änderung nicht vor das add ihres Objekts", () => {
    const late = setInterventionTime(durchstich, indexOfAdd(durchstich, "klotz"), 1);
    const index = late.interventions.findIndex((intervention) => intervention.op === "change");
    let message = "";
    const next = setInterventionTime(late, index, 0.5, (text) => {
      message = text;
    });
    assert.equal(next.interventions.find((intervention) => intervention.op === "change")!.t, 1);
    assert.ok(message.includes("Eisenklotz"), message);
  });
});
