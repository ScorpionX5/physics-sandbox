import {
  changeKeyAllowed,
  entitySpecAt,
  eulerDegreesFromQuaternion,
  quaternionFromEulerDegrees,
  type ChangeKey,
  type EntityChange,
  type EntitySpec,
  type Intervention,
  type LibraryEntry,
  type Scenario,
  type Vec3,
} from "@sandbox/schema";

import {
  changeValueAt,
  constraintSizeOf,
  constraintThicknessOf,
  entityRotationDegrees,
  listMaterials,
  setBodyHalfExtents,
  setBodyInitialAngularVelocity,
  setBodyInitialVelocity,
  setConstraintDimensions,
  setEntityMaterial,
  setEntityOpacity,
  setEntityPose,
  setEntityRotationDegrees,
  setLoadDirection,
  setInterventionChange,
  setLoadMagnitude,
} from "./scenarioEdits.js";

/**
 * Die Eigenschaften der rechten Leiste: welche Entitaet welche Werte zeigt,
 * in welcher Gruppe und in welcher Form.
 *
 * **Eine Eigenschaft gehoert einer Klasse und vererbt sich.** Die Opazitaet
 * steht einmal am Objekt und erscheint deshalb an jeder Entitaet; die
 * Kantenlaenge steht am Quader und erscheint an keiner Ebene. Wer eine neue
 * Eigenschaft anlegt, ordnet sie einer Klasse zu - nicht einer Stelle im
 * Inspektor. Frueher stand jede Eigenschaft je Entitaetsart von Hand im
 * Inspektor, und Opazitaet, Staerke und Groesse sahen jeweils etwas anders aus.
 *
 * **Der Typ bestimmt die Darstellung**, nicht die Eigenschaft. Dadurch sehen
 * zwei Vektoren immer gleich aus, egal wem sie gehoeren.
 *
 * **Eine Eigenschaft ist auch das Eingabefeld eines "Ändern"-Eingriffs**, wenn
 * sie eine Aenderungsbindung (`change`) hat: Schluessel und Umrechnung zwischen
 * Speicherwert (Quaternion, halbe Kante) und Anzeige. So zeigt ein geaenderter
 * Wert dieselbe Zeile, Einheit und Umrechnung wie der Startwert. Zustandsgroessen
 * ohne Startwert-Feld (Geschwindigkeit, Winkelgeschwindigkeit) stehen mit
 * `scope: "change"` nur in Aenderungen.
 *
 * Ohne React, damit es sich wie `scenarioEdits.ts` testen laesst. Gelesen und
 * geschrieben wird immer das Szenario - eine Eigenschaft hat keinen eigenen
 * Zustand.
 */

// ---------------------------------------------------------------- Klassen

export type EntityClass =
  | "object"
  | "body"
  | "constraint"
  | "load"
  | "cuboid"
  | "plane"
  | "gravity";

/** Oberklasse je Klasse; `object` ist die Wurzel. */
const PARENT_CLASS: Record<EntityClass, EntityClass | undefined> = {
  object: undefined,
  body: "object",
  constraint: "object",
  load: "object",
  cuboid: "body",
  plane: "constraint",
  gravity: "load",
};

/**
 * Die speziellste Klasse einer Entitaet.
 *
 * Beim Koerper entscheidet die wirksame Form (`phase.shape`), nicht der
 * Bibliothekseintrag: die Kantenlaenge wird dort gelesen, und ein fremdes
 * Szenario kann einen Eintrag nennen, der nicht zur Form passt. Bei der
 * Randbedingung entscheidet, ob sie eine Instanzgroesse hat - genau das macht
 * sie zur Ebene. Bei der Last entscheidet der Eintrag, weil Staerke und
 * Richtung an jeder `LoadSpec` stehen, aber nur bei der Gravitation etwas
 * bedeuten.
 */
export function entityClassOf(scenario: Scenario, spec: EntitySpec): EntityClass {
  if (spec.kind === "body") return spec.phase.shape.type === "box" ? "cuboid" : "body";
  if (spec.kind === "constraint") {
    return constraintSizeOf(scenario, spec) !== undefined ? "plane" : "constraint";
  }
  const entry = scenario.library.find(
    (candidate) => candidate.definition.kind === "load" && candidate.definition.id === spec.loadId,
  );
  return entry?.definition.kind === "load" && entry.definition.behaviour.loadType === "gravity"
    ? "gravity"
    : "load";
}

