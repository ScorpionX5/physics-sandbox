import { z } from "zod";
import { Finite, Id, IDENTITY_QUAT, Quat, Vec3, ZERO_VEC3 } from "./primitives.js";
import { LibraryEntry } from "./library.js";

/**
 * Szenario: die Datei, in der alles steht. Umgebung, Bibliothek, Entitaeten,
 * Eingriffe, Regiespur und die Simulationsparameter.
 */

// ---------------------------------------------------------------- Umgebung

/**
 * **Umgebung** - die Bedingungen, die auf alle Entitaeten wirken, ohne selbst
 * Entitaet zu sein.
 *
 * Schwerkraft steht *nicht* mehr hier: sie ist eine Last ("Gravitation") in
 * der Bibliothek, platziert wie jede andere Entitaet - mit Staerke und
 * Richtung an der Instanz (`LoadSpec`), nicht an der Umgebung. Umgebungs-
 * temperatur und -druck bleiben Umgebungselemente und werden von den
 * spaeteren Modulen gelesen.
 */
export const Environment = z.object({
  /** Umgebungstemperatur in Kelvin - Stufe 3. */
  ambientTemperature: Finite.positive().optional(),
  /** Umgebungsdruck in Pa - Stufe 3. */
  ambientPressure: Finite.min(0).optional(),
});
export type Environment = z.infer<typeof Environment>;

// ---------------------------------------------------------------- Koerper

/**
 * **Opazitaet** eines Objekts: 1 ist voll deckend (Standard), 0 unsichtbar.
 *
 * Steht an der *Instanz* und gilt fuer jedes Objekt - Koerper, Randbedingung
 * und Last. Eine Last hat keine Darstellung, speichert den Wert aber trotzdem,
 * damit alle Objekte dieselbe Eigenschaft haben. Rein Darstellung: die Physik
 * liest sie nie. Sie wird mit der Deckkraft des Materials bzw. der Randbedingung
 * (`appearance.macroscopic.opacity`) multipliziert, ersetzt sie also nicht.
 */
export const Opacity = Finite.min(0).max(1).default(1);

/** Kollisions- und Darstellungsform eines Koerpers. */
export const Shape = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("box"),
    /** Halbe Kantenlaengen in Metern. */
    halfExtents: Vec3,
  }),
  z.object({
    type: z.literal("sphere"),
    radius: Finite.positive(),
  }),
]);
export type Shape = z.infer<typeof Shape>;

export const PhaseState = z.enum(["solid", "liquid", "gas", "plasma"]);
export type PhaseState = z.infer<typeof PhaseState>;

/** **Erscheinungsform** - Aggregatzustand und Geometrie-Archetyp. */
export const Phase = z.object({
  state: PhaseState.default("solid"),
  shape: Shape,
});
export type Phase = z.infer<typeof Phase>;

export const Pose = z.object({
  position: Vec3.default(ZERO_VEC3),
  orientation: Quat.default(IDENTITY_QUAT),
});
export type Pose = z.infer<typeof Pose>;

export const Velocity = z.object({
  linear: Vec3.default(ZERO_VEC3),
  /** Winkelgeschwindigkeit in rad/s, Achse * Betrag. */
  angular: Vec3.default(ZERO_VEC3),
});
export type Velocity = z.infer<typeof Velocity>;

/**
 * **Koerper** - eine platzierte Instanz eines Koerper-Eintrags der Bibliothek,
 * aus einem Material. "Quader" ist der Eintrag, "Eisen" das Material; "dieser
 * 2-kg-Eisenquader bei (0, 3, 0)" ist der Koerper.
 *
 * Form und Material sind zwei getrennte Verweise, weil sie unabhaengig
 * voneinander wechseln: derselbe Quader aus Holz statt Eisen ist eine Aenderung
 * an einem Feld, kein neuer Koerper.
 */
export const BodySpec = z.object({
  kind: z.literal("body"),
  id: Id,
  /** Verweis auf einen `Body`-Eintrag der Bibliothek - die Unterklasse, z. B. "Quader". */
  bodyId: Id,
  /** Verweis auf einen `Material`-Eintrag der Bibliothek. */
  materialId: Id,
  name: z.string().max(120).optional(),
  opacity: Opacity,
  phase: Phase,
  /**
   * Masse in kg. Fehlt sie, wird sie aus Dichte und Volumen der Form berechnet
   * - das ist der Normalfall und haelt Material und Koerper konsistent.
   */
  mass: Finite.positive().optional(),
  pose: Pose.prefault({}),
  velocity: Velocity.prefault({}),
  /** Nimmt an Kontakten teil, wird aber nicht von Kraeften bewegt. */
  kinematic: z.boolean().default(false),
});
export type BodySpec = z.infer<typeof BodySpec>;

