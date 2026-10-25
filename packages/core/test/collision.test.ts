import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  BUILTIN_LIBRARY,
  EARTH_GRAVITY,
  STANDARD,
  type EntitySpec,
  type LibraryEntry,
  type Material,
  type Scenario,
  type Shape,
  type Vec3,
} from "@sandbox/schema";

import {
  createOverlap,
  entityTrack,
  makeMechanicalState,
  overlapBodies,
  runScenario,
  type RuntimeBody,
} from "../src/index.js";

// ---------------------------------------------------------------- Hilfsmittel

/** Stosszahl 1: idealelastisch. Nur fuer die Tests - die Bibliothek liefert keinen solchen Stoff. */
const ELASTIC: Material = {
  ...STANDARD,
  id: "elastisch",
  name: "Elastisch",
  mechanical: { ...STANDARD.mechanical, restitution: 1 },
};

const HALF_ELASTIC: Material = {
  ...STANDARD,
  id: "halb",
  name: "Halbelastisch",
  mechanical: { ...STANDARD.mechanical, restitution: 0.5 },
};

const LIBRARY: LibraryEntry[] = [
  ...BUILTIN_LIBRARY,
  ...[ELASTIC, HALF_ELASTIC].map((definition) => ({
    definition,
    provenance: { source: "manual" as const, correctedFields: [], warnings: [] },
  })),
];

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

function body(
  id: string,
  materialId: string,
  position: Vec3,
  options: { velocity?: Vec3; half?: number; shape?: Shape; kinematic?: boolean } = {},
): EntitySpec {
  const half = options.half ?? 0.1;
  return {
    kind: "body",
    id,
    bodyId: "quader",
    materialId,
    opacity: 1,
    phase: { state: "solid", shape: options.shape ?? { type: "box", halfExtents: [half, half, half] } },
    pose: { position, orientation: IDENTITY },
    velocity: { linear: options.velocity ?? [0, 0, 0], angular: [0, 0, 0] },
    kinematic: options.kinematic ?? false,
  };
}

/** Eine grosse waagerechte Ebene mit Oberseite bei z = 0. */
function plane(materialId: string): EntitySpec {
  return {
    kind: "constraint",
    id: "boden",
    constraintId: "ebene",
    materialId,
    opacity: 1,
    pose: { position: [0, 0, 0], orientation: IDENTITY },
    size: [5, 5],
  };
}

function scene(
  entities: EntitySpec[],
  options: { gravity?: number; duration?: number; interventions?: Scenario["interventions"] } = {},
): Scenario {
  const gravity = options.gravity ?? 0;
  const all: EntitySpec[] = [
    { kind: "load", id: "schwerkraft", loadId: "gravitation", opacity: 1, magnitude: gravity, direction: [0, 0, -1] },
    ...entities,
  ];
  return {
    schemaVersion: 1,
    id: "test-kollision",
    name: "Kollision",
    environment: {},
    view: { layer: "macroscopic", showAxes: true },
    library: LIBRARY,
    // Jeder Zeitschritt wird aufgezeichnet: die Stoesse sind einen Schritt lang.
    simulation: { dt: 0.001, recordRate: 1000, seed: 1 },
    entities: all,
    duration: options.duration ?? 1,
    interventions: [
      ...all.map((entity) => ({ op: "add" as const, t: 0, entityId: entity.id })),
      ...(options.interventions ?? []),
    ],
    directionTrack: [],
  };
}

const lastOf = (recording: ReturnType<typeof runScenario>, id: string) => entityTrack(recording, id).at(-1)!;

/** Masse eines Wuerfels aus Standard/elastischem Material: Dichte 1000 kg/m^3. */
const cubeMass = (half: number): number => 1000 * (2 * half) ** 3;

// ---------------------------------------------------------------- Stoss mit der Ebene

