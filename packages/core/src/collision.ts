import type { ResolvedSegment, RuntimeBody } from "./state.js";
import { m3fromQuat, v3dot, v3normalize, v3set, type M3, type V3 } from "./math/index.js";

/**
 * Ueberlappung zweier Koerper oder eines Koerpers mit einer Flaeche:
 * Kontaktnormale, Eindringtiefe und die Kontaktpunkte.
 *
 * Nur Geometrie, keine Physik - was mit der Ueberlappung geschieht (Impuls,
 * Lagekorrektur), entscheidet das Mechanik-Modul. Determinismusregel wie im
 * ganzen Kern: nur + - * / und sqrt.
 *
 * Die Punkte sind die Ecken der Kontaktflaeche, nicht ihr Mittelpunkt. Wo die
 * Kontaktkraft angreift (der Druckmittelpunkt), ist eine Frage der Dynamik und
 * nicht der Geometrie: ein Quader, der flach aufliegt, wird ueber die ganze
 * Flaeche getragen, einer, der gerade ueber eine Kante kippt, nur noch an
 * dieser Kante - bei derselben Kontaktflaeche. Der Kontaktloeser verteilt den
 * Impuls deshalb selbst auf die Ecken.
 */
export interface Overlap {
  /** Einheitsvektor, zeigt von Koerper a (bzw. der Flaeche) zu Koerper b. */
  normal: V3;
  /** Eindringtiefe entlang der Normale, positiv - der Weg, um den die Lagekorrektur trennt. */
  depth: number;
  /** Kontaktpunkte in Weltkoordinaten; gueltig sind die ersten `count`. */
  points: V3[];
  /** Eindringtiefe je Punkt entlang der Normale. */
  depths: number[];
  count: number;
}

/**
 * Hoechstzahl der Kontaktpunkte: ein Viereck, an den vier Seiten eines
 * Rechtecks beschnitten, hat hoechstens acht Ecken.
 */
export const MAX_CONTACT_POINTS = 8;

export function createOverlap(): Overlap {
  return {
    normal: [0, 0, 0],
    depth: 0,
    points: Array.from({ length: MAX_CONTACT_POINTS }, (): V3 => [0, 0, 0]),
    depths: new Array<number>(MAX_CONTACT_POINTS).fill(0),
    count: 0,
  };
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

/**
 * Ein Quader in Weltkoordinaten: Mittelpunkt, Achsen (Einheitsvektoren) und
 * halbe Kantenlaengen. Koerper und Platten werden fuer den Test in diese Form
 * gebracht, damit Koerper gegen Koerper und Koerper gegen Flaeche dieselbe
 * Rechnung sind.
 */
interface BoxFrame {
  center: V3;
  axes: V3[];
  half: number[];
}

function createBoxFrame(): BoxFrame {
  return { center: [0, 0, 0], axes: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], half: [0, 0, 0] };
}

// Arbeitsspeicher, dieselbe Begruendung wie in mechanics.ts: der Test laeuft fuer
// jedes Koerperpaar und jede Flaeche in jedem Zeitschritt.
const rotationScratch: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const boxA = createBoxFrame();
const boxB = createBoxFrame();
const axisScratch: V3 = [0, 0, 0];
const nearestScratch: V3 = [0, 0, 0];
const centreOffset: V3 = [0, 0, 0];
const localPoint: V3 = [0, 0, 0];
const edgePointA: V3 = [0, 0, 0];
const edgePointB: V3 = [0, 0, 0];

/** Bisher kleinste Ueberlappung je Achsenart, fuer `considerAxis`. */
const best = {
  faceDepth: 0,
  edgeDepth: 0,
  faceNormal: [0, 0, 0] as V3,
  edgeNormal: [0, 0, 0] as V3,
  /** Zu welchem Quader die beste Flaechenachse gehoert. */
  faceOwner: boxA,
  faceAxis: 0,
  edgeAxisA: 0,
  edgeAxisB: 0,
};

/**
 * Ein Rechteck, an dem eine Quaderflaeche beschnitten wird: die Bezugsflaeche
 * des anderen Quaders. `normal` zeigt zum beschnittenen Quader hin.
 */
const referenceRect = {
  center: [0, 0, 0] as V3,
  normal: [0, 0, 0] as V3,
  tangent: [0, 0, 0] as V3,
  bitangent: [0, 0, 0] as V3,
  halfExtentU: 0,
  halfExtentV: 0,
};