/** Der Name einer Klasse, wie er in der Oberflaeche erscheint. */
export const ENTITY_CLASS_LABELS: Record<EntityClass, string> = {
  object: "Objekt",
  body: "Körper",
  constraint: "Randbedingung",
  load: "Last",
  cuboid: "Quader",
  plane: "Ebene",
  gravity: "Gravitation",
};

/**
 * Die Klasse, deren Entitaeten aus einem Bibliothekseintrag entstehen.
 *
 * Ein Material ist keine Entitaet und hat deshalb keine Klasse. Ein Eintrag
 * ohne eigene Unterklasse (die Waermequelle) faellt auf seine Oberklasse
 * zurueck - wie `entityClassOf` bei der platzierten Entitaet.
 */
export function libraryEntryClassOf(entry: LibraryEntry): EntityClass | undefined {
  const definition = entry.definition;
  switch (definition.kind) {
    case "body":
      return definition.behaviour.bodyType === "cuboid" ? "cuboid" : "body";
    case "constraint":
      return definition.behaviour.constraintType === "staticSurface" ? "plane" : "constraint";
    case "load":
      return definition.behaviour.loadType === "gravity" ? "gravity" : "load";
    case "material":
      return undefined;
  }
}

/** Die Klasse und alle ihre Oberklassen, von speziell nach allgemein. */
export function classChain(entityClass: EntityClass): EntityClass[] {
  const chain: EntityClass[] = [];
  for (let current: EntityClass | undefined = entityClass; current; current = PARENT_CLASS[current]) {
    chain.push(current);
  }
  return chain;
}

// ---------------------------------------------------------------- Gruppen

export type PropertyGroup = "geometry" | "material" | "kinematics" | "appearance";

/** Reihenfolge der Gruppen in der Leiste. */
export const PROPERTY_GROUPS: readonly PropertyGroup[] = [
  "geometry",
  "material",
  "kinematics",
  "appearance",
];

// ---------------------------------------------------------------- Eigenschaften

interface PropertyBase {
  id: string;
  label: string;
  group: PropertyGroup;
  /** Die Klassen, denen die Eigenschaft gehoert; Unterklassen erben sie. */
  classes: readonly EntityClass[];
  /**
   * `"change"`: nur in einem "Ändern"-Eingriff, nicht bei den Startwerten -
   * fuer Zustandsgroessen, die kein Eingabefeld haben. Fehlt es, steht die
   * Eigenschaft bei den Startwerten (und in Aenderungen, falls `change` gesetzt).
   */
  scope?: "change";
}

/**
 * Wie eine Eigenschaft in einer Aenderung steht: ihr Schluessel und die
 * Umrechnung zwischen gespeichertem Wert und Anzeige (`D`).
 */
export interface ChangeBinding<D> {
  key: ChangeKey;
  fromChange(change: EntityChange): D;
  toChange(value: D): EntityChange;
}

export interface Vector3Property extends PropertyBase {
  type: "vector3";
  unit: string;
  step: number;
  get(scenario: Scenario, spec: EntitySpec): Vec3;
  set(scenario: Scenario, entityId: string, value: Vec3): Scenario;
  change?: ChangeBinding<Vec3>;
}

export interface Vector2Property extends PropertyBase {
  type: "vector2";
  /** Beschriftung der beiden Felder, z. B. L und B. */
  axes: readonly [string, string];
  unit: string;
  step: number;
  min?: number;
  get(scenario: Scenario, spec: EntitySpec): [number, number];
  set(scenario: Scenario, entityId: string, value: [number, number]): Scenario;
  change?: ChangeBinding<[number, number]>;
}