describe("Stoss mit der Ebene: Stosszahl aus der Materialpaarung", () => {
  /** Faellt aus 0,5 m und gibt Geschwindigkeit vor und nach dem ersten Aufprall zurueck. */
  function firstImpact(bodyMaterial: string, planeMaterial: string, interventions?: Scenario["interventions"]) {
    const recording = runScenario(
      scene([plane(planeMaterial), body("ball", bodyMaterial, [0, 0, 0.6])], {
        gravity: EARTH_GRAVITY,
        duration: 1,
        interventions,
      }),
    );
    const track = entityTrack(recording, "ball");
    const index = track.findIndex((sample, i) => i > 0 && sample.mechanics.contactCount > 0);
    assert.ok(index > 1, "kein Aufprall gefunden");
    return {
      beforeStep: track[index - 1]!.mechanics.linearVelocity[2],
      after: track[index]!.mechanics.linearVelocity[2],
    };
  }

  it("gibt den Anteil e der Aufprallgeschwindigkeit zurueck, e = Minimum der beiden Materialien", () => {
    // Der Aufprall geschieht im Schritt nach `beforeStep`: erst addiert der
    // Integrator g*dt, dann dreht der Kontakt die Normalkomponente um und
    // verkleinert sie auf e.
    const dt = 0.001;
    for (const [bodyMaterial, planeMaterial, e] of [
      ["halb", "halb", 0.5],
      ["elastisch", "halb", 0.5],
      ["halb", "elastisch", 0.5],
      ["elastisch", "elastisch", 1],
    ] as const) {
      const { beforeStep, after } = firstImpact(bodyMaterial, planeMaterial);
      const impactSpeed = -(beforeStep - EARTH_GRAVITY * dt);
      assert.ok(
        Math.abs(after - e * impactSpeed) < 1e-9,
        `${bodyMaterial} auf ${planeMaterial}: v danach ${after}, erwartet ${e * impactSpeed}`,
      );
    }
  });

  it("prallt auf Standard nicht ab, egal aus welchem Material der Koerper ist", () => {
    // Standard hat Stosszahl 0; das Minimum macht jede Paarung unelastisch. Das
    // ist das Verhalten, das es vor den Stosszahlen gab.
    for (const bodyMaterial of ["standard", "elastisch", "eisen"]) {
      const { after } = firstImpact(bodyMaterial, "standard");
      assert.ok(Math.abs(after) < 1e-9, `${bodyMaterial} auf Standard: v danach ${after}, erwartet 0`);
    }
  });

  it("uebernimmt einen Materialwechsel der Ebene", () => {
    // Das Material der Ebene wird zur Laufzeit neu gelesen, nicht nur beim
    // Anlegen: sonst prallt der Koerper nach dem Wechsel mit der alten Zahl ab.
    const { beforeStep, after } = firstImpact("elastisch", "standard", [
      { op: "change", t: 0, entityId: "boden", change: { key: "materialId", value: "elastisch" } },
    ]);
    assert.ok(Math.abs(after + (beforeStep - EARTH_GRAVITY * 0.001)) < 1e-9, `v danach ${after}`);
  });

  it("kommt trotz Stosszahl zur Ruhe, statt fuer immer zu huepfen", () => {
    const recording = runScenario(
      scene([plane("halb"), body("ball", "halb", [0, 0, 0.6])], { gravity: EARTH_GRAVITY, duration: 4 }),
    );
    const end = lastOf(recording, "ball");
    assert.ok(Math.abs(end.mechanics.position[2] - 0.1) < 1e-3, `z war ${end.mechanics.position[2]}`);
    assert.ok(Math.abs(end.mechanics.linearVelocity[2]) < 0.05, `v_z war ${end.mechanics.linearVelocity[2]}`);
    // Und er ist wirklich zwischendurch abgeprallt, sonst prueft der Test nichts.
    const peak = Math.max(
      ...entityTrack(recording, "ball")
        .filter((sample) => sample.t > 0.5)
        .map((sample) => sample.mechanics.position[2]),
    );
    assert.ok(peak > 0.12, `der Ball stieg nach t = 0,5 s nicht mehr (Maximum ${peak})`);
  });
});

// ---------------------------------------------------------------- Stoss zweier Koerper

