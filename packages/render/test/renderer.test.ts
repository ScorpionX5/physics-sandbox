import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as THREE from "three";

import { createInclinedPlaneScenario, RAMP_ORIENTATION, SMOOTH, type Recording } from "@sandbox/schema";
import { runScenario } from "@sandbox/core";

import { AtomicRenderer } from "../src/layers/atomic.js";
import { KinematicRenderer } from "../src/layers/kinematic.js";
import { MacroscopicRenderer } from "../src/layers/macroscopic.js";
import { placeOnSegment, scenarioInventory, type ViewLayerRenderer } from "../src/common.js";
import { snapshotAt } from "../src/playback.js";

/**
 * Kopflose Pruefung der Darstellungsschicht.
 *
 * Three.js braucht einen WebGL-Kontext nur fuer `WebGLRenderer`. Szenengraph,
 * Geometrien und Matrizen laufen in Node - und genau dort steckt die
 * fehleranfaellige Mathematik: die Ausrichtung der Platten aus Normale und
 * Tangente, das Absenken um die halbe Dicke, das Ein- und Ausblenden von
 * Koerpern, die es zu einem Zeitpunkt noch nicht gibt.
 *
 * Was hier *nicht* geprueft wird: dass das Bild am Ende richtig aussieht. Das
 * braucht ein Auge oder einen Pixelvergleich und ist von Hand zu pruefen.
 */

const scenario = createInclinedPlaneScenario();
const recording: Recording = runScenario(scenario);
const context = { scenario, seed: recording.seed };

/**
 * Das Flaechensegment der schiefen Ebene, so wie die Darstellungsschicht es
 * sieht: mit der instanzeigenen Groesse aufgeloest.
 *
 * Bewusst aus dem Inventar und nicht aus dem Bibliothekseintrag - genau die
 * Umrechnung von Eintrag plus Instanzgroesse auf das gezeichnete Rechteck soll
 * hier geprueft werden.
 */
function inclineSegment() {
  const inventory = scenarioInventory(scenario);
  const incline = inventory.constraints.find((entry) => entry.spec.id === "schiefe-ebene");
  assert.ok(incline, "Instanz \"schiefe-ebene\" fehlt im Inventar");
  assert.equal(incline.segments.length, 1);
  return incline.segments[0]!;
}

describe("Ausrichtung der Flaechensegmente", () => {
  it("dreht die Plattenoberseite in die Richtung der Normale", () => {
    // Die Platte liegt im Geometriesystem in der xz-Ebene, ihre Hochachse ist
    // dort +y - das ist eine Konvention der Box-Geometrie und unabhaengig davon,
    // welche Weltachse oben ist. Nach der Ausrichtung muss diese lokale +y-Achse
    // auf die Normale zeigen - sonst steht die Platte quer, und der Koerper
    // gleitet neben ihr her.
    const segment = inclineSegment();
    const plate = new THREE.Object3D();
    placeOnSegment(plate, segment);

    const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(plate.quaternion);
    const expected = new THREE.Vector3(...segment.normal).normalize();
    assert.ok(
      localUp.distanceTo(expected) < 1e-9,
      `Hochachse zeigt nach (${localUp.toArray()}), erwartet (${expected.toArray()})`,
    );
  });

  it("richtet die lokale x-Achse auf die Tangente aus", () => {
    const segment = inclineSegment();
    const plate = new THREE.Object3D();
    placeOnSegment(plate, segment);
    const localRight = new THREE.Vector3(1, 0, 0).applyQuaternion(plate.quaternion);
    const expected = new THREE.Vector3(...segment.tangent).normalize();
    assert.ok(localRight.distanceTo(expected) < 1e-9, "Tangente nicht getroffen");
  });

  it("baut ein rechtshaendiges System - sonst waere die Platte gespiegelt", () => {
    const plate = new THREE.Object3D();
    placeOnSegment(plate, inclineSegment());
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(plate.quaternion);
    assert.ok(
      Math.abs(matrix.determinant() - 1) < 1e-9,
      `Determinante war ${matrix.determinant()}, erwartet +1`,
    );
  });

  it("senkt die Platte um die halbe Dicke ab, damit ihre Oberseite in der Kollisionsebene liegt", () => {
    // Ohne das Absenken steckt der Koerper sichtbar in der Platte: er liegt auf
    // der Kollisionsebene, die Platte waere aber um ihre halbe Dicke darueber.
    const segment = inclineSegment();
    const plate = new THREE.Object3D();
    placeOnSegment(plate, segment);

    const centre = new THREE.Vector3(...segment.center);
    const normal = new THREE.Vector3(...segment.normal).normalize();
    const offset = plate.position.clone().sub(centre);
    assert.ok(
      Math.abs(offset.dot(normal) + segment.thickness / 2) < 1e-9,
      `Absenkung war ${offset.dot(normal)}, erwartet ${-segment.thickness / 2}`,
    );
    // Quer zur Normale darf sie nicht verschoben sein.
    assert.ok(offset.clone().projectOnPlane(normal).length() < 1e-9, "Platte quer verschoben");
  });
});

