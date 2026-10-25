import { z } from "zod";
import {
  BUILTIN_LIBRARY,
  changeKeyAllowed,
  CUBOID,
  DirectionCue,
  EARTH_GRAVITY,
  Finite,
  GRAVITATION,
  Id,
  MAX_DURATION,
  PLANE,
  quaternionFromEulerDegrees,
  Scenario,
  STANDARD,
  Vec3,
  ViewLayer,
  type EntityChange,
  type EntitySpec,
  type Intervention,
  type Material,
} from "@sandbox/schema";
import { penetrationReport, runScenario, summarizeEntity } from "@sandbox/core";

/**
 * **Szenarioentwurf**: die Form, in der ein externer Agent (der Regisseur in
 * Hermes) ein ganzes Szenario auf einmal beschreibt - und der Zusammenbau, der
 * daraus ein `Scenario` macht.
 *
 * Warum nicht gleich das `Scenario`? Aus demselben Grund wie beim
 * Bibliothekar: **die Geometrie rechnet der Code, nicht das Modell.** Der
 * Entwurf nimmt Drehungen in Grad, Kanten in voller Laenge und
 * Winkelgeschwindigkeiten in Grad pro Sekunde - dieselben Einheiten, die die
 * rechte Leiste des Studios zeigt. Quaternionen und halbe Kanten entstehen
 * hier. Die Bibliothekseintraege nennt der Entwurf nur beim Namen; der
 * Zusammenbau kopiert sie aus der Startbibliothek, damit das Szenario wie jedes
 * andere seine Eintraege selbst mitbringt.
 *
 * Und warum nicht einzelne Werkzeuge wie `add_body`? Weil das Szenario die
 * Quelle der Wahrheit ist: ein Entwurf ist ein ganzes Szenario, jede Pruefung
 * simuliert es vollstaendig neu. Ein Agent, der Einzelschritte schickt, muesste
 * einen Zwischenstand auf dem Server pflegen, der nirgends sonst existiert.
 */

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** Zeitpunkt in simulierten Sekunden, wie bei einem Eingriff. */
const DraftTime = Finite.min(0).max(MAX_DURATION);

const BodyDraft = z.object({
  id: Id.describe("Eindeutige Kennung, z. B. \"klotz\""),
  name: z.string().max(120).optional().describe("Anzeigename, z. B. \"Eisenklotz\""),
  materialId: Id.default(STANDARD.id).describe("Kennung eines Materials aus bibliothek_auflisten"),
  size: z
    .tuple([Finite.positive(), Finite.positive(), Finite.positive()])
    .describe("Volle Kantenlaengen in x, y, z, Meter (0.2 = 20 cm)"),
  position: Vec3.describe("Mittelpunkt in Metern; z ist oben"),
  rotation: Vec3.optional().describe("Drehung in Grad, Eulerwinkel in Reihenfolge XYZ"),
  linearVelocity: Vec3.optional().describe("Startgeschwindigkeit in m/s"),
  angularVelocity: Vec3.optional().describe("Startwinkelgeschwindigkeit in Grad/s, Achse * Betrag"),
  kinematic: z.boolean().optional().describe("Nimmt an Kontakten teil, wird aber nicht von Kraeften bewegt"),
  opacity: Finite.min(0).max(1).optional(),
  addAt: DraftTime.default(0).describe("Ab wann der Koerper in der Szene ist, Sekunden"),
  removeAt: DraftTime.optional().describe("Ab wann er wieder entfernt ist, Sekunden"),
});

const SurfaceDraft = z.object({
  id: Id,
  name: z.string().max(120).optional(),
  materialId: Id.default(STANDARD.id).describe("Bestimmt Reibung und Stosszahl der Flaeche"),
  position: Vec3.describe("Mittelpunkt der Platte in Metern"),
  rotation: Vec3.optional().describe(
    "Drehung in Grad, XYZ. Ungedreht liegt die Platte waagerecht (Normale +z); " +
      "[0, 30, 0] neigt sie um 30 Grad, sie faellt dann in +x-Richtung ab",
  ),
  length: Finite.positive().describe("Volle Laenge entlang der lokalen x-Achse (Falllinie), Meter"),
  width: Finite.positive().describe("Volle Breite entlang der lokalen y-Achse, Meter"),
  thickness: Finite.positive().optional().describe("Dicke der Platte, Meter (Standard 0.01)"),
  opacity: Finite.min(0).max(1).optional(),
  addAt: DraftTime.default(0),
  removeAt: DraftTime.optional(),
});