/** Eine platzierte Randbedingung. */
export const ConstraintSpec = z.object({
  kind: z.literal("constraint"),
  id: Id,
  /** Verweis auf einen `Constraint`-Eintrag der Bibliothek. */
  constraintId: Id,
  /**
   * Verweis auf einen `Material`-Eintrag der Bibliothek. Bestimmt die
   * Darstellung der Flaeche und spaeter ihre Reibung.
   */
  materialId: Id,
  name: z.string().max(120).optional(),
  opacity: Opacity,
  pose: Pose.prefault({}),
  /**
   * Halbe Ausdehnung in u- und v-Richtung, in Metern - ueberschreibt die Groesse
   * aus dem Bibliothekseintrag.
   *
   * Steht bewusst an der *Instanz* und nicht am Eintrag: "Ebene" ist ein
   * einziger Bibliothekseintrag, aus dem sich sehr unterschiedliche Flaechen
   * bauen lassen - eine 4 m lange schiefe Ebene und ein 8 m langer Auslauf sind
   * dieselbe Randbedingung in zwei Groessen. Ohne instanzeigene Groesse
   * braeuchte man fuer jede Abmessung einen eigenen Eintrag.
   *
   * Gilt nur fuer `staticSurface` mit genau einem Segment; bei mehreren waere
   * nicht entscheidbar, welches gemeint ist, und die Pruefung lehnt es ab.
   */
  size: z.tuple([Finite.positive(), Finite.positive()]).optional(),
  /**
   * Dicke der Platte in Metern (die "Hoehe" der Ebene) - ueberschreibt die Dicke
   * aus dem Bibliothekseintrag. Eigenes Feld statt dritter Wert in `size`, damit
   * Dateien mit zweiteiliger Groesse weiter gelten. Dieselbe Einschraenkung wie
   * bei `size`: nur fuer Flaechen mit genau einem Segment.
   */
  thickness: Finite.positive().optional(),
});
export type ConstraintSpec = z.infer<typeof ConstraintSpec>;

/**
 * Eine platzierte Last.
 *
 * Staerke und Richtung stehen hier, nicht am Bibliothekseintrag - analog zur
 * Instanzgroesse einer Flaeche: aus dem einen Eintrag "Gravitation" lassen
 * sich beliebig viele, verschieden starke und verschieden gerichtete
 * Schwerefelder bauen. Anders als ein Koerper oder eine Flaeche hat eine Last
 * keine Lage: sie wirkt unabhaengig vom Ort auf jeden Koerper der Szene.
 * Mehrere gleichzeitig platzierte Lasten summieren sich.
 */
export const LoadSpec = z.object({
  kind: z.literal("load"),
  id: Id,
  /** Verweis auf einen `Load`-Eintrag der Bibliothek. */
  loadId: Id,
  name: z.string().max(120).optional(),
  opacity: Opacity,
  /** Staerke in m/s^2 - der Betrag der Fallbeschleunigung dieser Last. */
  magnitude: Finite.min(0).default(0),
  /** Richtungsvektor. Wird beim Wirken normiert, muss also nicht normiert eingegeben werden. */
  direction: Vec3.default([0, 0, -1]),
});
export type LoadSpec = z.infer<typeof LoadSpec>;

/**
 * **Entitaet** - ein Koerper, eine platzierte Randbedingung oder eine
 * platzierte Last.
 *
 * Eine Last verhaelt sich wie ein Koerper oder eine Flaeche: sie laesst sich
 * genauso anlegen, umbenennen, bearbeiten und loeschen. Anders als die beiden
 * hat sie aber keine Lage - sie wirkt unabhaengig vom Ort auf jede Entitaet
 * der Szene.
 */
export const EntitySpec = z.discriminatedUnion("kind", [BodySpec, ConstraintSpec, LoadSpec]);
export type EntitySpec = z.infer<typeof EntitySpec>;

// ---------------------------------------------------------------- Eingriff

/** Laengste Gesamtdauer eines Szenarios, in simulierten Sekunden. */
export const MAX_DURATION = 3600;

/**
 * Zeitpunkt eines Eingriffs in simulierten Sekunden. Nach oben nicht durch die
 * Gesamtdauer begrenzt: ein Eingriff hinter dem Ende bleibt stehen und wirkt
 * nur nicht - sonst loeschte das Kuerzen der Gesamtdauer Arbeit.
 */
