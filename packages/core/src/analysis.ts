import type { ConstraintSpec, MechanicalState, Recording, Shape, Vec3 } from "@sandbox/schema";
import { interventionsInOrder } from "@sandbox/schema";
import { v3dot, v3rotateByQuat, type V3 } from "./math/index.js";
import {
  constraintSegments,
  boxCornersLocal,
  LibraryIndex,
  resolveSegments,
  type ResolvedSegment,
} from "./state.js";

/**
 * Auswertung einer Aufzeichnung.
 *
 * Zwei Nutzer, ein Werkzeug: die Tests pruefen hiermit gegen analytische
 * Loesungen, und der Regisseur bekommt genau dieselben Funktionen als Werkzeug
 * `inspect_recording`. Ohne diesen Rueckkanal schreibt der Agent blind - er
 * koennte nicht feststellen, ob der Klotz die Flaeche ueberhaupt erreicht hat,
 * und nicht nachjustieren, wenn nichts Sichtbares passiert.
 */

export interface TrackSample {
  t: number;
  mechanics: MechanicalState;
}

/** Der Zustandsverlauf einer Entitaet, in Aufzeichnungsreihenfolge. */
export function entityTrack(recording: Recording, entityId: string): TrackSample[] {
  const samples: TrackSample[] = [];
  for (const snapshot of recording.snapshots) {
    const state = snapshot.entities[entityId];
    if (state?.mechanics) samples.push({ t: snapshot.t, mechanics: state.mechanics });
  }
  return samples;
}

function requireTrack(recording: Recording, entityId: string): TrackSample[] {
  const track = entityTrack(recording, entityId);
  if (track.length === 0) {
    const known = new Set<string>();
    for (const snapshot of recording.snapshots) {
      for (const id of Object.keys(snapshot.entities)) known.add(id);
    }
    throw new Error(
      `Entitaet "${entityId}" kommt in der Aufzeichnung nicht vor. Vorhanden: ` +
        `${[...known].join(", ") || "(keine)"}`,
    );
  }
  return track;
}

