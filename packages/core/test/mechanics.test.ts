import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  BUILTIN_LIBRARY,
  createInclinedPlaneScenario,
  EARTH_GRAVITY,
  expectedSlideAcceleration,
  RAMP_INCLINE_DEGREES,
  RAMP_ORIENTATION,
  type EntitySpec,
  type Scenario,
  type Vec3,
} from "@sandbox/schema";

import {
  angularMomentumMagnitude,
  averageAccelerationAlong,
  createMechanicsModule,
  createRng,
  deriveSeed,
  entityTrack,
  kineticEnergy,
  ModuleRegistry,
  penetrationReport,
  potentialEnergy,
  runScenario,
  sampleNearest,
  Simulator,
  speedOf,
  summarizeEntity,
  v3rotateByQuat,
} from "../src/index.js";

// ---------------------------------------------------------------- Hilfsmittel

const BLOCK_HALF_EXTENTS: Vec3 = [0.1, 0.1, 0.1];

/**
 * Minimalszenario mit einem einzelnen Koerper und ohne Flaechen - fuer alle
 * Tests, die den Integrator ohne Kontakte pruefen.
 */
/**
 * Zerlegt einen Schwerkraftvektor in Staerke und Richtung - fuer die
 * Gravitations-Last, die `freeBodyScenario` platziert. Beim Nullvektor
 * (Schwerkraft "aus") ist die Richtung beliebig; nach unten ist die
 * sprechendste Wahl.
 */
function gravityLoadEntity(gravity: Vec3): Extract<EntitySpec, { kind: "load" }> {
  const magnitude = Math.hypot(...gravity);
  const direction: Vec3 =
    magnitude < 1e-12 ? [0, 0, -1] : [gravity[0] / magnitude, gravity[1] / magnitude, gravity[2] / magnitude];
  return { kind: "load", id: "schwerkraft", loadId: "gravitation", opacity: 1, magnitude, direction };
}

function freeBodyScenario(overrides: {
  duration?: number;
  recordRate?: number;
  dt?: number;
  gravity?: Vec3;
  position?: Vec3;
  linear?: Vec3;
  angular?: Vec3;
  halfExtents?: Vec3;
}): Scenario {
  return {
    schemaVersion: 1,
    id: "test-freier-koerper",
    name: "Freier Koerper",
    environment: {},
    view: { layer: "macroscopic", showAxes: true },
    library: BUILTIN_LIBRARY,
    simulation: {
      dt: overrides.dt ?? 0.001,
      recordRate: overrides.recordRate ?? 100,
      seed: 1,
    },
    entities: [
      gravityLoadEntity(overrides.gravity ?? [0, 0, -EARTH_GRAVITY]),
      {
        kind: "body",
        id: "klotz",
        bodyId: "quader",
        materialId: "eisen",
        opacity: 1,
        phase: {
          state: "solid",
          shape: { type: "box", halfExtents: overrides.halfExtents ?? BLOCK_HALF_EXTENTS },
        },
        pose: { position: overrides.position ?? [0, 0, 100], orientation: [0, 0, 0, 1] },
        velocity: { linear: overrides.linear ?? [0, 0, 0], angular: overrides.angular ?? [0, 0, 0] },
        kinematic: false,
      },
    ],
    duration: overrides.duration ?? 1,
    interventions: [
      { op: "add", t: 0, entityId: "schwerkraft" },
      { op: "add", t: 0, entityId: "klotz" },
    ],
    directionTrack: [],
  };
}

/**
 * Falllinie und Normale der schiefen Ebene.
 *
 * Abgeleitet aus der *Drehung der platzierten Instanz*, nicht aus dem
 * Bibliothekseintrag: die "Ebene" liegt im Koerpersystem waagerecht, und
 * erst `RAMP_ORIENTATION` neigt sie. Damit prueft der Test die ganze
 * Komposition - Eintrag, Drehung, Aufloesung - und nicht nur eine Zahl, die
 * ohnehin im Eintrag stand.
 */
function downhillDirection(): Vec3 {
  const rotated = v3rotateByQuat([0, 0, 0], [1, 0, 0], RAMP_ORIENTATION);
  return [rotated[0], rotated[1], rotated[2]];
}

