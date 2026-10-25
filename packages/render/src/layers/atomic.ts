import * as THREE from "three";
import type { EntitySpec, LatticeType, Snapshot, Material, ViewLayer } from "@sandbox/schema";
import {
  applyEntityOpacity,
  disposeTree,
  isShownBy,
  placeOnSegment,
  scenarioInventory,
  segmentGeometry,
  showVariant,
  stageAt,
  type EntityStage,
  type EntityVariants,
  type LayerContext,
  type ViewLayerRenderer,
} from "../common.js";

/**
 * Atomare Ansicht: der Koerper als Kugelgitter.
 *
 * **Diese Ansicht ist schematisch, und das muss sie sein.** Eisen hat eine
 * Gitterkonstante von 287 pm; ein Klotz von 20 cm Kante enthaelt daher etwa
 * 3 * 10^23 Atome. Darstellbar sind einige Tausend. Jede atomare Ansicht einer
 * makroskopischen Probe ist also um zwanzig Groessenordnungen daneben - die
 * Frage ist nur, ob sie das zugibt.
 *
 * Was hier *echt* ist: die Gitterform (kubisch, raumzentriert,
 * flaechenzentriert) und das Verhaeltnis von Atomradius zu Gitterkonstante, also
 * die Packungsdichte. Beide stehen im Bibliothekseintrag und werden
 * uebernommen. Was schematisch ist: die absolute Zellgroesse.
 *
 * In Stufe 1 bewegt sich das Gitter starr mit dem Koerper. Mit dem
 * Thermodynamik-Modul kommt die Schwingungsamplitude proportional zu
 * sqrt(T) hinzu - die Stelle dafuer ist in `update` markiert.
 */

export interface AtomicOptions {
  /** Zellen entlang der kuerzesten Koerperachse. */
  cellsPerShortestAxis?: number;
  /** Obergrenze fuer die Zahl der Kugeln je Koerper. */
  maxAtomsPerBody?: number;
}

interface BodyLattice {
  mesh: THREE.InstancedMesh;
  /** Atompositionen im Koerpersystem. */
  sites: THREE.Vector3[];
}

export class AtomicRenderer implements ViewLayerRenderer {
  readonly layer: ViewLayer = "atomic";
  readonly title = "Atomar";
  readonly schematicNote =
    "Schematisch: Gitterform und Packungsdichte sind echt, die Zellgroesse nicht. " +
    "Ein Klotz dieser Groesse enthaelt rund 10^23 Atome.";
  readonly root = new THREE.Group();

  /** Je Koerper und Spec ein vorgebautes Gitter - Groesse und Material bestimmen es. */
  private readonly lattices = new Map<string, { stages: EntityStage[]; variants: Map<EntitySpec, BodyLattice> }>();
  private readonly constraintObjects = new Map<string, EntityVariants>();
  private readonly options: Required<AtomicOptions>;

  constructor(options: AtomicOptions = {}) {
    this.options = {
      cellsPerShortestAxis: options.cellsPerShortestAxis ?? 4,
      maxAtomsPerBody: options.maxAtomsPerBody ?? 4000,
    };
  }

  build(context: LayerContext): void {
    this.dispose();
    const inventory = scenarioInventory(context.scenario);

    for (const { spec: first, constraint, stages, variants } of inventory.constraints) {
      if (constraint.behaviour.constraintType !== "staticSurface") continue;
      const built = new Map<EntitySpec, THREE.Object3D>();
      for (const { spec, segments } of variants) {
        const group = new THREE.Group();
        group.position.set(...spec.pose.position);
        group.quaternion.set(...spec.pose.orientation);
        for (const segment of segments) {
          const plate = new THREE.LineSegments(
            new THREE.EdgesGeometry(segmentGeometry(segment)),
            new THREE.LineBasicMaterial({ color: 0x47566b }),
          );
          placeOnSegment(plate, segment);
          group.add(plate);
        }
        group.visible = built.size === 0;
        applyEntityOpacity(group, spec.opacity);
        built.set(spec, group);
        this.root.add(group);
      }
      this.constraintObjects.set(first.id, { stages, variants: built });
    }

    for (const { spec: first, stages, variants } of inventory.bodies) {
      const built = new Map<EntitySpec, BodyLattice>();
      for (const { spec, material } of variants) built.set(spec, this.bodyLattice(spec, material));
      this.lattices.set(first.id, { stages, variants: built });
    }
  }

