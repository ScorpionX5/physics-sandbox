import { quaternionFromEulerDegrees } from "./geometry.js";
import type { Body, Constraint, LibraryEntry, Load, Material } from "./library.js";
import type { EntitySpec, Scenario } from "./scenario.js";
import { DEFAULT_DURATION, Scenario as ScenarioSchema } from "./scenario.js";

/**
 * Startbibliothek, leeres Startszenario und das Durchstich-Szenario.
 *
 * Die Eintraege sind von Hand gepflegt (`source: "builtin"`) und dienen als
 * Referenz dafuer, wie eine Antwort des Bibliothekars aussehen muss. Sie sind
 * damit zugleich das Vergleichsmaterial fuer die Pruefung: ein KI-Eintrag fuer
 * Eisen sollte nach der Korrektur hier landen.
 */

function entry(definition: Body | Material | Constraint | Load): LibraryEntry {
  return {
    definition,
    provenance: { source: "builtin", correctedFields: [], warnings: [] },
  };
}

/**
 * **Standard** - das Material, das jedes neue Objekt (Koerper wie Ebene) nach
 * dem Anlegen hat, solange der Benutzer kein anderes waehlt.
 *
 * Rein didaktisch, kein Stoff: 1000 kg/m^3 ist eine runde Dichte, mit der sich
 * Massen im Kopf nachrechnen lassen. Die Optik ist das Grau, das die Ebene
 * frueher fest hatte.
 *
 * Stosszahl 0: perfekt inelastisch. Weil eine Paarung das Minimum der beiden
 * Stosszahlen nimmt, prallt alles, was mit Standard zusammenstoesst, nicht
 * zurueck, sondern bleibt liegen oder geht ins Gleiten ueber - egal, aus
 * welchem Material der Partner ist. Das war vor den Stosszahlen das einzige
 * Verhalten und bleibt der Ausgangszustand eines neuen Szenarios.
 */
export const STANDARD: Material = {
  kind: "material",
  id: "standard",
  name: "Standard",
  mechanical: { density: 1000, restitution: 0, staticFriction: 0.5, kineticFriction: 0.4, rollingFriction: 0.001 },
  appearance: {
    macroscopic: { color: "#4a5568", metalness: 0.1, roughness: 0.8, opacity: 1 },
    atomic: { atomColor: "#7b8494", atomRadius: 140, lattice: "amorphous", latticeConstant: 400 },
  },
};

/**
 * **Glatt** - ideal reibungsfrei, wie Standard ein didaktisches Material und
 * kein Stoff.
 *
 * Reibwerte 0: weil eine Paarung das geometrische Mittel der beiden
 * Materialien nimmt, gleitet alles reibungsfrei, was auf Glatt liegt - egal,
 * aus welchem Material es ist. Damit bleibt der Lehrbuchfall "reibungsfreie
 * schiefe Ebene" baubar, und der Vergleich mit und ohne Reibung ist ein
 * Materialwechsel der Ebene.
 */
export const SMOOTH: Material = {
  kind: "material",
  id: "glatt",
  name: "Glatt",
  mechanical: { density: 1000, restitution: 0, staticFriction: 0, kineticFriction: 0, rollingFriction: 0 },
  appearance: {
    macroscopic: { color: "#9fc4d8", metalness: 0.1, roughness: 0.1, opacity: 1 },
    atomic: { atomColor: "#b5d3e3", atomRadius: 140, lattice: "amorphous", latticeConstant: 400 },
  },
};

export const IRON: Material = {
  kind: "material",
  id: "eisen",
  name: "Eisen",
  formula: "Fe",
  mechanical: {
    density: 7874,
    // Stosszahl von Eisen gegen Stahl. Gegen einen Partner mit kleinerer
    // Stosszahl (etwa Standard, 0) wird sie ueberstimmt - die Paarung nimmt das
    // Minimum.
    restitution: 0.4,
    // Reibwerte von Stahl auf Stahl, trocken. Die Paarung nimmt das
    // geometrische Mittel mit dem Partner (`pairFriction` im Kern).
    staticFriction: 0.74,
    kineticFriction: 0.57,
    rollingFriction: 0.0005,
  },
  thermal: {
    specificHeatCapacity: 449,
    thermalConductivity: 80.4,
    emissivity: 0.3,
    meltingPoint: 1811,
    boilingPoint: 3134,
  },
  chemical: { molarMass: 55.845, atomicNumber: 26, neutronCount: 30 },
  appearance: {
    macroscopic: { color: "#8c8c94", metalness: 0.9, roughness: 0.35, opacity: 1 },
    atomic: { atomColor: "#b0b4bd", atomRadius: 126, lattice: "bcc", latticeConstant: 287 },
  },
};

