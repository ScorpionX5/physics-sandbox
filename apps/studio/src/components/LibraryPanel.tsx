import { useState } from "react";
import type { LibraryEntry, Scenario } from "@sandbox/schema";
import { libraryEntryClassOf } from "../entityProperties.js";
import { ClassIcon, hasClassIcon } from "./ClassIcon.js";

/**
 * Die Objektbibliothek.
 *
 * Zwei Wege hinein: die handgepflegten Builtin-Eintraege und der
 * **Bibliothekar** - der KI-Aufruf, der aus Text einen geprueften Eintrag
 * macht. Der Aufruf geht ueber den Dienst und nicht direkt zur Claude API: ein
 * API-Schluessel im Browser-Bundle ist oeffentlich.
 */

export interface LibraryPanelProps {
  scenario: Scenario;
  /** Was gerade platziert wird - `undefined`, wenn nichts. */
  placing: string | undefined;
  /**
   * Waehrend der Wiedergabe gesperrt: jedes Platzieren legt einen Eingriff zur
   * Zeit des Zeitcursors an, und der steht waehrenddessen nicht still.
   */
  locked: boolean;
  onPlace(entryId: string): void;
  onCancelPlacing(): void;
  /**
   * Fuegt eine Last hinzu. Anders als bei Koerpern und Randbedingungen reicht
   * ein Klick: eine Last hat keine Lage und braucht deshalb keinen Klickpunkt
   * in der Szene.
   */
  onAddLoad(entryId: string): void;
  onEntrySynthesized(entry: LibraryEntry): void;
  onMessage(kind: "info" | "error", text: string): void;
}

/**
 * Was vor dem Namen eines platzierbaren Eintrags steht: das Icon seiner
 * Klasse. Nur ein Eintrag, dessen Klasse noch keines hat, faellt auf den
 * Farbtupfen zurueck - beim Koerper gestrichelt, weil seine Farbe erst vom
 * Material kommt.
 */
function EntryMark({ entry, color }: { entry: LibraryEntry; color?: string }) {
  const entityClass = libraryEntryClassOf(entry);
  if (hasClassIcon(entityClass)) return <ClassIcon entityClass={entityClass} />;
  return color === undefined ? (
    <span className="farbtupfen ohne-farbe" />
  ) : (
    <span className="farbtupfen" style={{ background: color }} />
  );
}

interface SynthesizeResult {
  ok: boolean;
  entry?: LibraryEntry;
  errors: string[];
  warnings: string[];
  correctedFields: string[];
}

export function LibraryPanel({
  scenario,
  placing,
  locked,
  onPlace,
  onCancelPlacing,
  onAddLoad,
  onEntrySynthesized,
  onMessage,
}: LibraryPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const constraints = scenario.library.filter((entry) => entry.definition.kind === "constraint");
  const loads = scenario.library.filter((entry) => entry.definition.kind === "load");
  const bodies = scenario.library.filter((entry) => entry.definition.kind === "body");
  const materials = scenario.library.filter((entry) => entry.definition.kind === "material");

  async function synthesize(): Promise<void> {
    const trimmed = prompt.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/v1/library/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          takenIds: scenario.library.map((entry) => entry.definition.id),
        }),
      });
      const result = (await response.json()) as SynthesizeResult;

      if (response.status === 503) {
        onMessage(
          "error",
          "Der Bibliothekar ist nicht eingerichtet. Starte den Dienst mit gesetztem " +
            "ANTHROPIC_API_KEY (npm run service) und versuche es erneut.",
        );
        return;
      }
      if (!result.ok) {
        // Ein abgelehnter Eintrag ist eine Information, kein Absturz: die
        // Pruefkette hat etwas gefunden, und der Benutzer soll erfahren, was.
        onMessage("error", `Eintrag abgelehnt: ${result.errors.join(" | ")}`);
        return;
      }

      onEntrySynthesized(result.entry!);
      const corrected =
        result.correctedFields.length > 0
          ? ` Korrigiert gegen die Referenztabelle: ${result.correctedFields.join(", ")}.`
          : "";
      onMessage("info", `"${result.entry!.definition.name}" in die Bibliothek aufgenommen.${corrected}`);
      setPrompt("");
    } catch (error) {
      onMessage(
        "error",
        `Der Dienst ist nicht erreichbar (${(error as Error).message}). Laeuft "npm run service"?`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Objektbibliothek</h2>

      <div className="eingabe-zeile">
        <input
          type="text"
          value={prompt}
          placeholder='z. B. "Kupfer" oder "schiefe Ebene 20 Grad"'
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void synthesize();
          }}
          disabled={busy}
          aria-label="Neues Objekt per Texteingabe erzeugen"
        />
        <button type="button" onClick={() => void synthesize()} disabled={busy || prompt.trim() === ""}>
          {busy ? "…" : "Erzeugen"}
        </button>
      </div>
      <p className="hinweis">
        Die KI entwirft Darstellung und Eigenschaften. Materialwerte von Elementen werden
        anschliessend gegen eine Referenztabelle geprueft und notfalls korrigiert.
      </p>

      <h3>Randbedingungen</h3>
      <ul className="eintragsliste">
        {constraints.map((entry) =>
          entry.definition.kind !== "constraint" ? null : (
            <li key={entry.definition.id}>
              <button
                type="button"
                className={placing === entry.definition.id ? "eintrag aktiv" : "eintrag"}
                disabled={locked}
                onClick={() =>
                  placing === entry.definition.id ? onCancelPlacing() : onPlace(entry.definition.id)
                }
              >
                <EntryMark entry={entry} />
                <span className="eintrag-name">{entry.definition.name}</span>
              </button>
            </li>
          ),
        )}
      </ul>

      <h3>Lasten</h3>
      <ul className="eintragsliste">
        {loads.map((entry) =>
          entry.definition.kind !== "load" ? null : (
            <li key={entry.definition.id}>
              <button
                type="button"
                className="eintrag"
                disabled={locked}
                onClick={() => onAddLoad(entry.definition.id)}
              >
                <EntryMark entry={entry} color={entry.definition.appearance.macroscopic.color} />
                <span className="eintrag-name">{entry.definition.name}</span>
              </button>
            </li>
          ),
        )}
      </ul>

      <h3>Körper</h3>
      <ul className="eintragsliste">
        {bodies.map((entry) => (
          <li key={entry.definition.id}>
            <button
              type="button"
              className={placing === entry.definition.id ? "eintrag aktiv" : "eintrag"}
              disabled={locked}
              onClick={() =>
                placing === entry.definition.id ? onCancelPlacing() : onPlace(entry.definition.id)
              }
            >
              <EntryMark entry={entry} />
              <span className="eintrag-name">{entry.definition.name}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Materialien werden nicht platziert, sondern einem Koerper zugewiesen
          (rechte Leiste). Deshalb kein Knopf, nur der Eintrag. */}
      <h3>Materialien</h3>
      <ul className="eintragsliste">
        {materials.map((entry) =>
          entry.definition.kind !== "material" ? null : (
            <li key={entry.definition.id}>
              <div className="eintrag statisch">
                <span
                  className="farbtupfen"
                  style={{ background: entry.definition.appearance.macroscopic.color }}
                />
                <span className="eintrag-name">{entry.definition.name}</span>
              </div>
              {entry.provenance.correctedFields.length > 0 && (
                <p className="korrektur" title={entry.provenance.warnings.join("\n")}>
                  korrigiert: {entry.provenance.correctedFields.join(", ")}
                </p>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
