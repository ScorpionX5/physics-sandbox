/**
 * Vektor-, Quaternion- und Matrixrechnung fuer den Simulationskern.
 *
 * **Determinismusregel:** in diesem Paket kommen ausschliesslich +, -, *, / und
 * `Math.sqrt` vor. Diese Operationen sind nach IEEE-754 bitgenau definiert und
 * liefern auf jeder JS-Engine dasselbe Ergebnis. `Math.sin`, `cos`, `tan`,
 * `pow`, `exp` und `log` sind es *nicht* - ihre Genauigkeit ist
 * implementierungsabhaengig. Eine Aufzeichnung, die auf dem Server entsteht und
 * im Browser abgespielt oder nachgerechnet wird, waere damit nicht mehr
 * reproduzierbar.
 *
 * Ein Neigungswinkel wird deshalb genau einmal beim Anlegen des Szenarios in
 * einen Normalenvektor umgerechnet (`@sandbox/schema/geometry`) und als Vektor
 * gespeichert. Sollte die Chemie spaeter `exp` fuer die Arrhenius-Gleichung
 * brauchen, kommt eine eigene, versionierte Implementierung in dieses Paket -
 * keine Engine-Funktion.
 *
 * Die Typen sind veraenderbare Tupel, und die Funktionen schreiben wo moeglich
 * in ein Zielobjekt: pro Zeitschritt waeren sonst Dutzende kurzlebiger Arrays
 * zu allozieren, und bei 1 ms Schrittweite sind das Millionen pro Sekunde
 * simulierter Zeit.
 */

export type V3 = [number, number, number];
/** Quaternion als [x, y, z, w]. */
export type Q4 = [number, number, number, number];
/** 3x3-Matrix, zeilenweise. */
export type M3 = [number, number, number, number, number, number, number, number, number];

// ---------------------------------------------------------------- Vektoren

export function v3(x = 0, y = 0, z = 0): V3 {
  return [x, y, z];
}

export function v3copy(source: readonly [number, number, number]): V3 {
  return [source[0], source[1], source[2]];
}

export function v3set(out: V3, x: number, y: number, z: number): V3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function v3zero(out: V3): V3 {
  return v3set(out, 0, 0, 0);
}

export function v3add(out: V3, a: readonly number[], b: readonly number[]): V3 {
  return v3set(out, a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!);
}

