import { z } from "zod";
import {
  Appearance,
  MechanicalProperties,
  ThermalProperties,
  ChemicalProperties,
  validateLibraryEntry,
  type Constraint,
  type LibraryEntry,
  type Material,
  type SurfaceSegment,
  type ValidationResult,
} from "@sandbox/schema";

/**
 * Der **Bibliothekar**: der eng umrissene KI-Aufruf, der aus Text einen
 * geprueften Bibliothekseintrag macht.
 *
 * Ein Aufruf, strukturierte Ausgabe, keine Werkzeuge. Das ist der Unterschied
 * zum **Regisseur**, der eine Agentenschleife mit Werkzeugen fuehrt.
 *
 * Zwei Entwurfsentscheidungen tragen die Qualitaet:
 *
 * 1. **Die Geometrie rechnet der Code, nicht das Modell.** Ein Modell um
 *    orthonormale Basisvektoren zu bitten ist eine verlaessliche Fehlerquelle.
 *    Es liefert stattdessen hohe Parameter - Neigungswinkel, Laengen, Breite -
 *    und der Code macht daraus die Segmente. Das Modell tut, was
 *    Modelle gut koennen (benennen, einordnen, plausible Werte waehlen), der
 *    Code tut die Trigonometrie.
 *
 * 2. **Zahlen gewinnt die Referenztabelle.** Fuer Elemente braucht das Modell
 *    ueberhaupt keine Materialwerte zu erfinden, nur die Darstellung zu entwerfen.
 *    Die Pruefung in `@sandbox/schema` ersetzt abweichende Werte und vermerkt
 *    das. Dieses Modul erzwingt die Pruefung - es gibt keinen Weg daran vorbei
 *    in die Bibliothek.
 */

// ---------------------------------------------------------------- Ausgabeform

/**
 * Mechanische Werte im Entwurf: wie im Schema, aber mit Pflicht-Reibwerten.
 *
 * Im Schema darf die Reibung fehlen (dann ist das Material reibungsfrei), damit
 * aeltere Dateien laden. Ein neues Material vom Modell soll sie mitbringen - ein
 * vergessener Wert hiesse sonst still "gleitet wie auf Eis".
 */
const MechanicalDraft = MechanicalProperties.extend({
  staticFriction: z
    .number()
    .min(0)
    .describe("Haftreibungszahl des Materials gegen sich selbst, trocken (Stahl auf Stahl: 0.74)"),
  kineticFriction: z
    .number()
    .min(0)
    .describe("Gleitreibungszahl gegen sich selbst, trocken, hoechstens die Haftreibungszahl (Stahl: 0.57)"),
  rollingFriction: z
    .number()
    .min(0)
    .max(0.1)
    .describe("Hebelarm der Rollreibung in Metern, gegen sich selbst (Stahl: 0.0005, Holz: 0.0015)"),
});

/**
 * Entwurf eines Materials. Ohne `kind` und `id`: beide setzt der Code, damit das
 * Modell keine Ids erfinden kann, die mit bestehenden kollidieren.
 */
export const MaterialDraft = z.object({
  name: z.string().min(1).max(120).describe("Deutscher Anzeigename, z.B. \"Eisen\""),
  formula: z
    .string()
    .max(60)
    .optional()
    .describe("Summenformel, falls sinnvoll: \"Fe\", \"O2\", \"Fe2O3\". Bei Stoffgemischen weglassen."),
  mechanical: MechanicalDraft,
  thermal: ThermalProperties.optional(),
  chemical: ChemicalProperties.optional(),
  appearance: Appearance,
});
export type MaterialDraft = z.infer<typeof MaterialDraft>;

/**
 * Entwurf einer Flaeche. Der Code macht daraus ein Segment mit normierten,
 * zueinander senkrechten Achsen.
 *
 * Bewusst nur eine *einzelne* Flaeche, nicht eine Rampe mit Auslauf: die
 * "Ebene" ist die einzige Flaechen-Grundform, und Neigung, Lage und Groesse
 * stehen an der platzierten Instanz. Ein Bibliothekseintrag, der eine fertige
 * Rampe mitbringt, waere ein zweiter Weg zu derselben Sache - und der Benutzer
 * koennte ihn hinterher nicht mehr in seine Teile zerlegen.
 */
export const SurfaceDraft = z.object({
  length: z.number().positive().describe("Laenge der Flaeche in Metern"),
  width: z.number().positive().describe("Breite der Flaeche in Metern"),
  thickness: z
    .number()
    .positive()
    .max(1)
    .describe("Dicke der Platte in Metern, nur fuer die Darstellung"),
});
export type SurfaceDraft = z.infer<typeof SurfaceDraft>;

