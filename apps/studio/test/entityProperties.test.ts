import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createInclinedPlaneScenario, DEFAULT_GRAVITY_ID, WOOD } from "@sandbox/schema";
import { runScenario } from "@sandbox/core";

import {
  changePropertiesOf,
  changeRowsOf,
  classChain,
  describeIntervention,
  ENTITY_PROPERTIES,
  entityClassOf,
  libraryEntryClassOf,
  propertyGroupsOf,
  type EntityProperty,
} from "../src/entityProperties.js";
import { addChangeAt, findEntity } from "../src/scenarioEdits.js";

/**
 * Die Eigenschaften der rechten Leiste: Zuordnung zu Klassen, Vererbung,
 * Gruppenfolge - und dass Lesen und Schreiben durch das Szenario laufen.
 */

const durchstich = createInclinedPlaneScenario();

function specOf(scenario: typeof durchstich, id: string) {
  const found = findEntity(scenario, id);
  assert.ok(found, `Entität "${id}" fehlt`);
  return found.spec;
}

function layout(scenario: typeof durchstich, id: string): string[][] {
  return propertyGroupsOf(scenario, specOf(scenario, id)).map(({ properties }) =>
    properties.map((property) => property.id),
  );
}

function property(id: string): EntityProperty {
  const found = ENTITY_PROPERTIES.find((candidate) => candidate.id === id);
  assert.ok(found, `Eigenschaft "${id}" fehlt`);
  return found;
}

describe("Klassen", () => {
  it("bestimmt die speziellste Klasse jeder Entität", () => {
    assert.equal(entityClassOf(durchstich, specOf(durchstich, "klotz")), "cuboid");
    assert.equal(entityClassOf(durchstich, specOf(durchstich, "schiefe-ebene")), "plane");
    assert.equal(entityClassOf(durchstich, specOf(durchstich, DEFAULT_GRAVITY_ID)), "gravity");
  });

  it("führt jede Klasse auf das Objekt zurück", () => {
    assert.deepEqual(classChain("cuboid"), ["cuboid", "body", "object"]);
    assert.deepEqual(classChain("plane"), ["plane", "constraint", "object"]);
    assert.deepEqual(classChain("gravity"), ["gravity", "load", "object"]);
  });

  it("gibt einem Bibliothekseintrag die Klasse der Entitäten, die aus ihm entstehen", () => {
    for (const spec of durchstich.entities) {
      const entryId =
        spec.kind === "body" ? spec.bodyId : spec.kind === "constraint" ? spec.constraintId : spec.loadId;
      const entry = durchstich.library.find((candidate) => candidate.definition.id === entryId);
      assert.ok(entry, `Eintrag "${entryId}" fehlt`);
      assert.equal(libraryEntryClassOf(entry), entityClassOf(durchstich, spec), spec.id);
    }
    const material = durchstich.library.find((entry) => entry.definition.kind === "material");
    assert.ok(material);
    assert.equal(libraryEntryClassOf(material), undefined);
  });
});

describe("Gliederung", () => {
  it("ordnet den Quader in Geometrie, Material, Kinematik, Darstellung - ohne Masse", () => {
    assert.deepEqual(layout(durchstich, "klotz"), [
      ["position", "rotation", "edges"],
      ["material"],
      ["velocity", "initialAngularVelocity"],
      ["opacity"],
    ]);
  });

  it("gibt der Ebene Größe und Material, aber keine Geschwindigkeit", () => {
    assert.deepEqual(layout(durchstich, "schiefe-ebene"), [
      ["position", "rotation", "size"],
      ["material"],
      ["opacity"],
    ]);
  });

  it("gibt der Gravitation Stärke und Richtung, aber keine Lage", () => {
    assert.deepEqual(layout(durchstich, DEFAULT_GRAVITY_ID), [
      ["magnitude", "direction"],
      ["opacity"],
    ]);
  });
});