// Zwei Puffer fuer das Beschneiden nach Sutherland-Hodgman: jede der vier
// Schnittebenen kann eine Ecke hinzufuegen, also hoechstens acht.
const clipBufferA: V3[] = Array.from({ length: MAX_CONTACT_POINTS }, (): V3 => [0, 0, 0]);
const clipBufferB: V3[] = Array.from({ length: MAX_CONTACT_POINTS }, (): V3 => [0, 0, 0]);
const negatedDirection: V3 = [0, 0, 0];

/** Ein Quader-Koerper als BoxFrame; die Achsen sind die Spalten der Rotationsmatrix. */
function loadBody(body: RuntimeBody, out: BoxFrame): BoxFrame {
  if (body.shape.type !== "box") throw new Error(`Koerper "${body.id}" ist kein Quader.`);
  const p = body.mechanics.position;
  v3set(out.center, p[0], p[1], p[2]);
  m3fromQuat(rotationScratch, body.mechanics.orientation);
  for (let i = 0; i < 3; i += 1) {
    v3set(out.axes[i]!, rotationScratch[i]!, rotationScratch[3 + i]!, rotationScratch[6 + i]!);
    out.half[i] = body.shape.halfExtents[i]!;
  }
  return out;
}

/**
 * Ein Flaechensegment als flache Platte: die Oberseite liegt im Segment, die
 * Dicke reicht entgegen der Normale nach unten - so, wie die Darstellung sie
 * zeichnet. Achse 2 ist die Normale.
 */
function loadSegment(segment: ResolvedSegment, out: BoxFrame): BoxFrame {
  const n = segment.normal;
  const halfThickness = segment.thickness / 2;
  v3set(
    out.center,
    segment.center[0] - halfThickness * n[0],
    segment.center[1] - halfThickness * n[1],
    segment.center[2] - halfThickness * n[2],
  );
  v3set(out.axes[0]!, segment.tangent[0], segment.tangent[1], segment.tangent[2]);
  v3set(out.axes[1]!, segment.bitangent[0], segment.bitangent[1], segment.bitangent[2]);
  v3set(out.axes[2]!, n[0], n[1], n[2]);
  out.half[0] = segment.halfExtentU;
  out.half[1] = segment.halfExtentV;
  out.half[2] = halfThickness;
  return out;
}

/** Vorzeichen mit festem Ergebnis bei 0, damit der Lauf deterministisch bleibt. */
function signOf(value: number): number {
  return value < 0 ? -1 : 1;
}

function clamp(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}

function addPoint(out: Overlap, point: readonly number[], depth: number): void {
  if (out.count >= MAX_CONTACT_POINTS) return;
  v3set(out.points[out.count]!, point[0]!, point[1]!, point[2]!);
  out.depths[out.count] = depth;
  out.count += 1;
}

/**
 * Beschneidet ein Polygon an der Halbebene `direction . (p - center) <= limit`
 * (Sutherland-Hodgman). Gibt die neue Eckenzahl zurueck.
 */
function clipAgainst(
  input: V3[],
  count: number,
  output: V3[],
  center: V3,
  direction: V3,
  limit: number,
): number {
  let written = 0;
  for (let i = 0; i < count; i += 1) {
    const current = input[i]!;
    const next = input[(i + 1) % count]!;
    const distCurrent =
      (current[0] - center[0]) * direction[0] +
      (current[1] - center[1]) * direction[1] +
      (current[2] - center[2]) * direction[2] -
      limit;
    const distNext =
      (next[0] - center[0]) * direction[0] +
      (next[1] - center[1]) * direction[1] +
      (next[2] - center[2]) * direction[2] -
      limit;
    if (distCurrent <= 0 && written < MAX_CONTACT_POINTS) {
      v3set(output[written]!, current[0], current[1], current[2]);
      written += 1;
    }
    const crosses = (distCurrent < 0 && distNext > 0) || (distCurrent > 0 && distNext < 0);
    if (crosses && written < MAX_CONTACT_POINTS) {
      const s = distCurrent / (distCurrent - distNext);
      v3set(
        output[written]!,
        current[0] + s * (next[0] - current[0]),
        current[1] + s * (next[1] - current[1]),
        current[2] + s * (next[2] - current[2]),
      );
      written += 1;
    }
  }
  return written;
}