export const ConstraintDraft = z.object({
  name: z.string().min(1).max(120).describe("Deutscher Anzeigename"),
  surface: SurfaceDraft,
});
export type ConstraintDraft = z.infer<typeof ConstraintDraft>;

/**
 * Was der Bibliothekar zurueckgibt.
 *
 * Die Alternative zwischen Material und Randbedingung ist absichtlich als
 * Diskriminator plus zwei optionale Felder modelliert und nicht als
 * diskriminierte Union: letztere wird zu `anyOf` mit Konstanten, und je nach
 * Modellversion ist das fuer strukturierte Ausgaben heikel. Dass genau eines
 * der beiden Felder gesetzt ist, prueft `assembleEntry`.
 */
export const LibrarianDraft = z.object({
  kind: z
    .enum(["material", "constraint"])
    .describe(
      "\"material\" fuer ein Material (Eisen, Sauerstoff, Holz), \"constraint\" fuer eine " +
        "Randbedingung ohne eigene Materie (schiefe Ebene, Flaeche).",
    ),
  material: MaterialDraft.optional(),
  constraint: ConstraintDraft.optional(),
  note: z
    .string()
    .max(600)
    .describe("Ein bis zwei Saetze, woher die Werte stammen oder worauf sie beruhen."),
});
export type LibrarianDraft = z.infer<typeof LibrarianDraft>;

// ---------------------------------------------------------------- Zusammenbau

/** Macht aus einem Namen eine stabile Id. */
export function slugify(name: string): string {
  const replacements: Record<string, string> = {
    ä: "ae",
    ö: "oe",
    ü: "ue",
    Ä: "ae",
    Ö: "oe",
    Ü: "ue",
    ß: "ss",
  };
  const normalized = [...name.trim().toLowerCase()]
    .map((character) => replacements[character] ?? character)
    .join("");
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "eintrag" : slug.slice(0, 64);
}

/**
 * Baut das Flaechensegment aus den hohen Parametern des Modells.
 *
 * Normale und Tangente setzt der Code, nicht das Modell: ein Modell um
 * orthonormale Basisvektoren zu bitten ist eine verlaessliche Fehlerquelle. Die
 * Flaeche liegt im Koerpersystem waagerecht - ihre Normale zeigt nach +z, der
 * Hochachse der Welt; geneigt wird sie durch die Drehung der platzierten
 * Instanz.
 */
function surfaceSegments(draft: SurfaceDraft): SurfaceSegment[] {
  return [
    {
      id: "flaeche",
      center: [0, 0, 0],
      normal: [0, 0, 1],
      tangent: [1, 0, 0],
      halfExtentU: draft.length / 2,
      halfExtentV: draft.width / 2,
      thickness: draft.thickness,
    },
  ];
}