describe("Stoss zweier Koerper", () => {
  const velocityOf = (recording: ReturnType<typeof runScenario>, id: string): number =>
    lastOf(recording, id).mechanics.linearVelocity[0];

  it("tauscht bei gleicher Masse und e = 1 die Geschwindigkeiten", () => {
    const recording = runScenario(
      scene(
        [body("a", "elastisch", [-1, 0, 0], { velocity: [2, 0, 0] }), body("b", "elastisch", [1, 0, 0])],
        { duration: 2 },
      ),
    );
    assert.ok(Math.abs(velocityOf(recording, "a")) < 1e-9, `a: ${velocityOf(recording, "a")}`);
    assert.ok(Math.abs(velocityOf(recording, "b") - 2) < 1e-9, `b: ${velocityOf(recording, "b")}`);
  });

  it("folgt bei verschiedenen Massen den Stossgesetzen und erhaelt den Impuls", () => {
    // Zentraler Stoss mit Stosszahl e (hier 0,5):
    //   v1' = ((m1 - e m2) v1 + (1 + e) m2 v2) / (m1 + m2)
    //   v2' = ((m2 - e m1) v2 + (1 + e) m1 v1) / (m1 + m2)
    const e = 0.5;
    const m1 = cubeMass(0.1);
    const m2 = cubeMass(0.2);
    const v1 = 3;
    const recording = runScenario(
      scene(
        [
          body("a", "halb", [-1, 0, 0], { velocity: [v1, 0, 0], half: 0.1 }),
          body("b", "halb", [1, 0, 0], { half: 0.2 }),
        ],
        { duration: 2 },
      ),
    );
    const expectedA = ((m1 - e * m2) * v1) / (m1 + m2);
    const expectedB = ((1 + e) * m1 * v1) / (m1 + m2);
    assert.ok(Math.abs(velocityOf(recording, "a") - expectedA) < 1e-9, `a: ${velocityOf(recording, "a")} statt ${expectedA}`);
    assert.ok(Math.abs(velocityOf(recording, "b") - expectedB) < 1e-9, `b: ${velocityOf(recording, "b")} statt ${expectedB}`);
    const momentum = m1 * velocityOf(recording, "a") + m2 * velocityOf(recording, "b");
    assert.ok(Math.abs(momentum - m1 * v1) < 1e-6, `Impuls ${momentum} statt ${m1 * v1}`);
  });

  it("erhaelt bei e = 1 auch die kinetische Energie", () => {
    const m1 = cubeMass(0.1);
    const m2 = cubeMass(0.2);
    const v1 = 3;
    const recording = runScenario(
      scene(
        [
          body("a", "elastisch", [-1, 0, 0], { velocity: [v1, 0, 0], half: 0.1 }),
          body("b", "elastisch", [1, 0, 0], { half: 0.2 }),
        ],
        { duration: 2 },
      ),
    );
    const energy = 0.5 * m1 * velocityOf(recording, "a") ** 2 + 0.5 * m2 * velocityOf(recording, "b") ** 2;
    assert.ok(Math.abs(energy - 0.5 * m1 * v1 * v1) < 1e-6, `Energie ${energy} statt ${0.5 * m1 * v1 * v1}`);
  });

  it("bleibt mit Standard als Partner vollstaendig unelastisch", () => {
    // Min(1, 0) = 0: beide haben danach dieselbe Geschwindigkeit, v = m1 v1 / (m1 + m2).
    const m1 = cubeMass(0.1);
    const m2 = cubeMass(0.1);
    const recording = runScenario(
      scene(
        [body("a", "elastisch", [-1, 0, 0], { velocity: [2, 0, 0] }), body("b", "standard", [1, 0, 0])],
        { duration: 2 },
      ),
    );
    const expected = (m1 * 2) / (m1 + m2);
    assert.ok(Math.abs(velocityOf(recording, "a") - expected) < 1e-9, `a: ${velocityOf(recording, "a")}`);
    assert.ok(Math.abs(velocityOf(recording, "b") - expected) < 1e-9, `b: ${velocityOf(recording, "b")}`);
  });

  it("prallt von einem festgehaltenen Koerper ab wie von einer Wand", () => {
    const recording = runScenario(
      scene(
        [
          body("a", "elastisch", [-1, 0, 0], { velocity: [2, 0, 0] }),
          body("wand", "elastisch", [1, 0, 0], { kinematic: true }),
        ],
        { duration: 2 },
      ),
    );
    assert.ok(Math.abs(velocityOf(recording, "a") + 2) < 1e-9, `a: ${velocityOf(recording, "a")}`);
    assert.deepEqual(lastOf(recording, "wand").mechanics.position, [1, 0, 0]);
  });

  it("zaehlt den Koerper-Kontakt in contactCount", () => {
    const recording = runScenario(
      scene([body("a", "standard", [-1, 0, 0], { velocity: [2, 0, 0] }), body("b", "standard", [1, 0, 0])], {
        duration: 1,
      }),
    );
    const touching = entityTrack(recording, "a").filter((sample) => sample.mechanics.contactCount > 0);
    assert.ok(touching.length >= 1, "der Stoss wurde nicht als Kontakt gezaehlt");
    assert.equal(entityTrack(recording, "a")[0]!.mechanics.contactCount, 0);
  });

  it("stoesst Kugeln wie Quader", () => {
    const sphere: Shape = { type: "sphere", radius: 0.1 };
    const recording = runScenario(
      scene(
        [
          body("a", "elastisch", [-1, 0, 0], { velocity: [2, 0, 0], shape: sphere }),
          body("b", "elastisch", [1, 0, 0], { shape: sphere }),
        ],
        { duration: 2 },
      ),
    );
    assert.ok(Math.abs(velocityOf(recording, "a")) < 1e-9);
    assert.ok(Math.abs(velocityOf(recording, "b") - 2) < 1e-9);
  });

  it("stoesst Kugel gegen Quader in Richtung der Quaderflaeche", () => {
    // Die Kugel trifft die Seitenflaeche des Quaders mittig: der Stoss laeuft
    // genau in x, y bleibt unberuehrt.
    const recording = runScenario(
      scene(
        [
          body("kugel", "elastisch", [-1, 0, 0], { velocity: [2, 0, 0], shape: { type: "sphere", radius: 0.1 } }),
          body("quader", "elastisch", [1, 0, 0], { kinematic: true }),
        ],
        { duration: 2 },
      ),
    );
    const end = lastOf(recording, "kugel").mechanics;
    assert.ok(Math.abs(end.linearVelocity[0] + 2) < 1e-9, `v_x war ${end.linearVelocity[0]}`);
    assert.ok(Math.abs(end.linearVelocity[1]) < 1e-12 && Math.abs(end.linearVelocity[2]) < 1e-12);
  });
});