/** Beschneidet an beiden Seiten eines Streifens |direction . (p - center)| <= limit; Ergebnis in `input`. */
function clipAgainstSlab(
  input: V3[],
  count: number,
  scratch: V3[],
  center: V3,
  direction: V3,
  limit: number,
): number {
  const half = clipAgainst(input, count, scratch, center, direction, limit);
  v3set(negatedDirection, -direction[0], -direction[1], -direction[2]);
  return clipAgainst(scratch, half, input, center, negatedDirection, limit);
}

/**
 * Kontaktflaeche eines Quaders mit der Bezugsflaeche `referenceRect`.
 *
 * Die Flaeche des Quaders, die der Bezugsflaeche am staerksten zugewandt ist
 * (die einfallende Flaeche), wird an deren vier Seiten beschnitten; jede
 * verbleibende Ecke hinter der Bezugsebene ist ein Kontaktpunkt. Liegt ein
 * Quader flach auf, sind das die vier Ecken der Auflageflaeche - oder, wenn er
 * ueber einen Rand ragt, die Ecken des Teils, der noch aufliegt. Steht er auf
 * einer Kante, bleiben deren zwei Endpunkte, auf einer Ecke nur diese.
 */
function clipIncidentFace(box: BoxFrame, out: Overlap): void {
  const rect = referenceRect;
  const n = rect.normal;
  const axes = box.axes;
  const half = box.half;

  // Einfallende Flaeche: Aussennormale am staerksten gegen `n` gerichtet.
  let axis = 0;
  let strongest = -1;
  for (let i = 0; i < 3; i += 1) {
    const along = Math.abs(v3dot(axes[i]!, n));
    if (along > strongest) {
      strongest = along;
      axis = i;
    }
  }
  const faceAxis = axes[axis]!;
  const uAxis = axes[(axis + 1) % 3]!;
  const vAxis = axes[(axis + 2) % 3]!;
  const hn = -signOf(v3dot(faceAxis, n)) * half[axis]!;
  const hu = half[(axis + 1) % 3]!;
  const hv = half[(axis + 2) % 3]!;
  const c = box.center;

  // Ecken im Umlaufsinn, damit das Beschneiden ein zusammenhaengendes Polygon liefert.
  for (let k = 0; k < 4; k += 1) {
    const su = (k === 0 || k === 3 ? 1 : -1) * hu;
    const sv = (k < 2 ? 1 : -1) * hv;
    v3set(
      clipBufferA[k]!,
      c[0] + hn * faceAxis[0] + su * uAxis[0] + sv * vAxis[0],
      c[1] + hn * faceAxis[1] + su * uAxis[1] + sv * vAxis[1],
      c[2] + hn * faceAxis[2] + su * uAxis[2] + sv * vAxis[2],
    );
  }

  let count = clipAgainstSlab(clipBufferA, 4, clipBufferB, rect.center, rect.tangent, rect.halfExtentU);
  count = clipAgainstSlab(clipBufferA, count, clipBufferB, rect.center, rect.bitangent, rect.halfExtentV);

  for (let k = 0; k < count; k += 1) {
    const point = clipBufferA[k]!;
    const depth =
      (rect.center[0] - point[0]) * n[0] + (rect.center[1] - point[1]) * n[1] + (rect.center[2] - point[2]) * n[2];
    if (depth > 0) addPoint(out, point, depth);
  }
}

/**
 * Kontakt eines Koerpers mit einem Flaechensegment; die Normale zeigt von der
 * Flaeche zum Koerper.
 *
 * Die Flaeche ist dabei eine Platte mit ihrer Dicke, kein unendlich duenner
 * Schnitt: liegt ein Quader ueber dem Rand, drueckt die Plattenkante gegen
 * seine Unterseite, und die Kraft steht senkrecht auf *dieser*, nicht auf der
 * Platte. Nur so rutscht ein Quader, der ueber die Kante kippt, auch ab.
 *
 * Mit einer Ausnahme: die Unterseite der Platte schiebt nie. Ist ein Koerper
 * tiefer als die halbe Dicke eingesunken, wird er trotzdem nach oben
 * herausgeschoben - eine Flaeche hat eine Oberseite, auf der etwas liegt.
 */
export function overlapSurface(body: RuntimeBody, segment: ResolvedSegment, out: Overlap): boolean {
  out.count = 0;
  out.depth = 0;
  loadSegment(segment, boxA);
  if (body.shape.type === "sphere") {
    return overlapSphereBox(body.mechanics.position, body.shape.radius, boxA, out, true, true);
  }
  return overlapBoxes(boxA, loadBody(body, boxB), true, out);
}

