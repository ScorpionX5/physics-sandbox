import { ELEMENTS, elementByNumber, findElement } from "./elements.js";
import type { Body, Constraint, Load, LibraryEntry, Material } from "./library.js";
import { LibraryEntry as LibraryEntrySchema } from "./library.js";

/**
 * Pruefung der Bibliothekseintraege.
 *
 * Schema-Validierung allein genuegt nicht: ein schematisch korrektes Material kann
 * physikalisch Unsinn sein. Eisen mit der Dichte von Styropor passiert jedes
 * Zod-Schema. Diese Schicht prueft deshalb zusaetzlich auf Konsistenz zwischen
 * Feldern und gegen die kuratierte Referenztabelle.
 *
 * Grundhaltung: **korrigieren statt ablehnen, wo eine belastbare Referenz
 * existiert; ablehnen, wo der Eintrag in sich widerspruechlich ist.** Ein
 * falscher Dichtewert fuer Eisen wird stillschweigend durch den Referenzwert
 * ersetzt und vermerkt - das ist besser, als den Eintrag zu verwerfen und den
 * Benutzer ohne Eisen stehen zu lassen. Ein Schmelzpunkt oberhalb des
 * Siedepunkts dagegen ist nicht reparierbar, weil unklar ist, welcher der beiden
 * Werte gemeint war.
 */

/** Relative Abweichung, ab der ein KI-Wert durch den Referenzwert ersetzt wird. */
export const REFERENCE_TOLERANCE = 0.05;

export interface ValidationResult {
  ok: boolean;
  /** Der - moeglicherweise korrigierte - Eintrag. Nur gesetzt, wenn `ok`. */
  entry?: LibraryEntry;
  /** Gruende fuer eine Ablehnung. */
  errors: string[];
  /** Hinweise, die den Eintrag nicht ablehnen. */
  warnings: string[];
  /** Pfade der Felder, bei denen die Referenz den KI-Wert ueberstimmt hat. */
  correctedFields: string[];
}

// ---------------------------------------------------------------- Formeln

export interface ParsedFormula {
  /** Atomanzahl je Elementsymbol. */
  counts: Map<string, number>;
}

const VALID_SYMBOLS = new Set(ELEMENTS.map((e) => e.symbol));

/**
 * Parst eine Summenformel zu Atomanzahlen. Unterstuetzt Klammern und
 * nachgestellte Faktoren: "Fe2O3", "Ca(OH)2", "CuSO4".
 *
 * Gibt `undefined` zurueck, wenn die Formel nicht eindeutig lesbar ist - das ist
 * kein Fehler, sondern heisst nur, dass die formelbasierten Pruefungen
 * ausfallen. Viele sinnvolle Materialien ("Holz", "Stahl") haben keine Summenformel.
 */
export function parseFormula(formula: string): ParsedFormula | undefined {
  const text = formula.trim();
  if (text === "") return undefined;

  let index = 0;

  function readNumber(): number {
    let digits = "";
    while (index < text.length) {
      const ch = text[index]!;
      if (ch < "0" || ch > "9") break;
      digits += ch;
      index += 1;
    }
    return digits === "" ? 1 : Number(digits);
  }

  /**
   * Liest eine Folge von Symbolen und Gruppen bis zum Ende oder bis zur
   * naechsten schliessenden Klammer und gibt ihre Atomanzahlen zurueck.
   * `undefined` heisst: nicht lesbar.
   */
  function parseSequence(): Map<string, number> | undefined {
    const counts = new Map<string, number>();
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === ")") break;

      if (ch === "(") {
        index += 1;
        const inner = parseSequence();
        if (!inner || text[index] !== ")") return undefined;
        index += 1;
        const factor = readNumber();
        for (const [symbol, count] of inner) {
          counts.set(symbol, (counts.get(symbol) ?? 0) + count * factor);
        }
        continue;
      }

      if (ch >= "A" && ch <= "Z") {
        let symbol = ch;
        index += 1;
        const next = text[index];
        if (next !== undefined && next >= "a" && next <= "z" && VALID_SYMBOLS.has(symbol + next)) {
          symbol += next;
          index += 1;
        }
        if (!VALID_SYMBOLS.has(symbol)) return undefined;
        counts.set(symbol, (counts.get(symbol) ?? 0) + readNumber());
        continue;
      }

      // Alles andere (Ladungen, Punkte, Leerzeichen) macht die Formel fuer
      // diese Pruefung unlesbar.
      return undefined;
    }
    return counts;
  }

  const counts = parseSequence();
  if (!counts || index !== text.length || counts.size === 0) return undefined;
  return { counts };
}

