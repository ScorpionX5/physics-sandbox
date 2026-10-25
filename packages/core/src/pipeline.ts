import type { RunEvent } from "@sandbox/schema";
import type { Rng } from "./rng.js";
import type { RuntimeEntity, SimState } from "./state.js";

/**
 * Die Zeitschritt-Pipeline - die Erweiterbarkeitsachse des Kerns.
 *
 * Jeder Zeitschritt durchlaeuft feste Phasen in fester Reihenfolge. Ein
 * **Physikmodul** haengt sich in die Phasen ein, die es braucht, und deklariert,
 * welche Zustandsabschnitte es liest und schreibt.
 *
 * | Phase          | Mechanik (Stufe 1)        | Thermodynamik (spaeter)      | Chemie (spaeter) |
 * |----------------|---------------------------|------------------------------|------------------|
 * | `interventions`| kernseitig                | -                            | -                |
 * | `accumulate`   | Schwerkraft aus den Gravitations-Lasten | Auftrieb, Druck | -                |
 * | `integrate`    | Lage und Geschwindigkeit  | Temperatur-ODE               | Stoffmengen-ODE  |
 * | `contacts`     | Normalimpulse             | -                            | -                |
 * | `exchange`     | *leer*                    | Leitung, Strahlung, Konvektion | Diffusion      |
 * | `transform`    | *leer*                    | Schmelzen, Sieden            | Reaktionen       |
 * | `record`       | kernseitig                | -                            | -                |
 *
 * `exchange` und `transform` sind in Stufe 1 leer. Dass sie existieren und die
 * Reihenfolge feststeht, ist die konkrete Einloesung von "spaeter erweiterbar":
 * Thermodynamik ist dann ein Modul, das `exchange` fuellt und dem Zustand ein
 * Temperaturfeld hinzufuegt - kein Umbau.
 *
 * Die Reihenfolge ist nicht beliebig. `accumulate` vor `integrate`, weil der
 * Integrator die Kraftsumme braucht. `contacts` nach `integrate`, weil
 * Durchdringungen erst nach der Lageaenderung feststellbar sind. `exchange` nach
 * `contacts`, weil Waermeleitung ueber eine Beruehrung wissen muss, dass sie
 * besteht - die Kontaktliste der Mechanik ist genau die Information, die das
 * Thermodynamik-Modul dafuer braucht.
 */

export const PIPELINE_PHASES = [
  "interventions",
  "accumulate",
  "integrate",
  "contacts",
  "exchange",
  "transform",
  "record",
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

/** Die Phasen, in die sich ein Modul einhaengen kann. */
export const MODULE_PHASES = ["accumulate", "integrate", "contacts", "exchange", "transform"] as const;
export type ModulePhase = (typeof MODULE_PHASES)[number];

export interface ModuleContext {
  state: SimState;
  /** Fester Zeitschritt in Sekunden. */
  dt: number;
  rng: Rng;
  /** Meldet ein Ereignis in die Aufzeichnung - fuer Diagnose und Regie. */
  emit(event: RunEvent): void;
}

/**
 * Ein **Physikmodul**.
 *
 * `reads` und `writes` nennen die Zustandsabschnitte (`mechanics`, `thermal`,
 * `chemical`) und werden beim Registrieren geprueft: zwei Module, die denselben
 * Abschnitt schreiben, sind ein Entwurfsfehler und werden abgelehnt. Das ist der
 * Mechanismus, der die Partitionierung des Zustands durchsetzt, statt sie nur zu
 * dokumentieren.
 */
export interface PhysicsModule {
  readonly id: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /** Wird aufgerufen, wenn eine Entitaet hinzukommt - zum Anlegen des eigenen Abschnitts. */
  onEntityAdded?(entity: RuntimeEntity, context: ModuleContext): void;
  accumulate?(context: ModuleContext): void;
  integrate?(context: ModuleContext): void;
  contacts?(context: ModuleContext): void;
  exchange?(context: ModuleContext): void;
  transform?(context: ModuleContext): void;
}

export class ModuleRegistry {
  private readonly modules: PhysicsModule[] = [];
  private readonly writers = new Map<string, string>();

  register(module: PhysicsModule): this {
    if (this.modules.some((existing) => existing.id === module.id)) {
      throw new Error(`Physikmodul "${module.id}" ist bereits registriert.`);
    }
    for (const section of module.writes) {
      const existing = this.writers.get(section);
      if (existing !== undefined) {
        throw new Error(
          `Zustandsabschnitt "${section}" wird bereits von Modul "${existing}" geschrieben; ` +
            `"${module.id}" darf ihn nur lesen. Jeder Abschnitt gehoert genau einem Modul.`,
        );
      }
      this.writers.set(section, module.id);
    }
    this.modules.push(module);
    return this;
  }

  all(): readonly PhysicsModule[] {
    return this.modules;
  }

  /** Module, die eine bestimmte Phase bedienen - in Registrierungsreihenfolge. */
  forPhase(phase: ModulePhase): readonly PhysicsModule[] {
    return this.modules.filter((module) => typeof module[phase] === "function");
  }

  runPhase(phase: ModulePhase, context: ModuleContext): void {
    for (const module of this.modules) {
      module[phase]?.(context);
    }
  }

  notifyEntityAdded(entity: RuntimeEntity, context: ModuleContext): void {
    for (const module of this.modules) {
      module.onEntityAdded?.(entity, context);
    }
  }
}