/**
 * Prueft zwei Koerper auf Ueberlappung und fuellt `out`, falls sie sich
 * durchdringen. `out.normal` zeigt von `a` nach `b`.
 */
export function overlapBodies(a: RuntimeBody, b: RuntimeBody, out: Overlap): boolean {
  out.count = 0;
  out.depth = 0;
  if (a.shape.type === "sphere" && b.shape.type === "sphere") return overlapSpheres(a, b, out);
  if (a.shape.type === "sphere") {
    return overlapSphereBox(a.mechanics.position, a.shape.radius, loadBody(b, boxA), out, false, false);
  }
  if (b.shape.type === "sphere") {
    return overlapSphereBox(b.mechanics.position, b.shape.radius, loadBody(a, boxA), out, true, false);
  }
  return overlapBoxes(loadBody(a, boxA), loadBody(b, boxB), false, out);
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
  const ra = a.shape.radius;
  v3set(localPoint, pa[0] + ra * out.normal[0], pa[1] + ra * out.normal[1], pa[2] + ra * out.normal[2]);
  out.depth = reach - distance;
  addPoint(out, localPoint, out.depth);
  return true;
}

/**
 * Kugel gegen Quader: der Quaderpunkt, der dem Kugelmittelpunkt am naechsten
 * liegt, entscheidet. `boxFirst` heisst: der Quader ist Koerper a des Paars,
 * die Normale muss also vom Quader zur Kugel zeigen. `oneSided`: der Quader
 * ist eine Platte, deren Unterseite nicht schiebt (siehe `overlapSurface`).
 */
