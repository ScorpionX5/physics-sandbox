import * as THREE from "three";
import type { EntitySpec, Snapshot, ViewLayer } from "@sandbox/schema";
import {
  applyEntityOpacity,
  applyMechanics,
  bodyGeometry,
  disposeTree,
  placeOnSegment,
  scenarioInventory,
  segmentGeometry,
  showVariant,
  stageAt,
  type EntityVariants,
  type LayerContext,
  type ViewLayerRenderer,
} from "../common.js";

/** Farbe der Kanten des aktiven Objekts. */
const ACTIVE_COLOR = 0xff8a1f;

/**
 * Makroskopische Ansicht: Koerper und Flaechen als Volumen.
 *
 * Liest aus dem Zustand nur Lage und Orientierung. Die Farben und
 * Oberflaecheneigenschaften kommen aus `appearance.macroscopic` des Materials,
 * bei Koerpern wie bei Flaechen -
 * also aus dem Teil des Bibliothekseintrags, den die KI entwerfen darf, waehrend
 * die Zahlen aus der Referenztabelle stammen.
 */
export class MacroscopicRenderer implements ViewLayerRenderer {
  readonly layer: ViewLayer = "macroscopic";
  readonly title = "Makroskopisch";
  readonly root = new THREE.Group();

  /** Je Entitaet ihre Staende und je Spec eine vorgebaute Variante. */
  private readonly bodyObjects = new Map<string, EntityVariants>();
  private readonly constraintObjects = new Map<string, EntityVariants>();
  /** Die Netze je Entitaet - woran die Hervorhebung ihre Kanten haengt. */
  private readonly entityMeshes = new Map<string, THREE.Mesh[]>();
  private outlines: THREE.LineSegments[] = [];
  private activeEntityId: string | undefined;

  /** Orange Kanten an allen Netzen der Entitaet; die Geometrie selbst bleibt unberuehrt. */
  setActiveEntity(entityId: string | undefined): void {
    this.activeEntityId = entityId;
    this.refreshOutlines();
  }

  private refreshOutlines(): void {
    for (const outline of this.outlines) {
      outline.parent?.remove(outline);
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
    }
    this.outlines = [];
    if (this.activeEntityId === undefined) return;
    for (const mesh of this.entityMeshes.get(this.activeEntityId) ?? []) {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: ACTIVE_COLOR }),
      );
      mesh.add(outline);
      this.outlines.push(outline);
    }
  }

  build(context: LayerContext): void {
    this.dispose();
    const inventory = scenarioInventory(context.scenario);

    for (const { spec: first, constraint, stages, variants } of inventory.constraints) {
      if (constraint.behaviour.constraintType !== "staticSurface") continue;
      const id = first.id;
      const built = new Map<EntitySpec, THREE.Object3D>();
      for (const { spec, material: surfaceMaterial, segments } of variants) {
        const group = new THREE.Group();
        group.name = `randbedingung:${id}`;
        const look = surfaceMaterial.appearance.macroscopic;
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(look.color),
          metalness: look.metalness,
          roughness: look.roughness,
          transparent: look.opacity < 1,
          opacity: look.opacity,
        });
        for (const segment of segments) {
          const plate = new THREE.Mesh(segmentGeometry(segment), material);
          // Mit "Ebene" heissen alle Segmente gleich; die Instanz-Id macht den
          // Namen im Szenengraph wieder eindeutig.
          plate.name = `segment:${id}/${segment.id}`;
          plate.userData.entityId = id;
          placeOnSegment(plate, segment);
          plate.receiveShadow = true;
          group.add(plate);
          this.entityMeshes.set(id, [...(this.entityMeshes.get(id) ?? []), plate]);
        }
        // Die Lage der platzierten Randbedingung kommt zu der der Segmente hinzu.
        group.position.set(...spec.pose.position);
        group.quaternion.set(...spec.pose.orientation);
        // Nur die erste Variante ist vor dem ersten `update` zu sehen.
        group.visible = built.size === 0;
        applyEntityOpacity(group, spec.opacity);
        built.set(spec, group);
        this.root.add(group);
      }
      this.constraintObjects.set(id, { stages, variants: built });
    }

    for (const { spec: first, stages, variants } of inventory.bodies) {
      const built = new Map<EntitySpec, THREE.Object3D>();
      for (const { spec, material } of variants) {
        const look = material.appearance.macroscopic;
        const mesh = new THREE.Mesh(
          bodyGeometry(spec),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(look.color),
            metalness: look.metalness,
            roughness: look.roughness,
            transparent: look.opacity < 1,
            opacity: look.opacity,
          }),
        );
        mesh.name = `koerper:${spec.id}`;
        mesh.userData.entityId = spec.id;
        this.entityMeshes.set(spec.id, [...(this.entityMeshes.get(spec.id) ?? []), mesh]);
        mesh.castShadow = true;
        // Bis zum ersten Schnappschuss unsichtbar: ein Koerper, der erst
        // spaeter hinzukommt, darf nicht von Anfang an herumstehen.
        mesh.visible = false;
        applyEntityOpacity(mesh, spec.opacity);
        built.set(spec, mesh);
        this.root.add(mesh);
      }
      this.bodyObjects.set(first.id, { stages, variants: built });
    }
    this.refreshOutlines();
  }

  update(snapshot: Snapshot): void {
    for (const [id, { stages, variants }] of this.bodyObjects) {
      applyMechanics(variants, stages, snapshot, id);
    }
    // Randbedingungen stehen in keinem Schnappschuss; Lage, Groesse und
    // Anwesenheit folgen allein aus dem Szenario.
    for (const { stages, variants } of this.constraintObjects.values()) {
      const stage = stageAt(stages, snapshot.t);
      showVariant(variants, stage, stage.present);
    }
  }

  dispose(): void {
    disposeTree(this.root);
    this.bodyObjects.clear();
    this.constraintObjects.clear();
    this.entityMeshes.clear();
    this.outlines = [];
  }
}
