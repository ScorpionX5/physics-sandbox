import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Scenario } from "@sandbox/schema";

/**
 * **Szenarioablage**: wo ein vom Regisseur fertiggestelltes Szenario liegt,
 * bis die Lernplattform es im Studio oeffnet.
 *
 * Abgelegt wird, statt das JSON durch den Agenten zur Plattform zu reichen,
 * weil die Plattform das Studio nur mit einem Link einbettet
 * (`?szenario=<kennung>`): ein Szenario mit eingebetteter Bibliothek ist zu
 * gross fuer eine URL, und ein Modell, das Kilobytes JSON abschreibt, schreibt
 * sie nicht zuverlaessig ab.
 *
 * Die Kennung ist eine zufaellige UUID und damit zugleich die Zugangskontrolle:
 * wer den Link nicht hat, findet das Szenario nicht. Mehr braucht ein
 * Lernszenario nicht - es enthaelt nichts Persoenliches.
 */
export interface ScenarioStore {
  put(scenario: Scenario): Promise<string>;
  get(id: string): Promise<Scenario | undefined>;
}

/** Nur UUIDs - eine Kennung wird zum Dateinamen, `../` darf nie durchkommen. */
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isStoreId(id: string): boolean {
  return STORE_ID.test(id);
}

/** Eine Datei je Szenario in einem Verzeichnis - ohne Datenbank, und von Hand einsehbar. */
export function createFileScenarioStore(directory: string): ScenarioStore {
  return {
    async put(scenario) {
      const id = randomUUID();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${id}.json`), `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
      return id;
    },
    async get(id) {
      if (!isStoreId(id)) return undefined;
      let text: string;
      try {
        text = await readFile(join(directory, `${id}.json`), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      // Durch das Schema, wie jede Datei von der Platte: das Schema kann sich
      // seit dem Ablegen geaendert haben.
      const parsed = Scenario.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    },
  };
}

/** Fuer Tests und fuer einen Dienst ohne Schreibrechte. Weg mit dem Prozess. */
export function createMemoryScenarioStore(): ScenarioStore {
  const scenarios = new Map<string, Scenario>();
  return {
    async put(scenario) {
      const id = randomUUID();
      scenarios.set(id, structuredClone(scenario));
      return id;
    },
    async get(id) {
      const found = scenarios.get(id);
      return found ? structuredClone(found) : undefined;
    },
  };
}
