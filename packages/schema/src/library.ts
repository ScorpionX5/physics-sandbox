import { z } from "zod";
import { Finite, HexColor, Id, Vec3 } from "./primitives.js";

/**
 * Bibliothek: Koerper, Materialien, Randbedingungen und Lasten.
 *
 * Ein **Koerper** (`Body`) ist eine Form ohne Material - "Quader", nicht "dieser
 * Eisenklotz"; die Form ist die Unterklasse (`bodyType`). Ein **Material**
 * (`Material`) ist eine stoffliche Definition ohne Ort, Menge und Form -
 * "Eisen". Erst die platzierte Instanz (`BodySpec`) bringt beides zusammen:
 * ein Quader aus Eisen. Eine **Randbedingung** (`Constraint`) zwingt
 * Entitaeten eine Lage oder Bewegung auf, ohne selbst Materie zu sein - die
 * Ebene ist die einzige, die Stufe 1 kennt. Eine **Last** (`Load`) wirkt auf
 * Entitaeten ein, ohne ihre Lage vorzuschreiben - Stufe 1 kennt "gravity" mit
 * einem Modul (die Mechanik) und "heatSource" als Platzhalter ohne eines.
 * Anders als Koerper und Randbedingungen hat eine platzierte Last keine Lage:
 * sie wirkt unabhaengig vom Ort auf jede Entitaet der Szene.
 *
 * Die Felder sind nach Physikdomaene gruppiert und ausserhalb von `mechanical`
 * optional: solange das Thermodynamik-Modul fehlt, bleibt `thermal` leer. Die
 * Gruppierung spiegelt die Modulgrenzen des Kerns - jedes Modul liest genau
 * seinen Abschnitt.
 */

// ---------------------------------------------------------------- Material

/** Mechanische Materialdaten - Stufe 1 und 2. Die einzige Gruppe, die Pflicht ist. */
export const MechanicalProperties = z.object({
  /** kg/m^3. Zusammen mit dem Volumen des Koerpers ergibt sie die Masse. */
  density: Finite.positive(),
  /**
   * Stosszahl: 0 = kein Zurueckprallen, 1 = idealelastisch. Gilt fuer jede
   * Paarung (Koerper-Koerper, Koerper-Ebene) als Minimum der beiden Materialien.
   */
  restitution: Finite.min(0).max(1),
  /**
   * Haftreibungszahl mu_H. Wie die Stosszahl ein Wert je Material; die Paarung
   * verrechnet der Kern (`pairFriction` in mechanics.ts). Fehlt der Wert, ist
   * das Material reibungsfrei - so verhielt sich jedes Material, bevor die
   * Mechanik Reibung kannte, und so laden aeltere Dateien unveraendert.
   */
  staticFriction: Finite.min(0).optional(),
  /** Gleitreibungszahl mu_G, nicht groesser als die Haftreibungszahl. Fehlt sie: reibungsfrei. */
  kineticFriction: Finite.min(0).optional(),
  /**
   * Hebelarm der Rollreibung f in Metern: das Rollreibungsmoment ist hoechstens
   * f * N. Eine Laenge und keine Zahl, weil sie aus der Verformung an der
   * Auflage kommt - der Rollwiderstand eines Rads ist f / r, haengt also vom
   * Radius ab, f nicht. Fehlt er: kein Rollwiderstand.
   */
  rollingFriction: Finite.min(0).max(0.1).optional(),
  /** Elastizitaetsmodul in Pa - Stufe 2 (weiche Kontakte). */
  youngsModulus: Finite.positive().optional(),
});
export type MechanicalProperties = z.infer<typeof MechanicalProperties>;

/** Thermische Materialdaten - Stufe 3. */
export const ThermalProperties = z.object({
  /** Spezifische Waermekapazitaet in J/(kg*K). */
  specificHeatCapacity: Finite.positive().optional(),
  /** Waermeleitfaehigkeit in W/(m*K). */
  thermalConductivity: Finite.positive().optional(),
  /** Emissionsgrad fuer Waermestrahlung, 0..1. */
  emissivity: Finite.min(0).max(1).optional(),
  /** Schmelzpunkt in Kelvin. */
  meltingPoint: Finite.positive().optional(),
  /** Siedepunkt in Kelvin. */
  boilingPoint: Finite.positive().optional(),
});
export type ThermalProperties = z.infer<typeof ThermalProperties>;