export interface PercentProperty extends PropertyBase {
  type: "percent";
  /** In Prozentpunkten, wie die Felder anderer Typen in ihrer Einheit. */
  step: number;
  /** Anteil 0..1; die Darstellung rechnet in Prozent. */
  get(scenario: Scenario, spec: EntitySpec): number;
  set(scenario: Scenario, entityId: string, fraction: number): Scenario;
  change?: ChangeBinding<number>;
}

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface ChoiceProperty extends PropertyBase {
  type: "choice";
  options(scenario: Scenario, spec: EntitySpec): ChoiceOption[];
  get(scenario: Scenario, spec: EntitySpec): string;
  set(scenario: Scenario, entityId: string, value: string): Scenario;
  change?: ChangeBinding<string>;
}

export interface NumberProperty extends PropertyBase {
  type: "number";
  unit: string;
  step: number;
  min?: number;
  get(scenario: Scenario, spec: EntitySpec): number;
  set(scenario: Scenario, entityId: string, value: number): Scenario;
  change?: ChangeBinding<number>;
}

export type EntityProperty =
  | Vector3Property
  | Vector2Property
  | PercentProperty
  | ChoiceProperty
  | NumberProperty;

export type PropertyType = EntityProperty["type"];

/**
 * Die Getter werden nur fuer Entitaeten der passenden Klasse aufgerufen; die
 * Pruefungen darin fangen deshalb nur Programmierfehler ab.
 */
function wrongClass(property: string, spec: EntitySpec): never {
  throw new Error(`"${spec.id}" hat keine Eigenschaft "${property}".`);
}

/** Ein Wert aus einer Aenderung - die Bindung wird nur mit ihrem eigenen Schluessel gerufen. */
function valueOf<K extends ChangeKey>(change: EntityChange, key: K): ChangeValues[K] {
  if (change.key !== key) throw new Error(`Aenderung "${change.key}" ist keine "${key}".`);
  // Nach der Pruefung oben ist es genau die Variante mit diesem Schluessel;
  // TypeScript kann das bei einem generischen Schluessel nicht selbst schliessen.
  return change.value as ChangeValues[K];
}

/** Werttyp je Aenderungsschluessel. */
type ChangeValues = { [C in EntityChange as C["key"]]: C["value"] };

/** Startwert-Zugriff einer Eigenschaft, die es nur in Aenderungen gibt - wird nie gerufen. */
function changeOnly(property: string): never {
  throw new Error(`"${property}" gibt es nur in einem "Ändern"-Eingriff.`);
}

const DEGREES_PER_RADIAN = 180 / Math.PI;

function degreesPerSecond(omega: Vec3): Vec3 {
  return [omega[0] * DEGREES_PER_RADIAN, omega[1] * DEGREES_PER_RADIAN, omega[2] * DEGREES_PER_RADIAN];
}

function radiansPerSecond(degrees: Vec3): Vec3 {
  return [degrees[0] / DEGREES_PER_RADIAN, degrees[1] / DEGREES_PER_RADIAN, degrees[2] / DEGREES_PER_RADIAN];
}

/**
 * Alle Eigenschaften. Die Reihenfolge hier ist die Reihenfolge innerhalb
 * einer Gruppe.
 */
