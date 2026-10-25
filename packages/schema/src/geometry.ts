import type { SurfaceSegment } from "./library.js";
import type { Quat, Vec3 } from "./primitives.js";
import type { Shape } from "./scenario.js";

/**
 * Geometrie-Helfer fuer das *Anlegen* von Szenarien.
 *
 * Hier - und nur hier - darf Trigonometrie vorkommen. `Math.sin` und `Math.cos`
 * sind ueber JS-Engines nicht bitgenau spezifiziert; im Simulationskern wuerden
 * sie den Determinismus brechen. Deshalb wird ein Neigungswinkel genau einmal,
 * beim Erzeugen des Bibliothekseintrags, in einen Normalenvektor umgerechnet und
 * als Vektor im Szenario gespeichert. Der Kern rechnet danach nur noch mit
 * + - * / und sqrt, die nach IEEE-754 exakt definiert sind.
 */

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Quaternion aus Eulerwinkeln in Grad, Reihenfolge XYZ.
 *
 * Fuer die Oberflaeche: drei Winkel sind bedienbar, ein Quaternion nicht.
 * Gespeichert wird trotzdem das Quaternion - Eulerwinkel haben Singularitaeten
 * (bei 90 Grad um Y laufen X und Z zusammen), und die hat man im Datenmodell
 * nicht gern.
 *
 * Die Reihenfolge XYZ ist dieselbe, die Three.js standardmaessig benutzt, damit
 * Anzeige und Darstellung nicht auseinanderfallen.
 */
export function quaternionFromEulerDegrees(x: number, y: number, z: number): Quat {
  const hx = degreesToRadians(x) / 2;
  const hy = degreesToRadians(y) / 2;
  const hz = degreesToRadians(z) / 2;
  const c1 = Math.cos(hx), s1 = Math.sin(hx);
  const c2 = Math.cos(hy), s2 = Math.sin(hy);
  const c3 = Math.cos(hz), s3 = Math.sin(hz);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Eulerwinkel in Grad (Reihenfolge XYZ) aus einem Einheitsquaternion. */
export function eulerDegreesFromQuaternion(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  // Nur die Matrixelemente, die fuer die XYZ-Zerlegung gebraucht werden.
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);

  const clamped = Math.min(1, Math.max(-1, m13));
  const ey = Math.asin(clamped);
  // Nahe +-90 Grad um Y laufen die Drehungen um X und Z zusammen (Gimbal Lock);
  // dann wird die Drehung ganz auf X gelegt, statt zwei beliebige Werte zu
  // erfinden.
  if (Math.abs(m13) < 0.9999999) {
    return [
      radiansToDegrees(Math.atan2(-m23, m33)),
      radiansToDegrees(ey),
      radiansToDegrees(Math.atan2(-m12, m11)),
    ];
  }
  return [radiansToDegrees(Math.atan2(m32, m22)), radiansToDegrees(ey), 0];
}

export function normalize(v: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length === 0) throw new Error("Nullvektor kann nicht normiert werden");
  return [v[0] / length, v[1] / length, v[2] / length];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Volumen einer Form in m^3 - Grundlage der Massenberechnung aus der Dichte. */
export function shapeVolume(shape: Shape): number {
  if (shape.type === "box") {
    const [hx, hy, hz] = shape.halfExtents;
    return 8 * hx * hy * hz;
  }
  return (4 / 3) * Math.PI * shape.radius ** 3;
}

/**
 * Hinweis: eine `buildRampSegments`-Funktion gab es hier, solange eine Rampe
 * *eine* Randbedingung mit zwei Segmenten war. Mit der "Ebene" als einziger
 * Flaechen-Grundform ist eine Rampe stattdessen *zwei platzierte Instanzen* mit
 * eigener Lage, Drehung und Groesse. Die Funktion haette damit einen zweiten Weg
 * geboten, dasselbe auszudruecken - und zwei Wege zu derselben Sache sind
 * teurer als einer.
 */

/**
 * Erwartete Gleitbeschleunigung auf einer reibungsfreien schiefen Ebene,
 * a = g * sin(alpha). Nur fuer Tests und UI-Anzeige - der Kern berechnet das
 * Ergebnis selbst aus Kontaktimpulsen und darf diese Formel nie benutzen,
 * sonst prueft der Test sich gegen sich selbst.
 */
export function expectedSlideAcceleration(gravityMagnitude: number, inclineDegrees: number): number {
  return gravityMagnitude * Math.sin(degreesToRadians(inclineDegrees));
}