/** Chemische und atomare Materialdaten - Stufe 4 und die subatomare Ansicht. */
export const ChemicalProperties = z.object({
  /** Molare Masse in g/mol. */
  molarMass: Finite.positive().optional(),
  /** Ordnungszahl - nur bei Elementen. Treibt die subatomare Ansicht. */
  atomicNumber: z.number().int().min(1).max(118).optional(),
  /** Neutronenzahl des haeufigsten Isotops - nur bei Elementen. */
  neutronCount: z.number().int().min(0).max(200).optional(),
  /**
   * Elektronenkonfiguration wird aus der Ordnungszahl per Aufbauprinzip
   * berechnet, nicht von der KI geliefert. Nur die echten Ausnahmen
   * (Cr, Cu, Pd, ...) stehen hier als Override.
   */
  electronConfigurationOverride: z.array(z.string().min(2).max(8)).max(32).optional(),
});
export type ChemicalProperties = z.infer<typeof ChemicalProperties>;

/** Gitterform fuer die atomare Ansicht. */
export const LatticeType = z.enum(["cubic", "bcc", "fcc", "hcp", "amorphous", "none"]);
export type LatticeType = z.infer<typeof LatticeType>;

/** Darstellungsdaten, nach Darstellungsebene gruppiert. */
export const Appearance = z.object({
  macroscopic: z.object({
    color: HexColor,
    /** 0 = dielektrisch, 1 = metallisch. */
    metalness: Finite.min(0).max(1).default(0.2),
    roughness: Finite.min(0).max(1).default(0.6),
    /** 1 = opak. Gaswolken liegen deutlich darunter. */
    opacity: Finite.min(0).max(1).default(1),
  }),
  atomic: z.object({
    atomColor: HexColor,
    /** Atomradius in Pikometern. Rein schematisch skaliert. */
    atomRadius: Finite.positive().default(140),
    lattice: LatticeType.default("cubic"),
    /** Gitterkonstante in Pikometern. */
    latticeConstant: Finite.positive().default(300),
  }),
});
export type Appearance = z.infer<typeof Appearance>;

export const Material = z.object({
  kind: z.literal("material"),
  id: Id,
  /** Anzeigename, deutsch: "Eisen". */
  name: z.string().min(1).max(120),
  /** Summenformel, falls sinnvoll: "Fe", "O2", "Fe2O3". */
  formula: z.string().max(60).optional(),
  mechanical: MechanicalProperties,
  thermal: ThermalProperties.optional(),
  chemical: ChemicalProperties.optional(),
  appearance: Appearance,
});
export type Material = z.infer<typeof Material>;

// ---------------------------------------------------------------- Koerper

/** Halbe Kantenlaengen eines Quaders in Metern - jede positiv. */
export const HalfExtents = z.tuple([Finite.positive(), Finite.positive(), Finite.positive()]);

/**
 * **Quader** - die einzige Koerperform, die die Bibliothek bisher anbietet.
 *
 * Die halben Kantenlaengen hier sind nur die Voreinstellung beim Platzieren;
 * die Groesse steht an der Instanz (`BodySpec.phase.shape`) - derselbe
 * Grund wie bei der Instanzgroesse einer Ebene: ein Eintrag, beliebig viele
 * verschieden grosse Quader.
 */
export const CuboidBody = z.object({
  bodyType: z.literal("cuboid"),
  halfExtents: HalfExtents,
});

/**
 * Die Unterklassen von Koerper. Von Anfang an als Diskriminierung, damit eine
 * spaetere Kugel ein weiterer Eintrag ist und keine Schemamigration.
 */
export const BodyBehaviour = z.discriminatedUnion("bodyType", [CuboidBody]);
export type BodyBehaviour = z.infer<typeof BodyBehaviour>;

/**
 * **Koerper** als Bibliothekseintrag: eine Form ohne Material.
 *
 * Bewusst ohne `appearance`: wie ein Koerper aussieht, bestimmt sein Material.
 * Eine eigene Farbe am Koerper waere eine zweite Quelle fuer dieselbe Sache.
 */
export const Body = z.object({
  kind: z.literal("body"),
  id: Id,
  name: z.string().min(1).max(120),
  behaviour: BodyBehaviour,
});
export type Body = z.infer<typeof Body>;

// ---------------------------------------------------------------- Randbedingung

/**
 * Ein Flaechensegment: endliche Rechteckplatte, aufgespannt durch Mittelpunkt,
 * Normale und eine In-Plane-Tangente.
 *
 * Die Neigung steht hier als **Normalenvektor**, nicht als Winkel. Der Winkel
 * wird beim Anlegen des Eintrags einmal umgerechnet (siehe `geometry.ts`), damit
 * im Kern keine Trigonometrie vorkommt - `Math.sin`/`cos` sind ueber
 * JS-Engines nicht bitgenau spezifiziert und wuerden den Determinismus brechen.
 */
