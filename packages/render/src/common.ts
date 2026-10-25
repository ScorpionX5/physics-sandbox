import * as THREE from "three";
import { constraintSegments } from "@sandbox/core";
import { applyEntityChange, interventionsInOrder } from "@sandbox/schema";
import type {
  Constraint,
  ConstraintSpec,
  BodySpec,
  EntitySpec,
  Scenario,
  Snapshot,
  Material,
  SurfaceSegment,
  ViewLayer,
} from "@sandbox/schema";

/**
 * Gemeinsame Grundlage der Darstellungsebenen.
 *
 * Jede Ebene liest dieselbe Aufzeichnung und zeigt etwas anderes. Keine Ebene
 * schreibt zurueck - die Darstellungsschicht leitet ihre Geometrie aus dem
 * Zustand ab und ist nie dessen Quelle.
 */

export interface LayerContext {
  scenario: Scenario;
  /** Seed der Aufzeichnung - fuer prozedural erzeugte Details. */
  seed: number;
}

export interface ViewLayerRenderer {
  readonly layer: ViewLayer;
  /** Anzeigename fuer die Benutzeroberflaeche. */
  readonly title: string;
  /**
   * Hinweis, dass die Darstellung schematisch ist und keine
   * Groessenverhaeltnisse der Realitaet zeigt. Die Benutzeroberflaeche muss ihn
   * anzeigen - eine atomare Ansicht, die wie eine Messung aussieht, ist
   * didaktisch schaedlicher als keine.
   */
  readonly schematicNote?: string;
  readonly root: THREE.Object3D;
  build(context: LayerContext): void;
  /**
   * Hebt die Darstellung einer Entitaet hervor (`undefined`: keine). Optional,
   * weil nicht jede Ebene etwas Sinnvolles hervorheben kann; der Betrachter
   * ruft es nach jedem `build` erneut auf, denn das Bauen verwirft die
   * Hervorhebung mit der Geometrie.
   */
  setActiveEntity?(entityId: string | undefined): void;
  update(snapshot: Snapshot): void;
  dispose(): void;
}

// ---------------------------------------------------------------- Szenario lesen

/**
 * Ein **Stand** einer Entitaet: ab Zeit `t` gilt diese Spec (Startwerte plus
 * Aenderungen der Eingabeeigenschaften), und die Entitaet ist in der Szene oder
 * nicht.
 *
 * Gefaltet mit `applyEntityChange`, derselben Regel wie `entitySpecAt` und der
 * Simulator. Folgen zwei Staende mit derselben Spec aufeinander (eine
 * Zustandsaenderung, ein `add`), ist es dasselbe Objekt - daran erkennen die
 * Renderer, dass sie keine neue Variante brauchen.
 */
export interface EntityStage {
  t: number;
  spec: EntitySpec;
  present: boolean;
}

/** Die Staende einer Entitaet in Wirkreihenfolge; der erste gilt vor jedem Eingriff. */
export function entityStages(scenario: Scenario, spec: EntitySpec): EntityStage[] {
  const stages: EntityStage[] = [{ t: -Infinity, spec, present: false }];
  for (const intervention of interventionsInOrder(scenario)) {
    if (intervention.op === "setEnvironment" || intervention.entityId !== spec.id) continue;
    const last = stages[stages.length - 1]!;
    if (intervention.op === "add") stages.push({ ...last, t: intervention.t, present: true });
    else if (intervention.op === "remove") stages.push({ ...last, t: intervention.t, present: false });
    else stages.push({ ...last, t: intervention.t, spec: applyEntityChange(last.spec, intervention.change) });
  }
  return stages;
}

/**
 * Der Stand zur Zeit `t`. Bei genau der Eingriffszeit gilt der Stand danach -
 * wie beim Schnappschusspaar des Simulators und bei `snapshotAt`.
 */
export function stageAt(stages: readonly EntityStage[], t: number): EntityStage {
  let current = stages[0]!;
  for (const stage of stages) {
    if (stage.t > t + 1e-9) break;
    current = stage;
  }
  return current;
}

/** Die verschiedenen Specs einer Entitaet ueber den Lauf, in Reihenfolge ihres Auftretens. */
function distinctSpecs<S extends EntitySpec>(stages: readonly EntityStage[]): S[] {
  const specs: S[] = [];
  for (const stage of stages) {
    if (!specs.includes(stage.spec as S)) specs.push(stage.spec as S);
  }
  return specs;
}

export interface ConstraintVariant {
  spec: ConstraintSpec;
  /** Das Material der Instanz - bestimmt die Optik der Flaeche. */
  material: Material;
  /**
   * Die Segmente im Koerpersystem, mit der instanzeigenen Groesse.
   *
   * Aufgeloest wird mit derselben Funktion, die auch der Simulator benutzt -
   * zeichnete die Darstellung die Bibliotheksgroesse, waehrend die Physik mit
   * der Instanzgroesse rechnet, wuerde ein Koerper sichtbar neben der Platte
   * aufliegen.
   */
  segments: SurfaceSegment[];
}