export const ENTITY_PROPERTIES: readonly EntityProperty[] = [
  {
    id: "position",
    label: "Position",
    type: "vector3",
    group: "geometry",
    classes: ["constraint", "body"],
    unit: "m",
    step: 0.1,
    get: (_scenario, spec) => (spec.kind === "load" ? wrongClass("position", spec) : spec.pose.position),
    set: (scenario, entityId, position) => setEntityPose(scenario, entityId, { position }),
    change: {
      key: "position",
      fromChange: (change) => valueOf(change, "position"),
      toChange: (value) => ({ key: "position", value }),
    },
  },
  {
    id: "rotation",
    label: "Drehung",
    type: "vector3",
    group: "geometry",
    classes: ["constraint", "body"],
    unit: "°",
    step: 5,
    get: (_scenario, spec) => entityRotationDegrees(spec),
    set: (scenario, entityId, degrees) =>
      setEntityRotationDegrees(scenario, entityId, [degrees[0], degrees[1], degrees[2]]),
    change: {
      key: "orientation",
      fromChange: (change) => eulerDegreesFromQuaternion(valueOf(change, "orientation")),
      toChange: (degrees) => ({
        key: "orientation",
        value: quaternionFromEulerDegrees(degrees[0], degrees[1], degrees[2]),
      }),
    },
  },
  {
    id: "size",
    label: "Größe",
    type: "vector3",
    group: "geometry",
    classes: ["plane"],
    unit: "m",
    step: 0.5,
    // x = Laenge, y = Breite, z = Hoehe (Plattendicke). Laenge und Breite
    // werden als ganze Ausdehnung angezeigt, gespeichert ist die halbe; die
    // Hoehe ist gespeichert wie angezeigt.
    get: (scenario, spec) => {
      const size = constraintSizeOf(scenario, spec) ?? wrongClass("size", spec);
      const height = constraintThicknessOf(scenario, spec) ?? wrongClass("size", spec);
      return [size[0] * 2, size[1] * 2, height];
    },
    set: (scenario, entityId, value) =>
      setConstraintDimensions(scenario, entityId, [value[0] / 2, value[1] / 2], value[2]),
    change: {
      key: "dimensions",
      fromChange: (change) => {
        const [halfU, halfV, height] = valueOf(change, "dimensions");
        return [halfU * 2, halfV * 2, height];
      },
      toChange: (value) => ({ key: "dimensions", value: [value[0] / 2, value[1] / 2, value[2]] }),
    },
  },
  {
    id: "edges",
    label: "Kantenlänge",
    type: "vector3",
    group: "geometry",
    classes: ["cuboid"],
    unit: "m",
    step: 0.05,
    get: (_scenario, spec) => {
      if (spec.kind !== "body" || spec.phase.shape.type !== "box") return wrongClass("edges", spec);
      const half = spec.phase.shape.halfExtents;
      return [half[0] * 2, half[1] * 2, half[2] * 2];
    },
    set: (scenario, entityId, edges) =>
      setBodyHalfExtents(scenario, entityId, [edges[0] / 2, edges[1] / 2, edges[2] / 2]),
    change: {
      key: "halfExtents",
      fromChange: (change) => {
        const half = valueOf(change, "halfExtents");
        return [half[0] * 2, half[1] * 2, half[2] * 2];
      },
      toChange: (edges) => ({ key: "halfExtents", value: [edges[0] / 2, edges[1] / 2, edges[2] / 2] }),
    },
  },
  {
    id: "material",
    label: "Material",
    type: "choice",
    group: "material",
    classes: ["body", "plane"],
    options: (scenario, spec) => {
      const options = listMaterials(scenario).map((material) => ({
        value: material.id,
        label: material.name,
      }));
      // Ein Verweis auf ein Material, das die Bibliothek nicht (mehr) hat,
      // bleibt als Option stehen - sonst zeigte das Feld stillschweigend ein
      // anderes an, als der Koerper hat.
      if (spec.kind !== "load" && !options.some((option) => option.value === spec.materialId)) {
        options.unshift({ value: spec.materialId, label: spec.materialId });
      }
      return options;
    },
    get: (_scenario, spec) => (spec.kind !== "load" ? spec.materialId : wrongClass("material", spec)),
    set: setEntityMaterial,
    change: {
      key: "materialId",
      fromChange: (change) => valueOf(change, "materialId"),
      toChange: (value) => ({ key: "materialId", value }),
    },
  },
  {
    id: "velocity",
    label: "Startgeschw.",
    type: "vector3",
    group: "kinematics",
    classes: ["body"],
    unit: "m/s",
    step: 0.5,
    get: (_scenario, spec) => (spec.kind === "body" ? spec.velocity.linear : wrongClass("velocity", spec)),
    set: setBodyInitialVelocity,
  },
  {
    // Angezeigt in Grad je Sekunde wie "Winkelgeschw." in Aenderungen,
    // gespeichert in rad/s.
    id: "initialAngularVelocity",
    label: "Startwinkelgeschw.",
    type: "vector3",
    group: "kinematics",
    classes: ["body"],
    unit: "°/s",
    step: 15,
    get: (_scenario, spec) =>
      spec.kind === "body" ? degreesPerSecond(spec.velocity.angular) : wrongClass("initialAngularVelocity", spec),
    set: (scenario, entityId, degrees) =>
      setBodyInitialAngularVelocity(scenario, entityId, radiansPerSecond(degrees)),
  },
  {
    // Die Geschwindigkeit waehrend des Laufs ist Zustand: es gibt sie nur als
    // Aenderung. Der Startwert ist "Startgeschw." darueber.
    id: "linearVelocity",
    label: "Geschwindigkeit",
    type: "vector3",
    group: "kinematics",
    classes: ["body"],
    scope: "change",
    unit: "m/s",
    step: 0.5,
    get: () => changeOnly("linearVelocity"),
    set: () => changeOnly("linearVelocity"),
    change: {
      key: "linearVelocity",
      fromChange: (change) => valueOf(change, "linearVelocity"),
      toChange: (value) => ({ key: "linearVelocity", value }),
    },
  },
  {
    // In Grad je Sekunde angezeigt wie die Drehung in Grad; gespeichert in rad/s.
    id: "angularVelocity",
    label: "Winkelgeschw.",
    type: "vector3",
    group: "kinematics",
    classes: ["body"],
    scope: "change",
    unit: "°/s",
    step: 15,
    get: () => changeOnly("angularVelocity"),
    set: () => changeOnly("angularVelocity"),
    change: {
      key: "angularVelocity",
      fromChange: (change) => degreesPerSecond(valueOf(change, "angularVelocity")),
      toChange: (degrees) => ({ key: "angularVelocity", value: radiansPerSecond(degrees) }),
    },
  },
  {
    id: "magnitude",
    label: "Stärke",
    type: "number",
    group: "kinematics",
    classes: ["gravity"],
    unit: "m/s²",
    step: 0.01,
    min: 0,
    get: (_scenario, spec) => (spec.kind === "load" ? spec.magnitude : wrongClass("magnitude", spec)),
    set: setLoadMagnitude,
    change: {
      key: "magnitude",
      fromChange: (change) => valueOf(change, "magnitude"),
      toChange: (value) => ({ key: "magnitude", value }),
    },
  },
  {
    id: "direction",
    label: "Richtung",
    type: "vector3",
    group: "kinematics",
    classes: ["gravity"],
    unit: "",
    step: 0.1,
    get: (_scenario, spec) => (spec.kind === "load" ? spec.direction : wrongClass("direction", spec)),
    set: setLoadDirection,
    change: {
      key: "direction",
      fromChange: (change) => valueOf(change, "direction"),
      toChange: (value) => ({ key: "direction", value }),
    },
  },
  {
    id: "opacity",
    label: "Opazität",
    type: "percent",
    group: "appearance",
    classes: ["object"],
    step: 5,
    get: (_scenario, spec) => spec.opacity,
    set: setEntityOpacity,
    change: {
      key: "opacity",
      fromChange: (change) => valueOf(change, "opacity"),
      toChange: (value) => ({ key: "opacity", value }),
    },
  },
];

