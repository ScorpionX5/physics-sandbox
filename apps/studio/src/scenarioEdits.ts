import {
  CHANGE_KEYS,
  changeKeyAllowed,
  EARTH_GRAVITY,
  entitySpecAt,
  eulerDegreesFromQuaternion,
  quaternionFromEulerDegrees,
  interventionsInOrder,
  MAX_DURATION,
  Scenario as ScenarioSchema,
  type ChangeKey,
  type EntityChange,
  type EntitySpec,
  type Intervention,
  type LibraryEntry,
  type Material,
  type Quat,
  type Scenario,
  type Vec3,
  type ViewLayer,
} from "@sandbox/schema";

/**
 * Bearbeitung eines Szenarios als reine Funktionen: Szenario rein, Szenario
 * raus.
 *
 * Bewusst ohne React: so ist die Bearbeitungslogik - der Teil, in dem die
 * Fehler stecken - ohne Browser pruefbar, und die Oberflaeche bleibt eine
 * duenne Schicht darueber.
 *
 * **Jede Aenderung am Szenario gehoert hierher**, nicht in eine Komponente: die
 * Oberflaeche ruft sie ueber `apply(...)` in App.tsx auf und zeigt nur
 * Fehlermeldungen an. Neue Funktion heisst neuer Test in
 * apps/studio/test/scenarioEdits.test.ts - das ist der billigste Ort, an dem
 * ein Bearbeitungsfehler auffaellt.
 *
 * Zur Zeitrechnung: jeder Eingriff traegt seinen Zeitpunkt `t`, die
 * Gesamtdauer steht fuer sich in `Scenario.duration`. Beides ist unabhaengig:
 * die Gesamtdauer zu kuerzen loescht keinen Eingriff, er wirkt nur nicht mehr.
 */

function clone(scenario: Scenario): Scenario {
  return structuredClone(scenario);
}

/**
 * Raster, auf das die Zeit eines neuen oder verschobenen Eingriffs gerundet
 * wird, in Sekunden. Nach einer Pause steht der Zeitcursor auf einer
 * beliebigen Zeit; ungerundet landeten zwei Eingriffe, die beide "1.23 s"
 * zeigen, in verschiedenen Rauten.
 */
export const INTERVENTION_TIME_STEP = 0.01;

export function roundInterventionTime(t: number): number {
  if (!Number.isFinite(t)) throw new Error(`Die Zeit muss eine Zahl sein, war ${t}.`);
  // toFixed statt nur Math.round: sonst bliebe z. B. 0.07 als 0.07000000000000001 stehen.
  const rounded = Number((Math.round(t / INTERVENTION_TIME_STEP) * INTERVENTION_TIME_STEP).toFixed(2));
  if (rounded < 0) throw new Error("Die Zeit eines Eingriffs darf nicht negativ sein.");
  if (rounded > MAX_DURATION) {
    throw new Error(`Die Zeit eines Eingriffs darf ${MAX_DURATION} s nicht überschreiten.`);
  }
  return rounded;
}

/** Alle Ids, die im Szenario je vorkommen - Entitaeten und Bibliothek. */
export function usedIds(scenario: Scenario): Set<string> {
  const ids = new Set<string>();
  for (const entry of scenario.library) ids.add(entry.definition.id);
  for (const entity of scenario.entities) ids.add(entity.id);
  return ids;
}