export interface AssembleOptions {
  prompt: string;
  model: string;
  /** Wird in `provenance.createdAt` geschrieben. Der Kern kennt keine Uhr - der Service schon. */
  createdAt?: string;
  /** Bereits belegte Ids, damit eine neue nicht kollidiert. */
  takenIds?: Iterable<string>;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Keine freie Id fuer "${base}" gefunden.`);
}

/**
 * Baut aus einem Entwurf einen geprueften Bibliothekseintrag.
 *
 * Die Pruefung laeuft immer. Es gibt keinen Parameter, der sie abschaltet -
 * sonst waere sie beim ersten Zeitdruck das erste, was wegfaellt.
 */
export function assembleEntry(draft: LibrarianDraft, options: AssembleOptions): ValidationResult {
  const taken = new Set(options.takenIds ?? []);

  if (draft.kind === "material" && !draft.material) {
    return {
      ok: false,
      errors: ['kind war "material", aber das Feld `material` fehlt.'],
      warnings: [],
      correctedFields: [],
    };
  }
  if (draft.kind === "constraint" && !draft.constraint) {
    return {
      ok: false,
      errors: ['kind war "constraint", aber das Feld `constraint` fehlt.'],
      warnings: [],
      correctedFields: [],
    };
  }

  const provenance = {
    source: "librarian" as const,
    prompt: options.prompt,
    model: options.model,
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    correctedFields: [],
    warnings: draft.note ? [`Bibliothekar: ${draft.note}`] : [],
  };

  if (draft.kind === "material") {
    const material = draft.material!;
    const definition: Material = {
      kind: "material",
      id: uniqueId(slugify(material.name), taken),
      ...material,
    };
    return validateLibraryEntry({ definition, provenance });
  }

  const constraintDraft = draft.constraint!;
  let segments: SurfaceSegment[];
  try {
    segments = surfaceSegments(constraintDraft.surface);
  } catch (error) {
    // Ein unmoeglicher Neigungswinkel ist ein Fehler des Modells, kein Absturz
    // des Dienstes.
    return {
      ok: false,
      errors: [`Flaechengeometrie nicht baubar: ${(error as Error).message}`],
      warnings: [],
      correctedFields: [],
    };
  }

  const definition: Constraint = {
    kind: "constraint",
    id: uniqueId(slugify(constraintDraft.name), taken),
    name: constraintDraft.name,
    behaviour: {
      constraintType: "staticSurface",
      segments,
    },
  };
  return validateLibraryEntry({ definition, provenance });
}

// ---------------------------------------------------------------- Modellanbindung

/**
 * Die Modellanbindung ist eine Schnittstelle, damit die Tests den
 * deterministischen Teil - Zusammenbau, Geometrie, Pruefung - ohne Netz und
 * ohne Kosten pruefen koennen.
 */
export interface LibrarianModel {
  readonly modelId: string;
  draft(prompt: string): Promise<LibrarianDraft>;
}

/**
 * Fehler, der fehlende oder unguelige Zugangsdaten bedeutet.
 *
 * Eigener Typ, weil er anders zu behandeln ist als ein Netzfehler: der Aufrufer
 * soll einen Hinweis bekommen, wie er Zugangsdaten einrichtet, und nicht die
 * Meldung, das Modell sei nicht erreichbar.
 */
export class MissingCredentialsError extends Error {
  constructor(detail?: string) {
    super(
      "Keine Zugangsdaten fuer die Claude API gefunden. Setze ANTHROPIC_API_KEY oder melde " +
        "dich mit `ant auth login` an und starte den Dienst neu." +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "MissingCredentialsError";
  }
}

export const LIBRARIAN_SYSTEM_PROMPT = `Du fuellst Eintraege fuer die Objektbibliothek einer Physik- und Chemie-Lernsandbox.

Aus einer kurzen Texteingabe des Benutzers ("Eisen", "Sauerstoff", "schiefe Ebene 30 Grad") erzeugst du einen vollstaendigen Eintrag.

Regeln:
- Alle Groessen in SI-Einheiten: Dichte in kg/m^3, Waermekapazitaet in J/(kg*K), Temperaturen in Kelvin, molare Masse in g/mol.
- Bei chemischen Elementen gib die Ordnungszahl an. Materialwerte wie Dichte, molare Masse, Schmelz- und Siedepunkt werden anschliessend gegen eine Referenztabelle geprueft und notfalls korrigiert - gib trotzdem deine beste Schaetzung an, aber erfinde keine Praezision.
- Die Elektronenkonfiguration wird aus der Ordnungszahl berechnet. Gib sie nicht an.
- Bei Stoffgemischen und Werkstoffen ohne klare Summenformel (Holz, Stahl, Beton) lass "formula" weg.
- Farben waehle so, dass das Material wiedererkennbar ist: Metalle grau mit hohem metalness-Wert, Rost rotbraun, Gase blass und mit geringer opacity.
- Fuer die atomare Ansicht gib Atomradius und Gitterkonstante in Pikometern an; ihr Verhaeltnis bestimmt die dargestellte Packungsdichte und soll stimmen.
- Reibwerte (Haft-, Gleitreibungszahl, Hebelarm der Rollreibung) gibst du fuer das Material gegen sich selbst an, trocken. Die Sandbox bildet die Werte einer Paarung als geometrisches Mittel der beiden Materialien.
- Bei Randbedingungen (constraint) gib nur Laenge, Breite und Dicke an; Aussehen, Stosszahl und Reibung kommen vom Material, das der Benutzer der Flaeche zuweist. Eine Randbedingung ist immer eine einzelne, waagerechte Flaeche; Neigung, Lage und Groesse legt der Benutzer beim Platzieren fest. Erzeuge also keine fertigen Rampen.
- Waehle "constraint" nur fuer Dinge ohne eigene Materie im Sinne der Simulation: Flaechen, Rampen. Alles Stoffliche ist "material".`;

export interface ClaudeLibrarianOptions {
  /** Standard: claude-sonnet-5-5. Ein Aufruf mit festem Schema - Opus waere hier Verschwendung. */
  model?: string;
  maxTokens?: number;
}

/**
 * Der echte Bibliothekar auf Basis der Claude API.
 *
 * Benutzt `messages.parse()` mit `output_config.format` und *keinen* erzwungenen
 * Werkzeugaufruf: `tool_choice: {type: "any"}` gibt auf Claude Sonnet 5.5 und
 * Claude Opus 5.5 einen 400er. Strukturierte Ausgaben sind hier ohnehin das
 * passendere Mittel - gebraucht wird ein Datensatz, keine Aktion.
 */
export async function createClaudeLibrarian(
  options: ClaudeLibrarianOptions = {},
): Promise<LibrarianModel> {
  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("@anthropic-ai/sdk/helpers/zod"),
  ]);

  const client = new Anthropic();
  const modelId = options.model ?? "claude-sonnet-5-5";
  const maxTokens = options.maxTokens ?? 8000;

  /**
   * `new Anthropic()` wirft *nicht*, wenn keine Zugangsdaten vorliegen - es
   * scheitert erst beim ersten Aufruf. Ein nicht gesetztes `ANTHROPIC_API_KEY`
   * bedeutet zudem nicht, dass es keine Zugangsdaten gibt: das SDK loest
   * `ANTHROPIC_API_KEY`, dann `ANTHROPIC_AUTH_TOKEN`, dann das OAuth-Profil von
   * `ant auth login` auf, und letzteres taucht in diesen Feldern nicht auf.
   *
   * Deshalb wird hier nur der eindeutige Fall gemeldet - beide Felder leer und
   * kein Profilverzeichnis vorhanden. Alles andere entscheidet der erste
   * Aufruf, und `MissingCredentialsError` faengt es dort ab.
   */
  if (client.apiKey === null && client.authToken === null && !(await hasStoredProfile())) {
    throw new MissingCredentialsError();
  }

  return {
    modelId,
    async draft(prompt: string): Promise<LibrarianDraft> {
      const response = await client.messages
        .parse({
        model: modelId,
        max_tokens: maxTokens,
        system: LIBRARIAN_SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
          output_config: { format: zodOutputFormat(LibrarianDraft) },
          messages: [{ role: "user", content: prompt }],
        })
        .catch((error: unknown) => {
          // 401 heisst fehlende oder falsche Zugangsdaten, nicht "Modell
          // kaputt". Der Unterschied entscheidet, welchen Hinweis der Benutzer
          // bekommt.
          if (error instanceof Anthropic.AuthenticationError) {
            throw new MissingCredentialsError(error.message);
          }
          throw error;
        });

      if (response.stop_reason === "refusal") {
        throw new Error(
          `Das Modell hat die Anfrage abgelehnt (${response.stop_details?.category ?? "ohne Angabe"}).`,
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(
          `Die Antwort wurde bei ${maxTokens} Tokens abgeschnitten; maxTokens erhoehen.`,
        );
      }
      if (!response.parsed_output) {
        throw new Error("Das Modell lieferte keine schemakonforme Ausgabe.");
      }
      return response.parsed_output;
    },
  };
}

/**
 * Ein Durchlauf des Bibliothekars: Text rein, geprueftes Ergebnis raus.
 */
export async function synthesizeEntry(
  model: LibrarianModel,
  prompt: string,
  options: { takenIds?: Iterable<string>; now?: () => string } = {},
): Promise<ValidationResult> {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    return {
      ok: false,
      errors: ["Die Texteingabe war leer."],
      warnings: [],
      correctedFields: [],
    };
  }
  const draft = await model.draft(trimmed);
  return assembleEntry(draft, {
    prompt: trimmed,
    model: model.modelId,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    ...(options.takenIds ? { takenIds: options.takenIds } : {}),
  });
}

/**
 * Ob ein OAuth-Profil von `ant auth login` auf der Platte liegt.
 *
 * Nur ein Indiz: ob das Profil gueltig ist, zeigt erst der Aufruf. Es genuegt
 * aber, um einen Dienst nicht abzuweisen, der ueber `ant auth login`
 * angemeldet ist.
 */
async function hasStoredProfile(): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const candidates = [
    process.env["ANTHROPIC_CONFIG_DIR"],
    join(homedir(), ".config", "anthropic"),
    join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "anthropic"),
  ].filter((path): path is string => typeof path === "string" && path !== "");

  for (const path of candidates) {
    try {
      await access(path);
      return true;
    } catch {
      // Verzeichnis fehlt - naechster Kandidat.
    }
  }
  return false;
}

export type { LibraryEntry };