describe("Lesen und Schreiben", () => {
  it("zeigt ganze Kantenlängen und speichert halbe", () => {
    const edges = property("edges");
    assert.equal(edges.type, "vector3");
    if (edges.type !== "vector3") return;
    const next = edges.set(durchstich, "klotz", [1, 0.5, 0.25]);
    const spec = specOf(next, "klotz");
    assert.ok(spec.kind === "body" && spec.phase.shape.type === "box");
    assert.deepEqual(spec.phase.shape.halfExtents, [0.5, 0.25, 0.125]);
    assert.deepEqual(edges.get(next, spec), [1, 0.5, 0.25]);
  });

  it("zeigt Länge, Breite und Höhe einer Ebene; Länge und Breite gespeichert als halbe", () => {
    const size = property("size");
    if (size.type !== "vector3") return assert.fail("Größe muss ein 3D-Vektor sein");
    const next = size.set(durchstich, "auslauf", [6, 2, 0.2]);
    const spec = specOf(next, "auslauf");
    assert.deepEqual(spec.kind === "constraint" && spec.size, [3, 1]);
    assert.equal(spec.kind === "constraint" && spec.thickness, 0.2);
    assert.deepEqual(size.get(next, spec), [6, 2, 0.2]);
    runScenario(next);
  });

  it("liest die Höhe einer Ebene ohne eigene Dicke aus dem Bibliothekseintrag", () => {
    const size = property("size");
    if (size.type !== "vector3") return assert.fail("Größe muss ein 3D-Vektor sein");
    const spec = specOf(durchstich, "auslauf");
    assert.ok(size.get(durchstich, spec)[2] > 0);
  });

  it("zeigt die Startwinkelgeschwindigkeit in °/s und speichert rad/s", () => {
    const omega = property("initialAngularVelocity");
    if (omega.type !== "vector3") return assert.fail("Startwinkelgeschw. muss ein 3D-Vektor sein");
    const next = omega.set(durchstich, "klotz", [180, 0, -90]);
    const spec = specOf(next, "klotz");
    assert.ok(spec.kind === "body");
    assert.ok(Math.abs(spec.velocity.angular[0] - Math.PI) < 1e-12);
    assert.ok(Math.abs(spec.velocity.angular[2] + Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(omega.get(next, spec)[0] - 180) < 1e-9);
    runScenario(next);
  });

  it("bietet das Material als Auswahl an und wechselt es", () => {
    const material = property("material");
    if (material.type !== "choice") return assert.fail("Material muss ein Auswahlwert sein");
    const klotz = specOf(durchstich, "klotz");
    assert.ok(material.options(durchstich, klotz).some((option) => option.value === WOOD.id));
    const next = material.set(durchstich, "klotz", WOOD.id);
    assert.equal(material.get(next, specOf(next, "klotz")), WOOD.id);
    // Die Bearbeitung muss ein lauffaehiges Szenario ergeben.
    runScenario(next);
  });

  it("hält ein unbekanntes Material als Option, statt ein anderes anzuzeigen", () => {
    const material = property("material");
    if (material.type !== "choice") return assert.fail("Material muss ein Auswahlwert sein");
    const klotz = specOf(durchstich, "klotz");
    assert.ok(klotz.kind === "body");
    const fremd = { ...klotz, materialId: "unobtainium" };
    assert.equal(material.options(durchstich, fremd)[0]?.value, "unobtainium");
  });
});

describe("Eigenschaften in Änderungen", () => {
  const changeIds = (id: string) =>
    changePropertiesOf(durchstich, specOf(durchstich, id)).map((candidate) => candidate.id);

  it("bietet am Körper Lage, Größe, Material, Geschwindigkeiten und Opazität an", () => {
    assert.deepEqual(changeIds("klotz"), [
      "position",
      "rotation",
      "edges",
      "material",
      "linearVelocity",
      "angularVelocity",
      "opacity",
    ]);
  });

  it("bietet an Ebene und Gravitation nur, was der Kern für sie kennt", () => {
    assert.deepEqual(changeIds("auslauf"), ["position", "rotation", "size", "material", "opacity"]);
    assert.deepEqual(changeIds(DEFAULT_GRAVITY_ID), ["magnitude", "direction", "opacity"]);
  });

  it("zeigt Zustandsgrößen nicht bei den Startwerten", () => {
    const shown = layout(durchstich, "klotz").flat();
    assert.ok(!shown.includes("linearVelocity") && !shown.includes("angularVelocity"), shown.join(", "));
  });

  it("rechnet zwischen Anzeige und Speicherwert hin und zurück", () => {
    const cases: [string, unknown][] = [
      ["rotation", [10, 20, 30]],
      ["edges", [0.4, 0.2, 0.6]],
      ["size", [3, 2, 0.1]],
      ["angularVelocity", [90, 0, -45]],
      ["opacity", 0.3],
    ];
    for (const [id, display] of cases) {
      const binding = property(id).change as {
        fromChange(change: unknown): unknown;
        toChange(value: unknown): unknown;
      };
      const back = binding.fromChange(binding.toChange(display));
      const flat = (value: unknown) => ([] as number[]).concat(value as number | number[]);
      flat(back).forEach((value, index) =>
        assert.ok(Math.abs(value - flat(display)[index]!) < 1e-9, `${id}: ${flat(back)}`),
      );
    }
  });

  it("zeichnet eine Änderung als Auswahl der Eigenschaft und ihren Wert", () => {
    const index = durchstich.interventions.findIndex((intervention) => intervention.op === "change");
    const rows = changeRowsOf(durchstich, index)!;
    assert.deepEqual(
      rows.rows.map((row) => [row.label, row.type]),
      [
        ["Eigenschaft", "choice"],
        ["Geschwindigkeit", "vector3"],
      ],
    );
    const [keyRow, valueRow] = rows.rows;
    assert.ok(valueRow?.type === "vector3");
    assert.deepEqual(valueRow.get(durchstich, rows.spec), [0, 0, 0]);

    // Wert schreiben: dieselbe Zeile, nur ein anderer Wert im Eingriff.
    const thrown = valueRow.set(durchstich, "klotz", [0, 0, 4]);
    const thrownChange = thrown.interventions[index]!;
    assert.deepEqual(thrownChange.op === "change" && thrownChange.change.value, [0, 0, 4]);

    // Eigenschaft wechseln: der Wert wird neu vorbelegt, nicht umgerechnet.
    assert.ok(keyRow?.type === "choice");
    const resized = keyRow.set(durchstich, "klotz", "halfExtents");
    const resizedChange = resized.interventions[index]!;
    assert.deepEqual(resizedChange.op === "change" && resizedChange.change, {
      key: "halfExtents",
      value: [0.1, 0.1, 0.1],
    });
    const resizedRows = changeRowsOf(resized, index)!;
    assert.equal(resizedRows.rows[1]!.label, "Kantenlänge");
    assert.equal(describeIntervention(resized, resized.interventions[index]!), "Eisenklotz: Kantenlänge ändern");
  });

  it("schreibt eine geänderte Drehung als Quaternion, die der Lauf übernimmt", () => {
    const tilted = addChangeAt(durchstich, 0, "auslauf", { key: "opacity", value: 1 });
    const index = tilted.interventions.findIndex(
      (intervention) => intervention.op === "change" && intervention.entityId === "auslauf",
    );
    const keyRow = changeRowsOf(tilted, index)!.rows[0]!;
    assert.ok(keyRow.type === "choice");
    const rotated = keyRow.set(tilted, "auslauf", "orientation");
    const rotationRow = changeRowsOf(rotated, index)!.rows[1]!;
    assert.ok(rotationRow.type === "vector3");
    const next = rotationRow.set(rotated, "auslauf", [0, 10, 0]);
    const change = next.interventions[index]!;
    assert.ok(change.op === "change" && change.change.key === "orientation");
    assert.equal(change.change.value.length, 4);
    assert.doesNotThrow(() => runScenario(next));
  });
});
