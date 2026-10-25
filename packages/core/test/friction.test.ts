import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  BUILTIN_LIBRARY,
  EARTH_GRAVITY,
  IRON,
  STANDARD,
  WOOD,
  type EntitySpec,
  type LibraryEntry,
  type Material,
  type Scenario,
  type Shape,
  type Vec3,
} from "@sandbox/schema";

import { averageAccelerationAlong, entityTrack, runScenario, sampleNearest, speedOf } from "../src/index.js";

// ---------------------------------------------------------------- Hilfsmittel

/**
 * Standard ohne Rollreibung: fuer die Faelle, deren Lehrbuchformel nur Haft-
 * und Gleitreibung kennt (Abrollen mit a = 5/7 g sin alpha).
 */
const NO_ROLLING: Material = {
  ...STANDARD,
  id: "ohne-rollreibung",
  name: "Ohne Rollreibung",
  mechanical: { ...STANDARD.mechanical, rollingFriction: 0 },
};

const LIBRARY: LibraryEntry[] = [
  ...BUILTIN_LIBRARY,
  { definition: NO_ROLLING, provenance: { source: "manual", correctedFields: [], warnings: [] } },
];

const HALF = 0.1;
const RADIUS = 0.1;
const SPHERE: Shape = { type: "sphere", radius: RADIUS };

type Quat = [number, number, number, number];