export function uniqueId(scenario: Scenario, base: string): string {
  const taken = usedIds(scenario);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Keine freie Id fuer "${base}".`);
}

/**
 * Fuegt einen Eingriff so ein, dass die Liste nach Zeit sortiert bleibt - hinter
 * allen Eingriffen derselben Zeit, damit er nach ihnen wirkt (`mutiert`).
 */
function insertIntervention(scenario: Scenario, intervention: Intervention): void {
  let position = scenario.interventions.length;
  while (position > 0 && scenario.interventions[position - 1]!.t > intervention.t) position -= 1;
  scenario.interventions.splice(position, 0, intervention);
}

/** Gleiche Zeit im Sinne der Rauten - Zeiten aus fremden Dateien sind nicht gerundet. */
export function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Lage einer Eingriffszeit zum Zeitcursor - bestimmt die Farbe von Raute und
 * Zeittext. Ein Wert, damit beide nie unterschiedlich entscheiden.
 */
export function timeRelation(t: number, cursorTime: number): "vergangen" | "gewaehlt" | "kommend" {
  if (sameTime(t, cursorTime)) return "gewaehlt";
  return t < cursorTime ? "vergangen" : "kommend";
}

// ---------------------------------------------------------------- Uebersicht

export interface EntityListing {
  spec: EntitySpec;
}

/**
 * Alle Objekte des Szenarios, unabhaengig von der Zeit.
 *
 * Die Oberflaeche zeigt eine einzige Objektliste: ein Objekt gehoert dem
 * Szenario, nicht einem Zeitpunkt. Auch eines, das nie hinzugefuegt
 * wird, steht in der Liste - *wann* es in der Szene ist, steht in den Eingriffen.
 */
export function listEntities(scenario: Scenario): EntityListing[] {
  return scenario.entities.map((spec) => ({ spec }));
}

/**
 * Ob ein Objekt zum Zeitpunkt `t` in der Szene ist - nach den Eingriffen bei
 * genau `t`. Das ist der Zustand, auf den ein neuer Eingriff zu dieser Zeit
 * aufsetzt.
 *
 * Gelesen in der Reihenfolge, in der der Simulator die Eingriffe anwendet: das
 * letzte `add` oder `remove` gewinnt.
 */
export function isEntityPresent(scenario: Scenario, entityId: string, t: number): boolean {
  let present = false;
  for (const intervention of interventionsInOrder(scenario)) {
    if (intervention.t > t + 1e-9) break;
    if (intervention.op === "add" && intervention.entityId === entityId) present = true;
    else if (intervention.op === "remove" && intervention.entityId === entityId) present = false;
  }
  return present;
}

/**
 * Ob ein Eingriff im Lauf ueberhaupt erreicht wird. Dieselbe Grenze wie im
 * Simulator: der letzte Zeitschritt beginnt bei `duration - dt`, und ein
 * Eingriff gilt am naechstgelegenen Schritt. Einer genau am Ende wirkt also
 * nicht mehr.
 */
export function isInterventionEffective(scenario: Scenario, intervention: Intervention): boolean {
  return intervention.t < scenario.duration - scenario.simulation.dt / 2;
}

export interface InterventionListing {
  /** Index in `Scenario.interventions` - zum Entfernen und Verschieben. */
  index: number;
  intervention: Intervention;
  /** Liegt der Eingriff hinter der Gesamtdauer, bleibt er stehen, wirkt aber nicht. */
  effective: boolean;
}

/**
 * Alle Eingriffe in der Reihenfolge, in der sie wirken, auch das Hinzufuegen
 * von Objekten.
 *
 * Ein `add` ist ein Eingriff wie jeder andere: es veraendert den Zustand zu
 * einem bestimmten Zeitpunkt. Die Eingriffsliste ist deshalb der Ort, an dem
 * sichtbar wird, *wann* ein Objekt erscheint - das steht nicht am Objekt.
 */
export function listInterventions(scenario: Scenario): InterventionListing[] {
  return scenario.interventions
    .map((intervention, index) => ({
      index,
      intervention,
      effective: isInterventionEffective(scenario, intervention),
    }))
    .sort((a, b) => a.intervention.t - b.intervention.t);
}

export interface InterventionMark {
  t: number;
  interventions: Intervention[];
}

/**
 * Die Rauten der Zeitleiste: je Zeitpunkt eine, mit allen Eingriffen dieser
 * Zeit. Nur wirksame - eine Raute hinter dem Ende laege ausserhalb des
 * Schiebers.
 */
export function interventionMarks(scenario: Scenario): InterventionMark[] {
  const marks: InterventionMark[] = [];
  for (const intervention of interventionsInOrder(scenario)) {
    if (!isInterventionEffective(scenario, intervention)) continue;
    const last = marks[marks.length - 1];
    if (last && sameTime(last.t, intervention.t)) last.interventions.push(intervention);
    else marks.push({ t: intervention.t, interventions: [intervention] });
  }
  return marks;
}

export function findEntity(scenario: Scenario, entityId: string): EntityListing | undefined {
  return listEntities(scenario).find((entry) => entry.spec.id === entityId);
}

// ---------------------------------------------------------------- Objekte

export interface AddBodyInput {
  /** Zeitpunkt des `add`-Eingriffs, in Sekunden. */
  t: number;
  /** Der Koerper-Eintrag der Bibliothek, z. B. "quader". */
  bodyId: string;
  /** Fehlt es, bekommt der Koerper das erste Material der Bibliothek. */
  materialId?: string;
  position: Vec3;
  orientation?: Quat;
  /** Fehlen sie, gelten die halben Kantenlaengen des Koerper-Eintrags. */
  halfExtents?: Vec3;
  name?: string;
  /** Fehlt sie, wird die Masse aus Dichte und Volumen berechnet. */
  mass?: number;
}

/** Alle Materialien der Bibliothek des Szenarios, in Bibliotheksreihenfolge. */
export function listMaterials(scenario: Scenario): Material[] {
  const materials: Material[] = [];
  for (const entry of scenario.library) {
    if (entry.definition.kind === "material") materials.push(entry.definition);
  }
  return materials;
}

export function addBody(scenario: Scenario, input: AddBodyInput): Scenario {
  const next = clone(scenario);
  const t = roundInterventionTime(input.t);
  const body = next.library.find(
    (entry) => entry.definition.kind === "body" && entry.definition.id === input.bodyId,
  )?.definition;
  if (!body || body.kind !== "body") {
    throw new Error(
      `Koerper "${input.bodyId}" ist nicht in der Bibliothek des Szenarios. ` +
        `Erst hinzufügen – ein Szenario trägt seine Einträge selbst.`,
    );
  }
  // Ohne Angabe das erste Material: ein Koerper ohne Material hat keine Dichte
  // und damit keine Masse, und eine Rueckfrage beim Platzieren waere ein Klick
  // mehr fuer etwas, das sich in der rechten Leiste jederzeit umstellen laesst.
  const materialId = input.materialId ?? listMaterials(next)[0]?.id;
  if (materialId === undefined) {
    throw new Error("Die Bibliothek enthaelt kein Material - ein Koerper braucht eines.");
  }
  if (!listMaterials(next).some((material) => material.id === materialId)) {
    throw new Error(
      `Material "${materialId}" ist nicht in der Bibliothek des Szenarios. ` +
        `Erst hinzufügen – ein Szenario trägt seine Einträge selbst.`,
    );
  }
  const label = input.name ?? body.name;
  const id = uniqueId(next, slug(label));
  next.entities.push({
    kind: "body",
    id,
    bodyId: body.id,
    materialId,
    name: label,
    opacity: 1,
    phase: {
      state: "solid",
      shape: { type: "box", halfExtents: input.halfExtents ?? [...body.behaviour.halfExtents] },
    },
    ...(input.mass !== undefined ? { mass: input.mass } : {}),
    pose: { position: input.position, orientation: input.orientation ?? [0, 0, 0, 1] },
    velocity: { linear: [0, 0, 0], angular: [0, 0, 0] },
    kinematic: false,
  });
  insertIntervention(next, { op: "add", t, entityId: id });
  return next;
}

/**
 * Kleinste Drehung, die die lokale z-Achse (Oberseite eines Körpers, Normale
 * einer Fläche) auf `normal` legt. Damit liegt die Unterseite eines platzierten
 * Körpers plan auf der getroffenen Oberfläche.
 *
 * Die kleinste Drehung ist hier die richtige, weil um die Normale selbst nichts
 * festgelegt ist: eine Rampe, die um y geneigt ist, ergibt wieder eine reine
 * Drehung um y und keine zusätzliche Verdrehung um z.
 */
export function orientationFromNormal(normal: Vec3): Quat {
  const length = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
  if (length === 0) return [0, 0, 0, 1];
  const nx = normal[0] / length;
  const ny = normal[1] / length;
  const nz = normal[2] / length;
  // Gegenüberliegende Richtung: die Achse (z × n) verschwindet, jede Achse
  // senkrecht zu z tut es.
  if (nz < -1 + 1e-9) return [1, 0, 0, 0];
  // z × n = (-ny, nx, 0); w = 1 + z·n. Normiert ergibt das die Drehung.
  const w = 1 + nz;
  const norm = Math.sqrt(ny * ny + nx * nx + w * w);
  return [-ny / norm, nx / norm, 0, w / norm];
}

export interface AddConstraintInput {
  /** Zeitpunkt des `add`-Eingriffs, in Sekunden. */
  t: number;
  constraintId: string;
  /** Fehlt es, bekommt die Randbedingung das erste Material der Bibliothek. */
  materialId?: string;
  position?: Vec3;
  orientation?: Quat;
  /** Halbe Ausdehnung in Laengs- und Querrichtung. */
  size?: [number, number];
  name?: string;
}

export function addConstraint(scenario: Scenario, input: AddConstraintInput): Scenario {
  const next = clone(scenario);
  const t = roundInterventionTime(input.t);
  const found = next.library.find(
    (entry) => entry.definition.kind === "constraint" && entry.definition.id === input.constraintId,
  );
  if (!found) {
    throw new Error(`Randbedingung "${input.constraintId}" ist nicht in der Bibliothek des Szenarios.`);
  }
  const materialId = input.materialId ?? listMaterials(next)[0]?.id;
  if (materialId === undefined) {
    throw new Error("Die Bibliothek enthaelt kein Material - eine Randbedingung braucht eines.");
  }
  if (!listMaterials(next).some((material) => material.id === materialId)) {
    throw new Error(
      `Material "${materialId}" ist nicht in der Bibliothek des Szenarios. ` +
        `Erst hinzufügen – ein Szenario trägt seine Einträge selbst.`,
    );
  }
  const label = input.name ?? found.definition.name;
  const id = uniqueId(next, slug(label));
  next.entities.push({
    kind: "constraint",
    id,
    constraintId: input.constraintId,
    materialId,
    name: label,
    opacity: 1,
    pose: {
      position: input.position ?? [0, 0, 0],
      orientation: input.orientation ?? [0, 0, 0, 1],
    },
    ...(input.size ? { size: input.size } : {}),
  });
  insertIntervention(next, { op: "add", t, entityId: id });
  return next;
}

/** Findet eine Entitaet und laesst sie aendern. */
function withEntitySpec(
  scenario: Scenario,
  entityId: string,
  change: (spec: EntitySpec) => void,
): Scenario {
  const next = clone(scenario);
  const spec = next.entities.find((candidate) => candidate.id === entityId);
  if (!spec) throw new Error(`Objekt "${entityId}" existiert nicht im Szenario.`);
  change(spec);
  return next;
}

export function renameEntity(scenario: Scenario, entityId: string, name: string): Scenario {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("Der Name darf nicht leer sein.");
  return withEntitySpec(scenario, entityId, (spec) => {
    spec.name = trimmed;
  });
}

/**
 * Setzt die Opazitaet eines Objekts, 0 (unsichtbar) bis 1 (voll deckend).
 *
 * Gilt fuer jede Entitaetsklasse; eine Last hat keine Darstellung, speichert
 * den Wert aber wie die anderen.
 */
export function setEntityOpacity(scenario: Scenario, entityId: string, opacity: number): Scenario {
  if (!(opacity >= 0 && opacity <= 1)) throw new Error("Die Opazität muss zwischen 0 und 1 liegen.");
  return withEntitySpec(scenario, entityId, (spec) => {
    spec.opacity = opacity;
  });
}

/**
 * Aendert die Startlage eines Objekts.
 *
 * Geaendert wird die Entitaet selbst, nicht ein "Ändern"-Eingriff: das ist die
 * Lage, mit der das Objekt erscheint. Eine Aenderung der Lage *waehrend* des
 * Laufs ist ein Eingriff und steht in der Eingriffsliste.
 */
export function setEntityPose(
  scenario: Scenario,
  entityId: string,
  pose: { position?: Vec3; orientation?: Quat },
): Scenario {
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind === "load") throw new Error(`"${entityId}" ist eine Last; Lasten haben keine Lage.`);
    if (pose.position) spec.pose.position = pose.position;
    if (pose.orientation) spec.pose.orientation = pose.orientation;
  });
}

/** Orientierung in Eulerwinkeln (Grad) setzen - so bedient die Oberflaeche sie. */
export function setEntityRotationDegrees(
  scenario: Scenario,
  entityId: string,
  degrees: [number, number, number],
): Scenario {
  return setEntityPose(scenario, entityId, {
    orientation: quaternionFromEulerDegrees(degrees[0], degrees[1], degrees[2]),
  });
}

export function entityRotationDegrees(spec: EntitySpec): [number, number, number] {
  if (spec.kind === "load") throw new Error(`"${spec.id}" ist eine Last; Lasten haben keine Lage.`);
  return eulerDegreesFromQuaternion(spec.pose.orientation);
}

/**
 * Die wirksame Groesse einer platzierten Flaeche: halbe Ausdehnung in Laengs-
 * und Querrichtung.
 *
 * Fehlt die Instanzgroesse, gilt die des Bibliothekseintrags. Diese aus dem
 * Eintrag zu lesen statt eine Zahl anzunehmen ist der Unterschied zwischen
 * einer richtigen und einer meist richtigen Anzeige: eine per Bibliothekar
 * erzeugte Flaeche hat eine andere Standardgroesse als die mitgelieferte.
 */
export function constraintSizeOf(
  scenario: Scenario,
  spec: EntitySpec,
): [number, number] | undefined {
  if (spec.kind !== "constraint") return undefined;
  if (spec.size) return [spec.size[0], spec.size[1]];
  const entry = scenario.library.find(
    (candidate) =>
      candidate.definition.kind === "constraint" && candidate.definition.id === spec.constraintId,
  );
  if (
    !entry ||
    entry.definition.kind !== "constraint" ||
    entry.definition.behaviour.constraintType !== "staticSurface"
  ) {
    return undefined;
  }
  const segment = entry.definition.behaviour.segments[0];
  return segment ? [segment.halfExtentU, segment.halfExtentV] : undefined;
}

/** Groesse einer Flaeche: halbe Ausdehnung in Laengs- und Querrichtung. */
export function setConstraintSize(
  scenario: Scenario,
  entityId: string,
  size: [number, number],
): Scenario {
  if (!(size[0] > 0 && size[1] > 0)) {
    throw new Error("Laenge und Breite muessen positiv sein.");
  }
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind !== "constraint") {
      throw new Error(`"${entityId}" ist keine Randbedingung; Koerper haben eine Form, keine Flaeche.`);
    }
    spec.size = size;
  });
}

/**
 * Die wirksame Dicke ("Hoehe") einer platzierten Flaeche. Gleiche Regel wie bei
 * `constraintSizeOf`: fehlt die Instanzdicke, gilt die des Bibliothekseintrags.
 */
export function constraintThicknessOf(scenario: Scenario, spec: EntitySpec): number | undefined {
  if (spec.kind !== "constraint") return undefined;
  if (spec.thickness !== undefined) return spec.thickness;
  const entry = scenario.library.find(
    (candidate) =>
      candidate.definition.kind === "constraint" && candidate.definition.id === spec.constraintId,
  );
  if (
    !entry ||
    entry.definition.kind !== "constraint" ||
    entry.definition.behaviour.constraintType !== "staticSurface"
  ) {
    return undefined;
  }
  return entry.definition.behaviour.segments[0]?.thickness;
}

/**
 * Setzt Groesse und Dicke einer Flaeche in einem Zug - die Eigenschaft "Groesse"
 * ist ein Vektor und wird als Ganzes uebernommen, zwei getrennte Aufrufe
 * liefen als zwei Bearbeitungen.
 */
export function setConstraintDimensions(
  scenario: Scenario,
  entityId: string,
  size: [number, number],
  thickness: number,
): Scenario {
  if (!(thickness > 0)) throw new Error("Die Hoehe muss positiv sein.");
  const resized = setConstraintSize(scenario, entityId, size);
  return withEntitySpec(resized, entityId, (spec) => {
    if (spec.kind === "constraint") spec.thickness = thickness;
  });
}

export function setBodyHalfExtents(
  scenario: Scenario,
  entityId: string,
  halfExtents: Vec3,
): Scenario {
  if (!halfExtents.every((value) => value > 0)) {
    throw new Error("Alle Kantenlaengen muessen positiv sein.");
  }
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind !== "body") throw new Error(`"${entityId}" ist kein Koerper.`);
    spec.phase.shape = { type: "box", halfExtents };
  });
}

/**
 * Setzt die Masse eines Koerpers, oder loescht sie wieder.
 *
 * `undefined` heisst: aus Dichte und Volumen berechnen. Das ist der Normalfall
 * und haelt Material und Koerper konsistent - ein Eisenklotz wiegt dann, was er
 * wiegen soll.
 */
export function setBodyMass(
  scenario: Scenario,
  entityId: string,
  mass: number | undefined,
): Scenario {
  if (mass !== undefined && !(mass > 0)) throw new Error("Die Masse muss positiv sein.");
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind !== "body") throw new Error(`"${entityId}" ist kein Koerper.`);
    if (mass === undefined) delete spec.mass;
    else spec.mass = mass;
  });
}

/**
 * Wechselt das Material eines Koerpers oder einer Ebene. Form, Lage und eine
 * ausdruecklich gesetzte Masse bleiben; ohne gesetzte Masse aendert sich die
 * Masse mit der Dichte - genau das soll ein Materialwechsel zeigen.
 */
export function setEntityMaterial(scenario: Scenario, entityId: string, materialId: string): Scenario {
  if (!listMaterials(scenario).some((material) => material.id === materialId)) {
    throw new Error(`Material "${materialId}" ist nicht in der Bibliothek des Szenarios.`);
  }
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind === "load") throw new Error(`"${entityId}" hat kein Material.`);
    spec.materialId = materialId;
  });
}

export function setBodyInitialVelocity(
  scenario: Scenario,
  entityId: string,
  linear: Vec3,
): Scenario {
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind !== "body") throw new Error(`"${entityId}" ist kein Koerper.`);
    spec.velocity.linear = linear;
  });
}

/**
 * Loescht ein Objekt vollstaendig - seine Definition und alle Eingriffe auf es.
 *
 * Bleibt ein Eingriff stehen, der auf ein nicht mehr vorhandenes Objekt
 * verweist, bricht der Lauf ab. Die Regieanweisungen werden mit aufgeraeumt.
 */
export function deleteEntity(scenario: Scenario, entityId: string): Scenario {
  const next = clone(scenario);
  next.entities = next.entities.filter((entity) => entity.id !== entityId);
  next.interventions = next.interventions.filter(
    (intervention) => intervention.op === "setEnvironment" || intervention.entityId !== entityId,
  );
  next.directionTrack = next.directionTrack.filter(
    (cue) => !("entityId" in cue && cue.entityId === entityId),
  );
  return next;
}

// ---------------------------------------------------------------- Eingriffe

/**
 * Nimmt ein Objekt ab der Zeit `t` aus der Szene - per `remove`-Eingriff, nicht
 * durch Loeschen seines `add`. Das ist der didaktisch interessante Fall: das
 * Objekt war da und ist dann weg.
 */
export function removeEntityAt(scenario: Scenario, t: number, entityId: string): Scenario {
  const next = clone(scenario);
  const time = roundInterventionTime(t);
  const alreadyRemoved = next.interventions.some(
    (intervention) =>
      intervention.op === "remove" &&
      intervention.entityId === entityId &&
      sameTime(intervention.t, time),
  );
  if (!alreadyRemoved) insertIntervention(next, { op: "remove", t: time, entityId });
  return next;
}

/**
 * Fuegt ein Objekt ab der Zeit `t` der Szene hinzu - per `add`-Eingriff auf
 * die vorhandene Definition. Gegenstueck zu `removeEntityAt`.
 */
export function addEntityAt(scenario: Scenario, t: number, entityId: string): Scenario {
  const next = clone(scenario);
  const time = roundInterventionTime(t);
  if (!next.entities.some((entity) => entity.id === entityId)) {
    throw new Error(`Objekt "${entityId}" existiert nicht im Szenario.`);
  }
  const alreadyAdded = next.interventions.some(
    (intervention) =>
      intervention.op === "add" &&
      intervention.entityId === entityId &&
      sameTime(intervention.t, time),
  );
  if (!alreadyAdded) insertIntervention(next, { op: "add", t: time, entityId });
  return next;
}

/**
 * Der Wert, den eine Eigenschaft zur Zeit `t` hat - als Aenderung verpackt,
 * so wie ein neuer "Ändern"-Eingriff ihn vorbelegt.
 *
 * Eingabeeigenschaften kommen aus `entitySpecAt` (Startwert plus fruehere
 * Aenderungen). Die Geschwindigkeiten eines Koerpers sind Zustand, und wo er
 * zur Zeit `t` steht, weiss nur die Aufzeichnung - die liest die Bearbeitung
 * nie (kein Pfeil von der Aufzeichnung ins Szenario). Sie starten deshalb bei
 * null, was zugleich das alte "Anhalten" ist; Lage und Drehung eines Koerpers
 * bei der Startlage.
 */
export function changeValueAt(scenario: Scenario, entityId: string, key: ChangeKey, t: number): EntityChange {
  const spec = entitySpecAt(scenario, entityId, t);
  if (!spec) throw new Error(`Objekt "${entityId}" existiert nicht im Szenario.`);
  if (!changeKeyAllowed(spec.kind, key)) throw new Error(`"${spec.name ?? entityId}" hat keine Eigenschaft "${key}".`);
  const missing = (): never => {
    throw new Error(`"${spec.name ?? entityId}" hat keine Eigenschaft "${key}".`);
  };
  switch (key) {
    case "linearVelocity":
    case "angularVelocity":
      return { key, value: [0, 0, 0] };
    case "position":
      return { key, value: spec.kind === "load" ? missing() : [...spec.pose.position] };
    case "orientation":
      return { key, value: spec.kind === "load" ? missing() : [...spec.pose.orientation] };
    case "halfExtents":
      return {
        key,
        value: spec.kind === "body" && spec.phase.shape.type === "box" ? [...spec.phase.shape.halfExtents] : missing(),
      };
    case "dimensions": {
      const size = constraintSizeOf(scenario, spec) ?? missing();
      const thickness = constraintThicknessOf(scenario, spec) ?? missing();
      return { key, value: [size[0], size[1], thickness] };
    }
    case "materialId":
      return { key, value: spec.kind === "load" ? missing() : spec.materialId };
    case "opacity":
      return { key, value: spec.opacity };
    case "magnitude":
      return { key, value: spec.kind === "load" ? spec.magnitude : missing() };
    case "direction":
      return { key, value: spec.kind === "load" ? [...spec.direction] : missing() };
  }
}

/**
 * Die Eigenschaft, die ein neuer "Ändern"-Eingriff ohne Angabe bekommt: beim
 * Koerper die Geschwindigkeit (mit null vorbelegt ist das das fruehere
 * "Anhalten"), sonst der erste Schluessel der Art - aber keiner, den das Objekt
 * zu dieser Zeit schon aendert, damit ein zweites "Ändern" etwas Neues anlegt.
 */
function defaultChangeKey(scenario: Scenario, spec: EntitySpec, t: number): ChangeKey {
  const keys = Object.keys(CHANGE_KEYS[spec.kind]) as ChangeKey[];
  const ordered: ChangeKey[] =
    spec.kind === "body" ? ["linearVelocity", ...keys.filter((key) => key !== "linearVelocity")] : keys;
  const used = new Set(
    scenario.interventions
      .filter((item) => item.op === "change" && item.entityId === spec.id && sameTime(item.t, t))
      .map((item) => (item.op === "change" ? item.change.key : undefined)),
  );
  return ordered.find((key) => !used.has(key)) ?? ordered[0]!;
}

/**
 * Legt einen "Ändern"-Eingriff zur Zeit `t` an. Ohne `change` mit der
 * Voreinstellung (`defaultChangeKey`, Wert aus `changeValueAt`).
 *
 * Aendert dasselbe Objekt dieselbe Eigenschaft zur selben Zeit schon, wird
 * dessen Wert ersetzt: zwei solche Eingriffe hiessen, dass einer nie sichtbar
 * wirkt.
 */
export function addChangeAt(scenario: Scenario, t: number, entityId: string, change?: EntityChange): Scenario {
  const time = roundInterventionTime(t);
  const spec = scenario.entities.find((candidate) => candidate.id === entityId);
  if (!spec) throw new Error(`Objekt "${entityId}" existiert nicht im Szenario.`);
  const chosen = change ?? changeValueAt(scenario, entityId, defaultChangeKey(scenario, spec, time), time);
  if (!changeKeyAllowed(spec.kind, chosen.key)) {
    throw new Error(`"${spec.name ?? entityId}" hat keine Eigenschaft "${chosen.key}".`);
  }
  const next = clone(scenario);
  const existing = next.interventions.find(
    (item) =>
      item.op === "change" &&
      item.entityId === entityId &&
      item.change.key === chosen.key &&
      sameTime(item.t, time),
  );
  if (existing && existing.op === "change") existing.change = structuredClone(chosen);
  else insertIntervention(next, { op: "change", t: time, entityId, change: structuredClone(chosen) });
  return next;
}

/**
 * Ersetzt Eigenschaft und/oder Wert eines vorhandenen "Ändern"-Eingriffs - die
 * Wertbearbeitung in der Eingriffsliste. Zeit und Position in der Liste
 * bleiben.
 */
export function setInterventionChange(scenario: Scenario, index: number, change: EntityChange): Scenario {
  const target = scenario.interventions[index];
  if (!target) throw new Error(`Es gibt keinen Eingriff an Position ${index}.`);
  if (target.op !== "change") throw new Error(`Eingriff ${index} ist kein "Ändern".`);
  const spec = scenario.entities.find((candidate) => candidate.id === target.entityId);
  if (!spec) throw new Error(`Objekt "${target.entityId}" existiert nicht im Szenario.`);
  if (!changeKeyAllowed(spec.kind, change.key)) {
    throw new Error(`"${spec.name ?? spec.id}" hat keine Eigenschaft "${change.key}".`);
  }
  if (change.key !== target.change.key) {
    const taken = scenario.interventions.some(
      (item, i) =>
        i !== index &&
        item.op === "change" &&
        item.entityId === target.entityId &&
        item.change.key === change.key &&
        sameTime(item.t, target.t),
    );
    if (taken) {
      throw new Error(`„${spec.name ?? spec.id}“ ändert diese Eigenschaft zur selben Zeit schon.`);
    }
  }
  const next = clone(scenario);
  next.interventions[index] = { ...target, change: structuredClone(change) };
  return next;
}

/**
 * Wirft Eingriffe weg, die ein Objekt ansprechen, das zu dem Zeitpunkt nicht in
 * der Szene ist (`mutiert`). Nach dem Entfernen eines `add` bliebe sonst z. B.
 * ein "Ändern" zurueck, und der Lauf braeche mit "unbekannte Entitaet" ab.
 */
function dropInterventionsOnAbsentEntity(scenario: Scenario, entityId: string): void {
  const dropped = new Set<Intervention>();
  let present = false;
  for (const intervention of interventionsInOrder(scenario)) {
    if (intervention.op === "setEnvironment" || intervention.entityId !== entityId) continue;
    if (intervention.op === "add") present = true;
    else if (intervention.op === "remove") {
      if (!present) dropped.add(intervention);
      present = false;
    } else if (!present) dropped.add(intervention);
  }
  scenario.interventions = scenario.interventions.filter((intervention) => !dropped.has(intervention));
}

/**
 * Prueft, ob die Eingriffe auf ein Objekt in ihrer Zeitfolge zusammenpassen:
 * kein `add` auf ein schon vorhandenes, kein anderer Eingriff auf ein
 * fehlendes. Sonst braeche der Lauf ab - besser die Bearbeitung ablehnen, als
 * Eingriffe still wegzuwerfen, die erst durch das Verschieben ungueltig wurden.
 */
function timelineProblem(scenario: Scenario, entityId: string): string | undefined {
  const name = scenario.entities.find((entity) => entity.id === entityId)?.name ?? entityId;
  let present = false;
  for (const intervention of interventionsInOrder(scenario)) {
    if (intervention.op === "setEnvironment" || intervention.entityId !== entityId) continue;
    const at = `t = ${intervention.t.toFixed(2)} s`;
    if (intervention.op === "add") {
      if (present) return `"${name}" wäre bei ${at} schon in der Szene.`;
      present = true;
    } else if (!present) {
      return `"${name}" wäre bei ${at} nicht in der Szene.`;
    } else if (intervention.op === "remove") {
      present = false;
    }
  }
  return undefined;
}

/** Entfernt einen einzelnen Eingriff - fuer die Eingriffsliste. */
export function removeIntervention(scenario: Scenario, index: number): Scenario {
  const next = clone(scenario);
  const target = next.interventions[index];
  if (!target) throw new Error(`Es gibt keinen Eingriff an Position ${index}.`);
  // Auch ein `add`: es verweist nur auf das Objekt, die Definition bleibt in
  // `entities`. Das Objekt ganz zu loeschen ist `deleteEntity`.
  next.interventions.splice(index, 1);
  if (target.op === "add") dropInterventionsOnAbsentEntity(next, target.entityId);
  return next;
}

/**
 * Verschiebt einen einzelnen Eingriff auf eine andere Zeit.
 *
 * Er wandert hinter die Eingriffe, die schon zur neuen Zeit stehen - wie ein
 * dort neu angelegter. Eingriffe anderer Objekte spielen keine Rolle, auch die
 * Reihenfolge zu ihnen darf sich aendern. Nur wenn die Zeitfolge desselben
 * Objekts danach nicht mehr passt (das `add` hinter seinem "Ändern"), springt
 * die Zeit auf den naechsten moeglichen Wert und `report` bekommt die Meldung;
 * ein anderer Eingriff wird dabei nie veraendert.
 */
export function setInterventionTime(
  scenario: Scenario,
  index: number,
  t: number,
  report?: (message: string) => void,
): Scenario {
  const target = scenario.interventions[index];
  if (!target) throw new Error(`Es gibt keinen Eingriff an Position ${index}.`);
  const desired = roundInterventionTime(t);
  if (sameTime(target.t, desired)) return scenario;

  const place = (time: number): Scenario => {
    const next = clone(scenario);
    next.interventions.splice(index, 1);
    insertIntervention(next, { ...target, t: time });
    return next;
  };
  if (target.op === "setEnvironment") return place(desired);
  const entityId = target.entityId;
  const problem = timelineProblem(place(desired), entityId);
  if (!problem) return place(desired);

  // Machbar ist ein Bereich um die alte Zeit; seine Grenze liegt an der Zeit
  // eines anderen Eingriffs desselben Objekts. Nach vorn endet er auf dessen
  // Zeit (der Eingriff wandert dahinter), nach hinten eine Rundungsstufe davor.
  const others = scenario.interventions.filter(
    (other, i) => i !== index && other.op !== "setEnvironment" && other.entityId === entityId,
  );
  const earlier = desired < target.t;
  const candidates = earlier
    ? others.map((other) => other.t).filter((time) => time > desired && time < target.t)
    : others
        .map((other) => roundInterventionTime(other.t - INTERVENTION_TIME_STEP))
        .filter((time) => time < desired && time > target.t);
  candidates.sort((a, b) => (earlier ? a - b : b - a));
  const limit = candidates.find((time) => !timelineProblem(place(time), entityId));
  if (limit === undefined) throw new Error(problem);
  report?.(
    `${problem.replace(/ wäre bei .*$/, "")}: Reihenfolge der Eingriffe darf sich nicht ändern, ` +
      `Zeit auf ${limit.toFixed(2)} s begrenzt.`,
  );
  return place(limit);
}

// ---------------------------------------------------------------- Gesamtdauer

/**
 * Setzt die Gesamtdauer. Eingriffe dahinter bleiben stehen und wirken nur
 * nicht - wer die Dauer wieder verlaengert, hat sie zurueck.
 */
export function setTotalDuration(scenario: Scenario, duration: number): Scenario {
  if (!(duration > 0)) throw new Error("Die Gesamtdauer muss positiv sein.");
  if (duration > MAX_DURATION) {
    throw new Error(`Die Gesamtdauer darf ${MAX_DURATION} s nicht überschreiten.`);
  }
  const next = clone(scenario);
  next.duration = duration;
  return next;
}

// ---------------------------------------------------------------- Lasten

export interface AddLoadInput {
  /** Zeitpunkt des `add`-Eingriffs, in Sekunden. */
  t: number;
  loadId: string;
  name?: string;
  magnitude?: number;
  direction?: Vec3;
}

/**
 * Platziert eine Last - genau wie `addConstraint`, nur ohne Lage: eine Last
 * wirkt unabhaengig vom Ort auf jeden Koerper der Szene. Ohne eigene Angabe
 * startet sie wie die Erdbeschleunigung, damit ein frisch hinzugefuegtes
 * Objekt sofort faellt.
 */
export function addLoad(scenario: Scenario, input: AddLoadInput): Scenario {
  const next = clone(scenario);
  const t = roundInterventionTime(input.t);
  const found = next.library.find(
    (entry) => entry.definition.kind === "load" && entry.definition.id === input.loadId,
  );
  if (!found) {
    throw new Error(`Last "${input.loadId}" ist nicht in der Bibliothek des Szenarios.`);
  }
  const label = input.name ?? found.definition.name;
  const id = uniqueId(next, slug(label));
  next.entities.push({
    kind: "load",
    id,
    loadId: input.loadId,
    name: label,
    opacity: 1,
    magnitude: input.magnitude ?? EARTH_GRAVITY,
    direction: input.direction ?? [0, 0, -1],
  });
  insertIntervention(next, { op: "add", t, entityId: id });
  return next;
}

export function setLoadMagnitude(scenario: Scenario, entityId: string, magnitude: number): Scenario {
  if (!(magnitude >= 0)) throw new Error("Die Stärke darf nicht negativ sein.");
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind !== "load") throw new Error(`"${entityId}" ist keine Last.`);
    spec.magnitude = magnitude;
  });
}

export function setLoadDirection(scenario: Scenario, entityId: string, direction: Vec3): Scenario {
  return withEntitySpec(scenario, entityId, (spec) => {
    if (spec.kind !== "load") throw new Error(`"${entityId}" ist keine Last.`);
    spec.direction = direction;
  });
}

// ---------------------------------------------------------------- Bibliothek

export function addLibraryEntry(scenario: Scenario, entry: LibraryEntry): Scenario {
  const next = clone(scenario);
  const index = next.library.findIndex(
    (candidate) => candidate.definition.id === entry.definition.id,
  );
  if (index >= 0) next.library[index] = entry;
  else next.library.push(entry);
  return next;
}

export function renameScenario(scenario: Scenario, name: string): Scenario {
  // Nicht trimmen: das liefe bei jedem Tastendruck, und ein Leerzeichen am
  // Ende waere sofort wieder weg, bevor das naechste Zeichen folgt - im
  // Feld liesse sich dann nie ein Leerzeichen eingeben.
  if (name.trim() === "") throw new Error("Der Name darf nicht leer sein.");
  const next = clone(scenario);
  next.name = name;
  return next;
}

export function setViewLayer(scenario: Scenario, layer: ViewLayer): Scenario {
  const next = clone(scenario);
  next.view.layer = layer;
  return next;
}

export function setAxesVisible(scenario: Scenario, visible: boolean): Scenario {
  const next = clone(scenario);
  next.view.showAxes = visible;
  return next;
}

/** Haelt die Kamera fest, wie sie beim Speichern im Betrachter steht. */
export function setViewCamera(scenario: Scenario, camera: { position: Vec3; target: Vec3 }): Scenario {
  const next = clone(scenario);
  next.view.camera = { position: [...camera.position], target: [...camera.target] };
  return next;
}

/** Prueft ein bearbeitetes Szenario gegen das Schema - vor jedem Lauf. */
export function validateScenario(scenario: Scenario): { ok: true } | { ok: false; errors: string[] } {
  const parsed = ScenarioSchema.safeParse(scenario);
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<wurzel>"}: ${issue.message}`),
  };
}

function slug(value: string): string {
  const replacements: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
  const normalized = [...value.trim().toLowerCase()]
    .map((character) => replacements[character] ?? character)
    .join("");
  const result = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result === "" ? "objekt" : result.slice(0, 48);
}