function inclineNormal(): Vec3 {
  const rotated = v3rotateByQuat([0, 0, 0], [0, 0, 1], RAMP_ORIENTATION);
  return [rotated[0], rotated[1], rotated[2]];
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

// ---------------------------------------------------------------- Freier Fall

describe("Freier Fall", () => {
  it("reproduziert s = 1/2 g t^2 und v = g t auf neun Stellen", () => {
    // Die Toleranz ist bewusst scharf. Velocity-Verlet ist bei konstanter
    // Beschleunigung nicht nur genau, sondern exakt: die Rekursion
    // x += v*dt + 1/2*a*dt^2 mit anschliessendem v += a*dt reproduziert die
    // geschlossene Loesung in reeller Arithmetik. Es bleibt nur
    // Gleitkommarundung, relativ etwa 1e-14.
    //
    // Entscheidend: eine weiche Toleranz wuerde falsche Integratoren
    // durchlassen. Vorwaerts-Euler (x += v*dt) und semi-impliziter Euler
    // (x += v_neu*dt) weichen beide um genau 1/n relativ ab - nach 1000
    // Schritten also um 1e-3. Mit 1e-9 faellt das sofort auf, mit 1 % nicht.
    const recording = runScenario(freeBodyScenario({ duration: 1, recordRate: 100 }));
    const track = entityTrack(recording, "klotz");
    assert.ok(track.length > 50);

    const z0 = 100;
    for (const sample of track) {
      const t = sample.t;
      const expectedZ = z0 - 0.5 * EARTH_GRAVITY * t * t;
      const expectedVz = -EARTH_GRAVITY * t;
      const actualZ = sample.mechanics.position[2];
      const actualVz = sample.mechanics.linearVelocity[2];

      if (t > 0) {
        assert.ok(
          Math.abs(actualZ - expectedZ) <= 1e-9 * Math.abs(z0),
          `t=${t}: z war ${actualZ}, erwartet ${expectedZ}`,
        );
        assert.ok(
          relativeError(actualVz, expectedVz) <= 1e-9,
          `t=${t}: v_z war ${actualVz}, erwartet ${expectedVz}`,
        );
      }
    }
  });

  it("beschleunigt mit genau g, unabhaengig von der Masse", () => {
    // Galilei: ein schwerer und ein leichter Koerper fallen gleich schnell. Der
    // Test prueft, dass die Masse sich in F = m*a und a = F/m vollstaendig
    // herauskuerzt und nicht irgendwo stehen bleibt.
    const light = runScenario(freeBodyScenario({ halfExtents: [0.01, 0.01, 0.01], duration: 0.5 }));
    const heavy = runScenario(freeBodyScenario({ halfExtents: [0.5, 0.5, 0.5], duration: 0.5 }));
    const lightEnd = entityTrack(light, "klotz").at(-1)!;
    const heavyEnd = entityTrack(heavy, "klotz").at(-1)!;
    assert.equal(lightEnd.mechanics.position[2], heavyEnd.mechanics.position[2]);
    assert.equal(lightEnd.mechanics.linearVelocity[2], heavyEnd.mechanics.linearVelocity[2]);
  });

  it("erhaelt die Gesamtenergie m*g*h + 1/2*m*v^2", () => {
    const scenario = freeBodyScenario({ duration: 2, recordRate: 50 });
    const simulator = new Simulator(scenario);
    const steps = Math.round(scenario.duration / scenario.simulation.dt);

    simulator.step();
    const body = simulator.state.entities.get("klotz");
    assert.ok(body && body.kind === "body");
    const initialEnergy = kineticEnergy(body) + potentialEnergy(body, simulator.state);

    for (let i = 1; i < steps; i += 1) {
      simulator.step();
      const energy = kineticEnergy(body) + potentialEnergy(body, simulator.state);
      assert.ok(
        relativeError(energy, initialEnergy) <= 1e-9,
        `Schritt ${i}: Energie ${energy} statt ${initialEnergy}`,
      );
    }
  });
});

// ---------------------------------------------------------------- Lasten

describe("Schwerkraft als Last", () => {
  it("laesst den Klotz in der Luft stehen, wenn die Schwerkraft null ist", () => {
    // Die Gegenprobe zum Entwurfsentscheid: Schwerkraft ist eine Last in der
    // Bibliothek, kein eingebautes Gesetz. Gibt es keine mit Staerke ungleich
    // null, passiert nichts.
    const recording = runScenario(freeBodyScenario({ gravity: [0, 0, 0], duration: 1 }));
    const track = entityTrack(recording, "klotz");
    for (const sample of track) {
      assert.deepEqual(sample.mechanics.position, [0, 0, 100], `t=${sample.t}`);
      assert.deepEqual(sample.mechanics.linearVelocity, [0, 0, 0], `t=${sample.t}`);
    }
  });

  it("beschleunigt seitwaerts, wenn die Schwerkraft seitwaerts zeigt", () => {
    // Richtungsfrei heisst richtungsfrei: der Kern darf nirgends "unten"
    // annehmen.
    const recording = runScenario(freeBodyScenario({ gravity: [EARTH_GRAVITY, 0, 0], duration: 1 }));
    const end = entityTrack(recording, "klotz").at(-1)!;
    const t = end.t;
    assert.ok(
      Math.abs(end.mechanics.position[0] - 0.5 * EARTH_GRAVITY * t * t) < 1e-9,
      `x war ${end.mechanics.position[0]}`,
    );
    assert.ok(Math.abs(end.mechanics.position[2] - 100) < 1e-12, "z darf sich nicht aendern");
  });

  it("uebernimmt eine Schwerkraftaenderung aus einem Eingriff", () => {
    // 0,5 s mit, dann 0,5 s ohne Schwerkraft: der Eingriff liegt bei t = 0,5 s.
    const scenario = freeBodyScenario({ duration: 0.5 });
    scenario.interventions.push({
      op: "change",
      t: scenario.duration,
      entityId: "schwerkraft",
      change: { key: "magnitude", value: 0 },
    });
    scenario.duration += 0.5;
    const recording = runScenario(scenario);
    const atSwitch = sampleNearest(recording, "klotz", 0.5);
    const atEnd = entityTrack(recording, "klotz").at(-1)!;
    const speedAtSwitch = speedOf(atSwitch.mechanics);
    // Nach dem Abschalten bleibt die Geschwindigkeit konstant (Traegheit).
    assert.ok(
      relativeError(speedOf(atEnd.mechanics), speedAtSwitch) < 1e-6,
      `Geschwindigkeit stieg von ${speedAtSwitch} auf ${speedOf(atEnd.mechanics)}`,
    );
  });
});

// ---------------------------------------------------------------- Rotation

describe("Rotation", () => {
  it("erhaelt den Drehimpulsbetrag eines unsymmetrischen Koerpers exakt", () => {
    // Der Kern fuehrt den Drehimpuls L, nicht die Winkelgeschwindigkeit. Ohne
    // Drehmoment ist L += 0, der Betrag bleibt also auf Bitgenauigkeit
    // erhalten. Wuerde omega integriert, muesste der Kreiselterm
    // omega x (I omega) mitgerechnet werden - mit Rundungsfehlern, die sich
    // aufsummieren.
    const scenario = freeBodyScenario({
      duration: 2,
      halfExtents: [0.1, 0.2, 0.3],
      angular: [1, 2, 3],
    });
    const simulator = new Simulator(scenario);
    simulator.step();
    const body = simulator.state.entities.get("klotz");
    assert.ok(body && body.kind === "body");
    const initial = angularMomentumMagnitude(body);
    assert.ok(initial > 0, "Drehimpuls muss ungleich null sein, sonst prueft der Test nichts");

    const steps = Math.round(scenario.duration / scenario.simulation.dt);
    for (let i = 1; i < steps; i += 1) {
      simulator.step();
      assert.equal(
        angularMomentumMagnitude(body),
        initial,
        `Schritt ${i}: Drehimpulsbetrag hat sich geaendert`,
      );
    }
  });

  it("laesst die Winkelgeschwindigkeit eines unsymmetrischen Koerpers variieren", () => {
    // Gegenprobe zum Test oben: bei unsymmetrischem Traegheitstensor *muss*
    // omega wandern, waehrend L konstant bleibt (Eulersche Kreiselgleichungen).
    // Blieben beide konstant, wuerde der Kern die Rotation gar nicht rechnen.
    const recording = runScenario(
      freeBodyScenario({ duration: 2, halfExtents: [0.1, 0.2, 0.3], angular: [1, 2, 3] }),
    );
    const track = entityTrack(recording, "klotz");
    const first = track[0]!.mechanics.angularVelocity;
    const changed = track.some(
      (sample) =>
        Math.abs(sample.mechanics.angularVelocity[0] - first[0]) > 1e-6 ||
        Math.abs(sample.mechanics.angularVelocity[1] - first[1]) > 1e-6 ||
        Math.abs(sample.mechanics.angularVelocity[2] - first[2]) > 1e-6,
    );
    assert.ok(changed, "omega blieb konstant - der Kreiselterm fehlt");
  });

  it("haelt omega bei symmetrischem Koerper konstant", () => {
    // Beim Wuerfel ist der Traegheitstensor isotrop, der Kreiselterm
    // verschwindet, und omega muss konstant bleiben.
    const recording = runScenario(
      freeBodyScenario({ duration: 1, halfExtents: [0.1, 0.1, 0.1], angular: [0, 3, 0] }),
    );
    for (const sample of entityTrack(recording, "klotz")) {
      const omega = sample.mechanics.angularVelocity;
      assert.ok(Math.abs(omega[1] - 3) < 1e-9, `t=${sample.t}: omega_y war ${omega[1]}`);
      assert.ok(Math.abs(omega[0]) < 1e-9 && Math.abs(omega[2]) < 1e-9);
    }
  });

  it("haelt das Orientierungsquaternion normiert", () => {
    const recording = runScenario(
      freeBodyScenario({ duration: 2, halfExtents: [0.1, 0.2, 0.3], angular: [5, -3, 7] }),
    );
    for (const sample of entityTrack(recording, "klotz")) {
      const [x, y, z, w] = sample.mechanics.orientation;
      const length = Math.sqrt(x * x + y * y + z * z + w * w);
      assert.ok(Math.abs(length - 1) < 1e-12, `t=${sample.t}: |q| war ${length}`);
    }
  });
});

// ---------------------------------------------------------------- Schiefe Ebene

describe("Durchstich: Klotz auf der schiefen Ebene", () => {
  const recording = runScenario(createInclinedPlaneScenario());
  const downhill = downhillDirection();

  it("faellt zuerst frei und bekommt dann Kontakt", () => {
    const summary = summarizeEntity(recording, "klotz");
    assert.ok(summary.contactIntervals.length >= 1, "kein einziger Kontakt - der Klotz hat die Rampe verfehlt");
    const firstContact = summary.contactIntervals[0]!.from;
    assert.ok(
      firstContact > 0.3 && firstContact < 0.7,
      `erster Kontakt bei t=${firstContact}, erwartet um 0,46 s`,
    );
  });

  it("gleitet mit a = g * sin(30 Grad) die schiefe Ebene hinab", () => {
    // Der scharfste Einzeltest des Durchstichs: er prueft Kontaktloeser,
    // Impulsrichtung und Integrator gemeinsam gegen eine Schulformel. Gemessen
    // wird als Differenzenquotient der Geschwindigkeit - also an dem, was
    // tatsaechlich mit dem Zustand passiert ist, einschliesslich der
    // Kontaktimpulse, die in der Kraftsumme gar nicht auftauchen.
    const expected = expectedSlideAcceleration(EARTH_GRAVITY, RAMP_INCLINE_DEGREES);
    assert.ok(Math.abs(expected - 4.905) < 1e-12, "Erwartungswert selbst falsch");

    // Das Messfenster muss ganz in der Gleitphase liegen: nach dem Aufprall
    // (ca. 0,46 s) und vor der Knickkante (ca. 1,01 s).
    for (const t of [0.55, 0.7, 0.85, 0.95]) {
      const sample = sampleNearest(recording, "klotz", t);
      assert.ok(
        sample.mechanics.contactCount > 0,
        `t=${t}: kein Kontakt - Messfenster liegt nicht in der Gleitphase`,
      );
    }

    const measured = averageAccelerationAlong(recording, "klotz", downhill, 0.55, 0.95);
    assert.ok(
      relativeError(measured, expected) < 2e-3,
      `gemessene Gleitbeschleunigung ${measured.toFixed(6)} m/s^2, erwartet ${expected.toFixed(6)}`,
    );
  });

  it("gleitet auf dem Auslauf ohne Beschleunigung weiter", () => {
    // Reibungsfrei und horizontal: keine Kraftkomponente laengs der Flaeche,
    // also konstante Geschwindigkeit. Genau deshalb braucht es den Eingriff bei
    // t = 2 s, um den Klotz anzuhalten.
    const horizontal: Vec3 = [1, 0, 0];
    const measured = averageAccelerationAlong(recording, "klotz", horizontal, 1.3, 1.9);
    assert.ok(
      Math.abs(measured) < 1e-3,
      `Beschleunigung auf dem Auslauf war ${measured} m/s^2, erwartet 0`,
    );

    const a = sampleNearest(recording, "klotz", 1.3);
    const b = sampleNearest(recording, "klotz", 1.9);
    assert.ok(
      relativeError(speedOf(b.mechanics), speedOf(a.mechanics)) < 1e-3,
      `Geschwindigkeit fiel von ${speedOf(a.mechanics)} auf ${speedOf(b.mechanics)}`,
    );
  });

  it("loescht beim Aufprall die Normalkomponente vollstaendig", () => {
    // Stosszahl 0: nach dem Aufprall darf keine Geschwindigkeit mehr in die
    // Flaeche hinein zeigen.
    const normal = inclineNormal();
    for (const t of [0.55, 0.7, 0.9]) {
      const sample = sampleNearest(recording, "klotz", t);
      const normalSpeed =
        sample.mechanics.linearVelocity[0] * normal[0] +
        sample.mechanics.linearVelocity[1] * normal[1] +
        sample.mechanics.linearVelocity[2] * normal[2];
      assert.ok(
        Math.abs(normalSpeed) < 1e-6,
        `t=${t}: Normalgeschwindigkeit war ${normalSpeed}, erwartet 0`,
      );
    }
  });

  it("laesst die Tangentialkomponente beim Aufprall unberuehrt", () => {
    // Das ist die eigentliche Aussage von "reibungsfrei", und sie braucht eine
    // Aufloesung von einem Zeitschritt: ueber ein Fenster von 0,15 s waechst die
    // Tangentialkomponente durch die Hangabtriebskraft ohnehin, und ein Loeser,
    // der bei der Beruehrung einen Teil davon wegnimmt, faellt dann nicht auf.
    //
    // Hier wird mit 1000 Hz aufgezeichnet, also jeder Zeitschritt. Ueber den
    // Aufprall hinweg darf die Tangentialkomponente nur um den Beitrag der
    // Hangabtriebskraft zunehmen: g * sin(30 Grad) * dt.
    const base = createInclinedPlaneScenario();
    const fine = runScenario({
      ...base,
      simulation: { dt: 0.001, recordRate: 1000, seed: 1 },
      // Nur der Aufprall ist interessant; eine kurze Dauer genuegt und haelt die
      // 1000-Hz-Aufzeichnung klein.
      duration: 0.6,
    });
    const track = entityTrack(fine, "klotz");
    const tangentialOf = (sample: (typeof track)[number]): number =>
      sample.mechanics.linearVelocity[0] * downhill[0] +
      sample.mechanics.linearVelocity[1] * downhill[1] +
      sample.mechanics.linearVelocity[2] * downhill[2];

    const impactIndex = track.findIndex((sample) => sample.mechanics.contactCount > 0);
    assert.ok(impactIndex > 1, `kein Aufprall gefunden (Index ${impactIndex})`);

    const before = tangentialOf(track[impactIndex - 1]!);
    const after = tangentialOf(track[impactIndex]!);
    assert.ok(before > 1, `Tangentialkomponente vor dem Aufprall war nur ${before}`);

    const expectedGain = expectedSlideAcceleration(EARTH_GRAVITY, RAMP_INCLINE_DEGREES) * fine.dt;
    assert.ok(
      Math.abs(after - before - expectedGain) < 1e-9,
      `Tangentialkomponente aenderte sich um ${(after - before).toExponential(4)}, ` +
        `erwartet ${expectedGain.toExponential(4)} - der Kontaktloeser greift in die Flaeche ein`,
    );
  });

  it("dringt nirgends in eine Flaeche ein", () => {
    // Faengt den klassischen Fehler, dass ein Koerper bei zu grossem Zeitschritt
    // durch eine duenne Flaeche tunnelt. Die Toleranz entspricht dem Einsinken
    // in einem Zeitschritt: 1/2*g*dt^2 = 4,9 Mikrometer.
    const report = penetrationReport(recording, "klotz", {
      type: "box",
      halfExtents: BLOCK_HALF_EXTENTS,
    });
    assert.ok(
      report.minSignedDistance > -1e-4,
      `Durchdringung von ${report.minSignedDistance} m bei t=${report.tAtMinimum} ` +
        `an Segment ${report.segmentId}`,
    );
  });

  it("bleibt nach dem Eingriff bei t = 2 s stehen", () => {
    const atStop = sampleNearest(recording, "klotz", 2.05);
    const atEnd = entityTrack(recording, "klotz").at(-1)!;
    assert.ok(atEnd.t > 3.5, `Aufzeichnung endet schon bei t=${atEnd.t}`);

    assert.ok(
      speedOf(atStop.mechanics) < 1e-6,
      `direkt nach dem Eingriff war die Geschwindigkeit ${speedOf(atStop.mechanics)}`,
    );
    const drift = Math.abs(atEnd.mechanics.position[0] - atStop.mechanics.position[0]);
    assert.ok(drift < 1e-6, `Klotz wanderte nach dem Anhalten um ${drift} m weiter`);
    assert.ok(
      speedOf(atEnd.mechanics) < 1e-6,
      `am Ende war die Geschwindigkeit ${speedOf(atEnd.mechanics)}`,
    );
  });

  it("bleibt auf dem Auslauf liegen, statt durchzusinken", () => {
    const atEnd = entityTrack(recording, "klotz").at(-1)!;
    // Der Klotz steht mit seiner Unterseite auf z = 0, der Mittelpunkt also auf
    // der halben Kantenhoehe.
    assert.ok(
      Math.abs(atEnd.mechanics.position[2] - BLOCK_HALF_EXTENTS[2]) < 1e-3,
      `Mittelpunkt lag bei z=${atEnd.mechanics.position[2]}, erwartet ${BLOCK_HALF_EXTENTS[2]}`,
    );
  });

  it("legt die ganze Rampe zurueck und bleibt innerhalb der Flaechen", () => {
    const summary = summarizeEntity(recording, "klotz");
    assert.ok(summary.startPosition[0] < -1, `Start bei x=${summary.startPosition[0]}`);
    assert.ok(summary.endPosition[0] > 3, `Ende bei x=${summary.endPosition[0]}`);
    assert.ok(summary.maxSpeed > 4 && summary.maxSpeed < 6, `Spitzengeschwindigkeit ${summary.maxSpeed}`);
    assert.equal(summary.endSpeed < 1e-6, true);
  });
});

// ---------------------------------------------------------------- Determinismus

describe("Determinismus", () => {
  it("liefert bei zwei Laeufen byte-identische Aufzeichnungen", () => {
    const a = runScenario(createInclinedPlaneScenario());
    const b = runScenario(createInclinedPlaneScenario());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("liefert bei Rotation und Kontakt ebenfalls identische Ergebnisse", () => {
    const build = () => {
      const scenario = createInclinedPlaneScenario();
      const body = scenario.entities.find((entity) => entity.kind === "body");
      assert.ok(body && body.kind === "body");
      body.velocity.angular = [2, -1, 4];
      return scenario;
    };
    assert.equal(JSON.stringify(runScenario(build())), JSON.stringify(runScenario(build())));
  });

  it("verwendet im Kern keine Uhr und keinen echten Zufall", async () => {
    // Statische Gegenprobe zur Determinismusregel. Date.now und Math.random
    // wuerden eine Aufzeichnung unreproduzierbar machen; sin/cos/exp/log/pow
    // sind ueber JS-Engines nicht bitgenau spezifiziert.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const forbidden = /\b(Date\.now|Math\.random|Math\.sin|Math\.cos|Math\.tan|Math\.pow|Math\.exp|Math\.log|performance\.now)\b/;

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
      return files;
    };

    const sourceDir = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const files = await walk(sourceDir);
    assert.ok(files.length >= 5, `nur ${files.length} Quelldateien gefunden - Pfad falsch?`);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      // Kommentare entfernen: sie erwaehnen die verbotenen Funktionen
      // absichtlich, um die Regel zu erklaeren.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const match = forbidden.exec(withoutComments);
      assert.equal(match, null, `${file} benutzt ${match?.[0]} - verletzt die Determinismusregel`);
    }
  });
});

describe("Pseudozufall", () => {
  it("liefert fuer denselben Seed dieselbe Folge", () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i += 1) assert.equal(a.next(), b.next());
  });

  it("liefert fuer verschiedene Seeds verschiedene Folgen", () => {
    const a = createRng(1);
    const b = createRng(2);
    const differing = Array.from({ length: 50 }, () => a.next() !== b.next()).filter(Boolean);
    assert.ok(differing.length > 45, "Folgen zu aehnlich");
  });

  it("bleibt in [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 10000; i += 1) {
      const value = rng.next();
      assert.ok(value >= 0 && value < 1, `Wert ${value} ausserhalb [0, 1)`);
    }
  });

  it("gibt jeder Entitaet einen eigenen, reihenfolgeunabhaengigen Strom", () => {
    // Haette jede Entitaet nur einen gemeinsamen Generator, wuerde das
    // Hinzufuegen eines Koerpers bei t = 2 s das Aussehen aller anderen
    // veraendern.
    assert.equal(deriveSeed(1, "klotz"), deriveSeed(1, "klotz"));
    assert.notEqual(deriveSeed(1, "klotz"), deriveSeed(1, "rampe"));
    assert.notEqual(deriveSeed(1, "klotz"), deriveSeed(2, "klotz"));
  });
});