export const ALUMINIUM: Material = {
  kind: "material",
  id: "aluminium",
  name: "Aluminium",
  formula: "Al",
  mechanical: {
    density: 2700,
    restitution: 0.35,
    staticFriction: 0.61,
    kineticFriction: 0.47,
    rollingFriction: 0.0007,
  },
  thermal: {
    specificHeatCapacity: 897,
    thermalConductivity: 237,
    emissivity: 0.1,
    meltingPoint: 933.47,
    boilingPoint: 2792,
  },
  chemical: { molarMass: 26.982, atomicNumber: 13, neutronCount: 14 },
  appearance: {
    macroscopic: { color: "#c8ccd2", metalness: 0.85, roughness: 0.3, opacity: 1 },
    atomic: { atomColor: "#d4d8de", atomRadius: 143, lattice: "fcc", latticeConstant: 405 },
  },
};

/**
 * Holz als Gegenbeispiel: kein Element, keine Summenformel. Damit laeuft der
 * Pfad der Pruefung mit, in dem keine Referenz greift und der KI-Wert
 * uebernommen wird - der Fall, der in der Praxis am haeufigsten vorkommt.
 */
export const WOOD: Material = {
  kind: "material",
  id: "holz",
  name: "Holz",
  mechanical: {
    density: 700,
    restitution: 0.3,
    staticFriction: 0.45,
    kineticFriction: 0.35,
    rollingFriction: 0.0015,
  },
  thermal: { specificHeatCapacity: 1700, thermalConductivity: 0.12, emissivity: 0.9 },
  appearance: {
    macroscopic: { color: "#9a6b3f", metalness: 0, roughness: 0.9, opacity: 1 },
    atomic: { atomColor: "#a5763f", atomRadius: 140, lattice: "amorphous", latticeConstant: 400 },
  },
};

/**
 * **Quader** - der einzige Koerper der Bibliothek, und die Form, die jeder
 * neu platzierte Koerper bisher hatte.
 *
 * 20 cm Kantenlaenge als Voreinstellung: gross genug, um ihn auf einer Ebene
 * zu sehen, klein genug, dass er auf einer 2 m breiten Flaeche Platz zum
 * Rutschen hat. Die Groesse der Instanz ist danach frei.
 */
export const CUBOID: Body = {
  kind: "body",
  id: "quader",
  name: "Quader",
  behaviour: { bodyType: "cuboid", halfExtents: [0.1, 0.1, 0.1] },
};

/**
 * **Ebene** - die einzige Flaechen-Grundform, und die einzige Randbedingung,
 * die Stufe 1 kennt.
 *
 * Eine unbewegliche Rechteckplatte. Lage, Orientierung und Groesse stehen an
 * der *platzierten Instanz*, nicht hier: aus diesem einen Eintrag lassen sich
 * damit eine schiefe Ebene, ein Auslauf, eine Wand und ein Tisch bauen.
 *
 * Die Werte hier sind nur die Voreinstellung beim Platzieren. Im Koerpersystem
 * liegt die Flaeche waagerecht, ihre Normale zeigt nach +z - die Hochachse der
 * Welt. Eine Drehung der Instanz neigt sie.
 */
export const PLANE: Constraint = {
  kind: "constraint",
  id: "ebene",
  name: "Ebene",
  behaviour: {
    constraintType: "staticSurface",
    segments: [
      {
        id: "flaeche",
        center: [0, 0, 0],
        normal: [0, 0, 1],
        tangent: [1, 0, 0],
        halfExtentU: 1,
        halfExtentV: 2,
        thickness: 0.01,
      },
    ],
  },
};

/**
 * **Gravitation** - die einzige Last, die Stufe 1 mit einem Modul kennt: ein
 * Schwerefeld mit Staerke und Richtung.
 *
 * Staerke und Richtung stehen an der platzierten Instanz, nicht hier - aus
 * diesem einen Eintrag lassen sich beliebig viele, verschieden starke und
 * verschieden gerichtete Schwerefelder bauen, genau wie die Ebene beliebig
 * viele verschieden grosse Flaechen liefert.
 */