const GravityDraft = z.object({
  id: Id,
  name: z.string().max(120).optional(),
  magnitude: Finite.min(0).describe("Fallbeschleunigung in m/s^2 (Erde: 9.81)"),
  direction: Vec3.default([0, 0, -1]).describe("Richtung, wird normiert; nach unten ist [0, 0, -1]"),
  addAt: DraftTime.default(0),
  removeAt: DraftTime.optional(),
});

/**
 * Schluessel einer Aenderung im Entwurf. Dieselben Namen wie `EntityChange`,
 * wo die Bedeutung dieselbe ist; `rotation` und `size` heissen anders, weil
 * ihre Einheiten andere sind als im Szenario.
 */
const DraftChangeKey = z.enum([
  "position",
  "rotation",
  "linearVelocity",
  "angularVelocity",
  "size",
  "materialId",
  "opacity",
  "magnitude",
  "direction",
]);
type DraftChangeKey = z.infer<typeof DraftChangeKey>;

/**
 * Bewusst kein diskriminierter Typ je Schluessel: `key` plus ein loser Wert
 * ist fuer ein Modell leichter zu treffen, und die Pruefung je Schluessel
 * liefert eine Meldung, die sagt, *welcher* Wert falsch war - statt einer
 * Liste gescheiterter Alternativen.
 */
const ChangeDraft = z.object({
  t: DraftTime.describe("Zeitpunkt in Sekunden"),
  entityId: Id,
  key: DraftChangeKey.describe(
    "position/linearVelocity/direction: [x,y,z]; rotation: Grad XYZ; angularVelocity: Grad/s; " +
      "size: Koerper volle Kanten [x,y,z], Flaeche [Laenge, Breite, Dicke]; " +
      "materialId: Kennung; opacity: 0..1; magnitude: m/s^2",
  ),
  value: z.union([z.array(Finite), Finite, z.string()]),
});

export const ScenarioDraft = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional().describe("Was das Szenario zeigt, fuer den Lernenden"),
  duration: Finite.positive().max(MAX_DURATION).describe("Gesamtdauer in Sekunden"),
  bodies: z.array(BodyDraft).default([]).describe("Quader"),
  surfaces: z.array(SurfaceDraft).default([]).describe("Unbewegliche Rechteckplatten: Boden, Rampe, Wand"),
  gravity: z
    .array(GravityDraft)
    .optional()
    .describe("Schwerefelder. Weggelassen: Erdschwere 9.81 m/s^2 nach unten. Leere Liste: keine Schwerkraft"),
  changes: z.array(ChangeDraft).default([]).describe("Eingriffe: eine Eigenschaft zu einem Zeitpunkt aendern"),
  directionTrack: z.array(DirectionCue).default([]).describe("Regiespur: Ebene, Kamera, Annotationen"),
  view: z
    .object({
      layer: ViewLayer.optional(),
      camera: z.object({ position: Vec3, target: Vec3 }).optional(),
    })
    .optional(),
  seed: z.number().int().min(0).optional(),
});
export type ScenarioDraft = z.input<typeof ScenarioDraft>;

/** Id der Erdschwere, wenn der Entwurf keine Schwerefelder nennt - wie in einem neuen Szenario. */
const DEFAULT_GRAVITY_ID = "schwerkraft";

// ---------------------------------------------------------------- Zusammenbau

export type AssembleResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: string[] };

const MATERIALS: Material[] = BUILTIN_LIBRARY.flatMap((entry) =>
  entry.definition.kind === "material" ? [entry.definition] : [],
);