// ---------------------------------------------------------------- Stapel

describe("Stapel", () => {
  it("bleibt als Stapel stehen und huepft auch mit Stosszahl nicht", () => {
    // Drei Quader mit kleinem Abstand aufeinander gesetzt, alle halbelastisch:
    // sie setzen sich und liegen dann. Ohne Ruheschwelle stiege der oberste
    // fuer immer in Mikrometern auf und ab.
    const gap = 0.01;
    const recording = runScenario(
      scene(
        [
          plane("halb"),
          body("unten", "halb", [0, 0, 0.1 + gap]),
          body("mitte", "halb", [0, 0, 0.3 + 2 * gap]),
          body("oben", "halb", [0, 0, 0.5 + 3 * gap]),
        ],
        { gravity: EARTH_GRAVITY, duration: 3 },
      ),
    );
    for (const [id, z] of [
      ["unten", 0.1],
      ["mitte", 0.3],
      ["oben", 0.5],
    ] as const) {
      const end = lastOf(recording, id).mechanics;
      assert.ok(Math.abs(end.position[2] - z) < 2e-3, `${id}: z war ${end.position[2]}, erwartet ${z}`);
      // Die Restgeschwindigkeit eines Stapels liegt unter der Ruheschwelle (zehn
      // Schritte Schwerkraft, knapp 0,1 m/s); die Lagekorrektur haelt die Lage
      // trotzdem exakt.
      assert.ok(Math.abs(end.linearVelocity[2]) < 0.1, `${id}: v_z war ${end.linearVelocity[2]}`);
      assert.ok(Math.abs(end.position[0]) < 1e-9, `${id} ist seitlich weggewandert`);
    }
    // Nach dem Setzen steigt der oberste nicht mehr merklich ueber seine Ruhelage.
    const hopping = entityTrack(recording, "oben")
      .filter((sample) => sample.t > 2)
      .map((sample) => sample.mechanics.position[2]);
    assert.ok(Math.max(...hopping) < 0.5 + 1e-3, `der oberste huepfte bis ${Math.max(...hopping)}`);
  });

  it("liegt bei Stosszahl 1 ruhig, statt in jedem zweiten Schritt den Kontakt zu verlieren", () => {
    // Genau der Fall, den die Ruheschwelle loest: ohne sie gibt ein aufliegender
    // Koerper bei e = 1 die g*dt, die er pro Schritt hineinfaellt, vollstaendig
    // zurueck. Er huepft dann in Mikrometern, und contactCount wechselt
    // tausendmal pro Sekunde zwischen 0 und 1.
    const recording = runScenario(
      scene(
        [
          plane("elastisch"),
          body("unten", "elastisch", [0, 0, 0.1]),
          body("mitte", "elastisch", [0, 0, 0.3]),
          body("oben", "elastisch", [0, 0, 0.5]),
        ],
        { gravity: EARTH_GRAVITY, duration: 2 },
      ),
    );
    for (const [id, z] of [
      ["unten", 0.1],
      ["mitte", 0.3],
      ["oben", 0.5],
    ] as const) {
      const settled = entityTrack(recording, id).filter((sample) => sample.t > 0.5);
      const heights = settled.map((sample) => sample.mechanics.position[2]);
      assert.ok(Math.max(...heights) - Math.min(...heights) < 1e-6, `${id} huepft: ${Math.max(...heights) - Math.min(...heights)} m`);
      assert.ok(Math.abs(heights[0]! - z) < 1e-3, `${id}: z war ${heights[0]}, erwartet ${z}`);
      const changes = settled.filter(
        (sample, i) => i > 0 && sample.mechanics.contactCount > 0 !== (settled[i - 1]!.mechanics.contactCount > 0),
      ).length;
      assert.equal(changes, 0, `${id}: contactCount wechselte ${changes}-mal`);
    }
  });

  it("laesst keine Durchdringung zwischen den Quadern uebrig", () => {
    const recording = runScenario(
      scene([plane("standard"), body("unten", "standard", [0, 0, 0.1]), body("oben", "standard", [0, 0, 1])], {
        gravity: EARTH_GRAVITY,
        duration: 2,
      }),
    );
    const end = lastOf(recording, "oben").mechanics.position[2] - lastOf(recording, "unten").mechanics.position[2];
    assert.ok(end > 0.2 - 1e-3, `Abstand der Mittelpunkte ${end}, mindestens 0,2 erwartet`);
    assert.deepEqual(recording.events.filter((event) => event.type === "warning"), []);
  });
});