export const GRAVITATION: Load = {
  kind: "load",
  id: "gravitation",
  name: "Gravitation",
  behaviour: { loadType: "gravity" },
  appearance: {
    macroscopic: { color: "#5b6ee1", metalness: 0, roughness: 1, opacity: 1 },
  },
};

/**
 * Nur der *Startinhalt* von `createEmptyScenario()`, keine Quelle zur Laufzeit:
 * jedes Szenario traegt seine Bibliothekseintraege selbst in `scenario.library`.
 * Wer einen Eintrag sucht, sucht ihn dort - sonst fehlt alles, was der
 * Bibliothekar erzeugt oder eine geladene Datei mitgebracht hat.
 */
export const BUILTIN_LIBRARY: LibraryEntry[] = [
  entry(CUBOID),
  // "Standard" steht als erstes Material vorn: ein neu platzierter Koerper oder
  // eine neue Ebene bekommt das erste Material der Bibliothek (`addBody` und
  // `addConstraint` in der Oberflaeche).
  entry(STANDARD),
  entry(SMOOTH),
  entry(IRON),
  entry(ALUMINIUM),
  entry(WOOD),
  entry(PLANE),
  entry(GRAVITATION),
];

/** Erdbeschleunigung in m/s^2, als Betrag. */
export const EARTH_GRAVITY = 9.81;

/** Id der Last, mit der jedes neue Szenario startet. */
export const DEFAULT_GRAVITY_ID = "schwerkraft";

/**
 * Die Last, mit der jedes neue Szenario beginnt: Erdbeschleunigung senkrecht
 * nach unten (-z, die Hochachse).
 */
function earthGravityEntity(): EntitySpec {
  return {
    kind: "load",
    id: DEFAULT_GRAVITY_ID,
    loadId: GRAVITATION.id,
    name: "Schwerkraft",
    opacity: 1,
    magnitude: EARTH_GRAVITY,
    direction: [0, 0, -1],
  };
}

/**
 * Das Startszenario der Oberflaeche: leer, 5 s lang.
 *
 * Absichtlich ohne weitere Objekte. Ein vorgefuelltes Beispiel ist bequem fuer
 * die erste Minute und im Weg fuer jede danach - man muss es erst wegraeumen,
 * um etwas Eigenes zu bauen. Schwerkraft steht trotzdem von Anfang an, weil
 * ein frisch platzierter Koerper sonst in der Luft stehen bliebe.
 */
export function createEmptyScenario(): Scenario {
  return ScenarioSchema.parse({
    schemaVersion: 1,
    id: "neues-szenario",
    name: "Neues Szenario",
    library: BUILTIN_LIBRARY,
    simulation: { dt: 0.001, recordRate: 20, seed: 1 },
    entities: [earthGravityEntity()],
    duration: DEFAULT_DURATION,
    interventions: [{ op: "add", t: 0, entityId: DEFAULT_GRAVITY_ID }],
    directionTrack: [],
  });
}

/** Neigung der schiefen Ebene im Durchstich, in Grad. */
export const RAMP_INCLINE_DEGREES = 30;

/**
 * Orientierung der schiefen Ebene im Durchstich.
 *
 * Eine Drehung um die y-Achse um +30 Grad kippt die Normale von (0, 0, 1) nach
 * (sin 30, 0, cos 30) und die Tangente von (1, 0, 0) auf die Falllinie
 * (cos 30, 0, -sin 30) - die Flaeche faellt also in +x-Richtung ab.
 *
 * Gedreht wird um y und nicht um z, weil z die Hochachse ist: eine Drehung um
 * die Hochachse wuerde die Flaeche nur herumschwenken, nicht neigen.
 */
export const RAMP_ORIENTATION = quaternionFromEulerDegrees(0, RAMP_INCLINE_DEGREES, 0);

