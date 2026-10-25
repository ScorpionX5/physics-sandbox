/**
 * `@sandbox/core` - die Zustandsschicht.
 *
 * Reines TypeScript ohne Grafik-Abhaengigkeit: derselbe Code laeuft im Browser
 * (Studio), in Node (serverseitiger Lauf fuer die Lernplattform) und im Test.
 * Das ist die Voraussetzung dafuer, dass eine serverseitig erzeugte Aufzeichnung
 * im Browser identisch aussieht.
 *
 * Die Zustandsschicht ist die einzige Quelle der Wahrheit. Die
 * Darstellungsschicht (`@sandbox/render`) leitet Atome, Elektronen und Partikel
 * daraus ab und wirkt nie zurueck.
 */

export * from "./math/index.js";
export * from "./rng.js";
export * from "./state.js";
export * from "./pipeline.js";
export * from "./modules/mechanics.js";
export * from "./simulate.js";
export * from "./analysis.js";
