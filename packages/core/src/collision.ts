import type { RuntimeBody } from "./state.js";
import { m3fromQuat, v3dot, v3normalize, v3set, type M3, type V3 } from "./math/index.js";

/**
 * Ueberlappung zweier Koerper: Kontaktnormale und Eindringtiefe.
 *
 * Nur Geometrie, keine Physik - was mit der Ueberlappung geschieht (Impuls,
 * Lagekorrektur), entscheidet das Mechanik-Modul. Determinismusregel wie im
 * ganzen Kern: nur + - * / und sqrt.
 *
 * Es gibt bewusst *keinen Kontaktpunkt*. Der Impuls greift wie bei der Flaeche
 * am Schwerpunkt an und erzeugt kein Drehmoment (Stufe 1, siehe
 * Architektur -> Kontakte); ein Punkt braeuchte erst der Loeser der Stufe 1b.
 */
export interface Overlap {
  /** Einheitsvektor, zeigt von Koerper a zu Koerper b. */
  normal: V3;
  /** Eindringtiefe entlang der Normale, positiv. */
  depth: number;
}

export function createOverlap(): Overlap {
  return { normal: [0, 0, 0], depth: 0 };
}

/**
 * Kante-Kante-Achsen, deren Laenge darunter liegt, gelten als parallele Kanten:
 * das Kreuzprodukt ist dann Rauschen, keine Trennachse.
 */
const PARALLEL_EPSILON = 1e-9;

/**
 * Eine Kante-Kante-Achse gewinnt nur, wenn sie die Eindringtiefe um mehr als
 * diesen Faktor verkleinert. Ohne den Vorrang der Flaechenachsen wechselte die
 * Normale bei fast paralleler Lage von Schritt zu Schritt zwischen zwei
 * gleichwertigen Achsen, und ein aufliegender Koerper zitterte.
 */
const EDGE_AXIS_PREFERENCE = 0.95;

// Arbeitsspeicher, dieselbe Begruendung wie in mechanics.ts: der Test laeuft fuer
// jedes Koerperpaar in jedem Zeitschritt.
const rotationA: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const rotationB: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const axesA: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const axesB: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const axisScratch: V3 = [0, 0, 0];
const nearestScratch: V3 = [0, 0, 0];
const centreOffset: V3 = [0, 0, 0];
const localPoint: V3 = [0, 0, 0];

/** Bisher kleinste Ueberlappung je Achsenart, fuer `considerAxis`. */
const best = { faceDepth: 0, edgeDepth: 0, faceNormal: [0, 0, 0] as V3, edgeNormal: [0, 0, 0] as V3 };

/** Die drei Koerperachsen im Weltsystem: Spalten der Rotationsmatrix. */
function worldAxes(body: RuntimeBody, matrix: M3, out: V3[]): void {
  m3fromQuat(matrix, body.mechanics.orientation);
  for (let i = 0; i < 3; i += 1) v3set(out[i]!, matrix[i]!, matrix[3 + i]!, matrix[6 + i]!);
}

function halfExtentsOf(body: RuntimeBody): readonly [number, number, number] {
  if (body.shape.type !== "box") throw new Error(`Koerper "${body.id}" ist kein Quader.`);
  return body.shape.halfExtents;
}

/**
 * Prueft zwei Koerper auf Ueberlappung und fuellt `out`, falls sie sich
 * durchdringen. `out.normal` zeigt von `a` nach `b`.
 */
export function overlapBodies(a: RuntimeBody, b: RuntimeBody, out: Overlap): boolean {
  const aSphere = a.shape.type === "sphere";
  const bSphere = b.shape.type === "sphere";
  if (aSphere && bSphere) return overlapSpheres(a, b, out);
  if (aSphere) return overlapSphereBox(a, b, out, false);
  if (bSphere) return overlapSphereBox(b, a, out, true);
  return overlapBoxes(a, b, out);
}