// ---------------------------------------------------------------- Pipeline

describe("Modulregistrierung", () => {
  it("lehnt zwei Module ab, die denselben Zustandsabschnitt schreiben", () => {
    // Der Mechanismus, der die Partitionierung des Zustands durchsetzt statt
    // sie nur zu dokumentieren.
    const registry = new ModuleRegistry().register(createMechanicsModule());
    assert.throws(
      () => registry.register({ id: "doppelt", reads: [], writes: ["mechanics"] }),
      /bereits von Modul "mechanics" geschrieben/,
    );
  });

  it("erlaubt ein zweites Modul, das einen anderen Abschnitt schreibt", () => {
    const registry = new ModuleRegistry().register(createMechanicsModule());
    registry.register({ id: "thermodynamik", reads: ["mechanics"], writes: ["thermal"] });
    assert.equal(registry.all().length, 2);
  });

  it("lehnt eine doppelte Modul-Id ab", () => {
    const registry = new ModuleRegistry().register(createMechanicsModule());
    assert.throws(() => registry.register(createMechanicsModule()), /bereits registriert/);
  });

  it("meldet die leeren Phasen als unbesetzt", () => {
    // Die Phasen existieren, aber Stufe 1 fuellt sie nicht. Das ist der Punkt:
    // Thermodynamik ist spaeter eine Implementierung, kein Umbau.
    const registry = new ModuleRegistry().register(createMechanicsModule());
    assert.equal(registry.forPhase("accumulate").length, 1);
    assert.equal(registry.forPhase("integrate").length, 1);
    assert.equal(registry.forPhase("contacts").length, 1);
    assert.equal(registry.forPhase("exchange").length, 0);
    assert.equal(registry.forPhase("transform").length, 0);
  });
});