export interface BodyVariant {
  spec: BodySpec;
  material: Material;
}

/**
 * Eine Randbedingung im Inventar. `spec`, `material`, `segments` sind die des
 * ersten Stands; `variants` enthaelt jede Spec, die sie im Lauf annimmt.
 */
export interface InventoryConstraint extends ConstraintVariant {
  constraint: Constraint;
  stages: EntityStage[];
  variants: ConstraintVariant[];
}

export interface InventoryBody extends BodyVariant {
  stages: EntityStage[];
  variants: BodyVariant[];
}

export interface ScenarioInventory {
  /** Alle Koerper, die im Lauf des Szenarios irgendwann auftreten. */
  bodies: InventoryBody[];
  /** Alle platzierten Randbedingungen. */
  constraints: InventoryConstraint[];
}

/**
 * Sammelt alles, was im Szenario je hinzugefuegt wird.
 *
 * Die Geometrie wird einmal angelegt, auch fuer Koerper, die erst spaeter
 * erscheinen - sie werden bis dahin nur unsichtbar geschaltet. Geometrie
 * mitten im Abspielen zu erzeugen wuerde beim Eingriff haengen. Aus demselben
 * Grund bekommt jede Spec, die eine Entitaet durch Aenderungen annimmt
 * (`variants`), ihre eigene vorgebaute Darstellung; `update` schaltet nur um.
 * Das ist einfacher als Skalieren und Materialtauschen und bildet auch ab, was
 * sich nicht skalieren laesst (das Atomgitter eines anderen Materials).
 */
export function scenarioInventory(scenario: Scenario): ScenarioInventory {
  const materials = new Map<string, Material>();
  const constraints = new Map<string, Constraint>();
  for (const entry of scenario.library) {
    if (entry.definition.kind === "material") materials.set(entry.definition.id, entry.definition);
    else if (entry.definition.kind === "constraint") constraints.set(entry.definition.id, entry.definition);
  }
  const materialOf = (materialId: string): Material => {
    const material = materials.get(materialId);
    if (!material) throw new Error(`Material "${materialId}" fehlt in der Bibliothek des Szenarios.`);
    return material;
  };

  const inventory: ScenarioInventory = { bodies: [], constraints: [] };
  const seen = new Set<string>();
  for (const intervention of scenario.interventions) {
    if (intervention.op !== "add" || seen.has(intervention.entityId)) continue;
    seen.add(intervention.entityId);
    // Nur was irgendwo hinzugefuegt wird, kommt vor: eine Entitaet ohne `add`
    // ist nie in der Szene und bekommt keine Geometrie.
    const entity = scenario.entities.find((candidate) => candidate.id === intervention.entityId);
    if (!entity) continue;
    const stages = entityStages(scenario, entity);
    if (entity.kind === "body") {
      const variants = distinctSpecs<BodySpec>(stages).map((spec) => ({
        spec,
        material: materialOf(spec.materialId),
      }));
      inventory.bodies.push({ ...variants[0]!, stages, variants });
    } else if (entity.kind === "constraint") {
      const constraint = constraints.get(entity.constraintId);
      if (!constraint) {
        throw new Error(
          `Randbedingung "${entity.constraintId}" fehlt in der Bibliothek des Szenarios.`,
        );
      }
      const variants = distinctSpecs<ConstraintSpec>(stages).map((spec) => ({
        spec,
        material: materialOf(spec.materialId),
        segments: constraintSegments(constraint, spec, spec.id),
      }));
      inventory.constraints.push({ ...variants[0]!, constraint, stages, variants });
    }
    // Lasten haben keine Lage und keine Geometrie - keine Darstellungsebene
    // zeichnet sie (noch).
  }
  return inventory;
}

/** Was ein Renderer je Entitaet haelt: ihre Staende und je Spec eine vorgebaute Darstellung. */
export interface EntityVariants<T extends THREE.Object3D = THREE.Object3D> {
  stages: EntityStage[];
  variants: Map<EntitySpec, T>;
}

/**
 * Schaltet unter den vorgebauten Varianten einer Entitaet die zum Stand
 * passende ein. `present` sagt, ob die Entitaet gerade in der Szene ist -
 * beim Koerper aus dem Schnappschuss, bei der Randbedingung aus dem Stand,
 * weil Randbedingungen nicht aufgezeichnet werden. Die Opazitaet einer
 * Variante (`isShownBy`) kann sie trotzdem ausgeblendet lassen.
 *
 * Liefert die eingeschaltete Variante, damit `update` nur sie bewegt.
 */