function overlapSpheres(a: RuntimeBody, b: RuntimeBody, out: Overlap): boolean {
  if (a.shape.type !== "sphere" || b.shape.type !== "sphere") return false;
  const pa = a.mechanics.position;
  const pb = b.mechanics.position;
  v3set(centreOffset, pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
  const reach = a.shape.radius + b.shape.radius;
  const distanceSquared = v3dot(centreOffset, centreOffset);
  if (distanceSquared >= reach * reach) return false;

  const distance = Math.sqrt(distanceSquared);
  if (distance === 0) {
    // Deckungsgleiche Mittelpunkte haben keine Richtung; irgendeine feste, damit
    // der Lauf deterministisch bleibt.
    v3set(out.normal, 0, 0, 1);
  } else {
    v3set(out.normal, centreOffset[0] / distance, centreOffset[1] / distance, centreOffset[2] / distance);
  }
  out.depth = reach - distance;
  return true;
}

/**
 * Kugel gegen Quader: der Quaderpunkt, der dem Kugelmittelpunkt am naechsten
 * liegt, entscheidet. `boxFirst` heisst: der Quader ist Koerper a des Paars,
 * die Normale muss also vom Quader zur Kugel zeigen.
 */
function overlapSphereBox(sphere: RuntimeBody, box: RuntimeBody, out: Overlap, boxFirst: boolean): boolean {
  if (sphere.shape.type !== "sphere") return false;
  const radius = sphere.shape.radius;
  const half = halfExtentsOf(box);
  worldAxes(box, rotationA, axesA);

  const ps = sphere.mechanics.position;
  const pb = box.mechanics.position;
  v3set(centreOffset, ps[0] - pb[0], ps[1] - pb[1], ps[2] - pb[2]);
  // Mittelpunkt im Quadersystem.
  v3set(
    localPoint,
    v3dot(centreOffset, axesA[0]!),
    v3dot(centreOffset, axesA[1]!),
    v3dot(centreOffset, axesA[2]!),
  );

  let outsideSquared = 0;
  const nearest = nearestScratch;
  v3set(nearest, 0, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const h = half[i]!;
    const value = localPoint[i]!;
    const clamped = value > h ? h : value < -h ? -h : value;
    nearest[i] = value - clamped;
    outsideSquared += nearest[i]! * nearest[i]!;
  }

  // Normale vom Quader zur Kugel, zuerst im Quadersystem.
  let depth: number;
  if (outsideSquared > 0) {
    if (outsideSquared >= radius * radius) return false;
    const distance = Math.sqrt(outsideSquared);
    for (let i = 0; i < 3; i += 1) nearest[i] = nearest[i]! / distance;
    depth = radius - distance;
  } else {
    // Mittelpunkt im Inneren: durch die naechste Flaeche hinaus.
    let axis = 0;
    let smallest = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const room = half[i]! - Math.abs(localPoint[i]!);
      if (room < smallest) {
        smallest = room;
        axis = i;
      }
    }
    v3set(nearest, 0, 0, 0);
    nearest[axis] = localPoint[axis]! < 0 ? -1 : 1;
    depth = smallest + radius;
  }

  const sign = boxFirst ? 1 : -1;
  v3set(
    out.normal,
    sign * (axesA[0]![0]! * nearest[0]! + axesA[1]![0]! * nearest[1]! + axesA[2]![0]! * nearest[2]!),
    sign * (axesA[0]![1]! * nearest[0]! + axesA[1]![1]! * nearest[1]! + axesA[2]![1]! * nearest[2]!),
    sign * (axesA[0]![2]! * nearest[0]! + axesA[1]![2]! * nearest[1]! + axesA[2]![2]! * nearest[2]!),
  );
  out.depth = depth;
  return true;
}

/**
 * Quader gegen Quader nach dem Satz der Trennachsen: zwei konvexe Koerper
 * ueberlappen genau dann, wenn auf *keiner* der 15 Kandidatenachsen (je drei
 * Flaechennormalen, dazu neun Kreuzprodukte der Kanten) eine Luecke zwischen
 * ihren Projektionen liegt. Die Achse mit der kleinsten Ueberlappung ist der
 * kuerzeste Weg, die Koerper auseinanderzuschieben.
 */
/**
 * Ueberlappung zweier Quader auf einer normierten Achse; haelt die kleinste je
 * Achsenart in `best` fest. `false` heisst: auf dieser Achse liegt eine Luecke,
 * die Koerper beruehren sich nicht.
 */
function considerAxis(
  hA: readonly number[],
  hB: readonly number[],
  axis: V3,
  isEdge: boolean,
): boolean {
  let reachA = 0;
  let reachB = 0;
  for (let i = 0; i < 3; i += 1) {
    reachA += hA[i]! * Math.abs(v3dot(axesA[i]!, axis));
    reachB += hB[i]! * Math.abs(v3dot(axesB[i]!, axis));
  }
  const along = v3dot(centreOffset, axis);
  const depth = reachA + reachB - Math.abs(along);
  if (depth <= 0) return false;

  if (depth < (isEdge ? best.edgeDepth : best.faceDepth)) {
    // Die Normale zeigt von a nach b, egal wie die Achse gerichtet war.
    const sign = along < 0 ? -1 : 1;
    const target = isEdge ? best.edgeNormal : best.faceNormal;
    v3set(target, sign * axis[0], sign * axis[1], sign * axis[2]);
    if (isEdge) best.edgeDepth = depth;
    else best.faceDepth = depth;
  }
  return true;
}

/**
 * Quader gegen Quader nach dem Satz der Trennachsen: zwei konvexe Koerper
 * ueberlappen genau dann, wenn auf *keiner* der 15 Kandidatenachsen (je drei
 * Flaechennormalen, dazu neun Kreuzprodukte der Kanten) eine Luecke zwischen
 * ihren Projektionen liegt. Die Achse mit der kleinsten Ueberlappung ist der
 * kuerzeste Weg, die Koerper auseinanderzuschieben.
 */
function overlapBoxes(a: RuntimeBody, b: RuntimeBody, out: Overlap): boolean {
  const hA = halfExtentsOf(a);
  const hB = halfExtentsOf(b);
  worldAxes(a, rotationA, axesA);
  worldAxes(b, rotationB, axesB);

  const pa = a.mechanics.position;
  const pb = b.mechanics.position;
  v3set(centreOffset, pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);

  best.faceDepth = Infinity;
  best.edgeDepth = Infinity;

  for (let i = 0; i < 3; i += 1) {
    if (!considerAxis(hA, hB, axesA[i]!, false)) return false;
    if (!considerAxis(hA, hB, axesB[i]!, false)) return false;
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const u = axesA[i]!;
      const v = axesB[j]!;
      v3set(
        axisScratch,
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      );
      if (v3dot(axisScratch, axisScratch) < PARALLEL_EPSILON) continue;
      v3normalize(axisScratch);
      if (!considerAxis(hA, hB, axisScratch, true)) return false;
    }
  }

  const useEdge = best.edgeDepth < best.faceDepth * EDGE_AXIS_PREFERENCE;
  const normal = useEdge ? best.edgeNormal : best.faceNormal;
  v3set(out.normal, normal[0], normal[1], normal[2]);
  out.depth = useEdge ? best.edgeDepth : best.faceDepth;
  return true;
}