export const SurfaceSegment = z.object({
  id: Id,
  /** Mittelpunkt der Platte in Metern. */
  center: Vec3,
  /** Normale, normiert. Zeigt zur Seite, auf der Koerper liegen. */
  normal: Vec3,
  /** Tangente in der Plattenebene, normiert. Definiert die u-Richtung. */
  tangent: Vec3,
  /** Halbe Ausdehnung in u-Richtung, Meter. */
  halfExtentU: Finite.positive(),
  /** Halbe Ausdehnung in v-Richtung (normal x tangent), Meter. */
  halfExtentV: Finite.positive(),
  /** Dicke nur fuer die Darstellung, Meter. Kollidiert wird mit der Ebene. */
  thickness: Finite.positive().default(0.05),
});
export type SurfaceSegment = z.infer<typeof SurfaceSegment>;

/**
 * Unbewegliche Flaeche - die schiefe Ebene mit Auslauf.
 *
 * Ohne eigene Stosszahl: sie kommt vom Material der platzierten Instanz
 * (`ConstraintSpec.materialId`), wie die Farbe. Eine Stosszahl am Eintrag waere
 * eine zweite Quelle, die das Material uebergeht. Aeltere Dateien mit dem Feld
 * werden gelesen, das Feld faellt beim Parsen weg.
 */
export const StaticSurfaceConstraint = z.object({
  constraintType: z.literal("staticSurface"),
  segments: z.array(SurfaceSegment).min(1).max(64),
});

export const ConstraintBehaviour = z.discriminatedUnion("constraintType", [
  StaticSurfaceConstraint,
]);
export type ConstraintBehaviour = z.infer<typeof ConstraintBehaviour>;

/**
 * **Randbedingung** als Bibliothekseintrag.
 *
 * Bewusst ohne `appearance`, wie der Koerper: wie eine Flaeche aussieht,
 * bestimmt das Material der platzierten Instanz (`ConstraintSpec.materialId`).
 * Eine eigene Farbe am Eintrag waere eine zweite Quelle fuer dieselbe Sache.
 */
export const Constraint = z.object({
  kind: z.literal("constraint"),
  id: Id,
  name: z.string().min(1).max(120),
  behaviour: ConstraintBehaviour,
});
export type Constraint = z.infer<typeof Constraint>;

// ---------------------------------------------------------------- Last

/**
 * Waermequelle - Stufe 3, hier als Platzhalter deklariert, damit die
 * Diskriminierung von Anfang an mehrelementig ist und ein spaeterer Typ keine
 * Schemamigration erzwingt.
 */
export const HeatSourceLoad = z.object({
  loadType: z.literal("heatSource"),
  /** Abgegebene Leistung in Watt. */
  power: Finite,
  /** Wirkradius in Metern. */
  radius: Finite.positive(),
});

/**
 * Gravitation - ein Schwerefeld mit Staerke und Richtung.
 *
 * Staerke und Richtung stehen nicht hier, sondern an der platzierten Instanz
 * (`LoadSpec` in scenario.ts) - derselbe Grund wie bei der Instanzgroesse
 * einer Ebene: aus einem einzigen Eintrag lassen sich beliebig viele,
 * verschieden starke und verschieden gerichtete Schwerefelder bauen. Mehrere
 * gleichzeitig platzierte Gravitations-Lasten summieren sich zu einer
 * Gesamtbeschleunigung.
 */
export const GravityLoad = z.object({
  loadType: z.literal("gravity"),
});

export const LoadBehaviour = z.discriminatedUnion("loadType", [HeatSourceLoad, GravityLoad]);
export type LoadBehaviour = z.infer<typeof LoadBehaviour>;

export const Load = z.object({
  kind: z.literal("load"),
  id: Id,
  name: z.string().min(1).max(120),
  behaviour: LoadBehaviour,
  appearance: Appearance.pick({ macroscopic: true }),
});
export type Load = z.infer<typeof Load>;

// ---------------------------------------------------------------- Eintrag

/** Woher ein Eintrag kommt und ob er die Pruefung passiert hat. */
export const Provenance = z.object({
  source: z.enum(["builtin", "librarian", "manual"]),
  /** Der Text, aus dem der Bibliothekar den Eintrag erzeugt hat. */
  prompt: z.string().max(4000).optional(),
  /** Modell-Id, z.B. "claude-sonnet-5-5". */
  model: z.string().max(120).optional(),
  /** ISO-8601. Liegt bewusst hier und nicht im Kern - der Kern kennt keine Uhr. */
  createdAt: z.string().optional(),
  /** Felder, bei denen die Referenztabelle den KI-Wert ueberstimmt hat. */
  correctedFields: z.array(z.string()).default([]),
  /** Hinweise der Pruefung, die den Eintrag nicht abgelehnt haben. */
  warnings: z.array(z.string()).default([]),
});
export type Provenance = z.infer<typeof Provenance>;

export const LibraryEntry = z.object({
  definition: z.discriminatedUnion("kind", [Body, Material, Constraint, Load]),
  provenance: Provenance,
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;

export const Library = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(LibraryEntry),
});
export type Library = z.infer<typeof Library>;
