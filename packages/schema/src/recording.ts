import { z } from "zod";
import { Finite, Id, Quat, Vec3 } from "./primitives.js";
import { Scenario } from "./scenario.js";

/**
 * Aufzeichnung: die Folge von Schnappschuessen, die ein Lauf erzeugt.
 *
 * Das ist das Artefakt, das an die Lernplattform geht - und der Grund, warum
 * dort kein Video ankommt. Gespeichert wird nur der Zustandsvektor; Atome,
 * Elektronen und Partikel erzeugt die Darstellungsschicht beim Abspielen
 * prozedural aus (Seed, Entitaets-Id, Zustand, t). Eine Aufzeichnung ist
 * dadurch um zwei Groessenordnungen kleiner als ein Video und bleibt frei
 * navigierbar: Kamera drehbar, Zeit scrubbar, Darstellungsebene umschaltbar.
 */

/**
 * Mechanischer Zustand einer Entitaet zu einem Zeitpunkt.
 *
 * `force` und `acceleration` sind aufgezeichnet, obwohl sie aus dem Verlauf
 * ableitbar waeren: die kinematische Darstellungsebene zeichnet sie als Pfeile,
 * und eine Ableitung aus 20-Hz-Schnappschuessen waere im Stosszeitpunkt
 * unbrauchbar. Jedes Feld hat damit einen Leser - die Bedingung dafuer, dass es
 * ueberhaupt im Schema stehen darf.
 */
export const MechanicalState = z.object({
  position: Vec3,
  orientation: Quat,
  linearVelocity: Vec3,
  /** Winkelgeschwindigkeit in rad/s. Intern wird der Drehimpuls gefuehrt. */
  angularVelocity: Vec3,
  /** Summe der Kraefte im Zeitschritt, N. */
  force: Vec3,
  /** Resultierende Beschleunigung, m/s^2. */
  acceleration: Vec3,
  /** Anzahl der aufgeloesten Kontakte in diesem Schnappschuss. */
  contactCount: z.number().int().min(0).default(0),
});
export type MechanicalState = z.infer<typeof MechanicalState>;

/** Thermischer Zustand - Stufe 3. Noch von keinem Modul geschrieben. */
export const ThermalState = z.object({
  /** Temperatur in Kelvin. */
  temperature: Finite.positive(),
  /** Netto-Waermestrom in W. */
  heatFlow: Finite.default(0),
});
export type ThermalState = z.infer<typeof ThermalState>;

/** Chemischer Zustand - Stufe 4. */
export const ChemicalState = z.object({
  /** Stoffmengen in mol, je Material-Id. */
  amounts: z.record(Id, Finite.min(0)),
});
export type ChemicalState = z.infer<typeof ChemicalState>;

/**
 * Zustand einer Entitaet, nach Physikmodul partitioniert. Jedes Modul besitzt
 * seinen Abschnitt exklusiv - so kann Thermodynamik spaeter `thermal` fuellen,
 * ohne eine Zeile Mechanik anzufassen.
 */
export const EntityState = z.object({
  mechanics: MechanicalState.optional(),
  thermal: ThermalState.optional(),
  chemical: ChemicalState.optional(),
});
export type EntityState = z.infer<typeof EntityState>;

export const Snapshot = z.object({
  /** Simulierte Zeit in Sekunden. */
  t: Finite.min(0),
  entities: z.record(Id, EntityState),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** Ein Ereignis, das der Kern gemeldet hat - fuer Diagnose und Regie. */
export const RunEvent = z.object({
  t: Finite.min(0),
  type: z.enum(["contactBegan", "warning"]),
  entityId: Id.optional(),
  message: z.string().max(400).optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const Recording = z.object({
  schemaVersion: z.literal(1),
  /**
   * Das vollstaendige Szenario liegt in der Aufzeichnung. Damit ist sie
   * selbsttragend: der Abspieler braucht weder Bibliothek noch Service, und
   * der Lernende kann Eingriffe aendern und neu simulieren.
   */
  scenario: Scenario,
  /** Uebernommen aus den Simulationsparametern, damit ein Replay exakt passt. */
  seed: z.number().int().min(0),
  dt: Finite.positive(),
  recordRate: Finite.positive(),
  snapshots: z.array(Snapshot),
  events: z.array(RunEvent).default([]),
});
export type Recording = z.infer<typeof Recording>;