/** Der Zustand zum Aufzeichnungszeitpunkt, der `t` am naechsten liegt. */
export function sampleNearest(recording: Recording, entityId: string, t: number): TrackSample {
  const track = requireTrack(recording, entityId);
  let best = track[0]!;
  let bestDistance = Math.abs(best.t - t);
  for (const sample of track) {
    const distance = Math.abs(sample.t - t);
    if (distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
  }
  return best;
}

export function speedOf(mechanics: MechanicalState): number {
  return Math.sqrt(v3dot(mechanics.linearVelocity, mechanics.linearVelocity));
}

/**
 * Mittlere Beschleunigung laengs einer Richtung zwischen zwei Zeitpunkten.
 *
 * Bewusst als Differenzenquotient der Geschwindigkeit ueber eine lange Basis und
 * nicht als Mittel der aufgezeichneten `acceleration`-Werte: der
 * Differenzenquotient prueft, was tatsaechlich mit dem Zustand passiert ist -
 * einschliesslich der Kontaktimpulse, die die Kraftsumme gar nicht enthaelt.
 * Genau das soll der Test der schiefen Ebene messen.
 */
export function averageAccelerationAlong(
  recording: Recording,
  entityId: string,
  direction: Vec3,
  tFrom: number,
  tTo: number,
): number {
  const from = sampleNearest(recording, entityId, tFrom);
  const to = sampleNearest(recording, entityId, tTo);
  if (to.t === from.t) {
    throw new Error(
      `Beschleunigungsmessung braucht zwei verschiedene Zeitpunkte; beide lagen bei t=${from.t}. ` +
        `Liegt das Intervall [${tFrom}, ${tTo}] innerhalb eines Aufzeichnungsschritts?`,
    );
  }
  const length = Math.sqrt(v3dot(direction, direction));
  if (length === 0) throw new Error("Richtungsvektor darf nicht der Nullvektor sein.");
  const unit: V3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  const velocityFrom = v3dot(from.mechanics.linearVelocity, unit);
  const velocityTo = v3dot(to.mechanics.linearVelocity, unit);
  return (velocityTo - velocityFrom) / (to.t - from.t);
}

// ---------------------------------------------------------------- Durchdringung

/**
 * Alle Flaechensegmente des Szenarios in Weltkoordinaten, aus der Aufzeichnung
 * rekonstruiert.
 *
 * Grenze: Lage und Groesse der Randbedingungen werden aus ihrer Spec genommen.
 * Wird eine Randbedingung spaeter verschoben, gedreht oder in der Groesse
 * geaendert, waere das Ergebnis falsch - und ein still falscher Abstand ist schlimmer als eine Fehlermeldung. Deshalb
 * bricht die Funktion in diesem Fall ab, statt zu rechnen. Mitwandernde
 * Flaechen brauchen aufgezeichnete Randbedingungslagen; die gehoeren zum
 * Schema, wenn der Fall auftritt.
 */
export function resolveScenarioSegments(recording: Recording): ResolvedSegment[] {
  const library = new LibraryIndex(recording.scenario.library);
  const constraintSpecs = new Map<string, ConstraintSpec>();
  for (const entity of recording.scenario.entities) {
    if (entity.kind === "constraint") constraintSpecs.set(entity.id, entity);
  }
  const placedConstraints = new Set<string>();
  for (const intervention of interventionsInOrder(recording.scenario)) {
    if (intervention.op === "add" && constraintSpecs.has(intervention.entityId)) {
      placedConstraints.add(intervention.entityId);
    } else if (
      intervention.op === "change" &&
      placedConstraints.has(intervention.entityId) &&
      intervention.change.key !== "materialId" &&
      intervention.change.key !== "opacity"
    ) {
      throw new Error(
        `Randbedingung "${intervention.entityId}" wird bei t = ${intervention.t} s veraendert ` +
          `(${intervention.change.key}). ` +
          `Diese Auswertung kennt nur die Anfangslage und wuerde einen falschen Abstand ` +
          `melden. Dafuer muessten die Randbedingungslagen mit aufgezeichnet werden.`,
      );
    }
  }

  const segments: ResolvedSegment[] = [];
  // Eine Flaeche, die mehrmals hinzugefuegt wird, zaehlt einmal.
  for (const spec of constraintSpecs.values()) {
    if (!placedConstraints.has(spec.id)) continue;
    const constraint = library.constraint(spec.constraintId);
    if (constraint.behaviour.constraintType !== "staticSurface") continue;
    segments.push(
      ...resolveSegments(
        // Dieselbe Groessenregel wie im Simulator - sonst meldet der
        // Durchdringungsbericht Abstaende zu Flaechen, die es so nicht gibt.
        constraintSegments(constraint, spec, spec.id),
        [...spec.pose.position],
        [...spec.pose.orientation],
      ),
    );
  }
  return segments;
}

/** Die Pruefpunkte eines Koerpers in Weltkoordinaten zu einem Zeitpunkt. */
function worldPoints(shape: Shape, mechanics: MechanicalState): { point: V3; radius: number }[] {
  if (shape.type === "sphere") {
    return [{ point: [...mechanics.position], radius: shape.radius }];
  }
  return boxCornersLocal(shape).map((local) => {
    const point = v3rotateByQuat([0, 0, 0], local, mechanics.orientation);
    point[0] += mechanics.position[0];
    point[1] += mechanics.position[1];
    point[2] += mechanics.position[2];
    return { point, radius: 0 };
  });
}

export interface PenetrationReport {
  /** Kleinster vorzeichenbehafteter Abstand ueber den ganzen Lauf. Negativ = Durchdringung. */
  minSignedDistance: number;
  /** Zeitpunkt des Minimums. */
  tAtMinimum: number;
  /** Segment, an dem das Minimum auftrat. */
  segmentId: string | undefined;
}

/**
 * Kleinster vorzeichenbehafteter Abstand eines Koerpers zu allen Flaechen.
 *
 * Nur Punkte *innerhalb* der endlichen Plattenausdehnung zaehlen - ein Koerper,
 * der neben der Platte vorbeifaellt, ist nicht "durchgedrungen", sondern
 * daneben. Ein stark negativer Wert bedeutet Tunneln: der Koerper ist zwischen
 * zwei Zeitschritten durch die Flaeche hindurchgesprungen.
 */
export function penetrationReport(
  recording: Recording,
  entityId: string,
  shape: Shape,
): PenetrationReport {
  const segments = resolveScenarioSegments(recording);
  const track = requireTrack(recording, entityId);
  let minSignedDistance = Infinity;
  let tAtMinimum = Number.NaN;
  let segmentId: string | undefined;

  for (const sample of track) {
    for (const { point, radius } of worldPoints(shape, sample.mechanics)) {
      for (const segment of segments) {
        const dx = point[0] - segment.center[0];
        const dy = point[1] - segment.center[1];
        const dz = point[2] - segment.center[2];

        const alongU = dx * segment.tangent[0] + dy * segment.tangent[1] + dz * segment.tangent[2];
        if (Math.abs(alongU) > segment.halfExtentU) continue;
        const alongV =
          dx * segment.bitangent[0] + dy * segment.bitangent[1] + dz * segment.bitangent[2];
        if (Math.abs(alongV) > segment.halfExtentV) continue;

        const distance =
          dx * segment.normal[0] + dy * segment.normal[1] + dz * segment.normal[2] - radius;
        if (distance < minSignedDistance) {
          minSignedDistance = distance;
          tAtMinimum = sample.t;
          segmentId = segment.id;
        }
      }
    }
  }
  return { minSignedDistance, tAtMinimum, segmentId };
}

// ---------------------------------------------------------------- Zusammenfassung

export interface EntitySummary {
  entityId: string;
  tFirst: number;
  tLast: number;
  sampleCount: number;
  startPosition: Vec3;
  endPosition: Vec3;
  /** Zurueckgelegte Strecke entlang der Bahn, Meter. */
  pathLength: number;
  maxSpeed: number;
  tAtMaxSpeed: number;
  endSpeed: number;
  /** Zeitintervalle, in denen mindestens ein Kontakt bestand. */
  contactIntervals: { from: number; to: number }[];
}

/**
 * Kompakte Zusammenfassung des Verlaufs einer Entitaet.
 *
 * Das ist die Form, in der der Regisseur eine Aufzeichnung liest: wenige Zahlen
 * statt hunderter Schnappschuesse. Ein Agent, der den vollen Verlauf ins
 * Kontextfenster bekommt, verbraucht ihn mit Zahlenkolonnen - und braeuchte sie
 * nicht, um zu entscheiden, ob ein Eingriff zu frueh liegt.
 */
export function summarizeEntity(recording: Recording, entityId: string): EntitySummary {
  const track = requireTrack(recording, entityId);
  const first = track[0]!;
  const last = track[track.length - 1]!;

  let pathLength = 0;
  let maxSpeed = 0;
  let tAtMaxSpeed = first.t;
  const contactIntervals: { from: number; to: number }[] = [];
  let openInterval: { from: number; to: number } | undefined;

  for (let i = 0; i < track.length; i += 1) {
    const sample = track[i]!;
    if (i > 0) {
      const previous = track[i - 1]!.mechanics.position;
      const current = sample.mechanics.position;
      pathLength += Math.sqrt(
        (current[0] - previous[0]) ** 2 +
          (current[1] - previous[1]) ** 2 +
          (current[2] - previous[2]) ** 2,
      );
    }
    const speed = speedOf(sample.mechanics);
    if (speed > maxSpeed) {
      maxSpeed = speed;
      tAtMaxSpeed = sample.t;
    }
    if (sample.mechanics.contactCount > 0) {
      if (openInterval) openInterval.to = sample.t;
      else openInterval = { from: sample.t, to: sample.t };
    } else if (openInterval) {
      contactIntervals.push(openInterval);
      openInterval = undefined;
    }
  }
  if (openInterval) contactIntervals.push(openInterval);

  return {
    entityId,
    tFirst: first.t,
    tLast: last.t,
    sampleCount: track.length,
    startPosition: [...first.mechanics.position],
    endPosition: [...last.mechanics.position],
    pathLength,
    maxSpeed,
    tAtMaxSpeed,
    endSpeed: speedOf(last.mechanics),
    contactIntervals,
  };
}
