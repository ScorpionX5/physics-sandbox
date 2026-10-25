import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ALUMINIUM,
  BUILTIN_LIBRARY,
  checkElementBalance,
  createEmptyScenario,
  createInclinedPlaneScenario,
  Constraint as ConstraintSchema,
  CUBOID,
  electronConfiguration,
  ELEMENTS,
  elementByNumber,
  eulerDegreesFromQuaternion,
  expectedSlideAcceleration,
  findElement,
  IRON,
  molarMassFromFormula,
  parseFormula,
  PLANE,
  quaternionFromEulerDegrees,
  RAMP_INCLINE_DEGREES,
  RAMP_ORIENTATION,
  applyEntityChange,
  entitySpecAt,
  interventionsInOrder,
  isStateChange,
  Scenario as ScenarioSchema,
  shapeVolume,
  shellOccupancy,
  validateLibraryEntry,
  WOOD,
} from "../src/index.js";

describe("Referenztabelle der Elemente", () => {
  it("deckt alle 118 Elemente lueckenlos und in der richtigen Reihenfolge ab", () => {
    assert.equal(ELEMENTS.length, 118);
    ELEMENTS.forEach((element, index) => {
      assert.equal(element.atomicNumber, index + 1, `Ordnungszahl an Position ${index}`);
      assert.ok(element.symbol.length >= 1 && element.symbol.length <= 2);
      assert.ok(element.name.length > 1, `Name fehlt fuer Z=${element.atomicNumber}`);
      assert.ok(element.molarMass > 0);
    });
  });

  it("haelt jede molare Masse im plausiblen Verhaeltnis zur Ordnungszahl", () => {
    // Faengt Zahlendreher und verschobene Zeilen, ohne eine handgepflegte
    // Ausnahmeliste zu brauchen: A/Z liegt real zwischen 1,008 (Wasserstoff)
    // und etwa 2,60 (Plutonium). Ein Tippfehler wie 5.5845 statt 55.845 fuer
    // Eisen faellt damit sofort auf.
    for (const element of ELEMENTS) {
      const ratio = element.molarMass / element.atomicNumber;
      assert.ok(
        ratio >= 1.0 && ratio <= 2.65,
        `${element.symbol} (Z=${element.atomicNumber}): A/Z = ${ratio.toFixed(3)} ist unphysikalisch`,
      );
    }
  });

  it("steigt ueber je drei Schritte verlaesslich an", () => {
    // Einzelne Inversionen sind echt (Ar/K, Co/Ni, Te/I, Th/Pa, U/Np, Pu/Am,
    // Bh/Hs). Ueber drei Ordnungszahlen hinweg muss die Masse aber immer
    // zunehmen - das faengt eine falsch einsortierte Zeile, ohne die
    // Inversionen einzeln auflisten zu muessen.
    for (let z = 1; z + 3 <= 118; z += 1) {
      const current = elementByNumber(z)!;
      const later = elementByNumber(z + 3)!;
      assert.ok(
        later.molarMass > current.molarMass,
        `Masse steigt nicht von ${current.symbol} (${current.molarMass}) zu ${later.symbol} (${later.molarMass})`,
      );
    }
  });

  it("findet Elemente ueber Symbol, deutschen Namen und einelementige Formel", () => {
    assert.equal(findElement("Fe")?.atomicNumber, 26);
    assert.equal(findElement("eisen")?.atomicNumber, 26);
    assert.equal(findElement("O2")?.atomicNumber, 8);
    assert.equal(findElement("Sauerstoff")?.symbol, "O");
    assert.equal(findElement("Unobtainium"), undefined);
  });

  it("gibt bei Schmelz- und Siedepunkt stets Schmelzpunkt unter Siedepunkt an", () => {
    for (const element of ELEMENTS) {
      if (element.meltingPoint === undefined || element.boilingPoint === undefined) continue;
      // Arsen sublimiert bei Normaldruck - der Siedepunkt liegt unter dem
      // Schmelzpunkt. Das ist korrekt und die einzige Ausnahme in der Tabelle.
      if (element.symbol === "As") continue;
      assert.ok(
        element.meltingPoint < element.boilingPoint,
        `${element.symbol}: Schmelzpunkt ${element.meltingPoint} >= Siedepunkt ${element.boilingPoint}`,
      );
    }
  });
});

