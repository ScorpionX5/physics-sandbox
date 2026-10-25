import { Scenario as ScenarioSchema, type Scenario } from "@sandbox/schema";

/**
 * Szenarien als Dateien speichern und laden.
 *
 * Dateien statt Browser-Speicher: ein Szenario ist damit teilbar,
 * versionierbar und liegt dort, wo der Benutzer es wiederfindet. Browser-Daten
 * sind an einen Browser gebunden und beim Loeschen der Website-Daten weg.
 *
 * Geladen wird **immer durch das Schema**. Eine Datei von der Platte ist
 * fremde Eingabe - auch die eigene von letzter Woche, die noch einem aelteren
 * Schema folgt. Sie unvalidiert in den Zustand zu uebernehmen hiesse, den
 * Fehler erst mitten im Simulationslauf zu bemerken.
 */

/** Dateiendung, auf die `Speichern` vorschlaegt. */
export const SCENARIO_EXTENSION = ".scenario.json";

export function scenarioFileName(scenario: Scenario): string {
  const base = scenario.name
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base === "" ? "szenario" : base}${SCENARIO_EXTENSION}`;
}

export function serializeScenario(scenario: Scenario): string {
  // Eingerueckt, weil die Datei von Hand lesbar und in Git diffbar sein soll -
  // ein Szenario ist Quelltext, nicht Transportformat.
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

/** Loest den Download der Szenariodatei aus. */
export function downloadScenario(scenario: Scenario): void {
  const blob = new Blob([serializeScenario(scenario)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = scenarioFileName(scenario);
    anchor.click();
  } finally {
    // Ohne das Freigeben haelt der Browser den Blob bis zum Neuladen fest.
    // Verzoegert, weil der Klick sonst ins Leere laeuft.
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export type ParseResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: string[] };

/**
 * Liest ein Szenario aus Text und prueft es gegen das Schema.
 *
 * Getrennt vom Dateidialog, damit die Pruefung ohne Browser testbar ist - und
 * damit derselbe Weg fuer eine Datei, eine Einfuegeaktion und eine spaetere
 * Netzantwort gilt.
 */
export function parseScenario(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Die Datei ist kein gueltiges JSON: ${(error as Error).message}`] };
  }

  const parsed = ScenarioSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".") || "<wurzel>"}: ${issue.message}`),
    };
  }

  // Ueber das Schema hinaus: ein Szenario muss seine Bibliothekseintraege
  // mitbringen, sonst scheitert erst der Lauf.
  const known = new Set(parsed.data.library.map((entry) => entry.definition.id));
  const missing: string[] = [];
  for (const entity of parsed.data.entities) {
    // Koerper und Randbedingung verweisen zweimal: auf ihren Eintrag und auf ihr Material.
    const needed =
      entity.kind === "body"
        ? [entity.bodyId, entity.materialId]
        : entity.kind === "constraint"
          ? [entity.constraintId, entity.materialId]
          : [entity.loadId];
    for (const id of needed) {
      if (!known.has(id) && !missing.includes(id)) missing.push(id);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      errors: [
        `Die Datei verweist auf Bibliothekseintraege, die sie nicht mitbringt: ${missing.join(", ")}.`,
      ],
    };
  }

  return { ok: true, scenario: parsed.data };
}

/** Oeffnet den Dateidialog und liest die gewaehlte Datei. */
export async function openScenarioFile(): Promise<ParseResult | undefined> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";

  const file = await new Promise<File | undefined>((resolve) => {
    // `change` feuert nicht, wenn der Benutzer abbricht; `cancel` schon. Ohne
    // das zweite bliebe das Versprechen bei einem Abbruch fuer immer offen.
    input.addEventListener("change", () => resolve(input.files?.[0] ?? undefined), { once: true });
    input.addEventListener("cancel", () => resolve(undefined), { once: true });
    input.click();
  });

  if (!file) return undefined;
  return parseScenario(await file.text());
}