describe("Eingriffe", () => {
  it("wendet Eingriffe nach ihrer Zeit an, nicht nach ihrer Listenposition", () => {
    // Eine fremde Datei muss ihre Eingriffe nicht sortieren. Hier steht das
    // Anhalten bei t = 0,5 s vor dem Hinzufuegen bei t = 0 - liefe die Liste
    // in ihrer Reihenfolge, gaebe es den Klotz beim Anhalten noch nicht.
    const scenario = freeBodyScenario({ duration: 1 });
    scenario.interventions.unshift({
      op: "change",
      t: 0.5,
      entityId: "klotz",
      change: { key: "linearVelocity", value: [0, 0, 0] },
    });
    const recording = runScenario(scenario);
    const justAfter = sampleNearest(recording, "klotz", 0.75);
    // Nach dem Anhalten beginnt der freie Fall neu: v = g * (t - 0,5 s).
    const expected = EARTH_GRAVITY * (justAfter.t - 0.5);
    assert.ok(
      Math.abs(speedOf(justAfter.mechanics) - expected) < 1e-9,
      `v war ${speedOf(justAfter.mechanics)}, erwartet ${expected}`,
    );
  });

  it("laesst einen Eingriff hinter der Gesamtdauer stehen, ohne dass er wirkt", () => {
    const scenario = freeBodyScenario({ duration: 0.5 });
    scenario.interventions.push({
      op: "change",
      t: 0.8,
      entityId: "klotz",
      change: { key: "linearVelocity", value: [0, 0, 0] },
    });
    const end = entityTrack(runScenario(scenario), "klotz").at(-1)!;
    // Ungestoerter freier Fall bis zum Ende: v = g * t.
    assert.ok(
      Math.abs(speedOf(end.mechanics) - EARTH_GRAVITY * end.t) < 1e-9,
      `v war ${speedOf(end.mechanics)}, erwartet ${EARTH_GRAVITY * end.t}`,
    );
  });

  it("meldet einen Eingriff auf eine unbekannte Entitaet", () => {
    const scenario = freeBodyScenario({ duration: 0.05 });
    scenario.interventions.push({
      op: "change",
      t: scenario.duration,
      entityId: "gibtsnicht",
      change: { key: "linearVelocity", value: [0, 0, 0] },
    });
    scenario.duration += 0.05;
    assert.throws(() => runScenario(scenario), /unbekannte Entitaet/);
  });

  it("entfernt eine Entitaet und laesst sie aus der Aufzeichnung verschwinden", () => {
    const scenario = freeBodyScenario({ duration: 0.5, recordRate: 20 });
    scenario.interventions.push({ op: "remove", t: scenario.duration, entityId: "klotz" });
    scenario.duration += 0.5;
    const recording = runScenario(scenario);
    const lastWithBody = entityTrack(recording, "klotz").at(-1)!;
    assert.ok(lastWithBody.t < 0.55, `Klotz war noch bei t=${lastWithBody.t} vorhanden`);
    const finalSnapshot = recording.snapshots.at(-1)!;
    assert.equal(finalSnapshot.entities["klotz"], undefined);
  });

  it("setzt die Geschwindigkeit, danach gilt wieder x = v * (t - t0)", () => {
    // Ohne Schwerkraft ist die Bahn nach der Aenderung eine Gerade.
    const scenario = freeBodyScenario({ duration: 1, gravity: [0, 0, 0] });
    scenario.interventions.push({
      op: "change",
      t: 0.4,
      entityId: "klotz",
      change: { key: "linearVelocity", value: [2, 0, 0] },
    });
    const end = entityTrack(runScenario(scenario), "klotz").at(-1)!;
    const expected = 2 * (end.t - 0.4);
    assert.ok(
      Math.abs(end.mechanics.position[0] - expected) < 1e-9,
      `x war ${end.mechanics.position[0]}, erwartet ${expected}`,
    );
  });

  it("setzt die Winkelgeschwindigkeit ueber den Drehimpuls", () => {
    const scenario = freeBodyScenario({ duration: 0.1, gravity: [0, 0, 0] });
    scenario.interventions.push({
      op: "change",
      t: 0.05,
      entityId: "klotz",
      change: { key: "angularVelocity", value: [0, 0, 3] },
    });
    const end = entityTrack(runScenario(scenario), "klotz").at(-1)!;
    // Ein Wuerfel dreht um eine Hauptachse gleichfoermig weiter.
    assert.ok(Math.abs(end.mechanics.angularVelocity[2] - 3) < 1e-9);
  });

  it("aendert die Kantenlaenge und rechnet die Masse aus Dichte und Volumen neu", () => {
    const scenario = freeBodyScenario({ duration: 0.1 });
    scenario.interventions.push({
      op: "change",
      t: 0.05,
      entityId: "klotz",
      change: { key: "halfExtents", value: [0.2, 0.2, 0.2] },
    });
    const simulator = new Simulator(scenario);
    for (let i = 0; i < 60; i += 1) simulator.step();
    const body = simulator.state.entities.get("klotz");
    assert.ok(body && body.kind === "body");
    // Kantenlaenge verdoppelt: achtfaches Volumen, achtfache Masse.
    const expectedMass = body.material.mechanical.density * 0.4 * 0.4 * 0.4;
    assert.ok(relativeError(body.mass, expectedMass) < 1e-12, `m war ${body.mass}`);
    assert.ok(relativeError(body.inverseMass, 1 / expectedMass) < 1e-12);
    // Die Masse aendert den freien Fall nicht: v = g * t laeuft durch.
    const [vx, vy, vz] = body.mechanics.linearVelocity;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    assert.ok(Math.abs(speed - EARTH_GRAVITY * simulator.state.t) < 1e-9, `v war ${speed}`);
  });

  it("aendert das Material und mit ihm die Masse", () => {
    const scenario = freeBodyScenario({ duration: 0.1 });
    scenario.interventions.push({
      op: "change",
      t: 0.05,
      entityId: "klotz",
      change: { key: "materialId", value: "holz" },
    });
    const simulator = new Simulator(scenario);
    for (let i = 0; i < 60; i += 1) simulator.step();
    const body = simulator.state.entities.get("klotz");
    assert.ok(body && body.kind === "body");
    assert.equal(body.materialId, "holz");
    assert.ok(relativeError(body.mass, body.material.mechanical.density * 0.2 * 0.2 * 0.2) < 1e-12);
  });

  it("behaelt geaenderte Eingabeeigenschaften beim Wiedereinfuegen", () => {
    const scenario = freeBodyScenario({ duration: 0.3 });
    scenario.interventions.push(
      { op: "change", t: 0.1, entityId: "klotz", change: { key: "halfExtents", value: [0.3, 0.3, 0.3] } },
      { op: "remove", t: 0.15, entityId: "klotz" },
      { op: "add", t: 0.2, entityId: "klotz" },
    );
    const simulator = new Simulator(scenario);
    for (let i = 0; i < 250; i += 1) simulator.step();
    const body = simulator.state.entities.get("klotz");
    assert.ok(body && body.kind === "body" && body.shape.type === "box");
    assert.deepEqual(body.shape.halfExtents, [0.3, 0.3, 0.3]);
    // Die Lage ist Zustand und beginnt wieder bei der Startlage.
    assert.ok(body.mechanics.position[2] > 99.9, `z war ${body.mechanics.position[2]}`);
  });

  it("neigt eine Ebene per Aenderung genau so wie ihre Startdrehung", () => {
    // Zwei Wege zum selben Zustand: flach gestartet und bei t = 0 auf
    // RAMP_ORIENTATION gedreht muss bitgleich zum Durchstich laufen - und der
    // gleitet nachweislich mit a = g * sin(30 Grad).
    const reference = createInclinedPlaneScenario();
    const changed = createInclinedPlaneScenario();
    const ramp = changed.entities.find((entity) => entity.id === "schiefe-ebene")!;
    assert.ok(ramp.kind === "constraint");
    ramp.pose.orientation = [0, 0, 0, 1];
    changed.interventions.splice(2, 0, {
      op: "change",
      t: 0,
      entityId: "schiefe-ebene",
      change: { key: "orientation", value: [...RAMP_ORIENTATION] },
    });
    assert.deepEqual(
      entityTrack(runScenario(changed), "klotz"),
      entityTrack(runScenario(reference), "klotz"),
    );
  });

  it("lehnt eine Geschwindigkeit auf einer Randbedingung ab", () => {
    const scenario = createInclinedPlaneScenario();
    scenario.interventions.push({
      op: "change",
      t: scenario.duration,
      entityId: "auslauf",
      change: { key: "linearVelocity", value: [1, 0, 0] },
    });
    scenario.duration += 1;
    assert.throws(() => runScenario(scenario), /passt nicht/);
  });

  it("meldet einen Verweis auf einen fehlenden Bibliothekseintrag", () => {
    const scenario = freeBodyScenario({ duration: 0.1 });
    scenario.library = [];
    assert.throws(() => runScenario(scenario), /nicht in der Bibliothek/);
  });
});

