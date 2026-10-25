import type {
  Constraint,
  Environment,
  LibraryEntry,
  Load,
  Shape,
  Material,
  SurfaceSegment,
} from "@sandbox/schema";
import { shapeVolume } from "@sandbox/schema";
import {
  m3diagonal,
  q4copy,
  v3copy,
  v3cross,
  v3normalize,
  v3rotateByQuat,
  v3scale,
  v3set,
  type M3,
  type Q4,
  type V3,
} from "./math/index.js";

/**
 * Laufzeitzustand der Simulation.
 *
 * Der Zustand ist nach Physikmodul partitioniert: `mechanics` existiert jetzt,
 * `thermal` und `chemical` kommen mit ihren Modulen hinzu. Jedes Modul besitzt
 * seinen Abschnitt exklusiv - so kann Thermodynamik spaeter ein Temperaturfeld
 * ergaenzen, ohne eine Zeile Mechanik anzufassen.
 *
 * Alle Felder sind veraenderbar und werden in-place aktualisiert. Das ist im
 * Kern bewusst so: bei 1 ms Schrittweite entstehen sonst Millionen kurzlebiger
 * Objekte pro simulierter Sekunde.
 */

/** Ein Flaechensegment in Weltkoordinaten, mit vorberechneter zweiter Tangente. */
export interface ResolvedSegment {
  id: string;
  center: V3;
  normal: V3;
  tangent: V3;
  /** normal x tangent - vorberechnet, weil sie in jedem Kontakttest gebraucht wird. */
  bitangent: V3;
  halfExtentU: number;
  halfExtentV: number;
  thickness: number;
}

/** Mechanischer Zustand eines Koerpers. */
export interface MechanicalEntityState {
  position: V3;
  orientation: Q4;
  linearVelocity: V3;
  /**
   * Drehimpuls im Weltsystem.
   *
   * Gefuehrt wird L, nicht omega: ohne Drehmoment ist `L += 0` und der
   * Drehimpuls bleibt damit auf Bitgenauigkeit erhalten. Wuerde omega
   * integriert, muesste bei einem unsymmetrischen Koerper in jedem Schritt der
   * Kreiselterm omega x (I omega) mitgerechnet werden - mit Rundungsfehlern,
   * die sich aufsummieren und die Drehimpulserhaltung aufweichen.
   */
  angularMomentum: V3;
  /**
   * Aus L und der aktuellen Lage abgeleitet. Nur fuer Ausgabe und Integration.
   *
   * Nie direkt zuweisen: der naechste `refreshDerivedState` ueberschreibt den
   * Wert aus dem Drehimpuls. Eine Winkelgeschwindigkeit setzt man mit
   * `setAngularVelocity(body, omega)` - das rechnet L mit.
   */
  angularVelocity: V3;

  // Akkumulatoren, die jeder Zeitschritt neu fuellt
  force: V3;
  torque: V3;
  acceleration: V3;
  contactCount: number;
}

/**
 * Was ein Kontakt vom Material eines Beteiligten braucht. Verrechnet wird je
 * Paarung im Mechanik-Modul (`pairRestitution`, `pairFriction`); hier steht
 * nur der Wert des einen Materials, aufgeloest von `contactProperties` in
 * simulate.ts - ein fehlender Reibwert ist dort schon 0.
 */
export interface ContactProperties {
  restitution: number;
  /** Haftreibungszahl. */
  staticFriction: number;
  /** Gleitreibungszahl. */
  kineticFriction: number;
  /** Hebelarm der Rollreibung in Metern. */
  rollingFriction: number;
}

export interface RuntimeBody extends ContactProperties {
  kind: "body";
  id: string;
  name: string;
  materialId: string;
  material: Material;
  shape: Shape;
  /** Grosste halbe Ausdehnung - Abschaetzung fuer Kontakttoleranzen. */
  boundingRadius: number;
  mass: number;
  /** 0 bei festgehaltenen Koerpern: Kraefte bewegen sie nicht. */
  inverseMass: number;
  inertiaBody: M3;
  inverseInertiaBody: M3;
  kinematic: boolean;
  mechanics: MechanicalEntityState;
}

export interface RuntimeSurface extends ContactProperties {
  kind: "surface";
  id: string;
  name: string;
  constraintId: string;
  constraint: Constraint;
  /** In Weltkoordinaten aufgeloeste Segmente. Bei `move` neu berechnet. */
  segments: ResolvedSegment[];
  /** Ungeloeste Segmente plus Lage, damit `move` ohne Bibliothek auskommt. */
  localSegments: SurfaceSegment[];
  position: V3;
  orientation: Q4;
  materialId: string;
  /** Liefert auch Stosszahl und Reibwerte - aus dem Material der Ebene, nicht aus dem Bibliothekseintrag. */
  material: Material;
}