describe("Instanzeigene Flaechengroesse", () => {
  it("uebernimmt die Groesse der Instanz, nicht die des Bibliothekseintrags", () => {
    // Die "Ebene" ist im Eintrag 1 x 2 (halbe Ausdehnungen). Die schiefe
    // Ebene des Durchstichs ist 2 x 1, der Auslauf 4,125 x 1. Zeichnete die
    // Darstellung die Eintragsgroesse, wuerde der Klotz sichtbar neben dem
    // Auslauf weitergleiten.
    const inventory = scenarioInventory(scenario);
    const runout = inventory.constraints.find((entry) => entry.spec.id === "auslauf")!;
    assert.equal(runout.segments[0]!.halfExtentU, 4.125);
    assert.equal(runout.segments[0]!.halfExtentV, 1);
  });

  it("zeichnet die Platte in der Groesse der Instanz", () => {
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const plate = layer.root.getObjectByName("segment:auslauf/flaeche") as THREE.Mesh;
    assert.ok(plate, "Auslauf-Platte fehlt");
    const parameters = (plate.geometry as THREE.BoxGeometry).parameters;
    assert.equal(parameters.width, 8.25, "Laenge = 2 * halbe Ausdehnung");
    assert.equal(parameters.depth, 2);
    layer.dispose();
  });

  it("dreht die Instanz, nicht das Segment", () => {
    // Die Neigung steht an der Lage der Instanz. Im Koerpersystem liegt jede
    // Ebene waagerecht.
    const segment = inclineSegment();
    assert.deepEqual(segment.normal, [0, 0, 1]);
    const inventory = scenarioInventory(scenario);
    const incline = inventory.constraints.find((entry) => entry.spec.id === "schiefe-ebene")!;
    assert.deepEqual(incline.spec.pose.orientation, RAMP_ORIENTATION);
  });
});