export function showVariant<T extends THREE.Object3D>(
  variants: ReadonlyMap<EntitySpec, T>,
  stage: EntityStage,
  present: boolean,
): T | undefined {
  let shown: T | undefined;
  for (const [spec, object] of variants) {
    const current = spec === stage.spec;
    object.visible = present && current && isShownBy(object);
    if (current) shown = object;
  }
  return shown;
}

// ---------------------------------------------------------------- Geometrie

/**
 * Richtet ein Objekt an einem Flaechensegment aus.
 *
 * Die Platte liegt im lokalen System in der xz-Ebene, ihre Dicke geht nach -y.
 * Die Basis wird aus Tangente und Normale aufgebaut; die dritte Achse ist
 * `tangent x normal`, damit das System rechtshaendig bleibt. Die Platte wird um
 * eine halbe Dicke abgesenkt, damit ihre *Oberseite* in der Kollisionsebene
 * liegt - sonst sitzt der Koerper sichtbar in der Platte.
 */
export function placeOnSegment(object: THREE.Object3D, segment: SurfaceSegment): void {
  const tangent = new THREE.Vector3(...segment.tangent).normalize();
  const normal = new THREE.Vector3(...segment.normal).normalize();
  const third = new THREE.Vector3().crossVectors(tangent, normal).normalize();

  const basis = new THREE.Matrix4().makeBasis(tangent, normal, third);
  object.quaternion.setFromRotationMatrix(basis);
  object.position
    .set(...segment.center)
    .addScaledVector(normal, -segment.thickness / 2);
}

export function segmentGeometry(segment: SurfaceSegment): THREE.BoxGeometry {
  return new THREE.BoxGeometry(
    segment.halfExtentU * 2,
    segment.thickness,
    segment.halfExtentV * 2,
  );
}

export function bodyGeometry(spec: BodySpec): THREE.BufferGeometry {
  const shape = spec.phase.shape;
  if (shape.type === "box") {
    const [hx, hy, hz] = shape.halfExtents;
    return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
  }
  return new THREE.SphereGeometry(shape.radius, 32, 16);
}

/** Groesste halbe Ausdehnung eines Koerpers - fuer Pfeillaengen und Kameradistanz. */
export function bodyScale(spec: BodySpec): number {
  const shape = spec.phase.shape;
  if (shape.type === "box") return Math.max(...shape.halfExtents);
  return shape.radius;
}

/**
 * Wendet die Opazitaet einer Entitaet (`EntitySpec.opacity`) auf ein Objekt an.
 *
 * Die Deckkraft der Materialien wird mit ihr multipliziert, damit ein schon
 * halbdurchsichtiges Material nicht voll deckend wird. Der Wert wird ausserdem in
 * `userData.opacity` abgelegt: bei 0 muss das Objekt ganz ausgeblendet sein
 * (`isShownBy`), denn ein durchsichtiges Netz schreibt weiter Tiefe und finge
 * Klicks ab. Gebaut wird nur einmal je Aufzeichnung, deshalb wird nicht auf einen
 * gemerkten Ausgangswert zurueckgerechnet - aber geteilte Materialien duerfen
 * nur einmal skaliert werden.
 */
export function applyEntityOpacity(object: THREE.Object3D, opacity: number): void {
  object.userData.opacity = opacity;
  if (opacity <= 0) object.visible = false;
  if (opacity >= 1) return;
  const scaled = new Set<THREE.Material>();
  object.traverse((node) => {
    const material = (node as Partial<THREE.Mesh>).material;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      if (scaled.has(entry)) continue;
      scaled.add(entry);
      entry.opacity *= opacity;
      entry.transparent = true;
    }
  });
}

/** Ob die Opazitaet eines Objekts es sichtbar sein laesst (Standard: ja). */
export function isShownBy(object: THREE.Object3D): boolean {
  return ((object.userData.opacity as number | undefined) ?? 1) > 0;
}

/**
 * Legt Lage und Orientierung aus dem Schnappschuss auf die passende Variante
 * eines Koerpers und blendet die anderen aus.
 */
export function applyMechanics(
  variants: ReadonlyMap<EntitySpec, THREE.Object3D>,
  stages: readonly EntityStage[],
  snapshot: Snapshot,
  id: string,
): boolean {
  const state = snapshot.entities[id]?.mechanics;
  const object = showVariant(variants, stageAt(stages, snapshot.t), state !== undefined);
  if (!state || !object) return false;
  object.position.set(...state.position);
  object.quaternion.set(...state.orientation);
  return true;
}

// ---------------------------------------------------------------- Aufraeumen

/**
 * Gibt Geometrien und Materialien eines Teilbaums frei.
 *
 * WebGL-Ressourcen haengen nicht am Garbage Collector: ein Ebenenwechsel ohne
 * `dispose` laesst Puffer auf der Grafikkarte zurueck, und nach genug Wechseln
 * bricht der Kontext weg.
 */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as Partial<THREE.Mesh> & Partial<THREE.Line>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
  root.clear();
}