describe("Aufzeichnung", () => {
  it("haelt die vereinbarte Aufzeichnungsrate ein", () => {
    const recording = runScenario(freeBodyScenario({ duration: 2, recordRate: 20, dt: 0.001 }));
    // 2 s bei 20 Hz = 40 Schnappschuesse, plus der Anfangszustand bei t = 0.
    assert.equal(recording.snapshots.length, 41);
    const second = recording.snapshots[1]!;
    assert.ok(Math.abs(second.t - 0.05) < 1e-9, `zweiter Schnappschuss bei t=${second.t}`);
  });

  it("haelt einen Eingriff zu seiner Zeit fest, nicht erst am naechsten Schnappschuss", () => {
    // dt = 0.003 geht in 0,25 s nicht auf: der Eingriff wirkt am Schritt bei
    // 0,251 s, gestempelt werden muss trotzdem 0,25 s.
    for (const dt of [0.001, 0.003]) {
      const scenario = freeBodyScenario({ duration: 1, recordRate: 20, dt });
      scenario.interventions[1] = { op: "add", t: 0.25, entityId: "klotz" };
      const snapshots = runScenario(scenario).snapshots;
      const atIntervention = snapshots.filter((snapshot) => snapshot.t === 0.25);
      assert.equal(atIntervention.length, 2, `dt=${dt}: ${atIntervention.length} Schnappschuesse bei 0,25 s`);
      assert.equal(atIntervention[0]!.entities["klotz"], undefined, `dt=${dt}: Klotz schon vor dem Eingriff da`);
      assert.ok(atIntervention[1]!.entities["klotz"], `dt=${dt}: Klotz fehlt nach dem Eingriff`);
      for (let index = 1; index < snapshots.length; index += 1) {
        assert.ok(snapshots[index]!.t >= snapshots[index - 1]!.t, `dt=${dt}: Zeit laeuft bei ${index} rueckwaerts`);
      }
    }
  });

  it("zeigt bei t = 0 den Anfangszustand und nicht eine leere Szene", () => {
    const recording = runScenario(createInclinedPlaneScenario());
    const first = recording.snapshots[0]!;
    assert.equal(first.t, 0);
    assert.ok(first.entities["klotz"], "Klotz fehlt im ersten Schnappschuss");
    assert.deepEqual(first.entities["klotz"]!.mechanics!.position, [-1.732, 0, 2.2]);
  });

  it("zeichnet Kraft und Beschleunigung auf, weil die kinematische Ansicht sie braucht", () => {
    const recording = runScenario(createInclinedPlaneScenario());
    const falling = sampleNearest(recording, "klotz", 0.2);
    // Im freien Fall ist die Beschleunigung genau g.
    assert.ok(
      Math.abs(falling.mechanics.acceleration[2] + EARTH_GRAVITY) < 1e-9,
      `a_z war ${falling.mechanics.acceleration[2]}`,
    );
    // Und die Kraft ist m*g - bei einem Eisenwuerfel von 20 cm Kante
    // 7874 * 0.008 = 62,992 kg.
    const mass = 7874 * 0.008;
    assert.ok(
      Math.abs(falling.mechanics.force[2] + mass * EARTH_GRAVITY) < 1e-6,
      `F_z war ${falling.mechanics.force[2]}, erwartet ${-mass * EARTH_GRAVITY}`,
    );
  });

  it("meldet keine Durchdringungswarnung beim Durchstich", () => {
    const recording = runScenario(createInclinedPlaneScenario());
    const warnings = recording.events.filter((event) => event.type === "warning");
    assert.deepEqual(
      warnings.map((w) => w.message),
      [],
      "der Loeser kam an seine Grenze - Zeitschritt oder Geometrie pruefen",
    );
  });

  it("traegt Szenario und Seed mit, damit sie selbsttragend ist", () => {
    const recording = runScenario(createInclinedPlaneScenario());
    assert.equal(recording.seed, 1);
    assert.equal(recording.dt, 0.001);
    assert.ok(recording.scenario.library.length > 0, "Bibliothek fehlt in der Aufzeichnung");
  });
});

