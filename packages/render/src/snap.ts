/**
 * Rastern von Klickpunkten nach Zoomstufe.
 *
 * Das Mausrad zoomt multiplikativ (jede Raste ändert den Abstand um denselben
 * Faktor). Die Zoomstufe ist deshalb der Logarithmus des Abstands, und "linear
 * in der Zoomstufe" heißt: je Zehnerpotenz Annäherung kommen
 * `DECIMALS_PER_DECADE` Nachkommastellen hinzu. Ein Raster, das mit dem Abstand
 * linear wüchse, wäre auf dem Bildschirm zwar gleich fein, bräuchte aber
 * beliebig viele Stufen dazwischen und ließe sich nicht als Dezimalstellen
 * lesen.
 */

/** Schrittweite im Ausgangsbild, Meter, als Zehnerpotenz: 10^-1 = 0,1 m. */
export const BASE_DECIMALS = 1;

/**
 * Zusätzliche Nachkommastellen je Zehnerpotenz, um die näher herangezoomt wird.
 * Die Zahl ist geschätzt und per Hinsehen nachzustellen: größer heißt, das
 * Raster wird beim Heranzoomen früher feiner.
 */
export const DECIMALS_PER_DECADE = 1;

/**
 * Anzahl Nachkommastellen für den aktuellen Abstand. Negativ heißt: gerundet
 * wird auf Zehner, Hunderter, ... - beim Herauszoomen auf ganze Meter oder
 * gröber.
 */
export function snapDecimals(distance: number, referenceDistance: number): number {
  if (!(distance > 0) || !(referenceDistance > 0)) return BASE_DECIMALS;
  const decades = Math.log10(referenceDistance / distance);
  return Math.round(BASE_DECIMALS + decades * DECIMALS_PER_DECADE);
}

/** Rundet `value` auf `decimals` Nachkommastellen, ohne Gleitkommareste (0,30000000000000004). */
export function roundToDecimals(value: number, decimals: number): number {
  if (decimals >= 0) return Number(value.toFixed(Math.min(decimals, 100)));
  const step = 10 ** -decimals;
  return Math.round(value / step) * step;
}