/**
 * Das Durchstich-Szenario: ein Klotz faellt auf die schiefe Ebene, rutscht ab
 * und gleitet auf den horizontalen Auslauf. Bei t = 2 s wird seine
 * Geschwindigkeit auf 0 gesetzt, damit er stehen bleibt - reibungsfrei gibt es
 * nichts, was ihn sonst bremsen wuerde. Reibungsfrei ist der Lauf, weil Rampe und
 * Auslauf aus Glatt sind (`SMOOTH`); mit Standard bremst die Reibung den Klotz
 * schon auf der Rampe und haelt ihn auf dem Auslauf von selbst an. Genau das ist der Grund fuer diesen
 * Eingriff: er zeigt, dass ein Eingriff den laufenden Zustand aendert.
 *
 * Die Rampe besteht aus **zwei Instanzen** der "Ebene": einer geneigten
 * von 4 m Laenge und einem waagerechten Auslauf von 8,25 m. Die beiden
 * ueberlappen an der Knickkante um 25 cm, damit ein Koerper beim Uebergang nie
 * zwischen beide Platten faellt - ohne diesen Ueberlapp koennte eine Ecke an der
 * Naht ausserhalb beider Rechtecke liegen und der Kontakt fuer einen Zeitschritt
 * ausfallen.
 *
 * Wird im Studio nicht automatisch geladen; erreichbar ueber
 * `?szenario=durchstich`.
 */
export function createInclinedPlaneScenario(): Scenario {
  return ScenarioSchema.parse({
    schemaVersion: 1,
    id: "durchstich-schiefe-ebene",
    name: "Klotz auf der schiefen Ebene",
    description:
      "Ein Eisenklotz faellt aus der Luft auf eine um 30 Grad geneigte Ebene, rutscht " +
      "reibungsfrei ab und gleitet auf den horizontalen Auslauf. Nach zwei Sekunden " +
      "setzt ein Eingriff seine Geschwindigkeit auf Null.",
    library: BUILTIN_LIBRARY,
    simulation: { dt: 0.001, recordRate: 20, seed: 1 },
    entities: [
      earthGravityEntity(),
      {
        kind: "constraint",
        id: "schiefe-ebene",
        constraintId: "ebene",
        materialId: SMOOTH.id,
        name: "Schiefe Ebene",
        // Mittelpunkt 2 m bergauf von der Knickkante bei (0, 0, 0).
        pose: { position: [-1.732, 0, 1], orientation: RAMP_ORIENTATION },
        size: [2, 1],
      },
      {
        kind: "constraint",
        id: "auslauf",
        constraintId: "ebene",
        materialId: SMOOTH.id,
        name: "Auslauf",
        pose: { position: [4, 0, 0], orientation: [0, 0, 0, 1] },
        size: [4.125, 1],
      },
      {
        kind: "body",
        id: "klotz",
        bodyId: CUBOID.id,
        materialId: IRON.id,
        name: "Eisenklotz",
        phase: { state: "solid", shape: { type: "box", halfExtents: [0.1, 0.1, 0.1] } },
        pose: { position: [-1.732, 0, 2.2] },
        velocity: { linear: [0, 0, 0], angular: [0, 0, 0] },
      },
    ],
    duration: 4,
    interventions: [
      { op: "add", t: 0, entityId: DEFAULT_GRAVITY_ID },
      { op: "add", t: 0, entityId: "schiefe-ebene" },
      { op: "add", t: 0, entityId: "auslauf" },
      { op: "add", t: 0, entityId: "klotz" },
      // Anhalten ist eine Aenderung der Geschwindigkeit auf null.
      { op: "change", t: 2, entityId: "klotz", change: { key: "linearVelocity", value: [0, 0, 0] } },
    ],
    directionTrack: [
      { cue: "setViewLayer", t: 0, layer: "macroscopic" },
      {
        cue: "annotate",
        t: 0.05,
        text: "Freier Fall: die Beschleunigung ist konstant, die Geschwindigkeit waechst linear.",
        entityId: "klotz",
        duration: 1.2,
      },
      { cue: "setViewLayer", t: 1.2, layer: "kinematic" },
      {
        cue: "annotate",
        t: 1.25,
        text: "Auf dem Auslauf wirkt keine Kraft laengs der Flaeche - die Geschwindigkeit bleibt konstant.",
        entityId: "klotz",
        duration: 1.5,
      },
      {
        cue: "annotate",
        t: 2.05,
        text: "Eingriff bei t = 2 s: Geschwindigkeit auf Null.",
        entityId: "klotz",
        duration: 1.5,
      },
    ],
  });
}
