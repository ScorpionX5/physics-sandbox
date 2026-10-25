import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as THREE from "three";

import { fitDistance } from "../src/framing.js";

const UP = new THREE.Vector3(0, 0, 1);
const TO_CAMERA = new THREE.Vector3(0.93, 0.25, 0.45).normalize();

/** Projiziert einen Punkt wie die Kamera: Bildkoordinaten in [-1, 1], tiefe > 0 davor. */
function project(point: THREE.Vector3, target: THREE.Vector3, distance: number, fov: number, aspect: number) {
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.01, 1000);
  camera.up.copy(UP);
  camera.position.copy(target).addScaledVector(TO_CAMERA, distance);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return point.clone().project(camera);
}

describe("fitDistance", () => {
  const target = new THREE.Vector3(0, 0, 0.5);
  const points = [
    new THREE.Vector3(-5, -5, 0),
    new THREE.Vector3(5, -5, 0),
    new THREE.Vector3(-5, 5, 0),
    new THREE.Vector3(5, 5, 0),
    new THREE.Vector3(0, 0, 3),
  ];

  for (const aspect of [0.6, 1, 2]) {
    it(`bringt alle Punkte ins Bild und beruehrt den Rand (Seitenverhaeltnis ${aspect})`, () => {
      const distance = fitDistance(points, target, TO_CAMERA, UP, 50, aspect);
      let extreme = 0;
      for (const point of points) {
        const ndc = project(point, target, distance, 50, aspect);
        extreme = Math.max(extreme, Math.abs(ndc.x), Math.abs(ndc.y));
      }
      assert.ok(Math.abs(extreme - 1) < 1e-6, `aeusserster Punkt bei ${extreme}, erwartet 1`);
    });
  }
});