function issues(error: z.ZodError, prefix = ""): string[] {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${prefix}${issue.path.join(".") || "<wurzel>"}: ${issue.message}`);
}

function radiansPerSecond(degrees: Vec3): Vec3 {
  return [degrees[0] / DEGREES_PER_RADIAN, degrees[1] / DEGREES_PER_RADIAN, degrees[2] / DEGREES_PER_RADIAN];
}

function rotationOf(degrees: Vec3 | undefined) {
  return degrees ? quaternionFromEulerDegrees(degrees[0], degrees[1], degrees[2]) : undefined;
}

function vec3Value(value: unknown): Vec3 | undefined {
  return Array.isArray(value) && value.length === 3 ? (value as Vec3) : undefined;
}

/** Eine Entwurfsaenderung in Speichereinheiten - oder die Meldung, was nicht passt. */
function toEntityChange(
  key: DraftChangeKey,
  value: unknown,
  spec: EntitySpec,
): EntityChange | string {
  const vector = vec3Value(value);
  const needVector = `"${key}" erwartet drei Zahlen [x, y, z]`;
  switch (key) {
    case "position":
    case "linearVelocity":
    case "direction":
      return vector ? { key, value: vector } : needVector;
    case "rotation":
      return vector ? { key: "orientation", value: rotationOf(vector)! } : needVector;
    case "angularVelocity":
      return vector ? { key, value: radiansPerSecond(vector) } : needVector;
    case "size":
      if (!vector) return needVector;
      return spec.kind === "constraint"
        ? { key: "dimensions", value: [vector[0] / 2, vector[1] / 2, vector[2]] }
        : { key: "halfExtents", value: [vector[0] / 2, vector[1] / 2, vector[2] / 2] };
    case "materialId":
      if (typeof value !== "string") return `"materialId" erwartet die Kennung eines Materials`;
      return { key, value };
    case "opacity":
    case "magnitude":
      return typeof value === "number" ? { key, value } : `"${key}" erwartet eine Zahl`;
  }
}

/**
 * Baut aus einem Entwurf ein `Scenario`.
 *
 * Am Ende geht das Ergebnis durch das `Scenario`-Schema: der Zusammenbau soll
 * nichts durchlassen, was das Studio beim Laden ablehnen wuerde.
 */
export function assembleScenario(input: unknown): AssembleResult {
  const parsed = ScenarioDraft.safeParse(input);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  const draft = parsed.data;
  const errors: string[] = [];

  const materialIds = new Set(MATERIALS.map((material) => material.id));
  const checkMaterial = (where: string, id: string) => {
    if (!materialIds.has(id)) {
      errors.push(`${where}: unbekanntes Material "${id}". Bekannt: ${[...materialIds].join(", ")}.`);
    }
  };

  const entities: EntitySpec[] = [];
  const interventions: Intervention[] = [];
  const place = (spec: EntitySpec, addAt: number, removeAt: number | undefined) => {
    if (entities.some((existing) => existing.id === spec.id)) {
      errors.push(`Kennung "${spec.id}" ist doppelt vergeben.`);
      return;
    }
    entities.push(spec);
    interventions.push({ op: "add", t: addAt, entityId: spec.id });
    if (removeAt !== undefined) {
      if (removeAt <= addAt) errors.push(`"${spec.id}": removeAt muss nach addAt liegen.`);
      interventions.push({ op: "remove", t: removeAt, entityId: spec.id });
    }
  };

  const gravity: z.infer<typeof GravityDraft>[] = draft.gravity ?? [
    { id: DEFAULT_GRAVITY_ID, name: "Schwerkraft", magnitude: EARTH_GRAVITY, direction: [0, 0, -1], addAt: 0 },
  ];
  for (const load of gravity) {
    place(
      {
        kind: "load",
        id: load.id,
        loadId: GRAVITATION.id,
        ...(load.name ? { name: load.name } : {}),
        opacity: 1,
        magnitude: load.magnitude,
        direction: load.direction,
      },
      load.addAt,
      load.removeAt,
    );
  }

  for (const surface of draft.surfaces) {
    checkMaterial(`Flaeche "${surface.id}"`, surface.materialId);
    const orientation = rotationOf(surface.rotation);
    place(
      {
        kind: "constraint",
        id: surface.id,
        constraintId: PLANE.id,
        materialId: surface.materialId,
        ...(surface.name ? { name: surface.name } : {}),
        opacity: surface.opacity ?? 1,
        pose: { position: surface.position, orientation: orientation ?? [0, 0, 0, 1] },
        size: [surface.length / 2, surface.width / 2],
        ...(surface.thickness !== undefined ? { thickness: surface.thickness } : {}),
      },
      surface.addAt,
      surface.removeAt,
    );
  }

  for (const body of draft.bodies) {
    checkMaterial(`Koerper "${body.id}"`, body.materialId);
    const half: Vec3 = [body.size[0] / 2, body.size[1] / 2, body.size[2] / 2];
    place(
      {
        kind: "body",
        id: body.id,
        bodyId: CUBOID.id,
        materialId: body.materialId,
        ...(body.name ? { name: body.name } : {}),
        opacity: body.opacity ?? 1,
        phase: { state: "solid", shape: { type: "box", halfExtents: half } },
        pose: { position: body.position, orientation: rotationOf(body.rotation) ?? [0, 0, 0, 1] },
        velocity: {
          linear: body.linearVelocity ?? [0, 0, 0],
          angular: body.angularVelocity ? radiansPerSecond(body.angularVelocity) : [0, 0, 0],
        },
        kinematic: body.kinematic ?? false,
      },
      body.addAt,
      body.removeAt,
    );
  }

  draft.changes.forEach((change, index) => {
    const where = `changes.${index} ("${change.key}" an "${change.entityId}")`;
    const spec = entities.find((candidate) => candidate.id === change.entityId);
    if (!spec) {
      errors.push(`${where}: unbekannte Entitaet.`);
      return;
    }
    const converted = toEntityChange(change.key, change.value, spec);
    if (typeof converted === "string") {
      errors.push(`${where}: ${converted}.`);
      return;
    }
    if (!changeKeyAllowed(spec.kind, converted.key)) {
      errors.push(`${where}: passt nicht zu einer Entitaet der Art "${spec.kind}".`);
      return;
    }
    if (converted.key === "materialId") checkMaterial(where, converted.value);
    interventions.push({ op: "change", t: change.t, entityId: change.entityId, change: converted });
  });

  draft.directionTrack.forEach((cue, index) => {
    if (cue.cue === "annotate" && cue.entityId && !entities.some((spec) => spec.id === cue.entityId)) {
      errors.push(`directionTrack.${index}: Annotation an unbekannter Entitaet "${cue.entityId}".`);
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  const scenario = Scenario.safeParse({
    schemaVersion: 1,
    id: slugOf(draft.name),
    name: draft.name,
    ...(draft.description ? { description: draft.description } : {}),
    library: BUILTIN_LIBRARY,
    entities,
    duration: draft.duration,
    interventions,
    directionTrack: draft.directionTrack,
    simulation: { dt: 0.001, recordRate: 20, seed: draft.seed ?? 1 },
    view: {
      ...(draft.view?.layer ? { layer: draft.view.layer } : {}),
      ...(draft.view?.camera ? { camera: draft.view.camera } : {}),
    },
  });
  if (!scenario.success) return { ok: false, errors: issues(scenario.error, "szenario.") };
  return { ok: true, scenario: scenario.data };
}

function slugOf(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug === "" ? "szenario" : slug;
}

// ---------------------------------------------------------------- Pruefung

/**
 * Tiefer als das steckt ein Koerper nicht mehr nur im Kontaktspielraum,
 * sondern in der Platte. Ein Zentimeter liegt weit ueber dem, was der
 * Kontaktloeser bei normalen Geschwindigkeiten zulaesst.
 */
const PENETRATION_LIMIT = 0.01;

/** Wie weit ein Koerper unter die tiefste Flaeche fallen darf, bevor er als "ins Leere gefallen" gilt. */
const FALL_LIMIT = 1;

export interface BodyReport {
  entityId: string;
  startPosition: Vec3;
  endPosition: Vec3;
  pathLength: number;
  maxSpeed: number;
  tAtMaxSpeed: number;
  endSpeed: number;
  contactIntervals: { from: number; to: number }[];
  /** Tiefste Eindringung in eine Flaeche, Meter; negativ heisst "steckt drin". */
  minSurfaceDistance: number | null;
}

export interface InspectionReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  bodies: BodyReport[];
  scenario?: Scenario;
}

/**
 * Drei Nachkommastellen: genug, um eine Rampe von einem Auslauf zu
 * unterscheiden, und die Zahlenkolonnen bleiben fuer ein Modell lesbar.
 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundVec(value: Vec3): Vec3 {
  return [round(value[0]), round(value[1]), round(value[2])];
}

/**
 * Baut den Entwurf zusammen, simuliert ihn und fasst zusammen, was passiert
 * ist - der Rueckkanal, ueber den der Regisseur sieht, ob sein Szenario tut,
 * was es soll.
 *
 * `errors` heisst "so nicht verwendbar", `warnings` heisst "laeuft, sieht aber
 * nach einem Versehen aus". Die Grenze ist bewusst gezogen: ein Koerper, der
 * neben der Rampe vorbeifaellt, kann gewollt sein - ein Koerper, der in einer
 * Platte steckt, nie.
 */
export function inspectScenario(input: unknown): InspectionReport {
  const assembled = assembleScenario(input);
  if (!assembled.ok) return { ok: false, errors: assembled.errors, warnings: [], bodies: [] };
  const { scenario } = assembled;

  let recording;
  try {
    recording = runScenario(scenario);
  } catch (error) {
    return { ok: false, errors: [(error as Error).message], warnings: [], bodies: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  const late = (t: number) => t > scenario.duration;
  for (const intervention of scenario.interventions) {
    if (late(intervention.t)) {
      warnings.push(
        `Eingriff "${intervention.op}" bei t = ${intervention.t} s liegt hinter der Gesamtdauer und wirkt nicht.`,
      );
    }
  }
  for (const cue of scenario.directionTrack) {
    if (late(cue.t)) warnings.push(`Regieanweisung "${cue.cue}" bei t = ${cue.t} s liegt hinter der Gesamtdauer.`);
  }

  const surfaces = scenario.entities.filter((spec) => spec.kind === "constraint");
  const lowestSurface = surfaces.length > 0 ? Math.min(...surfaces.map((spec) => spec.pose.position[2])) : undefined;

  const bodies: BodyReport[] = [];
  for (const spec of scenario.entities) {
    if (spec.kind !== "body") continue;
    let summary;
    try {
      summary = summarizeEntity(recording, spec.id);
    } catch {
      // Kein Schnappschuss mit diesem Koerper: er kommt erst nach dem Ende hinzu.
      warnings.push(`Koerper "${spec.id}" ist waehrend der Gesamtdauer nie in der Szene.`);
      continue;
    }
    const penetration = surfaces.length > 0 ? penetrationReport(recording, spec.id, spec.phase.shape) : undefined;
    const minDistance =
      penetration && Number.isFinite(penetration.minSignedDistance) ? penetration.minSignedDistance : undefined;

    if (minDistance !== undefined && minDistance < -PENETRATION_LIMIT) {
      errors.push(
        `Koerper "${spec.id}" steckt bei t = ${round(penetration!.tAtMinimum)} s ${round(-minDistance)} m tief ` +
          `in "${penetration!.segmentId}" - Startlage pruefen oder Geschwindigkeit verringern.`,
      );
    }
    if (lowestSurface !== undefined && summary.endPosition[2] < lowestSurface - FALL_LIMIT) {
      warnings.push(
        `Koerper "${spec.id}" endet bei z = ${round(summary.endPosition[2])} m, unter allen Flaechen - ` +
          `er faellt vermutlich an ihnen vorbei.`,
      );
    }

    bodies.push({
      entityId: spec.id,
      startPosition: roundVec(summary.startPosition),
      endPosition: roundVec(summary.endPosition),
      pathLength: round(summary.pathLength),
      maxSpeed: round(summary.maxSpeed),
      tAtMaxSpeed: round(summary.tAtMaxSpeed),
      endSpeed: round(summary.endSpeed),
      contactIntervals: summary.contactIntervals.map(({ from, to }) => ({ from: round(from), to: round(to) })),
      minSurfaceDistance: minDistance === undefined ? null : round(minDistance),
    });
  }

  return { ok: errors.length === 0, errors, warnings, bodies, scenario };
}

/** Die Startbibliothek in der Form, in der ein Modell daraus waehlt: Kennung, Name, Kennwerte. */
export function libraryOverview() {
  return {
    materials: MATERIALS.map((material) => ({
      id: material.id,
      name: material.name,
      density: material.mechanical.density,
      restitution: material.mechanical.restitution,
      staticFriction: material.mechanical.staticFriction ?? 0,
      kineticFriction: material.mechanical.kineticFriction ?? 0,
      rollingFriction: material.mechanical.rollingFriction ?? 0,
    })),
    note:
      "Koerper sind immer Quader, Flaechen immer Rechteckplatten, Lasten immer Schwerefelder. " +
      "Reibung und Stosszahl einer Paarung ergeben sich aus beiden Materialien: Reibung als " +
      "geometrisches Mittel, Stosszahl als Minimum. \"glatt\" ist reibungsfrei, \"standard\" " +
      "prallt nie zurueck (Stosszahl 0).",
  };
}
