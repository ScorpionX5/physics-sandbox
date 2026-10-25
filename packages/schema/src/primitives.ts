import { z } from "zod";

/**
 * Geometrische Primitive. Bewusst als Tupel statt Objekte: kompakter in JSON
 * (eine Aufzeichnung besteht fast nur aus diesen Werten) und direkt indexierbar
 * in den Rechenschleifen des Kerns.
 */

/** Endliche Zahl — schliesst NaN und Infinity aus, die sonst still durch den Integrator wandern. */
export const Finite = z.number().finite();

/** Position, Geschwindigkeit, Kraft: [x, y, z] */
export const Vec3 = z.tuple([Finite, Finite, Finite]);
export type Vec3 = z.infer<typeof Vec3>;

/** Orientierung als Einheitsquaternion: [x, y, z, w] */
export const Quat = z.tuple([Finite, Finite, Finite, Finite]);
export type Quat = z.infer<typeof Quat>;

/** 3x3-Matrix, zeilenweise: [m00, m01, m02, m10, ...] */
export const Mat3 = z.tuple([
  Finite, Finite, Finite,
  Finite, Finite, Finite,
  Finite, Finite, Finite,
]);
export type Mat3 = z.infer<typeof Mat3>;

/** Identifikator innerhalb eines Szenarios. */
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, {
  message: "Id darf nur Buchstaben, Ziffern und _ . : - enthalten",
});
export type Id = z.infer<typeof Id>;

/** Farbe als CSS-Hex, damit sowohl Three.js als auch die UI sie direkt lesen koennen. */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, {
  message: "Farbe muss die Form #rrggbb haben",
});
export type HexColor = z.infer<typeof HexColor>;

export const ZERO_VEC3: Vec3 = [0, 0, 0];
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