/**
 * Eine platzierte Last. Anders als Koerper und Flaechen hat sie keine Lage -
 * `gravity` ist bereits Richtung (normiert) mal Staerke und direkt als
 * Kraftbeitrag nutzbar, wenn `load.behaviour.loadType === "gravity"` ist.
 */
export interface RuntimeLoad {
  kind: "load";
  id: string;
  name: string;
  loadId: string;
  load: Load;
  magnitude: number;
  direction: V3;
  gravity: V3;
}

export type RuntimeEntity = RuntimeBody | RuntimeSurface | RuntimeLoad;

export interface SimState {
  /**
   * Simulierte Zeit in Sekunden.
   *
   * Nur `Simulator.step` schreibt sie, und zwar als `steps * dt` - nicht
   * `t += dt`. Siehe den Kommentar an `Simulator.steps`. Das ist *nicht* die
   * Abspielzeit der Oberflaeche; die lebt im `Playhead` in
   * packages/render/src/playback.ts.
   */
  t: number;
  environment: Environment;
  /**
   * Einfuegereihenfolge ist die Iterationsreihenfolge. JS-Maps garantieren das
   * laut Spezifikation - eine Voraussetzung fuer Determinismus, denn die
   * Reihenfolge, in der Kontakte aufgeloest werden, beeinflusst das Ergebnis.
   */
  entities: Map<string, RuntimeEntity>;
}

export function createState(environment: Environment): SimState {
  return { t: 0, environment: structuredClone(environment), entities: new Map() };
}

export function bodies(state: SimState): RuntimeBody[] {
  const result: RuntimeBody[] = [];
  for (const entity of state.entities.values()) {
    if (entity.kind === "body") result.push(entity);
  }
  return result;
}

export function surfaces(state: SimState): RuntimeSurface[] {
  const result: RuntimeSurface[] = [];
  for (const entity of state.entities.values()) {
    if (entity.kind === "surface") result.push(entity);
  }
  return result;
}

// ---------------------------------------------------------------- Traegheit

/**
 * Traegheitstensor im Koerpersystem.
 *
 * Fuer den achsenparallelen Block ist er diagonal: I_xx = m/3 * (hy^2 + hz^2)
 * mit den *halben* Kantenlaengen h. Das ist die uebliche Formel
 * m/12 * (b^2 + c^2) fuer die vollen Kantenlaengen b = 2*hy, c = 2*hz.
 */
export function inertiaTensorFor(shape: Shape, mass: number): M3 {
  if (shape.type === "box") {
    const [hx, hy, hz] = shape.halfExtents;
    const factor = mass / 3;
    return m3diagonal(
      factor * (hy * hy + hz * hz),
      factor * (hx * hx + hz * hz),
      factor * (hx * hx + hy * hy),
    );
  }
  const value = 0.4 * mass * shape.radius * shape.radius;
  return m3diagonal(value, value, value);
}

export function invertDiagonal(tensor: M3): M3 {
  const inverse = (value: number): number => (value === 0 ? 0 : 1 / value);
  return m3diagonal(inverse(tensor[0]), inverse(tensor[4]), inverse(tensor[8]));
}

export function boundingRadiusFor(shape: Shape): number {
  if (shape.type === "box") {
    const [hx, hy, hz] = shape.halfExtents;
    return Math.sqrt(hx * hx + hy * hy + hz * hz);
  }
  return shape.radius;
}

/** Die acht Eckpunkte eines Blocks im Koerpersystem. */
export function boxCornersLocal(shape: Extract<Shape, { type: "box" }>): V3[] {
  const [hx, hy, hz] = shape.halfExtents;
  const corners: V3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push([sx * hx, sy * hy, sz * hz]);
      }
    }
  }
  return corners;
}

// ---------------------------------------------------------------- Aufbau

/**
 * Loest Flaechensegmente in Weltkoordinaten auf.
 *
 * Die Segmente der Bibliothek stehen im Koerpersystem der Randbedingung; die
 * Lage der platzierten Instanz verschiebt und dreht sie. Aufgeloest wird beim
 * Hinzufuegen und bei `move` - nicht in jedem Zeitschritt, denn die Flaechen
 * sind unbeweglich.
 */
export function resolveSegments(
  localSegments: readonly SurfaceSegment[],
  position: V3,
  orientation: Q4,
): ResolvedSegment[] {
  return localSegments.map((segment) => {
    const center = v3rotateByQuat([0, 0, 0], segment.center, orientation);
    center[0] += position[0];
    center[1] += position[1];
    center[2] += position[2];
    const normal = v3rotateByQuat([0, 0, 0], segment.normal, orientation);
    const tangent = v3rotateByQuat([0, 0, 0], segment.tangent, orientation);
    const bitangent = v3cross([0, 0, 0], normal, tangent);
    return {
      id: segment.id,
      center,
      normal,
      tangent,
      bitangent,
      halfExtentU: segment.halfExtentU,
      halfExtentV: segment.halfExtentV,
      thickness: segment.thickness,
    };
  });
}

