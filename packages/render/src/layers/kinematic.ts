import * as THREE from "three";
import type { EntitySpec, Recording, Snapshot, ViewLayer } from "@sandbox/schema";
import {
  applyEntityOpacity,
  bodyScale,
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
 * Kinematische Ansicht: Geschwindigkeit, Beschleunigung, Kraft und Bahnkurve.
 *
 * Fuer die Mechanik die didaktisch wertvollste Ebene - sie zeigt genau das, was
 * man an einem Gleitvorgang verstehen will, und ist zugleich das
 * Diagnosewerkzeug fuer den Kontaktloeser: knickt der Geschwindigkeitspfeil beim
 * Aufprall nicht in die Flaeche, stimmt die Impulsrichtung nicht.
 *
 * `force` und `acceleration` kommen aus der Aufzeichnung und werden nicht aus
 * dem Verlauf abgeleitet. Eine Ableitung aus 20-Hz-Schnappschuessen waere genau
 * im Stosszeitpunkt unbrauchbar - dort, wo man sie am meisten sehen will.
 */

export interface KinematicOptions {
  /** Pfeillaenge pro m/s. */
  velocityScale?: number;
  /** Pfeillaenge pro m/s^2. */
  accelerationScale?: number;
  /** Bahnkurve der gesamten Aufzeichnung anzeigen. */
  showTrajectory?: boolean;
}

const VELOCITY_COLOR = 0x4ea3ff;
const ACCELERATION_COLOR = 0xffb347;
const TRAJECTORY_COLOR = 0x8899aa;

interface BodyVisual {
  group: THREE.Group;
  velocity: THREE.ArrowHelper;
  acceleration: THREE.ArrowHelper;
  /** Umriss des Koerpers, damit die Pfeile einen Bezug haben. */
  outline: THREE.LineSegments;
}

export class KinematicRenderer implements ViewLayerRenderer {
  readonly layer: ViewLayer = "kinematic";
  readonly title = "Kinematisch";
  readonly root = new THREE.Group();

  /** Je Koerper und Spec ein vorgebauter Umriss samt Pfeilen. */
  private readonly visuals = new Map<string, { stages: EntityStage[]; variants: Map<EntitySpec, BodyVisual> }>();
  private readonly constraintObjects = new Map<string, EntityVariants>();
  private readonly options: Required<KinematicOptions>;
  private recording: Recording | undefined;

  constructor(options: KinematicOptions = {}) {
    this.options = {
      velocityScale: options.velocityScale ?? 0.15,
      accelerationScale: options.accelerationScale ?? 0.05,
      showTrajectory: options.showTrajectory ?? true,
    };
  }

  /**
   * Die Bahnkurve braucht die ganze Aufzeichnung, nicht nur den aktuellen
   * Schnappschuss. Sie wird deshalb vor `build` gesetzt.
   */
  setRecording(recording: Recording): void {
    this.recording = recording;
  }

  build(context: LayerContext): void {
    this.dispose();
    const inventory = scenarioInventory(context.scenario);

    // Flaechen als Drahtgitter: sie geben die Orientierung, sollen aber die
    // Pfeile nicht verdecken.
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
            new THREE.LineBasicMaterial({ color: 0x5a6b7d }),
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
      const built = new Map<EntitySpec, BodyVisual>();
      for (const { spec } of variants) built.set(spec, this.bodyVisual(spec));
      this.visuals.set(first.id, { stages, variants: built });
      this.addTrajectory(first);
    }
  }

  /** Umriss und Pfeile eines Koerpers in einer Spec - eine Variante. */
  private bodyVisual(spec: Extract<EntitySpec, { kind: "body" }>): BodyVisual {
    const scale = bodyScale(spec);
    const group = new THREE.Group();
    group.name = `kinematik:${spec.id}`;
    group.visible = false;

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(
        spec.phase.shape.type === "box"
          ? new THREE.BoxGeometry(
              spec.phase.shape.halfExtents[0] * 2,
              spec.phase.shape.halfExtents[1] * 2,
              spec.phase.shape.halfExtents[2] * 2,
            )
          : new THREE.SphereGeometry(spec.phase.shape.radius, 16, 8),
      ),
      new THREE.LineBasicMaterial({ color: 0xdfe6ee }),
    );
    group.add(outline);

    // Startlaenge ist beliebig; `update` setzt sie jedes Bild neu. Die
    // Kopfgroesse haengt an der Koerpergroesse, damit die Pfeile bei einem
    // 2-cm- und einem 2-m-Koerper gleich lesbar bleiben.
    const velocity = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      scale,
      VELOCITY_COLOR,
      scale * 0.6,
      scale * 0.35,
    );
    const acceleration = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      scale,
      ACCELERATION_COLOR,
      scale * 0.6,
      scale * 0.35,
    );
    group.add(velocity, acceleration);
    applyEntityOpacity(group, spec.opacity);
    this.root.add(group);
    return { group, velocity, acceleration, outline };
  }

  /** Die Bahn gehoert dem Koerper, nicht einer Variante: eine Linie ueber den ganzen Lauf. */
  private addTrajectory(spec: Extract<EntitySpec, { kind: "body" }>): void {
    if (this.options.showTrajectory && this.recording) {
      const points: THREE.Vector3[] = [];
      for (const snapshot of this.recording.snapshots) {
        const state = snapshot.entities[spec.id]?.mechanics;
        if (state) points.push(new THREE.Vector3(...state.position));
      }
      if (points.length > 1) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineDashedMaterial({
            color: TRAJECTORY_COLOR,
            dashSize: 0.08,
            gapSize: 0.05,
          }),
        );
        line.computeLineDistances();
        line.name = `bahn:${spec.id}`;
        applyEntityOpacity(line, spec.opacity);
        this.root.add(line);
      }
    }
  }

  update(snapshot: Snapshot): void {
    for (const { stages, variants } of this.constraintObjects.values()) {
      const stage = stageAt(stages, snapshot.t);
      showVariant(variants, stage, stage.present);
    }
    for (const [id, { stages, variants }] of this.visuals) {
      const state = snapshot.entities[id]?.mechanics;
      const stage = stageAt(stages, snapshot.t);
      let visual: BodyVisual | undefined;
      for (const [spec, candidate] of variants) {
        const current = spec === stage.spec;
        candidate.group.visible = state !== undefined && current && isShownBy(candidate.group);
        if (current) visual = candidate;
      }
      if (!state || !visual) continue;
      visual.group.position.set(...state.position);
      // Der Umriss dreht sich mit dem Koerper, die Pfeile nicht: sie zeigen
      // Weltrichtungen. Die Gruppe bleibt deshalb ungedreht, und die
      // Orientierung sitzt nur am Umriss.
      visual.outline.quaternion.set(...state.orientation);

      setArrow(visual.velocity, state.linearVelocity, this.options.velocityScale);
      setArrow(visual.acceleration, state.acceleration, this.options.accelerationScale);
    }
  }

  dispose(): void {
    disposeTree(this.root);
    this.visuals.clear();
    this.constraintObjects.clear();
  }
}

const scratch = new THREE.Vector3();

/**
 * Richtet einen Pfeil auf einen Vektor aus. Ein Pfeil der Laenge null wird
 * ausgeblendet statt auf eine Restlaenge gezwungen - sonst zeigt die Ansicht
 * eine Beschleunigung an, wo keine ist.
 */
function setArrow(arrow: THREE.ArrowHelper, vector: readonly number[], scale: number): void {
  scratch.set(vector[0]!, vector[1]!, vector[2]!);
  const magnitude = scratch.length();
  if (magnitude < 1e-9) {
    arrow.visible = false;
    return;
  }
  arrow.visible = true;
  arrow.setDirection(scratch.normalize());
  arrow.setLength(magnitude * scale, magnitude * scale * 0.25, magnitude * scale * 0.15);
}