/** Die Eigenschaften einer Entitaet, nach Gruppen geordnet; leere Gruppen fehlen. */
export function propertyGroupsOf(
  scenario: Scenario,
  spec: EntitySpec,
): { group: PropertyGroup; properties: EntityProperty[] }[] {
  const owned = ownedProperties(scenario, spec).filter((property) => property.scope !== "change");
  return PROPERTY_GROUPS.map((group) => ({
    group,
    properties: owned.filter((property) => property.group === group),
  })).filter((entry) => entry.properties.length > 0);
}

function ownedProperties(scenario: Scenario, spec: EntitySpec): EntityProperty[] {
  const chain = classChain(entityClassOf(scenario, spec));
  return ENTITY_PROPERTIES.filter((property) =>
    property.classes.some((entityClass) => chain.includes(entityClass)),
  );
}

// ---------------------------------------------------------------- Aenderungen

/**
 * Die Eigenschaften, die ein "Ändern"-Eingriff auf dieser Entitaet setzen kann,
 * in Gruppenreihenfolge. Massgeblich ist ausser der Klasse, ob der Kern den
 * Schluessel fuer die Entitaetsart kennt (`changeKeyAllowed`).
 */
export function changePropertiesOf(scenario: Scenario, spec: EntitySpec): EntityProperty[] {
  const owned = ownedProperties(scenario, spec).filter(
    (property) => property.change !== undefined && changeKeyAllowed(spec.kind, property.change.key),
  );
  return PROPERTY_GROUPS.flatMap((group) => owned.filter((property) => property.group === group));
}