describe("Elektronenkonfiguration aus dem Aufbauprinzip", () => {
  it("summiert immer genau zur Ordnungszahl", () => {
    for (let z = 1; z <= 118; z += 1) {
      const total = electronConfiguration(z).reduce((sum, o) => sum + o.electrons, 0);
      assert.equal(total, z, `Elektronensumme fuer Z=${z}`);
    }
  });

  it("liefert fuer Eisen die Schalenbesetzung 2, 8, 14, 2", () => {
    // Fe: 1s2 2s2 2p6 3s2 3p6 4s2 3d6 -> Schale 1: 2, Schale 2: 8,
    // Schale 3: 2+6+6 = 14, Schale 4: 2.
    assert.deepEqual(shellOccupancy(26), [2, 8, 14, 2]);
  });

  it("liefert fuer Neon die abgeschlossene Konfiguration 2, 8", () => {
    assert.deepEqual(shellOccupancy(10), [2, 8]);
  });

  it("weist Ordnungszahlen ausserhalb von 1..118 zurueck", () => {
    assert.throws(() => electronConfiguration(0));
    assert.throws(() => electronConfiguration(119));
    assert.throws(() => electronConfiguration(26.5));
  });
});

describe("Summenformeln", () => {
  it("parst einfache und geklammerte Formeln", () => {
    assert.deepEqual([...parseFormula("Fe2O3")!.counts], [["Fe", 2], ["O", 3]]);
    assert.deepEqual([...parseFormula("H2O")!.counts], [["H", 2], ["O", 1]]);
    assert.deepEqual([...parseFormula("Ca(OH)2")!.counts], [["Ca", 1], ["O", 2], ["H", 2]]);
    assert.deepEqual([...parseFormula("CuSO4")!.counts], [["Cu", 1], ["S", 1], ["O", 4]]);
  });

  it("lehnt unlesbare Formeln ab, statt sie zu erraten", () => {
    assert.equal(parseFormula(""), undefined);
    assert.equal(parseFormula("Xx2"), undefined, "unbekanntes Symbol");
    assert.equal(parseFormula("Fe2O3)"), undefined, "unbalancierte Klammer");
    assert.equal(parseFormula("(FeO"), undefined, "unbalancierte Klammer");
    assert.equal(parseFormula("Fe+"), undefined, "Ladung nicht unterstuetzt");
  });

  it("berechnet die molare Masse aus der Formel", () => {
    // 2 * 55.845 + 3 * 15.999 = 111.69 + 47.997 = 159.687
    assert.ok(Math.abs(molarMassFromFormula("Fe2O3")! - 159.687) < 1e-9);
    // 2 * 1.008 + 15.999 = 18.015
    assert.ok(Math.abs(molarMassFromFormula("H2O")! - 18.015) < 1e-9);
  });
});

describe("Elementbilanz von Reaktionen", () => {
  it("akzeptiert eine korrekt ausgeglichene Rostreaktion", () => {
    const result = checkElementBalance(
      { species: [{ formula: "Fe", coefficient: 4 }, { formula: "O2", coefficient: 3 }] },
      { species: [{ formula: "Fe2O3", coefficient: 2 }] },
    );
    assert.equal(result.balanced, true, result.problems.join("; "));
  });

  it("lehnt die unausgeglichene Variante ab und benennt das Element", () => {
    const result = checkElementBalance(
      { species: [{ formula: "Fe", coefficient: 1 }, { formula: "O2", coefficient: 1 }] },
      { species: [{ formula: "Fe2O3", coefficient: 1 }] },
    );
    assert.equal(result.balanced, false);
    assert.ok(
      result.problems.some((p) => p.includes("Fe")),
      `Eisen haette als unausgeglichen gemeldet werden muessen: ${result.problems.join("; ")}`,
    );
  });

  it("lehnt nicht-positive Koeffizienten ab", () => {
    const result = checkElementBalance(
      { species: [{ formula: "Fe", coefficient: 0 }] },
      { species: [{ formula: "Fe", coefficient: 0 }] },
    );
    assert.equal(result.balanced, false);
  });
});