  private bodyLattice(spec: Extract<EntitySpec, { kind: "body" }>, material: Material): BodyLattice {
    const halfExtents: [number, number, number] =
      spec.phase.shape.type === "box"
        ? spec.phase.shape.halfExtents
        : [spec.phase.shape.radius, spec.phase.shape.radius, spec.phase.shape.radius];

    const sites = latticeSites(
      halfExtents,
      material.appearance.atomic.lattice,
      this.options.cellsPerShortestAxis,
      this.options.maxAtomsPerBody,
      spec.phase.shape.type === "sphere" ? spec.phase.shape.radius : undefined,
    );

    // Radius aus dem *echten* Verhaeltnis Atomradius zu Gitterkonstante,
    // angewandt auf die schematische Zellgroesse. Damit stimmt die
    // Packungsdichte, auch wenn der Maßstab es nicht tut.
    const packingRatio =
      material.appearance.atomic.atomRadius / material.appearance.atomic.latticeConstant;
    const cellSize = (Math.min(...halfExtents) * 2) / this.options.cellsPerShortestAxis;
    const atomRadius = Math.max(cellSize * packingRatio, cellSize * 0.08);

    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(atomRadius, 12, 8),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(material.appearance.atomic.atomColor),
        metalness: material.appearance.macroscopic.metalness * 0.6,
        roughness: 0.45,
      }),
      Math.max(sites.length, 1),
    );
    mesh.name = `gitter:${spec.id}`;
    mesh.userData.entityId = spec.id;
    mesh.visible = false;
    // Die Instanzmatrizen aendern sich bei jedem Bild nur ueber die
    // Gruppentransformation - solange das Gitter starr ist, einmal setzen.
    const matrix = new THREE.Matrix4();
    sites.forEach((site, index) => {
      mesh.setMatrixAt(index, matrix.makeTranslation(site.x, site.y, site.z));
    });
    mesh.instanceMatrix.needsUpdate = true;
    applyEntityOpacity(mesh, spec.opacity);
    this.root.add(mesh);
    return { mesh, sites };
  }

  update(snapshot: Snapshot): void {
    for (const { stages, variants } of this.constraintObjects.values()) {
      const stage = stageAt(stages, snapshot.t);
      showVariant(variants, stage, stage.present);
    }
    for (const [id, { stages, variants }] of this.lattices) {
      const state = snapshot.entities[id]?.mechanics;
      const stage = stageAt(stages, snapshot.t);
      let lattice: BodyLattice | undefined;
      for (const [spec, candidate] of variants) {
        const current = spec === stage.spec;
        candidate.mesh.visible = state !== undefined && current && isShownBy(candidate.mesh);
        if (current) lattice = candidate;
      }
      if (!state || !lattice) continue;
      lattice.mesh.position.set(...state.position);
      lattice.mesh.quaternion.set(...state.orientation);

      // Stufe 3: Sobald `snapshot.entities[id].thermal` existiert, bekommen die
      // Instanzmatrizen hier eine Auslenkung proportional zu sqrt(T) - erzeugt
      // aus (Seed, Entitaets-Id, Atomindex, t), damit sie nicht aufgezeichnet
      // werden muss. Bis dahin bewegt sich das Gitter starr mit dem Koerper.
    }
  }

  dispose(): void {
    disposeTree(this.root);
    this.lattices.clear();
    this.constraintObjects.clear();
  }
}

/**
 * Erzeugt die Atompositionen im Koerpersystem.
 *
 * Gitterknoten liegen auf einem Raster; je nach Gitterform kommen
 * Zellmittelpunkte (raumzentriert) oder Flaechenmittelpunkte
 * (flaechenzentriert) hinzu. `amorphous` und `none` erzeugen nur die
 * Rasterknoten - ein amorphes Material hat keine Fernordnung, und sie
 * vorzutaeuschen waere falscher als das Raster.
 */