function changePropertyFor(scenario: Scenario, spec: EntitySpec, key: ChangeKey): EntityProperty | undefined {
  return changePropertiesOf(scenario, spec).find((property) => property.change?.key === key);
}

/**
 * Eine Eigenschaft, deren Wert aus der Aenderung des Eingriffs `index` kommt
 * und deren `set` diese Aenderung ersetzt. Damit zeichnet `PropertyRow` eine
 * Aenderung genau wie einen Startwert - ein Zweig je Typ, keiner je Eigenschaft.
 */
function boundToChange(property: EntityProperty, index: number, change: EntityChange): EntityProperty {
  // Je Typ ein Aufruf, weil TypeScript den Werttyp nur nach der Verzweigung kennt.
  switch (property.type) {
    case "vector3":
      return rebound<Vec3, Vector3Property>(property, index, change);
    case "vector2":
      return rebound<[number, number], Vector2Property>(property, index, change);
    case "percent":
      return rebound<number, PercentProperty>(property, index, change);
    case "choice":
      return rebound<string, ChoiceProperty>(property, index, change);
    case "number":
      return rebound<number, NumberProperty>(property, index, change);
  }
}

function rebound<
  D,
  P extends {
    change?: ChangeBinding<D>;
    get(scenario: Scenario, spec: EntitySpec): D;
    set(scenario: Scenario, entityId: string, value: D): Scenario;
  },
>(property: P, index: number, change: EntityChange): P {
  const binding = property.change!;
  return {
    ...property,
    get: () => binding.fromChange(change),
    set: (scenario: Scenario, _entityId: string, value: D) =>
      setInterventionChange(scenario, index, binding.toChange(value)),
  };
}

/**
 * Die Zeilen eines aufgeklappten "Ändern"-Eingriffs: die Wahl der Eigenschaft
 * (Auswahlwert) und ihr Wert. `spec` ist die Entitaet zur Eingriffszeit - fuer
 * die Auswahl des Materials und die Beschriftung.
 *
 * Wechselt die Eigenschaft, wird der neue Wert so vorbelegt wie beim Anlegen
 * (`changeValueAt`), nicht aus dem alten umgerechnet: eine Kantenlaenge hat mit
 * einer Opazitaet nichts gemein.
 */
export function changeRowsOf(
  scenario: Scenario,
  index: number,
): { spec: EntitySpec; rows: EntityProperty[] } | undefined {
  const intervention = scenario.interventions[index];
  if (!intervention || intervention.op !== "change") return undefined;
  const spec = entitySpecAt(scenario, intervention.entityId, intervention.t);
  if (!spec) return undefined;
  const available = changePropertiesOf(scenario, spec);
  const keyRow: ChoiceProperty = {
    id: "change-key",
    label: "Eigenschaft",
    type: "choice",
    group: "kinematics",
    classes: [],
    options: () => available.map((property) => ({ value: property.change!.key, label: property.label })),
    get: () => intervention.change.key,
    set: (current, _id, key) =>
      setInterventionChange(
        current,
        index,
        changeValueAt(current, intervention.entityId, key as ChangeKey, intervention.t),
      ),
  };
  const valueProperty = changePropertyFor(scenario, spec, intervention.change.key);
  return {
    spec,
    rows: valueProperty ? [keyRow, boundToChange(valueProperty, index, intervention.change)] : [keyRow],
  };
}

/** Ein Eingriff in Worten - fuer die Eingriffsliste und den Tooltip der Raute. */
export function describeIntervention(scenario: Scenario, intervention: Intervention): string {
  if (intervention.op === "setEnvironment") return "Umgebung ändern";
  const spec = scenario.entities.find((entry) => entry.id === intervention.entityId);
  const name = spec?.name ?? intervention.entityId;
  switch (intervention.op) {
    case "add":
      return `${name} hinzufügen`;
    case "remove":
      return `${name} entfernen`;
    case "change": {
      const property = spec && changePropertyFor(scenario, spec, intervention.change.key);
      return `${name}: ${property?.label ?? intervention.change.key} ändern`;
    }
  }
}
