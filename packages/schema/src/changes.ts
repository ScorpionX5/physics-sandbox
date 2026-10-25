import type { ChangeKey, EntityChange, EntitySpec, Scenario } from "./scenario.js";
import { interventionsInOrder } from "./scenario.js";

/**
 * Aenderungen (`op: "change"`) auf Entitaeten: welche Schluessel es je
 * Entitaetsart gibt und wie eine Aenderung auf die Spec wirkt.
 *
 * Die Faltung "Spec + alle Aenderungen bis t" steht genau hier, weil drei
 * Stellen sie brauchen: der Simulator (beim Wiedereinfuegen und fuer Masse und
 * Form), die Renderer (Groesse, Material, Opazitaet zur Abspielzeit) und die
 * Oberflaeche (Vorbelegung eines neuen Eingriffs). Drei eigene Faltungen
 * liefen bei gleicher Zeit oder fremden Dateien auseinander.
 *
 * Rein und ohne Winkelfunktionen - der Kern ruft das auf.
 */

/**
 * Die Aenderungsschluessel je Entitaetsart. `state: true` heisst
 * Zustandsgroesse: die Simulation schreibt den Wert fort, die Aenderung setzt
 * ihn nur zum Zeitpunkt. Alle anderen sind Eingabeeigenschaften und folgen
 * allein aus dem Szenario.
 *
 * Die Lage ist beim Koerper Zustand, bei der Randbedingung Eingabe: eine Flaeche
 * bewegt sich nie von selbst.
 */
export const CHANGE_KEYS: Record<EntitySpec["kind"], Partial<Record<ChangeKey, { state: boolean }>>> = {
  body: {
    position: { state: true },
    orientation: { state: true },
    linearVelocity: { state: true },
    angularVelocity: { state: true },
    halfExtents: { state: false },
    materialId: { state: false },
    opacity: { state: false },
  },
  constraint: {
    position: { state: false },
    orientation: { state: false },
    dimensions: { state: false },
    materialId: { state: false },
    opacity: { state: false },
  },
  load: {
    magnitude: { state: false },
    direction: { state: false },
    opacity: { state: false },
  },
};

export function changeKeyAllowed(kind: EntitySpec["kind"], key: ChangeKey): boolean {
  return CHANGE_KEYS[kind][key] !== undefined;
}

/** Ob der Schluessel fuer diese Entitaetsart eine Zustandsgroesse ist. */
export function isStateChange(kind: EntitySpec["kind"], key: ChangeKey): boolean {
  return CHANGE_KEYS[kind][key]?.state === true;
}

function unsupported(spec: EntitySpec, key: ChangeKey): never {
  throw new Error(`Aenderung "${key}" passt nicht zu "${spec.id}" (${spec.kind}).`);
}

/**
 * Die Spec nach einer Aenderung - eine neue Spec, die alte bleibt unberuehrt.
 *
 * Zustandsgroessen eines Koerpers lassen die Spec unveraendert: seine Startlage
 * ist nicht die Lage, die er nach der Aenderung hat, und eine Spec, die so
 * taete, wuerde beim Wiedereinfuegen an einer Stelle erscheinen, an der er
 * nie gestartet ist.
 */
export function applyEntityChange(spec: EntitySpec, change: EntityChange): EntitySpec {
  if (!changeKeyAllowed(spec.kind, change.key)) unsupported(spec, change.key);
  if (isStateChange(spec.kind, change.key)) return spec;
  const next = structuredClone(spec);
  switch (change.key) {
    case "opacity":
      next.opacity = change.value;
      return next;
    case "materialId":
      if (next.kind === "load") return unsupported(spec, change.key);
      next.materialId = change.value;
      return next;
    case "position":
      if (next.kind === "load") return unsupported(spec, change.key);
      next.pose.position = [...change.value];
      return next;
    case "orientation":
      if (next.kind === "load") return unsupported(spec, change.key);
      next.pose.orientation = [...change.value];
      return next;
    case "halfExtents":
      if (next.kind !== "body" || next.phase.shape.type !== "box") return unsupported(spec, change.key);
      next.phase.shape = { type: "box", halfExtents: [...change.value] };
      return next;
    case "dimensions":
      if (next.kind !== "constraint") return unsupported(spec, change.key);
      next.size = [change.value[0], change.value[1]];
      next.thickness = change.value[2];
      return next;
    case "magnitude":
      if (next.kind !== "load") return unsupported(spec, change.key);
      next.magnitude = change.value;
      return next;
    case "direction":
      if (next.kind !== "load") return unsupported(spec, change.key);
      next.direction = [...change.value];
      return next;
    case "linearVelocity":
    case "angularVelocity":
      return unsupported(spec, change.key);
  }
}

/** Gleiche Zeit wie beim Simulator und in der Oberflaeche - fremde Zeiten sind nicht gerundet. */
const TIME_TOLERANCE = 1e-9;

/**
 * Die Spec einer Entitaet zur Zeit `t`: ihre Startwerte, gefaltet mit allen
 * Aenderungen ihrer Eingabeeigenschaften bis einschliesslich `t`, in
 * Wirkreihenfolge. Bei genau `t` gilt also der Stand nach dem Eingriff - wie im
 * Schnappschusspaar, das der Simulator an einem Eingriff aufzeichnet.
 *
 * Die Anwesenheit (`add`/`remove`) spielt keine Rolle: eine Eingabeeigenschaft
 * behaelt ihren letzten Wert auch ueber ein Entfernen und Wiedereinfuegen.
 */
export function entitySpecAt(
  scenario: Pick<Scenario, "entities" | "interventions">,
  entityId: string,
  t: number,
): EntitySpec | undefined {
  let spec = scenario.entities.find((candidate) => candidate.id === entityId);
  if (!spec) return undefined;
  for (const intervention of interventionsInOrder(scenario)) {
    if (intervention.t > t + TIME_TOLERANCE) break;
    if (intervention.op === "change" && intervention.entityId === entityId) {
      spec = applyEntityChange(spec, intervention.change);
    }
  }
  return spec;
}