describe("Grenzen der Auswertung", () => {
  it("bricht ab, statt einen falschen Abstand zu melden, wenn eine Flaeche veraendert wird", async () => {
    // Ein still falscher Messwert ist schlimmer als eine Fehlermeldung: der
    // Durchdringungsbericht kennt nur die Anfangslage der Randbedingungen.
    const { penetrationReport } = await import("../src/analysis.js");
    const scenario = createInclinedPlaneScenario();
    scenario.interventions.push({
      op: "change",
      t: scenario.duration,
      entityId: "auslauf",
      change: { key: "position", value: [4, 0, 1] },
    });
    scenario.duration += 1;
    const recording = runScenario(scenario);
    assert.throws(
      () => penetrationReport(recording, "klotz", { type: "box", halfExtents: BLOCK_HALF_EXTENTS }),
      /veraendert/,
    );
  });

  it("verschiebt eine Flaeche tatsaechlich, sodass der Koerper tiefer faellt", () => {
    // Gegenprobe: der Eingriff wirkt wirklich - die Auswertung ist die Grenze,
    // nicht die Simulation.
    const scenario = createInclinedPlaneScenario();
    scenario.interventions.push(
      {
        op: "change",
        t: scenario.duration,
        entityId: "schiefe-ebene",
        change: { key: "position", value: [-1.732, 0, -9] },
      },
      { op: "change", t: scenario.duration, entityId: "auslauf", change: { key: "position", value: [4, 0, -10] } },
    );
    scenario.duration += 1;
    const recording = runScenario(scenario);
    const end = entityTrack(recording, "klotz").at(-1)!;
    assert.ok(
      end.mechanics.position[2] < -2,
      `der Klotz blieb bei z=${end.mechanics.position[2]} liegen - die Flaeche wurde nicht verschoben`,
    );
  });
});