/** Molare Masse in g/mol aus einer Summenformel, oder `undefined`. */
export function molarMassFromFormula(formula: string): number | undefined {
  const parsed = parseFormula(formula);
  if (!parsed) return undefined;
  let total = 0;
  for (const [symbol, count] of parsed.counts) {
    const element = findElement(symbol);
    if (!element) return undefined;
    total += element.molarMass * count;
  }
  return total;
}

export interface ReactionSide {
  /** Summenformel je Beteiligtem mit stoechiometrischem Koeffizienten. */
  species: ReadonlyArray<{ formula: string; coefficient: number }>;
}

/**
 * Prueft die Elementbilanz einer Reaktion: die Atomsumme je Element muss auf
 * beiden Seiten gleich sein. `4 Fe + 3 O2 -> 2 Fe2O3` passiert; `Fe + O2 ->
 * Fe2O3` nicht.
 *
 * Steht bereit fuer das Chemie-Modul (Stufe 4) und wird vom Formel-Test schon
 * jetzt abgedeckt - eine Bilanzpruefung, die erst mit der Chemie entsteht,
 * entsteht erfahrungsgemaess nie.
 */
export function checkElementBalance(
  educts: ReactionSide,
  products: ReactionSide,
): { balanced: boolean; problems: string[] } {
  const problems: string[] = [];
  const tally = (side: ReactionSide, sign: number, into: Map<string, number>): boolean => {
    for (const { formula, coefficient } of side.species) {
      const parsed = parseFormula(formula);
      if (!parsed) {
        problems.push(`Summenformel nicht lesbar: ${formula}`);
        return false;
      }
      if (!(coefficient > 0)) {
        problems.push(`Stoechiometrischer Koeffizient muss positiv sein: ${formula}`);
        return false;
      }
      for (const [symbol, count] of parsed.counts) {
        into.set(symbol, (into.get(symbol) ?? 0) + sign * count * coefficient);
      }
    }
    return true;
  };

  const balance = new Map<string, number>();
  if (!tally(educts, 1, balance)) return { balanced: false, problems };
  if (!tally(products, -1, balance)) return { balanced: false, problems };

  for (const [symbol, delta] of balance) {
    if (Math.abs(delta) > 1e-9) {
      const side = delta > 0 ? "Eduktseite" : "Produktseite";
      problems.push(`Elementbilanz verletzt: ${symbol} um ${Math.abs(delta)} zu viel auf der ${side}`);
    }
  }
  return { balanced: problems.length === 0, problems };
}

// ---------------------------------------------------------------- Eintrag

function relativeDeviation(actual: number, reference: number): number {
  if (reference === 0) return actual === 0 ? 0 : Infinity;
  return Math.abs(actual - reference) / Math.abs(reference);
}