describe("Makroskopische Ansicht", () => {
  it("baut Flaechen und Koerper auf", () => {
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const names: string[] = [];
    layer.root.traverse((node) => {
      if (node.name) names.push(node.name);
    });
    assert.ok(names.includes("koerper:klotz"), `Klotz fehlt: ${names.join(", ")}`);
    assert.ok(names.includes("randbedingung:schiefe-ebene"), `schiefe Ebene fehlt: ${names.join(", ")}`);
    assert.ok(names.includes("randbedingung:auslauf"), `Auslauf fehlt: ${names.join(", ")}`);
    // Beide Instanzen haben ein Segment namens "flaeche"; die Instanz-Id macht
    // die Namen im Szenengraph wieder eindeutig.
    assert.ok(names.includes("segment:schiefe-ebene/flaeche"));
    assert.ok(names.includes("segment:auslauf/flaeche"));
    layer.dispose();
  });

  it("uebernimmt Lage und Orientierung aus dem Schnappschuss", () => {
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const snapshot = snapshotAt(recording, 0.3);
    layer.update(snapshot);

    const mesh = layer.root.getObjectByName("koerper:klotz")!;
    const expected = snapshot.entities["klotz"]!.mechanics!.position;
    assert.ok(
      mesh.position.distanceTo(new THREE.Vector3(...expected)) < 1e-12,
      `Mesh bei ${mesh.position.toArray()}, Zustand bei ${expected}`,
    );
    assert.equal(mesh.visible, true);
    layer.dispose();
  });

  it("blendet einen Koerper aus, den es zu diesem Zeitpunkt nicht gibt", () => {
    // Ein Koerper, der erst spaeter hinzukommt, darf nicht von Anfang an
    // herumstehen - und einer, der entfernt wurde, nicht stehenbleiben.
    const withRemoval = {
      ...scenario,
      interventions: [
        ...scenario.interventions.filter((intervention) => intervention.t === 0),
        { op: "remove" as const, t: 2, entityId: "klotz" },
      ],
    };
    const removedRecording = runScenario(withRemoval);
    const layer = new MacroscopicRenderer();
    layer.build({ scenario: withRemoval, seed: removedRecording.seed });

    layer.update(snapshotAt(removedRecording, 1));
    assert.equal(layer.root.getObjectByName("koerper:klotz")!.visible, true);

    layer.update(snapshotAt(removedRecording, 3));
    assert.equal(layer.root.getObjectByName("koerper:klotz")!.visible, false);
    layer.dispose();
  });

  it("legt die Drehung der Instanz auf die Randbedingungsgruppe", () => {
    // Die Platten sitzen im Koerpersystem; die Neigung kommt von der Gruppe.
    // Ohne das laege die schiefe Ebene flach.
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const group = layer.root.getObjectByName("randbedingung:schiefe-ebene")!;
    const expected = new THREE.Quaternion(...RAMP_ORIENTATION);
    assert.ok(
      Math.abs(group.quaternion.dot(expected)) > 1 - 1e-9,
      `Gruppe gedreht um ${group.quaternion.toArray().join(", ")}`,
    );
    layer.dispose();
  });

  it("uebernimmt Farbe und Oberflaeche aus dem Bibliothekseintrag", () => {
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const mesh = layer.root.getObjectByName("koerper:klotz") as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    assert.equal(`#${material.color.getHexString()}`, "#8c8c94", "Eisenfarbe nicht uebernommen");
    assert.ok(Math.abs(material.metalness - 0.9) < 1e-6);
    layer.dispose();
  });

  it("zeichnet die Ebene in der Farbe ihres Materials", () => {
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const group = layer.root.getObjectByName("randbedingung:schiefe-ebene")!;
    const mesh = group.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    // Die Rampe im Durchstich ist aus Glatt.
    assert.equal(`#${material.color.getHexString()}`, SMOOTH.appearance.macroscopic.color, "Farbe von Glatt nicht uebernommen");
    layer.dispose();
  });

  it("gibt beim Aufraeumen Geometrien und Materialien frei", () => {
    // WebGL-Ressourcen haengen nicht am Garbage Collector: ein Ebenenwechsel
    // ohne dispose laesst Puffer auf der Grafikkarte zurueck.
    const layer = new MacroscopicRenderer();
    layer.build(context);
    const mesh = layer.root.getObjectByName("koerper:klotz") as THREE.Mesh;
    let disposed = false;
    mesh.geometry.addEventListener("dispose", () => {
      disposed = true;
    });
    layer.dispose();
    assert.equal(disposed, true, "Geometrie wurde nicht freigegeben");
    assert.equal(layer.root.children.length, 0, "Szenengraph nicht geleert");
  });
});

describe("Kinematische Ansicht", () => {
  it("zeichnet die Bahnkurve der ganzen Aufzeichnung", () => {
    const layer = new KinematicRenderer();
    layer.setRecording(recording);
    layer.build(context);
    const path = layer.root.getObjectByName("bahn:klotz") as THREE.Line | undefined;
    assert.ok(path, "Bahnkurve fehlt");
    const points = path.geometry.getAttribute("position").count;
    assert.ok(points > 50, `Bahnkurve hat nur ${points} Punkte`);
    layer.dispose();
  });

  it("richtet den Geschwindigkeitspfeil auf die Bewegungsrichtung aus", () => {
    const layer = new KinematicRenderer();
    layer.setRecording(recording);
    layer.build(context);
    const snapshot = snapshotAt(recording, 0.3);
    layer.update(snapshot);

    const group = layer.root.getObjectByName("kinematik:klotz")!;
    const arrow = group.children.find((child) => child instanceof THREE.ArrowHelper) as THREE.ArrowHelper;
    assert.ok(arrow, "kein Pfeil gefunden");
    assert.equal(arrow.visible, true);

    // Im freien Fall zeigt die Geschwindigkeit senkrecht nach unten, also nach
    // -z. Die (0, 1, 0) ist die Eigenachse des ArrowHelper, nicht die Hochachse
    // der Welt.
    const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(arrow.quaternion);
    assert.ok(direction.z < -0.99, `Pfeil zeigt nach (${direction.toArray()}), erwartet nach unten`);
    layer.dispose();
  });

  it("blendet einen Pfeil der Laenge null aus, statt eine Restlaenge zu zeichnen", () => {
    // Sonst zeigt die Ansicht eine Beschleunigung an, wo keine ist - hier nach
    // dem Anhalten bei t = 2 s.
    const layer = new KinematicRenderer();
    layer.setRecording(recording);
    layer.build(context);
    layer.update(snapshotAt(recording, 3.5));

    const group = layer.root.getObjectByName("kinematik:klotz")!;
    const arrows = group.children.filter(
      (child): child is THREE.ArrowHelper => child instanceof THREE.ArrowHelper,
    );
    assert.ok(arrows.length >= 1);
    // Nach dem Anhalten ist die Geschwindigkeit null; der Pfeil muss weg sein.
    assert.ok(
      arrows.some((arrow) => !arrow.visible),
      "kein Pfeil wurde ausgeblendet, obwohl die Geschwindigkeit null ist",
    );
    layer.dispose();
  });
});

