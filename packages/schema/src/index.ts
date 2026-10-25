/**
 * `@sandbox/schema` - die einzige Quelle der Wahrheit fuer alle Datenformen.
 *
 * Dieselben Zod-Schemas validieren die Antwort des Bibliothekars (ueber
 * `zodOutputFormat`) und typisieren den Simulationskern. Eine Schemaaenderung
 * kann damit nicht vergessen werden: sie bricht beide Seiten sofort.
 */

export * from "./primitives.js";
export * from "./library.js";
export * from "./scenario.js";
export * from "./changes.js";
export * from "./recording.js";
export * from "./elements.js";
export * from "./geometry.js";
export * from "./validation.js";
export * from "./builtin.js";