function validateMaterial(material: Material, result: ValidationResult): Material {
  const next: Material = structuredClone(material);

  // --- Querbezuege, die Zod nicht pruefen kann
  const thermal = next.thermal;
  if (thermal?.meltingPoint !== undefined && thermal.boilingPoint !== undefined) {
    if (thermal.meltingPoint >= thermal.boilingPoint) {
      result.errors.push(
        `Schmelzpunkt (${thermal.meltingPoint} K) liegt nicht unter dem Siedepunkt ` +
          `(${thermal.boilingPoint} K). Nicht reparierbar, weil unklar ist, welcher Wert gemeint war.`,
      );
    }
  }

  // --- Element identifizieren: explizite Ordnungszahl, sonst Name oder Formel
  let element = next.chemical?.atomicNumber !== undefined
    ? elementByNumber(next.chemical.atomicNumber)
    : undefined;
  if (!element) {
    element = findElement(next.name) ?? (next.formula ? findElement(next.formula) : undefined);
    if (element) {
      next.chemical = { ...next.chemical, atomicNumber: element.atomicNumber };
      result.correctedFields.push("chemical.atomicNumber");
      result.warnings.push(
        `Ordnungszahl ${element.atomicNumber} aus dem Namen "${next.name}" erschlossen.`,
      );
    }
  }

  // --- Abgleich gegen die Referenztabelle
  if (element) {
    const compare = (
      path: string,
      actual: number | undefined,
      reference: number | undefined,
      assign: (value: number) => void,
    ): void => {
      if (reference === undefined) {
        if (actual !== undefined) {
          result.warnings.push(
            `${path}: kein Referenzwert fuer ${element!.symbol} hinterlegt, KI-Wert uebernommen.`,
          );
        }
        return;
      }
      if (actual === undefined) {
        assign(reference);
        result.correctedFields.push(path);
        return;
      }
      if (relativeDeviation(actual, reference) > REFERENCE_TOLERANCE) {
        result.warnings.push(
          `${path}: KI-Wert ${actual} weicht mehr als ${REFERENCE_TOLERANCE * 100} % vom ` +
            `Referenzwert ${reference} ab; Referenzwert uebernommen.`,
        );
        assign(reference);
        result.correctedFields.push(path);
      }
    };

    compare("mechanical.density", next.mechanical.density, element.density, (v) => {
      next.mechanical.density = v;
    });
    compare("chemical.molarMass", next.chemical?.molarMass, element.molarMass, (v) => {
      next.chemical = { ...next.chemical, molarMass: v };
    });
    compare("thermal.meltingPoint", next.thermal?.meltingPoint, element.meltingPoint, (v) => {
      next.thermal = { ...next.thermal, meltingPoint: v };
    });
    compare("thermal.boilingPoint", next.thermal?.boilingPoint, element.boilingPoint, (v) => {
      next.thermal = { ...next.thermal, boilingPoint: v };
    });
  } else if (next.formula) {
    // --- Verbindung: molare Masse muss zur Summenformel passen
    const fromFormula = molarMassFromFormula(next.formula);
    const claimed = next.chemical?.molarMass;
    if (fromFormula !== undefined) {
      if (claimed === undefined) {
        next.chemical = { ...next.chemical, molarMass: fromFormula };
        result.correctedFields.push("chemical.molarMass");
      } else if (relativeDeviation(claimed, fromFormula) > REFERENCE_TOLERANCE) {
        result.warnings.push(
          `chemical.molarMass: ${claimed} g/mol passt nicht zur Summenformel ` +
            `${next.formula} (${fromFormula.toFixed(3)} g/mol); aus der Formel berechneter Wert uebernommen.`,
        );
        next.chemical = { ...next.chemical, molarMass: fromFormula };
        result.correctedFields.push("chemical.molarMass");
      }
    } else {
      result.warnings.push(
        `Summenformel "${next.formula}" nicht lesbar; formelbasierte Pruefungen entfallen.`,
      );
    }
  }

  // --- Override der Elektronenkonfiguration nur mit Ordnungszahl sinnvoll
  if (
    next.chemical?.electronConfigurationOverride !== undefined &&
    next.chemical.atomicNumber === undefined
  ) {
    result.errors.push(
      "electronConfigurationOverride ohne atomicNumber: die subatomare Ansicht kann die " +
        "Konfiguration dann nicht gegen das Aufbauprinzip einordnen.",
    );
  }

  return next;
}