const InterventionTime = Finite.min(0).max(MAX_DURATION);

/**
 * **Aenderung** - genau eine Eigenschaft einer Entitaet und ihr neuer Wert, in
 * Speichereinheiten wie in der Spec (Quaternion statt Grad, halbe statt ganzer
 * Kanten). Der Schluessel `key` sagt, welche.
 *
 * Bewusst eine Eigenschaft je Eingriff: eine spaetere Interpolation ("von der
 * vorigen Aenderung desselben Schluessels bis hierher") hat damit eindeutige
 * Stuetzstellen. Welcher Schluessel zu welcher Entitaetsart passt und ob er
 * eine Zustandsgroesse ist, steht in `CHANGE_KEYS` (changes.ts) - das Schema
 * prueft nur die Form des Werts, weil es die Entitaet nicht kennt.
 */
export const EntityChange = z.discriminatedUnion("key", [
  /** Koerper: Zustandsgroesse. Randbedingung: Eingabeeigenschaft. */
  z.object({ key: z.literal("position"), value: Vec3 }),
  z.object({ key: z.literal("orientation"), value: Quat }),
  z.object({ key: z.literal("linearVelocity"), value: Vec3 }),
  /** rad/s, Achse * Betrag - wie `Velocity.angular`. */
  z.object({ key: z.literal("angularVelocity"), value: Vec3 }),
  z.object({
    key: z.literal("halfExtents"),
    value: z.tuple([Finite.positive(), Finite.positive(), Finite.positive()]),
  }),
  /** Halbe Laenge, halbe Breite, Dicke einer Flaeche - `size` und `thickness` in einem. */
  z.object({
    key: z.literal("dimensions"),
    value: z.tuple([Finite.positive(), Finite.positive(), Finite.positive()]),
  }),
  z.object({ key: z.literal("materialId"), value: Id }),
  z.object({ key: z.literal("opacity"), value: Finite.min(0).max(1) }),
  z.object({ key: z.literal("magnitude"), value: Finite.min(0) }),
  z.object({ key: z.literal("direction"), value: Vec3 }),
]);
export type EntityChange = z.infer<typeof EntityChange>;
export type ChangeKey = EntityChange["key"];

/**
 * **Eingriff** - eine Aenderung am Zustand zu einem Zeitpunkt `t`. Das ist,
 * was in der Projektbeschreibung "Frame" hiess; `Frame` bleibt fuer
 * Renderbilder reserviert.
 *
 * Mehrere Eingriffe zur selben Zeit gelten im selben Zeitschritt, in der
 * Reihenfolge, in der sie in `Scenario.interventions` stehen.
 *
 * `add` verweist nur auf eine Entitaet in `Scenario.entities`, es traegt sie
 * nicht. Sonst haette das Loeschen des Eingriffs die Entitaet mitgenommen, und
 * ein Objekt liesse sich nicht zu einer zweiten Zeit wieder hinzufuegen, ohne
 * seine Definition zu verdoppeln.
 *
 * `change` ersetzt die frueheren `move`, `setVelocity` und `setParameter`: vier
 * Wege, eine Eigenschaft zu setzen, waren drei zu viel. Dateien mit den alten
 * Typen lehnt das Schema ab.
 */
export const Intervention = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), t: InterventionTime, entityId: Id }),
  z.object({ op: z.literal("remove"), t: InterventionTime, entityId: Id }),
  z.object({ op: z.literal("change"), t: InterventionTime, entityId: Id, change: EntityChange }),
  z.object({
    op: z.literal("setEnvironment"),
    t: InterventionTime,
    environment: Environment.partial(),
  }),
]);
export type Intervention = z.infer<typeof Intervention>;

// ---------------------------------------------------------------- Regie

export const ViewLayer = z.enum([
  "macroscopic",
  "kinematic",
  "atomic",
  "subatomic",
  "thermal",
  "fields",
]);
export type ViewLayer = z.infer<typeof ViewLayer>;

/**
 * **Regieanweisung** - beeinflusst die Darstellung, nie die Physik. Ein
 * Lernender kann die Regiespur ignorieren, selbst die Kamera drehen und die
 * Ebene wechseln, ohne dass die Simulation sich aendert. Genau das
 * unterscheidet eine Aufzeichnung von einem Video.
 */