function overlapSphereBox(
  ps: V3,
  radius: number,
  box: BoxFrame,
  out: Overlap,
  boxFirst: boolean,
  oneSided: boolean,
): boolean {
  const half = box.half;
  const axes = box.axes;
  const pb = box.center;
  v3set(centreOffset, ps[0] - pb[0], ps[1] - pb[1], ps[2] - pb[2]);
  // Mittelpunkt im Quadersystem.
  v3set(localPoint, v3dot(centreOffset, axes[0]!), v3dot(centreOffset, axes[1]!), v3dot(centreOffset, axes[2]!));

  let outsideSquared = 0;
  const nearest = nearestScratch;
  for (let i = 0; i < 3; i += 1) {
    const value = localPoint[i]!;
    nearest[i] = value - clamp(value, half[i]!);
    outsideSquared += nearest[i]! * nearest[i]!;
  }

  // Normale vom Quader zur Kugel, zuerst im Quadersystem.
  let depth: number;
  // Mittelpunkt unter der Oberseite und ueber der Plattenflaeche, die Kugel
  // reicht noch in die Platte: nach oben hinaus, nicht durch die Unterseite.
  const belowTop =
    oneSided &&
    localPoint[2]! < half[2]! &&
    localPoint[2]! > -half[2]! - radius &&
    Math.abs(localPoint[0]!) <= half[0]! &&
    Math.abs(localPoint[1]!) <= half[1]!;
  if (belowTop) {
    v3set(nearest, 0, 0, 1);
    depth = half[2]! - localPoint[2]! + radius;
  } else if (outsideSquared > 0) {
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

  // Normale vom Quader zur Kugel im Weltsystem.
  v3set(
    axisScratch,
    axes[0]![0]! * nearest[0]! + axes[1]![0]! * nearest[1]! + axes[2]![0]! * nearest[2]!,
    axes[0]![1]! * nearest[0]! + axes[1]![1]! * nearest[1]! + axes[2]![1]! * nearest[2]!,
    axes[0]![2]! * nearest[0]! + axes[1]![2]! * nearest[1]! + axes[2]![2]! * nearest[2]!,
  );
  const sign = boxFirst ? 1 : -1;
  v3set(out.normal, sign * axisScratch[0], sign * axisScratch[1], sign * axisScratch[2]);
  // Der tiefste Punkt der Kugel. Wo entlang der Normale der Punkt liegt, ist
  // fuer das Drehmoment gleichgueltig: r x n haengt nur vom Querabstand ab.
  v3set(
    localPoint,
    ps[0] - radius * axisScratch[0],
    ps[1] - radius * axisScratch[1],
    ps[2] - radius * axisScratch[2],
  );
  out.depth = depth;
  addPoint(out, localPoint, depth);
  return true;
}

/**
 * Ueberlappung zweier Quader auf einer normierten Achse; haelt die kleinste je
 * Achsenart in `best` fest, samt der Herkunft der Achse, aus der spaeter die
 * Kontaktpunkte entstehen. `false` heisst: auf dieser Achse liegt eine Luecke,
 * die Quader beruehren sich nicht.
 *
 * `upward`: die Achse ist die Normale einer Platte (a). Dann wird b immer nach
 * oben hinausgeschoben, auch wenn sein Mittelpunkt schon unter der
 * Plattenmitte liegt - die Unterseite schiebt nicht.
 */
function considerAxis(axis: V3, isEdge: boolean, first: number, second: number, upward: boolean): boolean {
  let reachA = 0;
  let reachB = 0;
  for (let i = 0; i < 3; i += 1) {
    reachA += boxA.half[i]! * Math.abs(v3dot(boxA.axes[i]!, axis));
    reachB += boxB.half[i]! * Math.abs(v3dot(boxB.axes[i]!, axis));
  }
  const along = v3dot(centreOffset, axis);
  if (reachA + reachB - Math.abs(along) <= 0) return false;
  const depth = upward ? reachA + reachB - along : reachA + reachB - Math.abs(along);

  if (depth < (isEdge ? best.edgeDepth : best.faceDepth)) {
    // Die Normale zeigt von a nach b, egal wie die Achse gerichtet war.
    const sign = upward || along >= 0 ? 1 : -1;
    const target = isEdge ? best.edgeNormal : best.faceNormal;
    v3set(target, sign * axis[0], sign * axis[1], sign * axis[2]);
    if (isEdge) {
      best.edgeDepth = depth;
      best.edgeAxisA = first;
      best.edgeAxisB = second;
    } else {
      best.faceDepth = depth;
      best.faceOwner = first === 0 ? boxA : boxB;
      best.faceAxis = second;
    }
  }
  return true;
}

/**
 * Quader gegen Quader (`boxA`, `boxB`) nach dem Satz der Trennachsen: zwei
 * konvexe Koerper ueberlappen genau dann, wenn auf *keiner* der 15
 * Kandidatenachsen (je drei Flaechennormalen, dazu neun Kreuzprodukte der
 * Kanten) eine Luecke zwischen ihren Projektionen liegt. Die Achse mit der
 * kleinsten Ueberlappung ist der kuerzeste Weg, die Koerper auseinanderzuschieben.
 *
 * Die Kontaktpunkte haengen von der Art der Achse ab: bei einer Flaechenachse
 * wird die einfallende Flaeche des anderen Quaders an der Bezugsflaeche
 * beschnitten (Flaechen- oder Kantenkontakt, bis zu acht Punkte), bei einer
 * Kantenachse beruehren sich zwei Kanten in einem Punkt.
 *
 * `plate`: a ist eine Platte, deren Achse 2 die Normale ihrer Oberseite ist.
 */
function overlapBoxes(a: BoxFrame, b: BoxFrame, plate: boolean, out: Overlap): boolean {
  const pa = a.center;
  const pb = b.center;
  v3set(centreOffset, pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);

  best.faceDepth = Infinity;
  best.edgeDepth = Infinity;

  for (let i = 0; i < 3; i += 1) {
    if (!considerAxis(a.axes[i]!, false, 0, i, plate && i === 2)) return false;
    if (!considerAxis(b.axes[i]!, false, 1, i, false)) return false;
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const u = a.axes[i]!;
      const v = b.axes[j]!;
      v3set(
        axisScratch,
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      );
      if (v3dot(axisScratch, axisScratch) < PARALLEL_EPSILON) continue;
      v3normalize(axisScratch);
      if (!considerAxis(axisScratch, true, i, j, false)) return false;
    }
  }

  const useEdge = best.edgeDepth < best.faceDepth * EDGE_AXIS_PREFERENCE;
  const normal = useEdge ? best.edgeNormal : best.faceNormal;
  v3set(out.normal, normal[0], normal[1], normal[2]);
  const depth = useEdge ? best.edgeDepth : best.faceDepth;

  if (useEdge) edgeContact(a, b, depth, out);
  else faceContact(a, b, out);

  if (out.count === 0) {
    // Die Achse sagt "ueberlappt", das Beschneiden fand aber keinen Punkt
    // (Rundung genau an der Grenze). Dann ein Punkt mitten zwischen den
    // Mittelpunkten, damit der Kontakt nicht verloren geht.
    v3set(localPoint, (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2);
    addPoint(out, localPoint, depth);
  }
  // Die Tiefe ist die der Trennachse: sie ist der kuerzeste Weg auseinander,
  // auch wenn die beschnittenen Punkte sie nicht ganz erreichen.
  out.depth = depth;
  return true;
}

/** Bezugsflaeche = Flaeche der besten Flaechenachse; der andere Quader wird an ihr beschnitten. */
function faceContact(a: BoxFrame, b: BoxFrame, out: Overlap): void {
  const owner = best.faceOwner;
  const ownerIsA = owner === a;
  const k = best.faceAxis;
  // Die Bezugsnormale zeigt vom Eigentuemer zum einfallenden Quader.
  const sign = ownerIsA ? 1 : -1;
  const n = out.normal;
  const rect = referenceRect;
  v3set(rect.normal, sign * n[0], sign * n[1], sign * n[2]);
  const p = owner.center;
  const reach = owner.half[k]!;
  v3set(rect.center, p[0] + reach * rect.normal[0], p[1] + reach * rect.normal[1], p[2] + reach * rect.normal[2]);
  const uAxis = owner.axes[(k + 1) % 3]!;
  const vAxis = owner.axes[(k + 2) % 3]!;
  v3set(rect.tangent, uAxis[0], uAxis[1], uAxis[2]);
  v3set(rect.bitangent, vAxis[0], vAxis[1], vAxis[2]);
  rect.halfExtentU = owner.half[(k + 1) % 3]!;
  rect.halfExtentV = owner.half[(k + 2) % 3]!;

  clipIncidentFace(ownerIsA ? b : a, out);
}

/**
 * Kante gegen Kante: die beiden Kanten, die in Richtung der Normale am weitesten
 * hineinragen, und auf ihnen die einander naechsten Punkte. Der Kontaktpunkt ist
 * deren Mitte.
 */
function edgeContact(a: BoxFrame, b: BoxFrame, depth: number, out: Overlap): void {
  const n = out.normal;
  const i = best.edgeAxisA;
  const j = best.edgeAxisB;

  // Mitte der Kante von a, die am weitesten in Richtung n liegt, und der von b,
  // die am weitesten gegen n liegt.
  v3set(edgePointA, a.center[0], a.center[1], a.center[2]);
  v3set(edgePointB, b.center[0], b.center[1], b.center[2]);
  for (let k = 0; k < 3; k += 1) {
    if (k !== i) {
      const axis = a.axes[k]!;
      const s = signOf(v3dot(axis, n)) * a.half[k]!;
      v3set(edgePointA, edgePointA[0] + s * axis[0], edgePointA[1] + s * axis[1], edgePointA[2] + s * axis[2]);
    }
    if (k !== j) {
      const axis = b.axes[k]!;
      const s = -signOf(v3dot(axis, n)) * b.half[k]!;
      v3set(edgePointB, edgePointB[0] + s * axis[0], edgePointB[1] + s * axis[1], edgePointB[2] + s * axis[2]);
    }
  }

  // Naechste Punkte der Geraden edgePointA + s*da und edgePointB + t*db (|d| = 1).
  const da = a.axes[i]!;
  const db = b.axes[j]!;
  const cosine = v3dot(da, db);
  v3set(centreOffset, edgePointA[0] - edgePointB[0], edgePointA[1] - edgePointB[1], edgePointA[2] - edgePointB[2]);
  const c = v3dot(da, centreOffset);
  const f = v3dot(db, centreOffset);
  // Die Achse kam nur durch, weil die Kanten nicht parallel sind; der Nenner ist
  // also mindestens PARALLEL_EPSILON.
  const denominator = 1 - cosine * cosine;
  const s = clamp((cosine * f - c) / denominator, a.half[i]!);
  const t = clamp((f - cosine * c) / denominator, b.half[j]!);

  v3set(
    localPoint,
    (edgePointA[0] + s * da[0] + edgePointB[0] + t * db[0]) / 2,
    (edgePointA[1] + s * da[1] + edgePointB[1] + t * db[1]) / 2,
    (edgePointA[2] + s * da[2] + edgePointB[2] + t * db[2]) / 2,
  );
  addPoint(out, localPoint, depth);
}