/** Drehung um +y: neigt eine waagerechte Ebene so, dass sie in +x abfaellt. Nur im Test - der Kern rechnet ohne Winkelfunktionen. */
function tiltAboutY(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/** Falllinie und Normale einer um `degrees` geneigten Ebene. */
function slope(degrees: number): { downhill: Vec3; normal: Vec3 } {
  const a = (degrees * Math.PI) / 180;
  return { downhill: [Math.cos(a), 0, -Math.sin(a)], normal: [Math.sin(a), 0, Math.cos(a)] };
}

function floor(materialId: string, degrees = 0): EntitySpec {
  return {
    kind: "constraint",
    id: "boden",
    constraintId: "ebene",
    materialId,
    opacity: 1,
    pose: { position: [0, 0, 0], orientation: tiltAboutY(degrees) },
    size: [20, 5],
  };
}

/**
 * Ein Koerper, der auf der Ebene durch den Ursprung aufliegt: Mittelpunkt eine
 * halbe Kante (bzw. ein Radius) entlang der Normale, Drehung wie die Ebene.
 */
function resting(
  materialId: string,
  degrees: number,
  options: { shape?: Shape; velocity?: Vec3; angular?: Vec3 } = {},
): EntitySpec {
  const shape = options.shape ?? { type: "box", halfExtents: [HALF, HALF, HALF] };
  const lift = shape.type === "sphere" ? shape.radius : HALF;
  const { normal } = slope(degrees);
  return {
    kind: "body",
    id: "klotz",
    bodyId: "quader",
    materialId,
    opacity: 1,
    phase: { state: "solid", shape },
    pose: { position: [normal[0] * lift, 0, normal[2] * lift], orientation: tiltAboutY(degrees) },
    velocity: { linear: options.velocity ?? [0, 0, 0], angular: options.angular ?? [0, 0, 0] },
    kinematic: false,
  };
}

function scene(entities: EntitySpec[], duration: number): Scenario {
  const all: EntitySpec[] = [
    {
      kind: "load",
      id: "schwerkraft",
      loadId: "gravitation",
      opacity: 1,
      magnitude: EARTH_GRAVITY,
      direction: [0, 0, -1],
    },
    ...entities,
  ];
  return {
    schemaVersion: 1,
    id: "test-reibung",
    name: "Reibung",
    environment: {},
    view: { layer: "macroscopic", showAxes: true },
    library: LIBRARY,
    simulation: { dt: 0.001, recordRate: 100, seed: 1 },
    entities: all,
    duration,
    interventions: all.map((entity) => ({ op: "add" as const, t: 0, entityId: entity.id })),
    directionTrack: [],
  };
}

const relativeError = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Reibwert der Paarung, wie der Kern ihn bildet: geometrisches Mittel. */
const pair = (a: number | undefined, b: number | undefined): number => Math.sqrt(a! * b!);

const muG = STANDARD.mechanical.kineticFriction!;

// ---------------------------------------------------------------- Schiefe Ebene

describe("Reibung auf der schiefen Ebene", () => {
  it("haftet, solange tan(alpha) < mu_H, und kriecht dabei nicht", () => {
    // 20 Grad: tan = 0,364 < 0,5. Ohne den Lagenachtrag des Reibstosses
    // kroeche der Klotz trotz Geschwindigkeit 0 um 1/2 g sin(alpha) dt^2 je
    // Schritt hangab - in einer Sekunde 1,7 mm.
    const recording = runScenario(scene([floor("standard", 20), resting("standard", 20)], 1));
    const track = entityTrack(recording, "klotz");
    const start = track[0]!.mechanics.position;
    const end = track.at(-1)!.mechanics;
    const drift = Math.hypot(end.position[0] - start[0], end.position[1] - start[1], end.position[2] - start[2]);
    assert.ok(drift < 1e-6, `Klotz wanderte um ${drift} m`);
    assert.ok(speedOf(end) < 1e-9, `Geschwindigkeit am Ende ${speedOf(end)}`);
  });

  it("gleitet ab tan(alpha) > mu_H mit a = g (sin alpha - mu_G cos alpha)", () => {
    const degrees = 30;
    const { downhill } = slope(degrees);
    const expected = EARTH_GRAVITY * (Math.sin(radians(degrees)) - muG * Math.cos(radians(degrees)));
    const recording = runScenario(scene([floor("standard", degrees), resting("standard", degrees)], 1));
    const measured = averageAccelerationAlong(recording, "klotz", downhill, 0.2, 0.9);
    assert.ok(
      relativeError(measured, expected) < 1e-6,
      `Gleitbeschleunigung ${measured.toFixed(6)} m/s^2, erwartet ${expected.toFixed(6)}`,
    );
  });

  it("unterscheidet Haften und Gleiten: zwischen mu_G und mu_H bleibt liegen, was liegt, und gleitet weiter, was gleitet", () => {
    // 25 Grad: tan = 0,466 liegt zwischen mu_G = 0,4 und mu_H = 0,5.
    const degrees = 25;
    const { downhill } = slope(degrees);
    const still = runScenario(scene([floor("standard", degrees), resting("standard", degrees)], 0.5));
    assert.ok(speedOf(entityTrack(still, "klotz").at(-1)!.mechanics) < 1e-9, "liegender Klotz kam ins Rutschen");

    const v0 = 0.5;
    const pushed = runScenario(
      scene(
        [
          floor("standard", degrees),
          resting("standard", degrees, { velocity: [v0 * downhill[0], 0, v0 * downhill[2]] }),
        ],
        0.5,
      ),
    );
    const expected = EARTH_GRAVITY * (Math.sin(radians(degrees)) - muG * Math.cos(radians(degrees)));
    const measured = averageAccelerationAlong(pushed, "klotz", downhill, 0.1, 0.4);
    assert.ok(
      relativeError(measured, expected) < 1e-6,
      `Beschleunigung ${measured.toFixed(6)} m/s^2, erwartet ${expected.toFixed(6)}`,
    );
  });

  it("gleitet auf Glatt reibungsfrei mit a = g sin alpha, egal aus welchem Material der Koerper ist", () => {
    const degrees = 20;
    const { downhill } = slope(degrees);
    const recording = runScenario(scene([floor("glatt", degrees), resting("eisen", degrees)], 0.5));
    const measured = averageAccelerationAlong(recording, "klotz", downhill, 0.1, 0.4);
    const expected = EARTH_GRAVITY * Math.sin(radians(degrees));
    assert.ok(relativeError(measured, expected) < 1e-9, `Beschleunigung ${measured}, erwartet ${expected}`);
  });
});

// ---------------------------------------------------------------- Ebene

describe("Gleitreibung auf der Ebene", () => {
  it("bremst mit mu_G g und haelt nach s = v0^2 / (2 mu_G g) an", () => {
    const v0 = 2;
    const recording = runScenario(scene([floor("standard"), resting("standard", 0, { velocity: [v0, 0, 0] })], 1));
    const track = entityTrack(recording, "klotz");
    const stopTime = v0 / (muG * EARTH_GRAVITY);
    const distance = (v0 * v0) / (2 * muG * EARTH_GRAVITY);

    const measured = averageAccelerationAlong(recording, "klotz", [1, 0, 0], 0.1, 0.4);
    assert.ok(relativeError(measured, -muG * EARTH_GRAVITY) < 1e-6, `Verzoegerung ${measured} m/s^2`);

    const end = track.at(-1)!.mechanics;
    assert.ok(speedOf(end) < 1e-9, `steht am Ende nicht: ${speedOf(end)} m/s`);
    assert.ok(Math.abs(end.position[0] - distance) < 1e-4, `Bremsweg ${end.position[0]} m, erwartet ${distance}`);
    const moving = sampleNearest(recording, "klotz", stopTime - 0.02).mechanics;
    const stopped = sampleNearest(recording, "klotz", stopTime + 0.02).mechanics;
    // 20 ms vor dem Halt faehrt er noch mit mu_G g * 0,02 s = 0,078 m/s.
    assert.ok(speedOf(moving) > 0.05 && speedOf(stopped) < 1e-9, `Anhaltezeit liegt nicht bei ${stopTime} s`);
  });

  it("verrechnet die Paarung als geometrisches Mittel der beiden Materialien", () => {
    // Eisen auf Holz: mu_G = sqrt(0,57 * 0,35).
    const mu = pair(IRON.mechanical.kineticFriction, WOOD.mechanical.kineticFriction);
    const recording = runScenario(scene([floor("holz"), resting("eisen", 0, { velocity: [2, 0, 0] })], 0.4));
    const measured = averageAccelerationAlong(recording, "klotz", [1, 0, 0], 0.1, 0.3);
    assert.ok(relativeError(measured, -mu * EARTH_GRAVITY) < 1e-6, `Verzoegerung ${measured}, erwartet ${-mu * EARTH_GRAVITY}`);
  });

  it("bringt einen kreiselnden Klotz durch Bohrreibung zur Ruhe, auf Glatt nicht", () => {
    const spin: Vec3 = [0, 0, 5];
    const rough = runScenario(scene([floor("standard"), resting("standard", 0, { angular: spin })], 1));
    const roughEnd = entityTrack(rough, "klotz").at(-1)!.mechanics;
    assert.ok(Math.hypot(...roughEnd.angularVelocity) < 1e-9, `dreht noch mit ${[...roughEnd.angularVelocity]}`);

    const smooth = runScenario(scene([floor("glatt"), resting("standard", 0, { angular: spin })], 1));
    const smoothEnd = entityTrack(smooth, "klotz").at(-1)!.mechanics;
    assert.ok(Math.abs(smoothEnd.angularVelocity[2] - spin[2]) < 1e-9, `auf Glatt gebremst: ${[...smoothEnd.angularVelocity]}`);
  });
});

// ---------------------------------------------------------------- Rollen

describe("Rollen und Rollreibung", () => {
  // Vollkugel: I = 2/5 m r^2, also I / (m r^2) = 2/5.

  it("geht vom Gleiten ins Rollen ueber und rollt dann mit v = 5/7 v0", () => {
    // Die Gleitreibung bremst den Schwerpunkt und dreht die Kugel an, bis
    // v = omega r. Der Drehimpuls um den Auflagepunkt bleibt dabei erhalten:
    // m v0 r = m v r + 2/5 m r^2 (v / r).
    const v0 = 2;
    const recording = runScenario(
      scene([floor("ohne-rollreibung"), resting("ohne-rollreibung", 0, { shape: SPHERE, velocity: [v0, 0, 0] })], 1),
    );
    const end = entityTrack(recording, "klotz").at(-1)!.mechanics;
    assert.ok(relativeError(end.linearVelocity[0], (5 / 7) * v0) < 1e-6, `v = ${end.linearVelocity[0]}`);
    // Rollen in +x heisst Drehung um +y: der Auflagepunkt steht, v - omega_y r = 0.
    assert.ok(relativeError(end.angularVelocity[1] * RADIUS, end.linearVelocity[0]) < 1e-6, `omega = ${[...end.angularVelocity]}`);
  });

  it("rollt die schiefe Ebene mit a = 5/7 g sin alpha hinab", () => {
    // Haften genuegt, solange mu_H >= 2/7 tan(alpha) - bei 30 Grad 0,165.
    const degrees = 30;
    const { downhill } = slope(degrees);
    const recording = runScenario(
      scene([floor("ohne-rollreibung", degrees), resting("ohne-rollreibung", degrees, { shape: SPHERE })], 0.6),
    );
    const measured = averageAccelerationAlong(recording, "klotz", downhill, 0.1, 0.5);
    const expected = (5 / 7) * EARTH_GRAVITY * Math.sin(radians(degrees));
    assert.ok(relativeError(measured, expected) < 1e-6, `Rollbeschleunigung ${measured}, erwartet ${expected}`);
  });

  it("wird durch Rollreibung mit a = 5/7 g f / r gebremst", () => {
    // Das Moment f N wirkt gegen das Rollen: m a = -F, I (a / r) = F r - f N.
    // Mit N = m g folgt a = -(f / r) g / (1 + 2/5).
    const f = STANDARD.mechanical.rollingFriction!;
    const v0 = 1;
    const recording = runScenario(
      scene(
        [
          floor("standard"),
          resting("standard", 0, { shape: SPHERE, velocity: [v0, 0, 0], angular: [0, v0 / RADIUS, 0] }),
        ],
        1,
      ),
    );
    const measured = averageAccelerationAlong(recording, "klotz", [1, 0, 0], 0.1, 0.9);
    const expected = -(5 / 7) * EARTH_GRAVITY * (f / RADIUS);
    assert.ok(relativeError(measured, expected) < 1e-6, `Verzoegerung ${measured}, erwartet ${expected}`);
  });

  it("rollt ohne Rollreibung ungebremst weiter", () => {
    const v0 = 1;
    const recording = runScenario(
      scene(
        [
          floor("ohne-rollreibung"),
          resting("ohne-rollreibung", 0, { shape: SPHERE, velocity: [v0, 0, 0], angular: [0, v0 / RADIUS, 0] }),
        ],
        1,
      ),
    );
    const end = entityTrack(recording, "klotz").at(-1)!.mechanics;
    assert.ok(Math.abs(end.linearVelocity[0] - v0) < 1e-9, `v = ${end.linearVelocity[0]}`);
  });
});

// ---------------------------------------------------------------- Determinismus

describe("Determinismus der Reibung", () => {
  it("liefert bei zwei Laeufen identische Aufzeichnungen", () => {
    const build = (): Scenario =>
      scene([floor("standard", 25), resting("eisen", 25, { velocity: [0.3, 0.2, 0], angular: [1, 2, 3] })], 0.5);
    assert.equal(JSON.stringify(runScenario(build())), JSON.stringify(runScenario(build())));
  });
});