function validateConstraint(constraint: Constraint, result: ValidationResult): Constraint {
  const next: Constraint = structuredClone(constraint);
  if (next.behaviour.constraintType !== "staticSurface") return next;

  const seen = new Set<string>();
  for (const segment of next.behaviour.segments) {
    if (seen.has(segment.id)) {
      result.errors.push(`Flaechensegment-Id doppelt: ${segment.id}`);
    }
    seen.add(segment.id);

    const nLen = Math.hypot(...segment.normal);
    const tLen = Math.hypot(...segment.tangent);
    if (nLen < 1e-9 || tLen < 1e-9) {
      result.errors.push(`Segment ${segment.id}: Normale oder Tangente ist der Nullvektor.`);
      continue;
    }

    // Normieren statt ablehnen: ein nicht normierter Vektor ist eindeutig
    // reparierbar - die Richtung steht fest.
    if (Math.abs(nLen - 1) > 1e-6) {
      segment.normal = [segment.normal[0] / nLen, segment.normal[1] / nLen, segment.normal[2] / nLen];
      result.correctedFields.push(`segment.${segment.id}.normal`);
    }
    if (Math.abs(tLen - 1) > 1e-6) {
      segment.tangent = [
        segment.tangent[0] / tLen,
        segment.tangent[1] / tLen,
        segment.tangent[2] / tLen,
      ];
      result.correctedFields.push(`segment.${segment.id}.tangent`);
    }

    const dot =
      segment.normal[0] * segment.tangent[0] +
      segment.normal[1] * segment.tangent[1] +
      segment.normal[2] * segment.tangent[2];
    if (Math.abs(dot) > 1e-6) {
      result.errors.push(
        `Segment ${segment.id}: Tangente ist nicht senkrecht zur Normale ` +
          `(Skalarprodukt ${dot.toFixed(6)}). Die Plattenebene waere nicht eindeutig.`,
      );
    }
  }
  return next;
}

/**
 * Lasten haben noch kein Modul, das Felder gegen etwas pruefen koennte -
 * `heatSource` ist ein reiner Platzhalter. Die Funktion existiert trotzdem,
 * damit `validateLibraryEntry` nicht auf Zuruf unterscheiden muss, welcher
 * Definitionskind geprueft wird.
 */
function validateLoad(load: Load, _result: ValidationResult): Load {
  return structuredClone(load);
}

/**
 * Ein Koerper ist reine Form; dass die Kanten positiv sind, prueft schon das
 * Schema. Wie bei `validateLoad` existiert die Funktion, damit jede Art von
 * Eintrag denselben Weg nimmt.
 */
function validateBody(body: Body, _result: ValidationResult): Body {
  return structuredClone(body);
}

/**
 * Prueft einen Bibliothekseintrag und gibt ihn - moeglicherweise korrigiert -
 * zurueck. Der Eintrag wird vorher gegen das Zod-Schema validiert, damit diese
 * Funktion auch auf rohe KI-Ausgaben angewandt werden kann.
 */
export function validateLibraryEntry(candidate: unknown): ValidationResult {
  const result: ValidationResult = { ok: false, errors: [], warnings: [], correctedFields: [] };

  const parsed = LibraryEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      result.errors.push(`${issue.path.join(".") || "<wurzel>"}: ${issue.message}`);
    }
    return result;
  }

  const entry = parsed.data;
  const definition =
    entry.definition.kind === "body"
      ? validateBody(entry.definition, result)
      : entry.definition.kind === "material"
        ? validateMaterial(entry.definition, result)
        : entry.definition.kind === "constraint"
          ? validateConstraint(entry.definition, result)
          : validateLoad(entry.definition, result);

  result.ok = result.errors.length === 0;
  if (result.ok) {
    result.entry = {
      definition,
      provenance: {
        ...entry.provenance,
        correctedFields: [...entry.provenance.correctedFields, ...result.correctedFields],
        warnings: [...entry.provenance.warnings, ...result.warnings],
      },
    };
  }
  return result;
}