describe("Determinismus der Kollision", () => {
  it("liefert bei zwei Laeufen identische Aufzeichnungen", () => {
    const build = () =>
      scene(
        [
          plane("halb"),
          body("a", "halb", [-0.5, 0.02, 0.3], { velocity: [2, 0, 0] }),
          body("b", "halb", [0.5, 0, 0.1]),
          body("c", "halb", [0, 0, 0.6], { half: 0.15 }),
        ],
        { gravity: EARTH_GRAVITY, duration: 2 },
      );
    assert.equal(JSON.stringify(runScenario(build())), JSON.stringify(runScenario(build())));
  });
});

// ---------------------------------------------------------------- Geometrie

describe("Ueberlappung (overlapBodies)", () => {
  function fake(position: Vec3, shape: Shape, orientation: [number, number, number, number] = IDENTITY): RuntimeBody {
    return { id: "x", shape, mechanics: makeMechanicalState(position, orientation) } as unknown as RuntimeBody;
  }
  const cube = (half: number): Shape => ({ type: "box", halfExtents: [half, half, half] });
  const assertNormal = (actual: readonly number[], expected: readonly number[]): void => {
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(actual[i]! - expected[i]!) < 1e-12, `Normale ${[...actual]}, erwartet ${expected}`);
    }
  };
  const SIN_22_5 = Math.sqrt((1 - Math.SQRT1_2) / 2);
  const COS_22_5 = Math.sqrt((1 + Math.SQRT1_2) / 2);

  it("misst bei Flaeche gegen Flaeche die Eindringtiefe entlang der Normale", () => {
    const out = createOverlap();
    assert.equal(overlapBodies(fake([0, 0, 0], cube(1)), fake([1.8, 0, 0], cube(1)), out), true);
    assert.ok(Math.abs(out.depth - 0.2) < 1e-12, `Tiefe ${out.depth}`);
    assertNormal(out.normal, [1, 0, 0]);
  });

  it("richtet die Normale immer von a nach b", () => {
    const out = createOverlap();
    overlapBodies(fake([0, 0, 0], cube(1)), fake([0, -1.8, 0], cube(1)), out);
    assertNormal(out.normal, [0, -1, 0]);
  });

  it("meldet keine Ueberlappung bei Abstand und bei blosser Beruehrung", () => {
    const out = createOverlap();
    assert.equal(overlapBodies(fake([0, 0, 0], cube(1)), fake([2.5, 0, 0], cube(1)), out), false);
    assert.equal(overlapBodies(fake([0, 0, 0], cube(1)), fake([2, 0, 0], cube(1)), out), false);
  });

  it("findet die Ecke, die in eine Flaeche ragt", () => {
    // Um z um 45 Grad gedreht reicht die Ecke des zweiten Quaders sqrt(2) in x.
    const out = createOverlap();
    const rotated = fake([2.2, 0, 0], cube(1), [0, 0, SIN_22_5, COS_22_5]);
    assert.equal(overlapBodies(fake([0, 0, 0], cube(1)), rotated, out), true);
    assert.ok(Math.abs(out.depth - (1 - (2.2 - Math.SQRT2))) < 1e-9, `Tiefe ${out.depth}`);
    assert.ok(Math.abs(out.normal[0] - 1) < 1e-9);
  });

  it("findet den Kantenkontakt kreuzender Kanten", () => {
    // Beide auf der Kante stehend, die Kanten kreuzen sich rechtwinklig: die
    // Flaechenachsen sehen eine viel groessere Ueberlappung als die Kantenachse.
    const out = createOverlap();
    const delta = 0.01;
    const a = fake([0, 0, 0], cube(1), [SIN_22_5, 0, 0, COS_22_5]);
    const b = fake([0, 0, 2 * Math.SQRT2 - delta], cube(1), [0, SIN_22_5, 0, COS_22_5]);
    assert.equal(overlapBodies(a, b, out), true);
    assert.ok(Math.abs(out.depth - delta) < 1e-9, `Tiefe ${out.depth}`);
    assert.ok(Math.abs(out.normal[2] - 1) < 1e-9, `Normale ${[...out.normal]}`);
  });

  it("misst Kugel gegen Kugel", () => {
    const out = createOverlap();
    const ball: Shape = { type: "sphere", radius: 1 };
    assert.equal(overlapBodies(fake([0, 0, 0], ball), fake([0, 0, 1.5], ball), out), true);
    assert.ok(Math.abs(out.depth - 0.5) < 1e-12);
    assertNormal(out.normal, [0, 0, 1]);
  });

  it("misst Kugel gegen Quader mit richtiger Normalenrichtung, egal welcher zuerst kommt", () => {
    const ball: Shape = { type: "sphere", radius: 0.5 };
    const out = createOverlap();
    // Kugelmittelpunkt 0,4 ueber der Quaderoberseite (z = 1): Eindringtiefe 0,1.
    assert.equal(overlapBodies(fake([0, 0, 0], cube(1)), fake([0.2, 0.3, 1.4], ball), out), true);
    assert.ok(Math.abs(out.depth - 0.1) < 1e-12, `Tiefe ${out.depth}`);
    assertNormal(out.normal, [0, 0, 1]);
    assert.equal(overlapBodies(fake([0.2, 0.3, 1.4], ball), fake([0, 0, 0], cube(1)), out), true);
    assertNormal(out.normal, [0, 0, -1]);
  });

  it("schiebt eine Kugel mit Mittelpunkt im Quader durch die naechste Flaeche hinaus", () => {
    const out = createOverlap();
    const ball: Shape = { type: "sphere", radius: 0.2 };
    assert.equal(overlapBodies(fake([0, 0, 0], cube(1)), fake([0.9, 0, 0.1], ball), out), true);
    assertNormal(out.normal, [1, 0, 0]);
    assert.ok(Math.abs(out.depth - (0.1 + 0.2)) < 1e-12, `Tiefe ${out.depth}`);
  });
});