export function v3sub(out: V3, a: readonly number[], b: readonly number[]): V3 {
  return v3set(out, a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

export function v3scale(out: V3, a: readonly number[], s: number): V3 {
  return v3set(out, a[0]! * s, a[1]! * s, a[2]! * s);
}

/** out += a * s - der Akkumulationsschritt, der im Integrator am haeufigsten vorkommt. */
export function v3addScaled(out: V3, a: readonly number[], s: number): V3 {
  out[0] += a[0]! * s;
  out[1] += a[1]! * s;
  out[2] += a[2]! * s;
  return out;
}

export function v3dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

export function v3cross(out: V3, a: readonly number[], b: readonly number[]): V3 {
  // Zwischenwerte, damit out mit a oder b identisch sein darf.
  const x = a[1]! * b[2]! - a[2]! * b[1]!;
  const y = a[2]! * b[0]! - a[0]! * b[2]!;
  const z = a[0]! * b[1]! - a[1]! * b[0]!;
  return v3set(out, x, y, z);
}

export function v3lengthSquared(a: readonly number[]): number {
  return a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!;
}

export function v3length(a: readonly number[]): number {
  return Math.sqrt(v3lengthSquared(a));
}

/** Normiert in-place. Beim Nullvektor bleibt `out` unveraendert. */
export function v3normalize(out: V3, a: readonly number[] = out): V3 {
  const lengthSquared = v3lengthSquared(a);
  if (lengthSquared === 0) return out;
  const inverse = 1 / Math.sqrt(lengthSquared);
  return v3set(out, a[0]! * inverse, a[1]! * inverse, a[2]! * inverse);
}

// ---------------------------------------------------------------- Quaternionen

export function q4(): Q4 {
  return [0, 0, 0, 1];
}

export function q4copy(source: readonly [number, number, number, number]): Q4 {
  return [source[0], source[1], source[2], source[3]];
}

/** Hamilton-Produkt a * b. `out` darf mit a oder b identisch sein. */
export function q4multiply(out: Q4, a: readonly number[], b: readonly number[]): Q4 {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function q4normalize(out: Q4): Q4 {
  const lengthSquared = out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3];
  if (lengthSquared === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return out;
  }
  const inverse = 1 / Math.sqrt(lengthSquared);
  out[0] *= inverse;
  out[1] *= inverse;
  out[2] *= inverse;
  out[3] *= inverse;
  return out;
}

/**
 * Integriert eine Orientierung um die Winkelgeschwindigkeit `omega` ueber `dt`.
 *
 * Verwendet die Ableitung q' = 1/2 * omega_quat * q mit anschliessender
 * Normierung - kein `sin`/`cos` einer Drehachse, wie es die exakte
 * Exponentialabbildung braeuchte. Der Fehler ist O(dt^2) in der Drehung und
 * verschwindet in der Normierung fast vollstaendig; bei dt = 1 ms und
 * realistischen Drehraten liegt er weit unter der Darstellungsgenauigkeit.
 * Wichtiger ist, dass der Drehimpuls separat gefuehrt und damit exakt erhalten
 * wird (siehe `mechanics.ts`).
 */
export function q4integrate(out: Q4, omega: readonly number[], dt: number): Q4 {
  const half = 0.5 * dt;
  const x = out[0], y = out[1], z = out[2], w = out[3];
  const wx = omega[0]!, wy = omega[1]!, wz = omega[2]!;
  // omega_quat * q mit omega_quat = (wx, wy, wz, 0)
  out[0] = x + half * (w * wx + wy * z - wz * y);
  out[1] = y + half * (w * wy + wz * x - wx * z);
  out[2] = z + half * (w * wz + wx * y - wy * x);
  out[3] = w + half * (-wx * x - wy * y - wz * z);
  return q4normalize(out);
}

// ---------------------------------------------------------------- Matrizen

export function m3identity(): M3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function m3diagonal(a: number, b: number, c: number): M3 {
  return [a, 0, 0, 0, b, 0, 0, 0, c];
}

/** Rotationsmatrix eines Einheitsquaternions. */
export function m3fromQuat(out: M3, q: readonly number[]): M3 {
  const x = q[0]!, y = q[1]!, z = q[2]!, w = q[3]!;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz);
  out[1] = 2 * (xy - wz);
  out[2] = 2 * (xz + wy);
  out[3] = 2 * (xy + wz);
  out[4] = 1 - 2 * (xx + zz);
  out[5] = 2 * (yz - wx);
  out[6] = 2 * (xz - wy);
  out[7] = 2 * (yz + wx);
  out[8] = 1 - 2 * (xx + yy);
  return out;
}

/** out = a * b. `out` darf nicht mit a oder b identisch sein. */
export function m3multiply(out: M3, a: readonly number[], b: readonly number[]): M3 {
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row * 3 + col] =
        a[row * 3]! * b[col]! +
        a[row * 3 + 1]! * b[3 + col]! +
        a[row * 3 + 2]! * b[6 + col]!;
    }
  }
  return out;
}

export function m3transpose(out: M3, a: readonly number[]): M3 {
  const a01 = a[1]!, a02 = a[2]!, a12 = a[5]!;
  out[0] = a[0]!;
  out[1] = a[3]!;
  out[2] = a[6]!;
  out[3] = a01;
  out[4] = a[4]!;
  out[5] = a[7]!;
  out[6] = a02;
  out[7] = a12;
  out[8] = a[8]!;
  return out;
}

/** out = m * v. `out` darf mit v identisch sein. */
export function m3transform(out: V3, m: readonly number[], v: readonly number[]): V3 {
  const x = v[0]!, y = v[1]!, z = v[2]!;
  return v3set(
    out,
    m[0]! * x + m[1]! * y + m[2]! * z,
    m[3]! * x + m[4]! * y + m[5]! * z,
    m[6]! * x + m[7]! * y + m[8]! * z,
  );
}

/** Dreht einen Vektor mit einem Einheitsquaternion: v' = q * v * q^-1. */
export function v3rotateByQuat(out: V3, v: readonly number[], q: readonly number[]): V3 {
  const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
  const vx = v[0]!, vy = v[1]!, vz = v[2]!;
  // t = 2 * (q_vec x v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + qw * t + q_vec x t
  return v3set(
    out,
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  );
}