export const DirectionCue = z.discriminatedUnion("cue", [
  z.object({ cue: z.literal("setViewLayer"), t: Finite.min(0), layer: ViewLayer }),
  z.object({
    cue: z.literal("moveCamera"),
    t: Finite.min(0),
    position: Vec3,
    target: Vec3,
    /** Dauer der Fahrt in simulierten Sekunden. 0 = Schnitt. */
    duration: Finite.min(0).default(0),
  }),
  z.object({
    cue: z.literal("annotate"),
    t: Finite.min(0),
    text: z.string().min(1).max(600),
    /** Optional an eine Entitaet geheftet. */
    entityId: Id.optional(),
    duration: Finite.positive().default(3),
  }),
  z.object({ cue: z.literal("pause"), t: Finite.min(0) }),
  z.object({ cue: z.literal("setTimeScale"), t: Finite.min(0), timeScale: Finite.positive() }),
]);
export type DirectionCue = z.infer<typeof DirectionCue>;

// ---------------------------------------------------------------- Szenario

/**
 * Simulationsparameter. `dt` ist fest und nie aus dem Render-Loop abgeleitet -
 * variable Zeitschritte machen eine Aufzeichnung unreproduzierbar.
 */
export const SimulationSettings = z.object({
  /** Fester Integrationsschritt in Sekunden. */
  dt: Finite.positive().max(0.05).default(0.001),
  /** Schnappschuesse pro simulierter Sekunde. */
  recordRate: Finite.positive().max(1000).default(20),
  /** Startwert des PRNG. Steht in der Aufzeichnung, damit sie reproduzierbar ist. */
  seed: z.number().int().min(0).default(1),
});
export type SimulationSettings = z.infer<typeof SimulationSettings>;

/**
 * Wie das Szenario angezeigt wird: Ebene, Koordinatensystem, Kamera. Gehoert
 * zur Datei, damit ein Szenario so wieder aufgeht, wie es gespeichert wurde -
 * wirkt aber nie auf die Physik.
 */
export const ViewSettings = z.object({
  layer: ViewLayer.default("macroscopic"),
  /** Koordinatenachsen im Bild. In einem neuen Szenario eingeblendet. */
  showAxes: z.boolean().default(true),
  /**
   * Kameralage beim Speichern. Fehlt sie, wird die Szene eingepasst. Die
   * laufende Kamera lebt im Betrachter; dieses Feld wird nur beim Speichern
   * beschrieben und beim Laden gelesen.
   */
  camera: z.object({ position: Vec3, target: Vec3 }).optional(),
});
export type ViewSettings = z.infer<typeof ViewSettings>;

export const Scenario = z.object({
  schemaVersion: z.literal(1),
  id: Id,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  environment: Environment.prefault({}),
  /**
   * Die benutzten Bibliothekseintraege liegen im Szenario, nicht nur als
   * Verweis. Damit ist ein Szenario - und die daraus erzeugte Aufzeichnung -
   * ohne weitere Abfragen abspielbar.
   */
  library: z.array(LibraryEntry).default([]),
  /**
   * Alle Entitaeten des Szenarios, auch solche, die nie hinzugefuegt werden.
   * *Wann* eine Entitaet in der Szene ist, bestimmen die `add`/`remove`-
   * Eingriffe.
   */
  entities: z.array(EntitySpec).default([]),
  /**
   * Gesamtdauer in simulierten Sekunden. Ein eigenes Feld, weil sie an nichts
   * anderem haengt: Eingriffe haben Zeitpunkte, keine Dauern.
   */
  duration: Finite.positive().max(MAX_DURATION),
  /** Alle Eingriffe, nicht zwingend nach Zeit sortiert - `interventionsInOrder` sortiert. */
  interventions: z.array(Intervention).default([]),
  directionTrack: z.array(DirectionCue).default([]),
  simulation: SimulationSettings.prefault({}),
  view: ViewSettings.prefault({}),
});
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------- Zeitordnung

/**
 * Die Eingriffe in der Reihenfolge, in der sie wirken: nach Zeit, bei gleicher
 * Zeit in Listenreihenfolge (die Sortierung ist stabil). Simulator,
 * Darstellung und Oberflaeche lesen sie alle hierueber, damit sie dieselbe
 * Reihenfolge sehen - auch fuer eine fremde Datei, deren Liste unsortiert ist.
 */
export function interventionsInOrder(scenario: Pick<Scenario, "interventions">): Intervention[] {
  return [...scenario.interventions].sort((a, b) => a.t - b.t);
}

/** Gesamtdauer eines leeren Szenarios, in Sekunden. */
export const DEFAULT_DURATION = 5;