/**
 * Die Segmente einer Randbedingung im Koerpersystem, mit der instanzeigenen
 * Groesse.
 *
 * Eine Stelle fuer die Regel, damit Simulator und Auswertung nicht
 * auseinanderlaufen: rechnete die Auswertung mit der Bibliotheksgroesse,
 * waehrend der Simulator die Instanzgroesse nimmt, wuerde der
 * Durchdringungsbericht still falsche Abstaende melden.
 */
export function constraintSegments(
  constraint: Constraint,
  instance: { size?: readonly [number, number]; thickness?: number },
  entityId: string,
): SurfaceSegment[] {
  const { size, thickness } = instance;
  if (constraint.behaviour.constraintType !== "staticSurface") {
    throw new Error(
      `Randbedingung "${constraint.id}" ist vom Typ "${constraint.behaviour.constraintType}". ` +
        `Stufe 1 kennt nur "staticSurface".`,
    );
  }
  const segments = constraint.behaviour.segments;
  if (!size && thickness === undefined) return [...segments];
  if (segments.length !== 1) {
    throw new Error(
      `"${entityId}" gibt eine Groesse an, "${constraint.id}" hat aber ${segments.length} ` +
        `Segmente. Eine instanzeigene Groesse gilt nur fuer Flaechen mit genau einem Segment.`,
    );
  }
  const base = segments[0]!;
  return [
    {
      ...base,
      halfExtentU: size ? size[0] : base.halfExtentU,
      halfExtentV: size ? size[1] : base.halfExtentV,
      thickness: thickness ?? base.thickness,
    },
  ];
}

export class LibraryIndex {
  private readonly materials = new Map<string, Material>();
  private readonly constraints = new Map<string, Constraint>();
  private readonly loads = new Map<string, Load>();

  constructor(entries: readonly LibraryEntry[]) {
    for (const entry of entries) {
      if (entry.definition.kind === "material") {
        this.materials.set(entry.definition.id, entry.definition);
      } else if (entry.definition.kind === "constraint") {
        this.constraints.set(entry.definition.id, entry.definition);
      } else if (entry.definition.kind === "load") {
        this.loads.set(entry.definition.id, entry.definition);
      }
      // Koerper-Eintraege braucht der Kern nicht: die wirksame Form steht an
      // der Instanz (`BodySpec.phase.shape`), der Eintrag liefert nur die
      // Voreinstellung beim Platzieren.
    }
  }

  material(id: string): Material {
    const found = this.materials.get(id);
    if (!found) {
      throw new Error(
        `Material "${id}" ist nicht in der Bibliothek des Szenarios. Ein Szenario traegt ` +
          `seine Eintraege selbst, damit es ohne weitere Abfragen abspielbar ist.`,
      );
    }
    return found;
  }

  constraint(id: string): Constraint {
    const found = this.constraints.get(id);
    if (!found) {
      throw new Error(`Randbedingung "${id}" ist nicht in der Bibliothek des Szenarios.`);
    }
    return found;
  }

  load(id: string): Load {
    const found = this.loads.get(id);
    if (!found) {
      throw new Error(`Last "${id}" ist nicht in der Bibliothek des Szenarios.`);
    }
    return found;
  }
}

/**
 * Richtung (normiert) mal Staerke - direkt als Kraftbeitrag nutzbar.
 *
 * Normiert statt eine normierte Richtung zu verlangen: ein Eingabefeld, das
 * drei Zahlen einzeln uebernimmt, liefert fast nie exakt die Laenge 1. Beim
 * Nullvektor bleibt das Ergebnis der Nullvektor - konsistent mit Staerke 0.
 */
export function resolveGravity(direction: V3, magnitude: number): V3 {
  const normalized = v3normalize(v3copy(direction));
  return v3scale(normalized, normalized, magnitude);
}

export function makeMechanicalState(position: V3, orientation: Q4): MechanicalEntityState {
  return {
    position: v3copy(position),
    orientation: q4copy(orientation),
    linearVelocity: v3set([0, 0, 0], 0, 0, 0),
    angularMomentum: v3set([0, 0, 0], 0, 0, 0),
    angularVelocity: v3set([0, 0, 0], 0, 0, 0),
    force: v3set([0, 0, 0], 0, 0, 0),
    torque: v3set([0, 0, 0], 0, 0, 0),
    acceleration: v3set([0, 0, 0], 0, 0, 0),
    contactCount: 0,
  };
}