function latticeSites(
  halfExtents: readonly [number, number, number],
  lattice: LatticeType,
  cellsPerShortestAxis: number,
  maxAtoms: number,
  sphereRadius: number | undefined,
): THREE.Vector3[] {
  const shortest = Math.min(...halfExtents) * 2;
  let cellSize = shortest / Math.max(1, cellsPerShortestAxis);

  const extraPerCell = lattice === "bcc" ? 1 : lattice === "fcc" ? 3 : 0;

  // Zellgroesse so weit anheben, dass die Obergrenze eingehalten wird. Ohne
  // diese Schleife wuerde ein langer, duenner Koerper (z.B. ein Draht)
  // Zehntausende Instanzen erzeugen.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const counts = halfExtents.map((half) => Math.max(1, Math.round((half * 2) / cellSize)));
    const nodes = (counts[0]! + 1) * (counts[1]! + 1) * (counts[2]! + 1);
    const total = nodes + counts[0]! * counts[1]! * counts[2]! * extraPerCell;
    if (total <= maxAtoms) break;
    cellSize *= 1.25;
  }

  const counts = halfExtents.map((half) => Math.max(1, Math.round((half * 2) / cellSize))) as [
    number,
    number,
    number,
  ];
  const step: [number, number, number] = [
    (halfExtents[0] * 2) / counts[0],
    (halfExtents[1] * 2) / counts[1],
    (halfExtents[2] * 2) / counts[2],
  ];

  const sites: THREE.Vector3[] = [];
  const keep = (x: number, y: number, z: number): void => {
    // Bei der Kugel das Raster auf das Volumen beschneiden, sonst sieht die
    // atomare Ansicht einer Kugel wie ein Wuerfel aus.
    if (sphereRadius !== undefined && x * x + y * y + z * z > sphereRadius * sphereRadius) return;
    sites.push(new THREE.Vector3(x, y, z));
  };

  for (let i = 0; i <= counts[0]; i += 1) {
    for (let j = 0; j <= counts[1]; j += 1) {
      for (let k = 0; k <= counts[2]; k += 1) {
        keep(-halfExtents[0] + i * step[0], -halfExtents[1] + j * step[1], -halfExtents[2] + k * step[2]);
      }
    }
  }

  if (extraPerCell > 0) {
    for (let i = 0; i < counts[0]; i += 1) {
      for (let j = 0; j < counts[1]; j += 1) {
        for (let k = 0; k < counts[2]; k += 1) {
          const x0 = -halfExtents[0] + i * step[0];
          const y0 = -halfExtents[1] + j * step[1];
          const z0 = -halfExtents[2] + k * step[2];
          const cx = x0 + step[0] / 2;
          const cy = y0 + step[1] / 2;
          const cz = z0 + step[2] / 2;
          if (lattice === "bcc") {
            keep(cx, cy, cz);
          } else {
            // Flaechenzentriert: drei Flaechenmittelpunkte je Zelle genuegen,
            // die anderen drei gehoeren zur Nachbarzelle.
            keep(cx, cy, z0);
            keep(cx, y0, cz);
            keep(x0, cy, cz);
          }
        }
      }
    }
  }

  return sites;
}

/** Nur fuer Tests: wie viele Kugeln eine Konfiguration erzeugen wuerde. */
export function latticeSiteCount(
  halfExtents: readonly [number, number, number],
  lattice: LatticeType,
  cellsPerShortestAxis = 4,
  maxAtoms = 4000,
): number {
  return latticeSites(halfExtents, lattice, cellsPerShortestAxis, maxAtoms, undefined).length;
}

/** Nur fuer Tests und UI: der Hinweistext zur schematischen Darstellung. */
export function atomicSchematicNote(material: Material): string {
  return (
    `${material.name}: Gitter ${material.appearance.atomic.lattice}, Atomradius ` +
    `${material.appearance.atomic.atomRadius} pm bei Gitterkonstante ` +
    `${material.appearance.atomic.latticeConstant} pm. Darstellung schematisch.`
  );
}
