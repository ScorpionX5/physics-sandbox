/**
 * Deterministischer Pseudozufall (splitmix32).
 *
 * Der Kern darf `Math.random` nicht benutzen - eine Aufzeichnung waere sonst
 * nicht reproduzierbar. Stattdessen traegt jedes Szenario einen Seed, der in
 * die Aufzeichnung uebernommen wird.
 *
 * Die Mechanik braucht keinen Zufall. Gebraucht wird er von der
 * Darstellungsschicht: Atompositionen, Schwingungsphasen und
 * Partikelverteilungen werden beim Abspielen aus (Seed, Entitaets-Id, t)
 * erzeugt statt aufgezeichnet. Genau das macht eine Aufzeichnung um zwei
 * Groessenordnungen kleiner als ein Video - und es funktioniert nur, wenn
 * derselbe Seed ueberall dieselbe Folge liefert.
 *
 * splitmix32 arbeitet ausschliesslich mit 32-Bit-Ganzzahloperationen und ist
 * damit ueber Engines hinweg bitgenau - anders als alles, was Gleitkomma
 * einsetzt.
 */

export interface Rng {
  /** Naechster Wert in [0, 1). */
  next(): number;
  /** Naechster Wert in [min, max). */
  range(min: number, max: number): number;
  /** Naechste 32-Bit-Ganzzahl ohne Vorzeichen. */
  nextUint32(): number;
}

export function createRng(seed: number): Rng {
  let state = seed | 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  return {
    nextUint32,
    next: () => nextUint32() / 4294967296,
    range: (min, max) => min + (nextUint32() / 4294967296) * (max - min),
  };
}

/**
 * Leitet einen stabilen Seed aus einem Basis-Seed und einer Zeichenkette ab.
 *
 * Damit bekommt jede Entitaet ihren eigenen, reproduzierbaren Zufallsstrom,
 * ohne dass die Reihenfolge der Entitaeten eine Rolle spielt: haette jede
 * Entitaet nur einen gemeinsamen Generator, wuerde das Hinzufuegen eines
 * Koerpers bei t = 2 s das Aussehen aller anderen veraendern.
 */
export function deriveSeed(baseSeed: number, key: string): number {
  // FNV-1a, 32 Bit - klein, verteilt gut genug fuer diesen Zweck und rein
  // ganzzahlig.
  let hash = 0x811c9dc5 ^ (baseSeed | 0);
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
