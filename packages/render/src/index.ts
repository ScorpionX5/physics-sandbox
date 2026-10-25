/**
 * `@sandbox/render` - die Darstellungsschicht.
 *
 * Leitet Geometrie aus dem Zustand ab und wirkt nie zurueck. Jede
 * Darstellungsebene liest dieselbe Aufzeichnung und zeigt etwas anderes; eine
 * Ebene zu wechseln aendert nichts an der Physik.
 *
 * Interpolation und Abspielkopf liegen hier und nicht im Kern: der Kern
 * unterliegt der Determinismusregel (nur + - * / und sqrt), Interpolation ist
 * eine Darstellungsaufgabe.
 */

export * from "./common.js";
export * from "./playback.js";
export * from "./snap.js";
export * from "./viewer.js";
export * from "./layers/macroscopic.js";
export * from "./layers/kinematic.js";
export * from "./layers/atomic.js";