describe("Atomare Ansicht", () => {
  it("baut ein Instanzgitter fuer den Koerper", () => {
    const layer = new AtomicRenderer();
    layer.build(context);
    const lattice = layer.root.getObjectByName("gitter:klotz") as THREE.InstancedMesh | undefined;
    assert.ok(lattice, "Gitter fehlt");
    // Eisen ist raumzentriert: 5^3 Rasterknoten plus 4^3 Zellmittelpunkte.
    assert.equal(lattice.count, 125 + 64);
    layer.dispose();
  });

  it("bewegt das Gitter starr mit dem Koerper", () => {
    const layer = new AtomicRenderer();
    layer.build(context);
    const snapshot = snapshotAt(recording, 0.3);
    layer.update(snapshot);
    const lattice = layer.root.getObjectByName("gitter:klotz")!;
    const expected = snapshot.entities["klotz"]!.mechanics!.position;
    assert.ok(lattice.position.distanceTo(new THREE.Vector3(...expected)) < 1e-12);
    layer.dispose();
  });

  it("nennt die Darstellung schematisch", () => {
    // Eine atomare Ansicht, die wie eine Messung aussieht, ist didaktisch
    // schaedlicher als keine. Der Hinweis ist Teil der Schnittstelle, damit die
    // Oberflaeche ihn nicht weglassen kann, ohne es zu merken.
    const layer = new AtomicRenderer();
    assert.ok(layer.schematicNote, "schematicNote fehlt");
    assert.ok(layer.schematicNote.includes("chematisch"));
  });

  it("haelt das Verhaeltnis von Atomradius zu Gitterkonstante ein", () => {
    // Das ist der physikalisch echte Teil der Ansicht: die Packungsdichte.
    // Eisen: 126 pm Radius bei 287 pm Gitterkonstante.
    const layer = new AtomicRenderer({ cellsPerShortestAxis: 4 });
    layer.build(context);
    const lattice = layer.root.getObjectByName("gitter:klotz") as THREE.InstancedMesh;
    const geometry = lattice.geometry as THREE.SphereGeometry;
    const cellSize = 0.2 / 4;
    const expectedRadius = cellSize * (126 / 287);
    assert.ok(
      Math.abs(geometry.parameters.radius - expectedRadius) < 1e-12,
      `Radius ${geometry.parameters.radius}, erwartet ${expectedRadius}`,
    );
    layer.dispose();
  });
});

describe("Opazität der Objekte", () => {
  const faded = (opacity: number) => ({
    ...scenario,
    entities: scenario.entities.map((entity) =>
      entity.id === "klotz" || entity.id === "auslauf" ? { ...entity, opacity } : entity,
    ),
  });
  const lastSnapshot = recording.snapshots[recording.snapshots.length - 1]!;

  it("multipliziert die Deckkraft des Materials, statt sie zu ersetzen", () => {
    const renderer = new MacroscopicRenderer();
    renderer.build({ scenario: faded(0.5), seed: recording.seed });
    const body = renderer.root.getObjectByName("koerper:klotz") as THREE.Mesh;
    const material = body.material as THREE.MeshStandardMaterial;
    // Eisen ist voll deckend (1), also bleibt genau die Objekt-Opazitaet.
    assert.equal(material.opacity, 0.5);
    assert.equal(material.transparent, true);
  });

  it("lässt ein Objekt mit Opazität 0 auch nach update ausgeblendet", () => {
    const cases: [ViewLayerRenderer, string][] = [
      [new MacroscopicRenderer(), "koerper:klotz"],
      [new KinematicRenderer(), "kinematik:klotz"],
      [new AtomicRenderer(), "gitter:klotz"],
    ];
    for (const [renderer, name] of cases) {
      renderer.build({ scenario: faded(0), seed: recording.seed });
      renderer.update(lastSnapshot);
      const object = renderer.root.getObjectByName(name);
      assert.ok(object, name);
      assert.equal(object.visible, false, name);
    }
  });

  it("zeigt bei Opazität 1 das Objekt wie bisher", () => {
    const renderer = new MacroscopicRenderer();
    renderer.build(context);
    renderer.update(lastSnapshot);
    assert.equal((renderer.root.getObjectByName("koerper:klotz") as THREE.Mesh).visible, true);
  });
});