describe("Pruefung der Bibliothekseintraege", () => {
  it("nimmt den Quader als Koerper an und lehnt eine Kante ohne Laenge ab", () => {
    const provenance = { source: "builtin" as const, correctedFields: [], warnings: [] };
    assert.equal(validateLibraryEntry({ definition: CUBOID, provenance }).ok, true);
    const flat = { ...CUBOID, behaviour: { bodyType: "cuboid", halfExtents: [0.1, 0, 0.1] } };
    assert.equal(validateLibraryEntry({ definition: flat, provenance }).ok, false);
  });

  it("trennt Koerper und Material in der Startbibliothek", () => {
    const kinds = BUILTIN_LIBRARY.map((entry) => entry.definition.kind);
    assert.ok(kinds.includes("body"), "kein Koerper in der Startbibliothek");
    assert.ok(kinds.includes("material"), "kein Material in der Startbibliothek");
  });

  const asLibrarian = (definition: unknown) => ({
    definition,
    provenance: { source: "librarian" as const, correctedFields: [], warnings: [] },
  });

  it("laesst die handgepflegten Builtin-Eintraege unveraendert durch", () => {
    for (const builtin of BUILTIN_LIBRARY) {
      const result = validateLibraryEntry(builtin);
      assert.equal(result.ok, true, `${builtin.definition.id}: ${result.errors.join("; ")}`);
      assert.deepEqual(
        result.correctedFields,
        [],
        `${builtin.definition.id} wurde unerwartet korrigiert: ${result.correctedFields.join(", ")}`,
      );
    }
  });

  it("ueberstimmt eine falsche Dichte mit dem Referenzwert und vermerkt es", () => {
    const result = validateLibraryEntry(
      asLibrarian({ ...IRON, mechanical: { ...IRON.mechanical, density: 2000 } }),
    );
    assert.equal(result.ok, true, result.errors.join("; "));
    const definition = result.entry!.definition;
    assert.equal(definition.kind, "material");
    assert.equal(definition.kind === "material" && definition.mechanical.density, 7874);
    assert.ok(result.correctedFields.includes("mechanical.density"));
    assert.ok(result.entry!.provenance.warnings.some((w) => w.includes("mechanical.density")));
  });

  it("akzeptiert eine Dichte innerhalb der Toleranz unveraendert", () => {
    // 7874 * 1.03 = 8110.22 - innerhalb der 5-%-Toleranz, kein Eingriff.
    const result = validateLibraryEntry(
      asLibrarian({ ...IRON, mechanical: { ...IRON.mechanical, density: 8110 } }),
    );
    assert.equal(result.ok, true);
    assert.equal(
      result.entry!.definition.kind === "material" && result.entry!.definition.mechanical.density,
      8110,
    );
    assert.deepEqual(result.correctedFields, []);
  });

  it("erschliesst die Ordnungszahl aus dem deutschen Namen", () => {
    const { chemical, ...ironWithoutChemistry } = IRON;
    const result = validateLibraryEntry(asLibrarian(ironWithoutChemistry));
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(
      result.entry!.definition.kind === "material" &&
        result.entry!.definition.chemical?.atomicNumber,
      26,
    );
    assert.ok(result.correctedFields.includes("chemical.atomicNumber"));
  });

  it("korrigiert eine molare Masse, die nicht zur Summenformel passt", () => {
    const rust = {
      kind: "material" as const,
      id: "eisen-iii-oxid",
      name: "Eisen(III)-oxid",
      formula: "Fe2O3",
      mechanical: { density: 5240, restitution: 0.2 },
      chemical: { molarMass: 200 },
      appearance: {
        macroscopic: { color: "#8b3a1f", metalness: 0.1, roughness: 0.9, opacity: 1 },
        atomic: { atomColor: "#8b3a1f", atomRadius: 140, lattice: "hcp" as const, latticeConstant: 500 },
      },
    };
    const result = validateLibraryEntry(asLibrarian(rust));
    assert.equal(result.ok, true, result.errors.join("; "));
    const molarMass =
      result.entry!.definition.kind === "material"
        ? result.entry!.definition.chemical?.molarMass
        : undefined;
    assert.ok(Math.abs(molarMass! - 159.687) < 1e-9, `erwartet 159.687, war ${molarMass}`);
    assert.ok(result.correctedFields.includes("chemical.molarMass"));
  });

  it("uebernimmt Werte fuer Nicht-Elemente ohne Formel unveraendert", () => {
    const result = validateLibraryEntry(asLibrarian(WOOD));
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(
      result.entry!.definition.kind === "material" && result.entry!.definition.mechanical.density,
      700,
    );
    assert.deepEqual(result.correctedFields, []);
  });

  it("lehnt einen Schmelzpunkt oberhalb des Siedepunkts ab, statt zu raten", () => {
    const result = validateLibraryEntry(
      asLibrarian({
        ...ALUMINIUM,
        thermal: { ...ALUMINIUM.thermal, meltingPoint: 3000, boilingPoint: 2792 },
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("Schmelzpunkt")));
  });

  it("normiert nicht normierte Flaechennormalen, statt die Randbedingung zu verwerfen", () => {
    const segments = PLANE.behaviour.constraintType === "staticSurface" ? PLANE.behaviour.segments : [];
    const skewed = {
      ...PLANE,
      behaviour: {
        constraintType: "staticSurface" as const,
        segments: segments.map((s: (typeof segments)[number]) => ({
          ...s,
          normal: [s.normal[0] * 3, s.normal[1] * 3, s.normal[2] * 3] as [number, number, number],
        })),
      },
    };
    const result = validateLibraryEntry(asLibrarian(skewed));
    assert.equal(result.ok, true, result.errors.join("; "));
    const fixed =
      result.entry!.definition.kind === "constraint" &&
      result.entry!.definition.behaviour.constraintType === "staticSurface"
        ? result.entry!.definition.behaviour.segments
        : [];
    for (const segment of fixed) {
      const length = Math.hypot(...segment.normal);
      assert.ok(Math.abs(length - 1) < 1e-9, `Normale nicht normiert: ${length}`);
    }
  });

  it("lehnt eine Tangente ab, die nicht in der Plattenebene liegt", () => {
    const result = validateLibraryEntry(
      asLibrarian({
        ...PLANE,
        behaviour: {
          constraintType: "staticSurface" as const,
          segments: [
            {
              id: "schief",
              center: [0, 0, 0] as [number, number, number],
              normal: [0, 0, 1] as [number, number, number],
              // Tangente mit z-Anteil: nicht senkrecht zur Normale.
              tangent: [0.7071, 0, 0.7071] as [number, number, number],
              halfExtentU: 1,
              halfExtentV: 1,
              thickness: 0.05,
            },
          ],
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("senkrecht")));
  });

  it("lehnt eine Ausgabe ab, die das Schema verletzt, und nennt den Pfad", () => {
    const result = validateLibraryEntry(
      asLibrarian({ ...IRON, mechanical: { ...IRON.mechanical, density: -5 } }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("density")), result.errors.join("; "));
  });

  it("lehnt eine Stosszahl ausserhalb von 0..1 ab", () => {
    const result = validateLibraryEntry(
      asLibrarian({ ...IRON, mechanical: { ...IRON.mechanical, restitution: 1.5 } }),
    );
    assert.equal(result.ok, false);
  });
});

describe("Stosszahl der Ebene", () => {
  it("liest eine aeltere Randbedingung mit eigener Stosszahl und laesst das Feld fallen", () => {
    // Die Stosszahl einer Ebene kommt vom Material der Instanz. Dateien aus der
    // Zeit davor tragen sie noch am Eintrag und muessen trotzdem laden.
    const old = { ...PLANE, behaviour: { ...PLANE.behaviour, restitution: 0.7 } };
    const parsed = ConstraintSchema.parse(old);
    assert.equal("restitution" in parsed.behaviour, false);
  });

  it("macht Standard unelastisch, damit jede Paarung mit Standard nicht abprallt", () => {
    const standard = BUILTIN_LIBRARY.find((entry) => entry.definition.id === "standard")!.definition;
    assert.ok(standard.kind === "material");
    assert.equal(standard.mechanical.restitution, 0);
  });
});

describe("Geometrie", () => {
  it("berechnet das Volumen eines Wuerfels aus den Halbkanten", () => {
    // Halbkanten 0.1 -> Kantenlaenge 0.2 -> 0.008 m^3
    assert.ok(
      Math.abs(shapeVolume({ type: "box", halfExtents: [0.1, 0.1, 0.1] }) - 0.008) < 1e-15,
    );
  });

  it("liefert die Schulformel a = g * sin(alpha) fuer die Gegenprobe", () => {
    // Diese Funktion liegt absichtlich im Schema-Paket und nicht im Kern: der
    // Kern muss das Ergebnis aus Kontaktimpulsen selbst herausbekommen, sonst
    // prueft der Test sich gegen sich selbst.
    assert.ok(Math.abs(expectedSlideAcceleration(9.81, 30) - 4.905) < 1e-12);
    assert.ok(Math.abs(expectedSlideAcceleration(9.81, 90) - 9.81) < 1e-12);
  });

  it("gibt der Ebene genau ein Segment mit orthonormalen Achsen", () => {
    // Genau ein Segment ist die Voraussetzung dafuer, dass eine Instanz ihre
    // eigene Groesse haben darf - bei mehreren waere nicht entscheidbar,
    // welches gemeint ist.
    const segments = PLANE.behaviour.constraintType === "staticSurface" ? PLANE.behaviour.segments : [];
    assert.equal(segments.length, 1);
    const segment = segments[0]!;
    assert.ok(Math.abs(Math.hypot(...segment.normal) - 1) < 1e-12, "Normale normiert");
    assert.ok(Math.abs(Math.hypot(...segment.tangent) - 1) < 1e-12, "Tangente normiert");
    const dot =
      segment.normal[0] * segment.tangent[0] +
      segment.normal[1] * segment.tangent[1] +
      segment.normal[2] * segment.tangent[2];
    assert.ok(Math.abs(dot) < 1e-12, `Achsen nicht senkrecht: ${dot}`);
    // Im Koerpersystem liegt sie waagerecht, die Normale zeigt auf die
    // Hochachse z; eine Drehung der Instanz neigt sie.
    assert.deepEqual(segment.normal, [0, 0, 1]);
  });
});

describe("Drehung aus Eulerwinkeln", () => {
  it("liefert fuer null Grad das Einheitsquaternion", () => {
    const q = quaternionFromEulerDegrees(0, 0, 0);
    assert.ok(Math.abs(q[0]) < 1e-15 && Math.abs(q[1]) < 1e-15 && Math.abs(q[2]) < 1e-15);
    assert.ok(Math.abs(q[3] - 1) < 1e-15);
  });

  it("ist ein Rundweg: Winkel zu Quaternion zu Winkel", () => {
    // Die Eigenschaft, an der die Oberflaeche haengt: wer 30 Grad eintippt,
    // muss nach dem Speichern wieder 30 Grad sehen und nicht 29,999999.
    const cases: [number, number, number][] = [
      [0, 0, -30],
      [12, 0, 0],
      [0, 45, 0],
      [20, -35, 70],
      [-80, 10, 5],
    ];
    for (const angles of cases) {
      const back = eulerDegreesFromQuaternion(
        quaternionFromEulerDegrees(angles[0], angles[1], angles[2]),
      );
      for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(
          Math.abs(back[axis]! - angles[axis]!) < 1e-9,
          `${angles.join(", ")} kam als ${back.map((v) => v.toFixed(6)).join(", ")} zurueck`,
        );
      }
    }
  });

  it("haelt das Quaternion normiert", () => {
    const length = Math.hypot(...quaternionFromEulerDegrees(33, -17, 128));
    assert.ok(Math.abs(length - 1) < 1e-12, `|q| war ${length}`);
  });

  it("legt bei Gimbal Lock die Drehung auf eine Achse, statt Werte zu erfinden", () => {
    // Bei 90 Grad um Y laufen die Drehungen um X und Z zusammen. Zwei beliebige
    // Werte zurueckzugeben waere schlimmer als einer.
    const back = eulerDegreesFromQuaternion(quaternionFromEulerDegrees(0, 90, 0));
    assert.ok(Math.abs(back[1]! - 90) < 1e-6, `y war ${back[1]}`);
    assert.equal(back[2], 0);
  });

  it("neigt die Normale der schiefen Ebene um genau 30 Grad", () => {
    // Gegen diese Neigung prueft der Gleittest im Kern mit a = g * sin(30).
    // Geneigt wird um y: z ist die Hochachse, eine Drehung um sie wuerde die
    // Platte nur herumschwenken.
    const [, ey, ez] = eulerDegreesFromQuaternion(RAMP_ORIENTATION);
    assert.ok(Math.abs(ez) < 1e-9, `Drehung um z war ${ez}, erwartet 0`);
    assert.ok(
      Math.abs(ey - RAMP_INCLINE_DEGREES) < 1e-9,
      `Drehung um y war ${ey}, erwartet ${RAMP_INCLINE_DEGREES}`,
    );
  });
});

describe("Gesamtdauer und Eingriffszeiten", () => {
  it("lehnt eine Gesamtdauer ohne positive Laenge ab", () => {
    // Ein Szenario von null Sekunden hat keinen einzigen Zeitschritt.
    const base = createEmptyScenario();
    assert.equal(ScenarioSchema.safeParse({ ...base, duration: 0 }).success, false);
    assert.equal(ScenarioSchema.safeParse({ ...base, duration: -1 }).success, false);
  });

  it("verlangt eine Zeit an jedem Eingriff", () => {
    const base = createEmptyScenario();
    const withoutTime = { ...base, interventions: [{ op: "add", entityId: "schwerkraft" }] };
    assert.equal(ScenarioSchema.safeParse(withoutTime).success, false);
  });

  it("lehnt eine Datei mit Etappen ab", () => {
    // Das alte Format wird nicht still umgedeutet: ohne `duration` fehlt die
    // Gesamtdauer, und das Schema sagt es.
    const { duration: _duration, interventions: _interventions, ...rest } = createEmptyScenario();
    const old = { ...rest, stages: [{ id: "a", duration: 5, interventions: [] }] };
    assert.equal(ScenarioSchema.safeParse(old).success, false);
  });

  it("nimmt einen Eingriff hinter der Gesamtdauer an", () => {
    // Er wirkt nur nicht - die Gesamtdauer zu kuerzen soll keine Arbeit loeschen.
    const base = createEmptyScenario();
    const late = {
      ...base,
      interventions: [...base.interventions, { op: "remove", t: 99, entityId: "schwerkraft" }],
    };
    assert.equal(ScenarioSchema.safeParse(late).success, true);
  });

  it("sortiert Eingriffe nach Zeit und laesst gleiche Zeiten in Listenreihenfolge", () => {
    const ordered = interventionsInOrder({
      interventions: [
        { op: "remove", t: 2, entityId: "a" },
        { op: "add", t: 0, entityId: "a" },
        { op: "add", t: 2, entityId: "b" },
        { op: "add", t: 0, entityId: "b" },
      ],
    });
    assert.deepEqual(
      ordered.map(
        (intervention) =>
          `${intervention.t}:${intervention.op}:${"entityId" in intervention ? intervention.entityId : ""}`,
      ),
      ["0:add:a", "0:add:b", "2:remove:a", "2:add:b"],
    );
  });
});

describe("Aenderungen", () => {
  const withInterventions = (interventions: unknown[]) => ({
    ...createInclinedPlaneScenario(),
    interventions,
  });

  it("nimmt eine Aenderung mit passendem Wert an", () => {
    const parsed = ScenarioSchema.safeParse(
      withInterventions([
        { op: "change", t: 1, entityId: "klotz", change: { key: "opacity", value: 0.5 } },
      ]),
    );
    assert.equal(parsed.success, true);
  });

  it("lehnt einen Wert der falschen Form ab", () => {
    for (const change of [
      { key: "opacity", value: 1.5 },
      { key: "position", value: [1, 2] },
      { key: "halfExtents", value: [1, 0, 1] },
      { key: "unbekannt", value: 1 },
    ]) {
      const parsed = ScenarioSchema.safeParse(
        withInterventions([{ op: "change", t: 1, entityId: "klotz", change }]),
      );
      assert.equal(parsed.success, false, JSON.stringify(change));
    }
  });

  it("lehnt Dateien mit den alten Eingriffstypen ab", () => {
    // Nicht still umgedeutet: `change` ersetzt sie, wie `duration` die Etappen.
    for (const old of [
      { op: "setVelocity", t: 2, entityId: "klotz", linear: [0, 0, 0] },
      { op: "move", t: 2, entityId: "klotz", position: [0, 0, 0] },
      { op: "setParameter", t: 2, entityId: "klotz", path: "mass", value: 1 },
    ]) {
      assert.equal(ScenarioSchema.safeParse(withInterventions([old])).success, false, old.op);
    }
  });

  it("faltet Eingabeeigenschaften bis einschliesslich t, bei gleicher Zeit gewinnt der spaetere", () => {
    const scenario = createInclinedPlaneScenario();
    scenario.interventions.push(
      { op: "change", t: 1, entityId: "klotz", change: { key: "opacity", value: 0.5 } },
      { op: "change", t: 3, entityId: "klotz", change: { key: "opacity", value: 0.2 } },
      { op: "change", t: 3, entityId: "klotz", change: { key: "opacity", value: 0.7 } },
    );
    assert.equal(entitySpecAt(scenario, "klotz", 0.99)!.opacity, 1);
    assert.equal(entitySpecAt(scenario, "klotz", 1)!.opacity, 0.5);
    assert.equal(entitySpecAt(scenario, "klotz", 3)!.opacity, 0.7);
    // Das Szenario selbst bleibt unberuehrt.
    assert.equal(scenario.entities.find((entity) => entity.id === "klotz")!.opacity, 1);
  });

  it("laesst die Startlage eines Koerpers bei einer Zustandsaenderung stehen", () => {
    const klotz = createInclinedPlaneScenario().entities.find((entity) => entity.id === "klotz")!;
    assert.equal(isStateChange("body", "position"), true);
    assert.equal(isStateChange("constraint", "position"), false);
    const moved = applyEntityChange(klotz, { key: "position", value: [9, 9, 9] });
    assert.ok(moved.kind === "body");
    assert.deepEqual(moved.pose.position, [-1.732, 0, 2.2]);
  });

  it("verschiebt eine Randbedingung und setzt Groesse samt Dicke", () => {
    const ebene = createInclinedPlaneScenario().entities.find((entity) => entity.id === "auslauf")!;
    const moved = applyEntityChange(ebene, { key: "position", value: [1, 2, 3] });
    const resized = applyEntityChange(moved, { key: "dimensions", value: [2, 1, 0.3] });
    assert.ok(resized.kind === "constraint");
    assert.deepEqual(resized.pose.position, [1, 2, 3]);
    assert.deepEqual(resized.size, [2, 1]);
    assert.equal(resized.thickness, 0.3);
  });

  it("lehnt einen Schluessel ab, der nicht zur Entitaetsart passt", () => {
    const ebene = createInclinedPlaneScenario().entities.find((entity) => entity.id === "auslauf")!;
    assert.throws(() => applyEntityChange(ebene, { key: "linearVelocity", value: [1, 0, 0] }));
    assert.throws(() => applyEntityChange(ebene, { key: "magnitude", value: 1 }));
  });
});

describe("Leeres Startszenario", () => {
  it("dauert fuenf Sekunden", () => {
    assert.equal(createEmptyScenario().duration, 5);
  });

  it("enthaelt keine Koerper oder Flaechen, nur die Standard-Schwerkraft", () => {
    // Leer heisst leer: wer etwas Eigenes baut, soll nichts wegraeumen muessen.
    // Schwerkraft ist dabei keine Ausnahme von "leer", sondern der einzige
    // Grund, warum ein frisch platzierter Koerper ueberhaupt fallen kann.
    const scenario = createEmptyScenario();
    assert.equal(scenario.interventions.length, 1);
    assert.equal(scenario.entities.length, 1);
    assert.equal(scenario.entities[0]!.kind, "load");
    assert.deepEqual(scenario.interventions[0], {
      op: "add",
      t: 0,
      entityId: scenario.entities[0]!.id,
    });
    assert.equal(scenario.library.length, BUILTIN_LIBRARY.length);
  });

  it("hat Schwerkraft eingeschaltet", () => {
    const gravity = createEmptyScenario().entities[0]!;
    assert.ok(gravity.kind === "load");
    assert.equal(gravity.magnitude, 9.81);
    assert.deepEqual(gravity.direction, [0, 0, -1]);
  });

  it("enthaelt keine Rampe mehr, sondern die Ebene", () => {
    const constraints = createEmptyScenario()
      .library.filter((entry) => entry.definition.kind === "constraint")
      .map((entry) => entry.definition.id);
    assert.deepEqual(constraints, ["ebene"]);
  });
});

describe("Durchstich-Szenario", () => {
  it("parst gegen das Schema, dauert vier Sekunden und greift bei 0 s und 2 s ein", () => {
    const scenario = createInclinedPlaneScenario();
    assert.equal(scenario.duration, 4);
    assert.deepEqual([...new Set(scenario.interventions.map((intervention) => intervention.t))], [0, 2]);
  });

  it("stellt die Schwerkraft als Last bereit, nicht als Konstante", () => {
    const gravity = createInclinedPlaneScenario().entities.find((entity) => entity.kind === "load");
    assert.ok(gravity && gravity.kind === "load");
    assert.equal(gravity.magnitude, 9.81);
    assert.deepEqual(gravity.direction, [0, 0, -1]);
  });

  it("baut die Rampe aus zwei Instanzen der Ebene", () => {
    // Der Kern der Umstellung: ein Bibliothekseintrag, zwei sehr verschiedene
    // Flaechen - unterschiedliche Lage, Drehung und Groesse an der Instanz.
    const scenario = createInclinedPlaneScenario();
    const planes = scenario.entities.filter((entity) => entity.kind === "constraint");
    assert.equal(planes.length, 2);
    for (const plane of planes) {
      assert.ok(plane.kind === "constraint");
      assert.equal(plane.constraintId, "ebene");
      assert.ok(plane.size, `${plane.id} hat keine eigene Groesse`);
    }
  });

  it("laesst die schiefe Ebene genau an der Knickkante enden", () => {
    const scenario = createInclinedPlaneScenario();
    const incline = scenario.entities.find((entity) => entity.id === "schiefe-ebene");
    assert.ok(incline && incline.kind === "constraint");
    const [cx, , cz] = incline.pose.position;
    const halfU = incline.size![0];
    // Falllinie der um +30 Grad um y gedrehten Platte: (cos 30, 0, -sin 30).
    const radians = (RAMP_INCLINE_DEGREES * Math.PI) / 180;
    assert.ok(Math.abs(cx + Math.cos(radians) * halfU) < 1e-3, "bergab-Ende nicht bei x = 0");
    assert.ok(Math.abs(cz - Math.sin(radians) * halfU) < 1e-3, "bergab-Ende nicht bei z = 0");
  });

  it("laesst den Auslauf unter der Knickkante beginnen", () => {
    // Ohne diesen Ueberlapp koennte eine Ecke an der Naht ausserhalb beider
    // Platten liegen und der Kontakt fuer einen Zeitschritt ausfallen.
    const scenario = createInclinedPlaneScenario();
    const runout = scenario.entities.find((entity) => entity.id === "auslauf");
    assert.ok(runout && runout.kind === "constraint");
    const leftEdge = runout.pose.position[0] - runout.size![0];
    assert.ok(leftEdge < 0, `Auslauf beginnt erst bei x=${leftEdge}, also rechts der Kante`);
  });

  it("haelt den Klotz bei t = 2 s ueber Aenderungen der Geschwindigkeit an", () => {
    const atTwo = createInclinedPlaneScenario().interventions.filter((item) => item.t === 2);
    assert.deepEqual(
      atTwo.map((item) => (item.op === "change" ? `${item.entityId}:${item.change.key}` : item.op)),
      ["klotz:linearVelocity"],
    );
  });

  it("ist nach Schreiben, Lesen und erneutem Schreiben identisch (Roundtrip)", () => {
    // Die Grundlage von Speichern und Laden: eine Datei, die gelesen und wieder
    // geschrieben wird, muss Zeichen fuer Zeichen dieselbe sein.
    const once = JSON.stringify(createInclinedPlaneScenario());
    const twice = JSON.stringify(ScenarioSchema.parse(JSON.parse(once)));
    assert.equal(once, twice);
  });

  it("verweist nur auf Bibliothekseintraege, die es auch mitbringt", () => {
    const scenario = createInclinedPlaneScenario();
    const known = new Set(scenario.library.map((entry) => entry.definition.id));
    for (const entity of scenario.entities) {
      const needed =
        entity.kind === "body"
          ? [entity.bodyId, entity.materialId]
          : entity.kind === "constraint"
            ? [entity.constraintId, entity.materialId]
            : [entity.loadId];
      for (const id of needed) {
        assert.ok(known.has(id), `Eintrag "${id}" fehlt in der mitgelieferten Bibliothek`);
      }
    }
  });

  it("fuegt nur Entitaeten hinzu, die es auch definiert", () => {
    const scenario = createInclinedPlaneScenario();
    const defined = new Set(scenario.entities.map((entity) => entity.id));
    for (const intervention of scenario.interventions) {
      if (intervention.op === "add") assert.ok(defined.has(intervention.entityId));
    }
  });
});
