import * as THREE from "three";

/**
 * Der kleinste Kameraabstand vom Ziel, bei dem alle Punkte im Sichtfeld liegen.
 *
 * Eigene Funktion statt Teil des Betrachters, weil sie ohne WebGL pruefbar ist
 * und die Standardansicht sonst nur durch Hinsehen kontrolliert werden koennte.
 *
 * Ein Punkt q (relativ zum Ziel) liegt im Bild, wenn
 * `|q.right| <= tanX * (d - q.toCamera)` und entsprechend fuer `up` mit `tanY`;
 * daraus folgt je Punkt eine Untergrenze fuer d. `toCamera` muss normiert sein.
 */
export function fitDistance(
  points: readonly THREE.Vector3[],
  target: THREE.Vector3,
  toCamera: THREE.Vector3,
  worldUp: THREE.Vector3,
  fovDegrees: number,
  aspect: number,
): number {
  const right = new THREE.Vector3().crossVectors(worldUp, toCamera).normalize();
  const up = new THREE.Vector3().crossVectors(toCamera, right);
  const tanY = Math.tan((fovDegrees * Math.PI) / 360);
  const tanX = tanY * aspect;

  let fitted = 0;
  const q = new THREE.Vector3();
  for (const point of points) {
    q.copy(point).sub(target);
    const depth = q.dot(toCamera);
    fitted = Math.max(fitted, depth + Math.abs(q.dot(right)) / tanX, depth + Math.abs(q.dot(up)) / tanY);
  }
  return fitted;
}