describe("Aenderungen in der Darstellung", () => {
  /** Das sichtbare Objekt dieses Namens - jede Variante einer Entitaet traegt denselben. */
  function visibleNamed(root: THREE.Object3D, name: string): THREE.Object3D[] {
    const found: THREE.Object3D[] = [];
    root.traverse((node) => {
      if (node.name === name && node.visible) found.push(node);
    });
    return found;
  }

  it("zeigt eine Randbedingung nach einer Lageaenderung an der neuen Stelle", () => {
    const changed = {
      ...scenario,
      interventions: [
        ...scenario.interventions,
        {
          op: "change" as const,
          t: 1,
          entityId: "auslauf",
          change: { key: "position" as const, value: [5, 0, -3] as [number, number, number] },
        },
      ],
    };
    const changedRecording = runScenario(changed);
    const layer = new MacroscopicRenderer();
    layer.build({ scenario: changed, seed: changedRecording.seed });

    layer.update(snapshotAt(changedRecording, 0.5));
    const before = visibleNamed(layer.root, "randbedingung:auslauf");
    const runout = scenario.entities.find((entity) => entity.id === "auslauf")!;
    assert.ok(runout.kind === "constraint");
    assert.equal(before.length, 1);
    assert.deepEqual(before[0]!.position.toArray(), runout.pose.position);

    // Genau auf der Eingriffszeit gilt schon der Stand danach.
    layer.update(snapshotAt(changedRecording, 1));
    const after = visibleNamed(layer.root, "randbedingung:auslauf");
    assert.equal(after.length, 1, "genau eine Variante sichtbar");
    assert.deepEqual(after[0]!.position.toArray(), [5, 0, -3]);
    layer.dispose();
  });

  it("blendet eine entfernte Randbedingung aus", () => {
    const withRemoval = {
      ...scenario,
      interventions: [...scenario.interventions, { op: "remove" as const, t: 1, entityId: "auslauf" }],
    };
    const removedRecording = runScenario(withRemoval);
    const layer = new MacroscopicRenderer();
    layer.build({ scenario: withRemoval, seed: removedRecording.seed });
    layer.update(snapshotAt(removedRecording, 0.5));
    assert.equal(visibleNamed(layer.root, "randbedingung:auslauf").length, 1);
    layer.update(snapshotAt(removedRecording, 1.5));
    assert.equal(visibleNamed(layer.root, "randbedingung:auslauf").length, 0);
    layer.dispose();
  });

  it("zeichnet einen Koerper nach einer Groessenaenderung in der neuen Groesse", () => {
    const changed = {
      ...scenario,
      interventions: [
        ...scenario.interventions,
        {
          op: "change" as const,
          t: 1,
          entityId: "klotz",
          change: { key: "halfExtents" as const, value: [0.2, 0.1, 0.1] as [number, number, number] },
        },
      ],
    };
    const changedRecording = runScenario(changed);
    const layer = new MacroscopicRenderer();
    layer.build({ scenario: changed, seed: changedRecording.seed });
    const widthAt = (t: number): number => {
      layer.update(snapshotAt(changedRecording, t));
      const [mesh] = visibleNamed(layer.root, "koerper:klotz") as THREE.Mesh[];
      return (mesh!.geometry as THREE.BoxGeometry).parameters.width;
    };
    assert.equal(widthAt(0.5), 0.2);
    assert.equal(widthAt(1.5), 0.4);
    layer.dispose();
  });

  it("blendet per Opazitaetsaenderung aus und wieder ein, in jeder Ebene", () => {
    const changed = {
      ...scenario,
      interventions: [
        ...scenario.interventions,
        { op: "change" as const, t: 1, entityId: "klotz", change: { key: "opacity" as const, value: 0 } },
        { op: "change" as const, t: 1.5, entityId: "klotz", change: { key: "opacity" as const, value: 1 } },
      ],
    };
    const changedRecording = runScenario(changed);
    const cases: [ViewLayerRenderer, string][] = [
      [new MacroscopicRenderer(), "koerper:klotz"],
      [new KinematicRenderer(), "kinematik:klotz"],
      [new AtomicRenderer(), "gitter:klotz"],
    ];
    for (const [renderer, name] of cases) {
      renderer.build({ scenario: changed, seed: changedRecording.seed });
      const shownAt = (t: number): number => {
        renderer.update(snapshotAt(changedRecording, t));
        return visibleNamed(renderer.root, name).length;
      };
      assert.deepEqual([shownAt(0.5), shownAt(1.2), shownAt(1.7)], [1, 0, 1], name);
      renderer.dispose();
    }
  });
});
