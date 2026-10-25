import { createOverlap, MAX_CONTACT_POINTS, overlapBodies, overlapSurface, type Overlap } from "../collision.js";
import type { ModuleContext, PhysicsModule } from "../pipeline.js";
import type { ResolvedSegment, RuntimeBody, RuntimeSurface, SimState } from "../state.js";
import {
  m3fromQuat,
  m3identity,
  m3multiply,
  m3transform,
  m3transpose,
  q4integrate,
  v3addScaled,
  v3cross,
  v3dot,
  v3normalize,
  v3set,
  v3zero,
  type M3,
  type V3,
} from "../math/index.js";

/**
 * Summe der Schwerebeitraege aller platzierten Gravitations-Lasten.
 *
 * Keine Last vom Typ "gravity": die Summe ist der Nullvektor, und ein Koerper
 * bleibt in der Luft stehen - das ist die Gegenprobe, dass Schwerkraft eine
 * Last ist und kein eingebautes Gesetz. Mehrere zugleich platzierte Lasten
 * wirken addiert.
 */
export function totalGravity(state: SimState, out: V3 = [0, 0, 0]): V3 {
  v3zero(out);
  for (const entity of state.entities.values()) {
    if (entity.kind === "load" && entity.load.behaviour.loadType === "gravity") {
      v3addScaled(out, entity.gravity, 1);
    }
  }
  return out;
}

/**
 * Mechanik - Stufe 1 und 2: Translation, Rotation, Kontakt mit Haft-, Gleit-,
 * Bohr- und Rollreibung.
 *
 * Deckt `accumulate` (Kraefte), `integrate` (Lage und Geschwindigkeit) und
 * `contacts` (Normal- und Reibimpulse an den Kontaktpunkten) ab. `exchange` und
 * `transform` bleiben leer; sie gehoeren den spaeteren Modulen.
 */

/**
 * Ein erkannter Kontakt zweier Beteiligter mit seinen Kontaktpunkten und allem,
 * was der Loeser je Punkt braucht.
 *
 * Die Normale zeigt von a nach b. Bei einer Flaeche ist a die Flaeche und b der
 * Koerper. `movingA`/`movingB` sind die Beteiligten, die ein Impuls bewegt - eine
 * Flaeche und ein festgehaltener Koerper stehen dort als `null` und wirken wie
 * eine Wand.
 */
interface Contact {
  bodyA: RuntimeBody | null;
  bodyB: RuntimeBody;
  surface: RuntimeSurface | null;
  segment: ResolvedSegment | null;
  movingA: RuntimeBody | null;
  movingB: RuntimeBody | null;
  normal: V3;
  /** Groesste Durchdringungstiefe entlang der Normale, positiv. */
  depth: number;
  /** Lage von b beim Erkennen - daraus die Resttiefe, wenn b schon verschoben wurde. */
  originB: V3;
  count: number;
  /** Hebel vom Schwerpunkt zum Kontaktpunkt, im Weltsystem. */
  leverA: V3[];
  leverB: V3[];
  /** r x n je Punkt: der Drehimpuls, den ein Einheitsimpuls dort erzeugt. */
  momentA: V3[];
  momentB: V3[];
  /** I_welt^-1 (r x n): die Winkelgeschwindigkeit, die er erzeugt. */
  spinA: V3[];
  spinB: V3[];
  /** Normalgeschwindigkeit, die nach dem Stoss mindestens erreicht sein muss. */
  target: number[];
  /** Bisher aufgebrachter Impuls je Punkt, nie negativ. */
  impulse: number[];
  /** Kopplungsmatrix K (zeilenweise, Schrittweite MAX_CONTACT_POINTS), siehe `solveContact`. */
  coupling: number[];

  /** I_welt^-1 der bewegten Beteiligten, `null` fuer Wand und festgehaltenen Koerper. */
  inertiaA: M3 | null;
  inertiaB: M3 | null;
  /** Reibwerte der Paarung, siehe `pairFriction`. */
  staticFriction: number;
  kineticFriction: number;
  rollingFriction: number;
  /** Wirksamer Radius der Kontaktflaeche fuer die Bohrreibung, 0 bei einem einzelnen Punkt. */
  patchRadius: number;
  /** Zwei Tangenten, mit der Normale ein Rechtssystem. */
  tangentU: V3;
  tangentV: V3;
  /** Aufgebrachter Reibimpuls (in der Tangentialebene, auf b; a bekommt das Negative). */
  friction: V3;
  /** Wo er angegriffen hat: Hebel zum Druckmittelpunkt beim letzten Durchlauf. */
  frictionLeverA: V3;
  frictionLeverB: V3;
  /** Drehimpulsstoss der Bohrreibung, entlang der Normale. */
  twist: number;
  /** Drehimpulsstoss der Rollreibung, in der Tangentialebene. */
  rolling: V3;
}

function createContact(): Contact {
  const vectors = (): V3[] => Array.from({ length: MAX_CONTACT_POINTS }, (): V3 => [0, 0, 0]);
  return {
    bodyA: null,
    bodyB: null as unknown as RuntimeBody,
    surface: null,
    segment: null,
    movingA: null,
    movingB: null,
    normal: [0, 0, 0],
    depth: 0,
    originB: [0, 0, 0],
    count: 0,
    leverA: vectors(),
    leverB: vectors(),
    momentA: vectors(),
    momentB: vectors(),
    spinA: vectors(),
    spinB: vectors(),
    target: new Array<number>(MAX_CONTACT_POINTS).fill(0),
    impulse: new Array<number>(MAX_CONTACT_POINTS).fill(0),
    coupling: new Array<number>(MAX_CONTACT_POINTS * MAX_CONTACT_POINTS).fill(0),
    inertiaA: null,
    inertiaB: null,
    staticFriction: 0,
    kineticFriction: 0,
    rollingFriction: 0,
    patchRadius: 0,
    tangentU: [0, 0, 0],
    tangentV: [0, 0, 0],
    friction: [0, 0, 0],
    frictionLeverA: [0, 0, 0],
    frictionLeverB: [0, 0, 0],
    twist: 0,
    rolling: [0, 0, 0],
  };
}

/**
 * Wie weit hinter einer Flaeche ein Punkt noch als Kontakt gilt, relativ zur
 * Koerpergroesse.
 *
 * Die Grenze ist kein Komfortparameter, sondern eine Diagnosehilfe: ein Koerper,
 * der tiefer als das Vielfache seiner eigenen Ausdehnung hinter einer Flaeche
 * liegt, ist durchgetunnelt. Ihn dann noch zurueckzuziehen wuerde den Fehler
 * verstecken - stattdessen faellt er weiter, und der Durchdringungstest meldet
 * es.
 */
const PENETRATION_LIMIT_FACTOR = 2;

/** Ab welcher Durchdringung (relativ zur Koerpergroesse) eine Warnung in die Aufzeichnung geht. */
const PENETRATION_WARNING_FACTOR = 0.1;

/**
 * Bis zu welcher Aufprallgeschwindigkeit ein Kontakt als Ruhe gilt, in
 * Vielfachen dessen, was die Schwerkraft in einem Zeitschritt dazugibt
 * (|g| * dt).
 *
 * Ein Koerper, der auf einer Flaeche liegt, wird in jedem Schritt um genau
 * g*dt in sie hineinbeschleunigt. Mit Stosszahl > 0 gaebe jeder Kontakt davon
 * den Anteil e zurueck, und der Koerper huepfte fuer immer in Mikrometern, statt
 * liegenzubleiben. Unterhalb der Schwelle wird deshalb wie bei Stosszahl 0
 * aufgeloest. Zehn Schritte Schwerkraft, nicht einer: ein Koerper, der sich
 * nach dem Kippen auf eine Flaeche legt, trifft mit der Kante, die zuletzt
 * aufschlaegt, etwas schneller auf als g*dt, und auch ein Stapel loest nicht in
 * jedem Schritt vollstaendig auf. Bei g = 9,81 m/s^2 und 1 ms sind das knapp
 * 0,1 m/s - ein Rueckprall in der Groesse eines Millimeters.
 *
 * An |g| gebunden statt eine feste Zahl: ohne Schwerkraft gibt es keine Ruhe
 * zu unterscheiden, und ein langsamer Stoss im Schwerefreien prallt dann wie
 * jeder andere ab.
 */
const REST_THRESHOLD_STEPS = 10;

/**
 * Hoechstzahl der Durchlaeufe ueber alle Kontakte eines Zeitschritts.
 *
 * Jeder Kontakt fuer sich wird exakt geloest (`solveContact`); wiederholt
 * werden muss nur, wenn ein Koerper mehrere Kontakte hat und die Loesung des
 * einen die des anderen stoert - ein Stapel, ein Klotz an der Knickkante
 * zwischen zwei Flaechen. Ein einzelner Kontakt ist nach dem ersten Durchlauf
 * fertig, der zweite bestaetigt es nur.
 */
const SOLVER_ITERATIONS = 30;

/**
 * Restfehler, unterhalb dessen eine Loesung als exakt gilt, relativ zur
 * groessten Geschwindigkeit, die der Kontakt aufheben muss - knapp ueber dem
 * Rundungsrauschen.
 *
 * Relativ und so knapp, weil ein Rest hier nicht harmlos ist: bei einer
 * aufliegenden Flaeche tragen zwei diagonale Ecken, und eine kleine Drehung um
 * genau diese Diagonale bliebe unterhalb der Toleranz stehen. Sie wuerde von
 * Schritt zu Schritt mitgeschleppt, ein Stapel finge an zu wandern. Eine feste
 * Schranke wie 1e-10 m/s laesst das zu; bei einem aufliegenden Koerper sind die
 * aufzuhebenden Geschwindigkeiten nur g*dt, also 1e-2 m/s.
 */
const SOLVER_TOLERANCE = 1e-12;

/** Untergrenze der Toleranz, damit ein Kontakt ganz ohne Geschwindigkeit nicht an 0 scheitert. */
const SOLVER_TOLERANCE_FLOOR = 1e-15;

/**
 * Relative Schranke, unter der eine Teilmatrix als singulaer gilt: dann liegen
 * die gewaehlten Punkte auf einer Geraden durch die Wirkungslinie und tragen
 * nichts Unabhaengiges bei.
 */
const SINGULAR_EPSILON = 1e-9;

// Arbeitsspeicher auf Modulebene. Der Integrator laeuft bei dt = 1 ms
// tausendfach pro simulierter Sekunde; frische Arrays pro Aufruf waeren
// Millionen kurzlebiger Objekte.
const scratchRotation: M3 = m3identity();
const scratchRotationT: M3 = m3identity();
const scratchProduct: M3 = m3identity();
const scratchInverseInertiaWorld: M3 = m3identity();

/** I_welt^-1 = R * I_koerper^-1 * R^T in `out`. */
function worldInverseInertia(body: RuntimeBody, out: M3): M3 {
  m3fromQuat(scratchRotation, body.mechanics.orientation);
  m3transpose(scratchRotationT, scratchRotation);
  m3multiply(scratchProduct, scratchRotation, body.inverseInertiaBody);
  return m3multiply(out, scratchProduct, scratchRotationT);
}

/**
 * Winkelgeschwindigkeit aus dem Drehimpuls: omega = I_welt^-1 * L mit
 * I_welt^-1 = R * I_koerper^-1 * R^T.
 */
function updateAngularVelocity(body: RuntimeBody): void {
  if (body.kinematic) {
    v3zero(body.mechanics.angularVelocity);
    return;
  }
  worldInverseInertia(body, scratchInverseInertiaWorld);
  m3transform(body.mechanics.angularVelocity, scratchInverseInertiaWorld, body.mechanics.angularMomentum);
}

/** Setzt den Drehimpuls so, dass er einer gewuenschten Winkelgeschwindigkeit entspricht. */
export function setAngularVelocity(body: RuntimeBody, omega: readonly number[]): void {
  m3fromQuat(scratchRotation, body.mechanics.orientation);
  m3transpose(scratchRotationT, scratchRotation);
  m3multiply(scratchProduct, scratchRotation, body.inertiaBody);
  m3multiply(scratchInverseInertiaWorld, scratchProduct, scratchRotationT);
  m3transform(body.mechanics.angularMomentum, scratchInverseInertiaWorld, omega);
  v3set(body.mechanics.angularVelocity, omega[0]!, omega[1]!, omega[2]!);
}

/** Kinetische Energie eines Koerpers in J - Translation plus Rotation. */
export function kineticEnergy(body: RuntimeBody): number {
  const translational = 0.5 * body.mass * v3dot(body.mechanics.linearVelocity, body.mechanics.linearVelocity);
  // E_rot = 1/2 * omega . L
  const rotational = 0.5 * v3dot(body.mechanics.angularVelocity, body.mechanics.angularMomentum);
  return translational + rotational;
}

/**
 * Potentielle Energie im Schwerefeld aller Gravitations-Lasten, bezogen auf
 * den Ursprung. E = -m * g . x, damit das Vorzeichen fuer jede
 * Schwerkraftrichtung stimmt und nicht nur fuer "nach unten".
 */
export function potentialEnergy(body: RuntimeBody, state: SimState): number {
  return -body.mass * v3dot(totalGravity(state), body.mechanics.position);
}

/** Arbeitsliste der Koerper eines Zeitschritts - dieselbe Begruendung wie bei den Matrizen oben. */
const scratchBodies: RuntimeBody[] = [];
const scratchOverlap = createOverlap();

function bodiesOf(state: SimState, into: RuntimeBody[]): RuntimeBody[] {
  into.length = 0;
  for (const entity of state.entities.values()) {
    if (entity.kind === "body") into.push(entity);
  }
  return into;
}

/**
 * Stosszahl einer Paarung: das Minimum der beiden Materialien.
 *
 * Physikalisch gehoert die Stosszahl zur Paarung, nicht zu einem Stoff; das
 * Minimum ist die einfachste Regel, die das Naheliegende liefert: Standard
 * (0) macht jeden Stoss unelastisch, zwei gleiche Materialien prallen mit ihrer
 * eigenen Zahl. Unterhalb der Ruheschwelle gilt 0, siehe `REST_THRESHOLD_STEPS`.
 */
function pairRestitution(
  a: { restitution: number },
  b: { restitution: number },
  impactSpeed: number,
  restSpeed: number,
): number {
  return impactSpeed < restSpeed ? 0 : Math.min(a.restitution, b.restitution);
}

/**
 * Reibwert einer Paarung aus den Werten der beiden Materialien: das
 * geometrische Mittel sqrt(mu_a * mu_b).
 *
 * Gemessen wird Reibung immer an einer Paarung - Tabellen nennen "Stahl auf
 * Stahl", "Holz auf Stahl", nie "Stahl". Eine Kombinationsregel ist deshalb
 * eine Naeherung, keine Physik. Das geometrische Mittel ist die uebliche (Box2D,
 * Bullet), weil es das Erwartete liefert: zwei gleiche Materialien reiben mit
 * ihrem eigenen Wert, und ein reibungsfreies (Glatt, 0) macht jede Paarung
 * reibungsfrei. Das Minimum, das die Stosszahl nimmt, liesse ein einziges
 * rutschiges Material die Paarung ganz bestimmen; das arithmetische Mittel
 * liesse Glatt auf Stahl noch mit halber Stahlreibung haften.
 *
 * Gilt fuer alle drei Werte. Weil das Mittel monoton ist, bleibt die
 * Gleitreibung der Paarung unter der Haftreibung, wenn das fuer beide
 * Materialien gilt. Wer eine andere Regel will (oder eine Paarungstabelle als
 * Vorrang), aendert genau diese Funktion.
 */
function pairFriction(a: number, b: number): number {
  return Math.sqrt(a * b);
}

/**
 * Relative Normalgeschwindigkeit am Kontaktpunkt i, positiv heisst "trennt sich".
 *
 * Geschwindigkeit eines Punkts ist v + omega x r; entlang n ist das
 * v.n + omega.(r x n). Ein festgehaltener Koerper steht, was auch in seinem
 * Feld steht.
 */
function normalSpeed(contact: Contact, i: number): number {
  const n = contact.normal;
  let speed = 0;
  const b = contact.movingB;
  if (b) speed += v3dot(b.mechanics.linearVelocity, n) + v3dot(b.mechanics.angularVelocity, contact.momentB[i]!);
  const a = contact.movingA;
  if (a) speed -= v3dot(a.mechanics.linearVelocity, n) + v3dot(a.mechanics.angularVelocity, contact.momentA[i]!);
  return speed;
}

/**
 * Bringt am Punkt i den Normalimpuls `amount` auf: +n auf b, -n auf a.
 *
 * Der Drehimpuls bekommt r x (n * amount) - das ist das Kontaktdrehmoment.
 * Die Winkelgeschwindigkeit wird mitgefuehrt, damit der naechste Punkt schon
 * mit der neuen rechnet; am Ende des Loesers wird sie trotzdem aus L neu
 * abgeleitet, damit L die Wahrheit bleibt.
 */
function applyImpulse(contact: Contact, i: number, amount: number): void {
  const n = contact.normal;
  const b = contact.movingB;
  if (b) {
    v3addScaled(b.mechanics.linearVelocity, n, amount * b.inverseMass);
    v3addScaled(b.mechanics.angularMomentum, contact.momentB[i]!, amount);
    v3addScaled(b.mechanics.angularVelocity, contact.spinB[i]!, amount);
  }
  const a = contact.movingA;
  if (a) {
    v3addScaled(a.mechanics.linearVelocity, n, -amount * a.inverseMass);
    v3addScaled(a.mechanics.angularMomentum, contact.momentA[i]!, -amount);
    v3addScaled(a.mechanics.angularVelocity, contact.spinA[i]!, -amount);
  }
}

/**
 * Fuellt einen Kontakt aus einer Ueberlappung: Hebel, Kopplungsmatrix und
 * Zielgeschwindigkeit je Punkt.
 */
function prepareContact(
  contact: Contact,
  overlap: Overlap,
  bodyA: RuntimeBody | null,
  bodyB: RuntimeBody,
  surface: RuntimeSurface | null,
  segment: ResolvedSegment | null,
  inverseInertia: Map<string, M3>,
  restSpeed: number,
): void {
  contact.bodyA = bodyA;
  contact.bodyB = bodyB;
  contact.surface = surface;
  contact.segment = segment;
  contact.movingA = bodyA && !bodyA.kinematic ? bodyA : null;
  contact.movingB = bodyB.kinematic ? null : bodyB;
  const n = contact.normal;
  v3set(n, overlap.normal[0], overlap.normal[1], overlap.normal[2]);
  contact.depth = overlap.depth;
  const origin = bodyB.mechanics.position;
  v3set(contact.originB, origin[0], origin[1], origin[2]);
  const count = overlap.count;
  contact.count = count;

  const inertiaA = contact.movingA ? inverseInertia.get(contact.movingA.id)! : null;
  const inertiaB = contact.movingB ? inverseInertia.get(contact.movingB.id)! : null;
  contact.inertiaA = inertiaA;
  contact.inertiaB = inertiaB;
  for (let i = 0; i < count; i += 1) {
    const point = overlap.points[i]!;
    const leverA = contact.leverA[i]!;
    const leverB = contact.leverB[i]!;
    if (bodyA) {
      const p = bodyA.mechanics.position;
      v3set(leverA, point[0] - p[0], point[1] - p[1], point[2] - p[2]);
    } else {
      v3zero(leverA);
    }
    const p = bodyB.mechanics.position;
    v3set(leverB, point[0] - p[0], point[1] - p[1], point[2] - p[2]);
    v3cross(contact.momentA[i]!, leverA, n);
    v3cross(contact.momentB[i]!, leverB, n);
    if (inertiaA) m3transform(contact.spinA[i]!, inertiaA, contact.momentA[i]!);
    else v3zero(contact.spinA[i]!);
    if (inertiaB) m3transform(contact.spinB[i]!, inertiaB, contact.momentB[i]!);
    else v3zero(contact.spinB[i]!);
    contact.impulse[i] = 0;
  }

  // K_ij: wie stark ein Einheitsimpuls am Punkt j die Normalgeschwindigkeit am
  // Punkt i aendert. Translation (1/m_a + 1/m_b) plus Drehung beider Koerper.
  const inverseMassSum = (contact.movingA?.inverseMass ?? 0) + (contact.movingB?.inverseMass ?? 0);
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      contact.coupling[i * MAX_CONTACT_POINTS + j] =
        inverseMassSum +
        v3dot(contact.momentA[i]!, contact.spinA[j]!) +
        v3dot(contact.momentB[i]!, contact.spinB[j]!);
    }
  }

  // Die Stosszahl richtet sich nach der Aufprallgeschwindigkeit *vor* dem
  // Loesen; wuerde sie in jedem Durchlauf neu gelesen, saehe der zweite schon
  // die geloeste Geschwindigkeit und hielte den Stoss fuer Ruhe.
  const partnerA = bodyA ?? surface!;
  for (let i = 0; i < count; i += 1) {
    const speed = normalSpeed(contact, i);
    contact.target[i] = speed < 0 ? -pairRestitution(partnerA, bodyB, -speed, restSpeed) * speed : 0;
  }

  contact.staticFriction = pairFriction(partnerA.staticFriction, bodyB.staticFriction);
  contact.kineticFriction = pairFriction(partnerA.kineticFriction, bodyB.kineticFriction);
  contact.rollingFriction = pairFriction(partnerA.rollingFriction, bodyB.rollingFriction);
  contact.patchRadius = patchRadiusOf(overlap);
  tangentsOf(n, contact.tangentU, contact.tangentV);
  v3zero(contact.friction);
  v3zero(contact.frictionLeverA);
  v3zero(contact.frictionLeverB);
  contact.twist = 0;
  v3zero(contact.rolling);
}

/**
 * Wirksamer Radius der Kontaktflaeche fuer die Bohrreibung: zwei Drittel des
 * mittleren Abstands der Ecken von ihrem Mittelpunkt.
 *
 * Eine Naeherung. Exakt waere das Mittel von |r| ueber die gedrueckte Flaeche,
 * gewichtet mit dem Druck - den der Loeser nur als Resultierende kennt. Zwei
 * Drittel sind der Wert einer gleichmaessig gedrueckten Kreisscheibe bezogen auf
 * ihren Rand; fuer ein Quadrat, gemessen an den Ecken, liegt das um ein Viertel
 * zu hoch. Fuer das, was die Bohrreibung leisten muss - ein auf der Flaeche
 * kreiselnder Klotz kommt zur Ruhe, statt ewig weiterzudrehen -, genuegt das.
 * Ein einzelner Punkt (Kugel) hat den Radius 0: dort bremst nur die Rollreibung.
 */
function patchRadiusOf(overlap: Overlap): number {
  const count = overlap.count;
  if (count < 2) return 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i += 1) {
    const p = overlap.points[i]!;
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= count;
  cy /= count;
  cz /= count;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const p = overlap.points[i]!;
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return ((2 / 3) * sum) / count;
}

/**
 * Zwei Tangenten zur Normale n. Die Hilfsachse ist die Weltachse, die am
 * wenigsten zu n passt - fest gewaehlt, damit die Basis und mit ihr der Lauf
 * deterministisch bleibt. Welche Basis es ist, aendert nichts am Ergebnis: der
 * Reibimpuls wird in ihr nur ausgedrueckt.
 */
function tangentsOf(n: V3, u: V3, v: V3): void {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ax <= ay && ax <= az) v3set(u, 0, -n[2], n[1]);
  else if (ay <= az) v3set(u, n[2], 0, -n[0]);
  else v3set(u, -n[1], n[0], 0);
  v3normalize(u);
  v3cross(v, n, u);
}

// Arbeitsspeicher von `solveContact`.
const bias: number[] = new Array<number>(MAX_CONTACT_POINTS).fill(0);
const trial: number[] = new Array<number>(MAX_CONTACT_POINTS).fill(0);
const chosen: number[] = new Array<number>(MAX_CONTACT_POINTS).fill(0);
const subset: number[] = [0, 0, 0];

/**
 * Loest das Teilsystem K_SS * x = -b_S fuer die Punkte in `subset` nach der
 * Cramerschen Regel (nur + - * /). `false` bei singulaerer Teilmatrix.
 */
function solveSubset(coupling: number[], size: number, out: number[]): boolean {
  const k = (i: number, j: number): number => coupling[subset[i]! * MAX_CONTACT_POINTS + subset[j]!]!;
  const r0 = -bias[subset[0]!]!;
  if (size === 1) {
    const k00 = k(0, 0);
    if (!(k00 > 0)) return false;
    out[0] = r0 / k00;
    return true;
  }
  const r1 = -bias[subset[1]!]!;
  if (size === 2) {
    const det = k(0, 0) * k(1, 1) - k(0, 1) * k(1, 0);
    if (!(Math.abs(det) > SINGULAR_EPSILON * k(0, 0) * k(1, 1))) return false;
    out[0] = (r0 * k(1, 1) - k(0, 1) * r1) / det;
    out[1] = (k(0, 0) * r1 - r0 * k(1, 0)) / det;
    return true;
  }
  const r2 = -bias[subset[2]!]!;
  const a = k(0, 0), b = k(0, 1), c = k(0, 2);
  const d = k(1, 0), e = k(1, 1), f = k(1, 2);
  const g = k(2, 0), h = k(2, 1), m = k(2, 2);
  const det = a * (e * m - f * h) - b * (d * m - f * g) + c * (d * h - e * g);
  if (!(Math.abs(det) > SINGULAR_EPSILON * a * e * m)) return false;
  out[0] = (r0 * (e * m - f * h) - b * (r1 * m - f * r2) + c * (r1 * h - e * r2)) / det;
  out[1] = (a * (r1 * m - f * r2) - r0 * (d * m - f * g) + c * (d * r2 - r1 * g)) / det;
  out[2] = (a * (e * r2 - r1 * h) - b * (d * r2 - r1 * g) + r0 * (d * h - e * g)) / det;
  return true;
}

/**
 * Loest einen Kontakt exakt: welche Punkte tragen, und mit welchem Impuls.
 *
 * Gesucht sind Impulse lambda_i >= 0 so, dass nach dem Stoss an jedem Punkt
 * die Normalgeschwindigkeit w_i >= Ziel ist und ein Punkt nur dann traegt, wenn
 * er genau auf dem Ziel steht (lambda_i * w_i = 0: ein Kontakt zieht nicht).
 * Mit w = K lambda + b ist das ein kleines lineares Komplementaritaetsproblem.
 *
 * Geloest wird es durch Ausprobieren der tragenden Teilmengen, kleinste zuerst.
 * Drei Punkte genuegen immer: ein starrer Koerper hat entlang einer Normale nur
 * drei Freiheitsgrade (Verschiebung und zwei Kippungen), und jeder Druckmittel-
 * punkt im Inneren der Kontaktflaeche liegt in einem Dreieck aus drei ihrer
 * Ecken. Bei vier Ecken einer aufliegenden Flaeche ist die Aufteilung auf die
 * Ecken deshalb nicht eindeutig - die Bewegung, die herauskommt, aber schon.
 *
 * Gibt zurueck, ob sich ein Impuls merklich geaendert hat, damit der aeussere
 * Durchlauf weiss, ob er fertig ist.
 */
function solveContact(contact: Contact): boolean {
  const count = contact.count;
  const coupling = contact.coupling;
  // b_i: Normalgeschwindigkeit ohne den bisher aufgebrachten Impuls, minus Ziel.
  let scale = 0;
  for (let i = 0; i < count; i += 1) {
    let value = normalSpeed(contact, i) - contact.target[i]!;
    for (let j = 0; j < count; j += 1) value -= coupling[i * MAX_CONTACT_POINTS + j]! * contact.impulse[j]!;
    bias[i] = value;
    if (Math.abs(value) > scale) scale = Math.abs(value);
  }
  const tolerance = Math.max(SOLVER_TOLERANCE * scale, SOLVER_TOLERANCE_FLOOR);

  // Leere Teilmenge: kein Punkt muss tragen.
  let bestViolation = 0;
  for (let i = 0; i < count; i += 1) {
    chosen[i] = 0;
    if (-bias[i]! > bestViolation) bestViolation = -bias[i]!;
  }

  const evaluate = (size: number): void => {
    if (!solveSubset(coupling, size, trial)) return;
    let violation = 0;
    for (let s = 0; s < size; s += 1) {
      const pushes = -trial[s]! * coupling[subset[s]! * (MAX_CONTACT_POINTS + 1)]!;
      if (pushes > violation) violation = pushes;
    }
    for (let i = 0; i < count; i += 1) {
      if (i === subset[0] || (size > 1 && i === subset[1]) || (size > 2 && i === subset[2])) continue;
      let w = bias[i]!;
      for (let s = 0; s < size; s += 1) w += coupling[i * MAX_CONTACT_POINTS + subset[s]!]! * trial[s]!;
      if (-w > violation) violation = -w;
    }
    if (violation < bestViolation) {
      bestViolation = violation;
      for (let i = 0; i < count; i += 1) chosen[i] = 0;
      for (let s = 0; s < size; s += 1) chosen[subset[s]!] = trial[s]! > 0 ? trial[s]! : 0;
    }
  };

  // Kleinste Teilmengen zuerst, und die erste, die passt, gilt: die Reihenfolge
  // ist fest, also bleibt der Lauf deterministisch.
  for (let i = 0; i < count && bestViolation > tolerance; i += 1) {
    subset[0] = i;
    evaluate(1);
  }
  for (let i = 0; i < count && bestViolation > tolerance; i += 1) {
    for (let j = i + 1; j < count && bestViolation > tolerance; j += 1) {
      subset[0] = i;
      subset[1] = j;
      evaluate(2);
    }
  }
  for (let i = 0; i < count && bestViolation > tolerance; i += 1) {
    for (let j = i + 1; j < count && bestViolation > tolerance; j += 1) {
      for (let k = j + 1; k < count && bestViolation > tolerance; k += 1) {
        subset[0] = i;
        subset[1] = j;
        subset[2] = k;
        evaluate(3);
      }
    }
  }

  let changed = false;
  for (let i = 0; i < count; i += 1) {
    const delta = chosen[i]! - contact.impulse[i]!;
    if (delta === 0) continue;
    applyImpulse(contact, i, delta);
    contact.impulse[i] = chosen[i]!;
    if (Math.abs(delta) * coupling[i * (MAX_CONTACT_POINTS + 1)]! > tolerance) changed = true;
  }
  return changed;
}

// Arbeitsspeicher von `solveFriction` und seinen Helfern.
const pressureLeverA: V3 = [0, 0, 0];
const pressureLeverB: V3 = [0, 0, 0];
const relative: V3 = [0, 0, 0];
const angularImpulse: V3 = [0, 0, 0];
const scratchPoint: V3 = [0, 0, 0];
const scratchMoment: V3 = [0, 0, 0];
const scratchSpin: V3 = [0, 0, 0];
const scratchCrossA: V3 = [0, 0, 0];
const scratchCrossB: V3 = [0, 0, 0];

/** Drehimpulsstoss `angular` mal `sign`; omega wird mitgefuehrt wie in `applyImpulse`. */
function applyAngularImpulse(body: RuntimeBody, inertia: M3, angular: V3, sign: number): void {
  v3addScaled(body.mechanics.angularMomentum, angular, sign);
  m3transform(scratchSpin, inertia, angular);
  v3addScaled(body.mechanics.angularVelocity, scratchSpin, sign);
}

/** Stoss `impulse` mal `sign`, angreifend am Hebel `lever`. */
function applyImpulseAt(body: RuntimeBody, inertia: M3, lever: V3, impulse: V3, sign: number): void {
  v3addScaled(body.mechanics.linearVelocity, impulse, sign * body.inverseMass);
  v3cross(scratchMoment, lever, impulse);
  applyAngularImpulse(body, inertia, scratchMoment, sign);
}

/** Addiert sign * (v + omega x r), die Geschwindigkeit des Punkts am Hebel r. */
function addPointVelocity(out: V3, body: RuntimeBody, lever: V3, sign: number): void {
  v3cross(scratchPoint, body.mechanics.angularVelocity, lever);
  v3addScaled(out, body.mechanics.linearVelocity, sign);
  v3addScaled(out, scratchPoint, sign);
}

/** (r x d1) . I^-1 (r x d2): wie ein Stoss entlang d2 am Hebel r die Geschwindigkeit dort entlang d1 dreht. */
function leverCoupling(inertia: M3, lever: V3, d1: V3, d2: V3): number {
  v3cross(scratchCrossA, lever, d1);
  v3cross(scratchCrossB, lever, d2);
  m3transform(scratchSpin, inertia, scratchCrossB);
  return v3dot(scratchCrossA, scratchSpin);
}

/** d1 . I^-1 d2: wie ein Drehimpulsstoss um d2 die Winkelgeschwindigkeit um d1 aendert. */
function spinCoupling(inertia: M3, d1: V3, d2: V3): number {
  m3transform(scratchSpin, inertia, d2);
  return v3dot(d1, scratchSpin);
}

/**
 * Coulomb: haften, solange der Stoss, der die Relativbewegung ganz aufhebt,
 * hoechstens `stickLimit` (mu_H N) betraegt; sonst gleiten mit `slideLimit`
 * (mu_G N). Liefert den Faktor, mit dem der Haftstoss zu kuerzen ist.
 *
 * Gekuerzt wird der Haftstoss selbst, nicht ein Stoss gegen die
 * Gleitgeschwindigkeit. Beide zeigen gleich, solange sich der Koerper nicht
 * zugleich dreht; sonst ist die Richtung des Haftstosses die, die der Loeser
 * mit der Kopplung von Schieben und Drehen ohnehin berechnet hat. Box2D und
 * PhysX naehern genauso.
 */
function coulombScale(magnitude: number, stickLimit: number, slideLimit: number): number {
  return magnitude <= stickLimit ? 1 : slideLimit / magnitude;
}

/** Reibstoss `impulse` mal `sign` auf b am Hebel `leverB`, das Negative auf a. */
function applyFrictionImpulse(contact: Contact, impulse: V3, leverA: V3, leverB: V3, sign: number): void {
  if (contact.movingB) applyImpulseAt(contact.movingB, contact.inertiaB!, leverB, impulse, sign);
  if (contact.movingA) applyImpulseAt(contact.movingA, contact.inertiaA!, leverA, impulse, -sign);
}

/** Drehimpulsstoss `angular` mal `sign` auf b, das Negative auf a. */
function applyContactTorque(contact: Contact, angular: V3, sign: number): void {
  if (contact.movingB) applyAngularImpulse(contact.movingB, contact.inertiaB!, angular, sign);
  if (contact.movingA) applyAngularImpulse(contact.movingA, contact.inertiaA!, angular, -sign);
}

/** omega_b - omega_a der bewegten Beteiligten in `out`. */
function relativeSpin(contact: Contact, out: V3): V3 {
  v3zero(out);
  if (contact.movingB) v3addScaled(out, contact.movingB.mechanics.angularVelocity, 1);
  if (contact.movingA) v3addScaled(out, contact.movingA.mechanics.angularVelocity, -1);
  return out;
}

/**
 * Reibung eines Kontakts, gegeben seine Normalimpulse: Haft- bzw.
 * Gleitreibung in der Tangentialebene, Bohrreibung um die Normale und
 * Rollreibung um die Tangenten.
 *
 * Die Normallast N ist die Summe der Normalimpulse. Die Reibung greift an
 * ihrem Druckmittelpunkt an, dem mit den Normalimpulsen gewichteten Mittel der
 * Kontaktpunkte. Dass die Aufteilung auf die Ecken nicht eindeutig ist (siehe
 * `solveContact`), stoert dabei nicht: Summe und Moment der Normalimpulse
 * sind es, und genau die bestimmen den Druckmittelpunkt. Der Angriffspunkt
 * zaehlt, weil die Reibung unter dem Schwerpunkt angreift - ein gebremster
 * Klotz wird nach vorn gekippt, und die Normalimpulse wandern nach vorn, um
 * das aufzufangen.
 *
 * Jeder der drei Stoesse wird aus der momentanen Relativbewegung neu bestimmt
 * und ersetzt den vorigen, statt auf ihn aufzuaddieren; deshalb wird der vorige
 * zuerst zurueckgenommen. Der Druckmittelpunkt wandert zwischen den
 * Durchlaeufen, und ein Zuschlag am neuen Punkt auf einen Stoss am alten
 * ergaebe ein Moment, das es nicht gibt. Zurueckgenommen wird jeder Stoss erst
 * unmittelbar vor seiner eigenen Bestimmung, nicht alle drei vorab: sonst
 * bestimmte sich der Reibstoss ohne den Rollstoss, der danach wieder dazukommt,
 * und ein haftender Klotz behielte einen Rest Schlupf, den kein Durchlauf mehr
 * abbaut.
 *
 * Gibt zurueck, ob sich ein Stoss merklich geaendert hat.
 */
function solveFriction(contact: Contact): boolean {
  const n = contact.normal;
  const tu = contact.tangentU;
  const tv = contact.tangentV;
  const a = contact.movingA;
  const b = contact.movingB;
  const inertiaA = contact.inertiaA;
  const inertiaB = contact.inertiaB;

  const oldFriction0 = contact.friction[0], oldFriction1 = contact.friction[1], oldFriction2 = contact.friction[2];
  const oldTwist = contact.twist;
  const oldRolling0 = contact.rolling[0], oldRolling1 = contact.rolling[1], oldRolling2 = contact.rolling[2];

  let load = 0;
  for (let i = 0; i < contact.count; i += 1) load += contact.impulse[i]!;
  const frictionless = contact.staticFriction === 0 && contact.kineticFriction === 0 && contact.rollingFriction === 0;
  if (!(load > 0) || frictionless) {
    applyFrictionImpulse(contact, contact.friction, contact.frictionLeverA, contact.frictionLeverB, -1);
    v3set(angularImpulse, n[0] * oldTwist, n[1] * oldTwist, n[2] * oldTwist);
    applyContactTorque(contact, angularImpulse, -1);
    applyContactTorque(contact, contact.rolling, -1);
    v3zero(contact.friction);
    contact.twist = 0;
    v3zero(contact.rolling);
    return (
      oldFriction0 !== 0 || oldFriction1 !== 0 || oldFriction2 !== 0 || oldTwist !== 0 ||
      oldRolling0 !== 0 || oldRolling1 !== 0 || oldRolling2 !== 0
    );
  }

  // Druckmittelpunkt, als Hebel von beiden Schwerpunkten aus.
  v3zero(pressureLeverA);
  v3zero(pressureLeverB);
  for (let i = 0; i < contact.count; i += 1) {
    const weight = contact.impulse[i]! / load;
    v3addScaled(pressureLeverA, contact.leverA[i]!, weight);
    v3addScaled(pressureLeverB, contact.leverB[i]!, weight);
  }

  // --- Haft- und Gleitreibung: K_t p = -v_t, mit K_t der Kopplungsmatrix in
  // der Tangentialebene (Translation plus Drehung beider Koerper, wie in
  // `prepareContact` entlang der Normale).
  applyFrictionImpulse(contact, contact.friction, contact.frictionLeverA, contact.frictionLeverB, -1);
  v3zero(relative);
  if (b) addPointVelocity(relative, b, pressureLeverB, 1);
  if (a) addPointVelocity(relative, a, pressureLeverA, -1);
  const slipU = v3dot(relative, tu);
  const slipV = v3dot(relative, tv);
  const inverseMassSum = (a?.inverseMass ?? 0) + (b?.inverseMass ?? 0);
  let kuu = inverseMassSum, kuv = 0, kvv = inverseMassSum;
  if (a) {
    kuu += leverCoupling(inertiaA!, pressureLeverA, tu, tu);
    kuv += leverCoupling(inertiaA!, pressureLeverA, tu, tv);
    kvv += leverCoupling(inertiaA!, pressureLeverA, tv, tv);
  }
  if (b) {
    kuu += leverCoupling(inertiaB!, pressureLeverB, tu, tu);
    kuv += leverCoupling(inertiaB!, pressureLeverB, tu, tv);
    kvv += leverCoupling(inertiaB!, pressureLeverB, tv, tv);
  }
  let pu = 0, pv = 0;
  const det = kuu * kvv - kuv * kuv;
  if (det > SINGULAR_EPSILON * kuu * kvv) {
    pu = -(kvv * slipU - kuv * slipV) / det;
    pv = -(kuu * slipV - kuv * slipU) / det;
    const scale = coulombScale(
      Math.sqrt(pu * pu + pv * pv),
      contact.staticFriction * load,
      contact.kineticFriction * load,
    );
    pu *= scale;
    pv *= scale;
  }
  v3set(contact.friction, pu * tu[0] + pv * tv[0], pu * tu[1] + pv * tv[1], pu * tu[2] + pv * tv[2]);
  v3set(contact.frictionLeverA, pressureLeverA[0], pressureLeverA[1], pressureLeverA[2]);
  v3set(contact.frictionLeverB, pressureLeverB[0], pressureLeverB[1], pressureLeverB[2]);
  applyFrictionImpulse(contact, contact.friction, contact.frictionLeverA, contact.frictionLeverB, 1);

  // --- Bohrreibung: dieselbe Coulomb-Regel fuer die Drehung um die Normale,
  // mit dem Hebel `patchRadius`.
  v3set(angularImpulse, n[0] * oldTwist, n[1] * oldTwist, n[2] * oldTwist);
  applyContactTorque(contact, angularImpulse, -1);
  relativeSpin(contact, relative);
  const spinN = v3dot(relative, n);
  let kn = 0;
  if (a) kn += spinCoupling(inertiaA!, n, n);
  if (b) kn += spinCoupling(inertiaB!, n, n);
  let twist = 0;
  if (kn > 0 && contact.patchRadius > 0) {
    twist = -spinN / kn;
    twist *= coulombScale(
      Math.abs(twist),
      contact.staticFriction * load * contact.patchRadius,
      contact.kineticFriction * load * contact.patchRadius,
    );
  }
  contact.twist = twist;
  v3set(angularImpulse, n[0] * twist, n[1] * twist, n[2] * twist);
  applyContactTorque(contact, angularImpulse, 1);

  // --- Rollreibung: ein Moment gegen das Abrollen, hoechstens f N. Haften und
  // Gleiten unterscheidet sie nicht - es gibt nur den einen Hebelarm f.
  applyContactTorque(contact, contact.rolling, -1);
  relativeSpin(contact, relative);
  const rollU = v3dot(relative, tu);
  const rollV = v3dot(relative, tv);
  let ruu = 0, ruv = 0, rvv = 0;
  if (a) {
    ruu += spinCoupling(inertiaA!, tu, tu);
    ruv += spinCoupling(inertiaA!, tu, tv);
    rvv += spinCoupling(inertiaA!, tv, tv);
  }
  if (b) {
    ruu += spinCoupling(inertiaB!, tu, tu);
    ruv += spinCoupling(inertiaB!, tu, tv);
    rvv += spinCoupling(inertiaB!, tv, tv);
  }
  let hu = 0, hv = 0;
  const rollDet = ruu * rvv - ruv * ruv;
  if (contact.rollingFriction > 0 && rollDet > SINGULAR_EPSILON * ruu * rvv) {
    hu = -(rvv * rollU - ruv * rollV) / rollDet;
    hv = -(ruu * rollV - ruv * rollU) / rollDet;
    const limit = contact.rollingFriction * load;
    const scale = coulombScale(Math.sqrt(hu * hu + hv * hv), limit, limit);
    hu *= scale;
    hv *= scale;
  }
  v3set(contact.rolling, hu * tu[0] + hv * tv[0], hu * tu[1] + hv * tv[1], hu * tu[2] + hv * tv[2]);
  applyContactTorque(contact, contact.rolling, 1);

  // Merklich geaendert, gemessen wie in `solveContact`: an der Geschwindigkeit,
  // die die Aenderung bewirkt, relativ zu der, die aufzuheben war.
  const df0 = contact.friction[0] - oldFriction0;
  const df1 = contact.friction[1] - oldFriction1;
  const df2 = contact.friction[2] - oldFriction2;
  const slipTolerance = Math.max(SOLVER_TOLERANCE * Math.sqrt(slipU * slipU + slipV * slipV), SOLVER_TOLERANCE_FLOOR);
  if (Math.sqrt(df0 * df0 + df1 * df1 + df2 * df2) * 0.5 * (kuu + kvv) > slipTolerance) return true;
  const spinScale = Math.sqrt(spinN * spinN + rollU * rollU + rollV * rollV);
  const spinTolerance = Math.max(SOLVER_TOLERANCE * spinScale, SOLVER_TOLERANCE_FLOOR);
  if (Math.abs(twist - oldTwist) * kn > spinTolerance) return true;
  const dr0 = contact.rolling[0] - oldRolling0;
  const dr1 = contact.rolling[1] - oldRolling1;
  const dr2 = contact.rolling[2] - oldRolling2;
  return Math.sqrt(dr0 * dr0 + dr1 * dr1 + dr2 * dr2) * 0.5 * (ruu + rvv) > spinTolerance;
}

/** Durchdringungswarnung in die Aufzeichnung, wenn ein Kontakt zu tief ist. */
function warnIfDeep(contact: Contact, t: number, emit: ModuleContext["emit"]): void {
  const reference = contact.bodyA
    ? Math.min(contact.bodyA.boundingRadius, contact.bodyB.boundingRadius)
    : contact.bodyB.boundingRadius;
  if (contact.depth <= PENETRATION_WARNING_FACTOR * reference) return;
  const partner = contact.bodyA ? `mit ${contact.bodyB.id}` : `an Segment ${contact.segment!.id}`;
  emit({
    t,
    type: "warning",
    entityId: contact.bodyA?.id ?? contact.bodyB.id,
    message:
      `Durchdringung von ${contact.depth.toFixed(4)} m ${partner} - mehr als ` +
      `${(PENETRATION_WARNING_FACTOR * 100).toFixed(0)} % der Koerpergroesse. ` +
      `Zeitschritt zu gross oder Geschwindigkeit zu hoch.`,
  });
}

export function createMechanicsModule(): PhysicsModule {
  // Kontakte und Traegheitsmatrizen werden ueber die Zeitschritte
  // wiederverwendet - auch hier geht es um die Allokationen pro Zeitschritt.
  const contactPool: Contact[] = [];
  const inverseInertia = new Map<string, M3>();
  // Arbeitsspeicher fuer die Schwerkraftsumme - dieselbe Begruendung wie bei
  // den Matrizen oben: keine frischen Arrays pro Zeitschritt.
  const scratchGravity: V3 = [0, 0, 0];

  return {
    id: "mechanics",
    reads: [],
    writes: ["mechanics"],

    onEntityAdded(entity) {
      if (entity.kind === "body") {
        updateAngularVelocity(entity);
      }
    },

    /**
     * Kraefte und Drehmomente des Zeitschritts summieren.
     *
     * Die Schwerkraft kommt aus den platzierten Gravitations-Lasten, nicht aus
     * einem eingebauten Gesetz. Gibt es keine, ist die Summe der Nullvektor,
     * und der Klotz bleibt in der Luft stehen. Genau diese Gegenprobe gehoert
     * zur Verifikation.
     */
    accumulate({ state }) {
      const gravity = totalGravity(state, scratchGravity);
      for (const entity of state.entities.values()) {
        if (entity.kind !== "body") continue;
        const mechanics = entity.mechanics;
        v3zero(mechanics.force);
        v3zero(mechanics.torque);
        mechanics.contactCount = 0;
        if (entity.kinematic) {
          v3zero(mechanics.acceleration);
          continue;
        }
        v3addScaled(mechanics.force, gravity, entity.mass);
      }
    },

    /**
     * Zustand fortschreiben.
     *
     * Translation nach Velocity-Verlet:
     *
     *   x(t+dt) = x(t) + v(t)*dt + 1/2*a*dt^2
     *   v(t+dt) = v(t) + a*dt
     *
     * Die Reihenfolge ist wesentlich: die Lage benutzt die *alte*
     * Geschwindigkeit. Bei konstanter Beschleunigung - und die Schwerkraft ist
     * konstant - reproduziert diese Rekursion die geschlossene Loesung
     * s = 1/2*g*t^2 und v = g*t exakt, nicht nur naeherungsweise. Deshalb kann
     * der Falltest mit einer Toleranz von 1e-10 statt einem Prozent pruefen und
     * faengt damit Fehler, die eine weiche Toleranz durchlaesst.
     *
     * Sobald die Kraefte von der Lage abhaengen (Federn, Luftwiderstand), ist
     * das Verfahren zweiter Ordnung in der Lage statt exakt. Eine zweite
     * `accumulate`-Auswertung innerhalb des Schritts wuerde es zum vollen
     * Velocity-Verlet aufwerten - die Phasenreihenfolge laesst das zu, ohne
     * dass sich etwas anderes aendert.
     *
     * Rotation laeuft ueber den Drehimpuls: L(t+dt) = L(t) + tau*dt, daraus
     * omega = I_welt^-1 * L, daraus die neue Lage. Ohne Drehmoment bleibt L
     * bitgenau erhalten - die Drehimpulserhaltung ist damit keine Frage der
     * Schrittweite.
     */
    integrate({ state, dt }) {
      const halfDtSquared = 0.5 * dt * dt;
      for (const entity of state.entities.values()) {
        if (entity.kind !== "body" || entity.kinematic) continue;
        const mechanics = entity.mechanics;

        v3set(
          mechanics.acceleration,
          mechanics.force[0] * entity.inverseMass,
          mechanics.force[1] * entity.inverseMass,
          mechanics.force[2] * entity.inverseMass,
        );

        v3addScaled(mechanics.position, mechanics.linearVelocity, dt);
        v3addScaled(mechanics.position, mechanics.acceleration, halfDtSquared);
        v3addScaled(mechanics.linearVelocity, mechanics.acceleration, dt);

        v3addScaled(mechanics.angularMomentum, mechanics.torque, dt);
        updateAngularVelocity(entity);
        q4integrate(mechanics.orientation, mechanics.angularVelocity, dt);
      }
    },

    /**
     * Beruehrungen erkennen und aufloesen.
     *
     * Jeder Kontakt traegt seine Kontaktpunkte - die Ecken der Kontaktflaeche,
     * bei einer Kante deren Endpunkte, bei einer Ecke diese. Der Normalimpuls
     * greift an diesen Punkten an, nicht am Schwerpunkt, und erzeugt damit ein
     * Kontaktdrehmoment: ein Klotz, der mit einer Ecke auf die schiefe Ebene
     * faellt, kippt auf seine Flaeche; einer, der ueber den Rand ragt, kippt
     * ueber die Kante.
     *
     * Zur Normalkraft kommt die Reibung (`solveFriction`): Haft- oder
     * Gleitreibung in der Tangentialebene, Bohr- und Rollreibung als Moment.
     * Sie haengt an der Normallast, deshalb wechseln sich Normal- und
     * Reibstoss je Kontakt ab, bis beide zueinander passen. Mit Glatt als
     * Partner bleibt alles entlang der Normale: der Klotz im Durchstich gleitet
     * reibungsfrei und braucht einen Eingriff, um anzuhalten.
     *
     * Ablauf: alle Kontakte erkennen, dann die Geschwindigkeiten loesen (jeden
     * Kontakt exakt, alle zusammen im Wechsel, bis sich nichts mehr aendert),
     * dann die Lage korrigieren. Die Lagekorrektur verschiebt nur und dreht
     * nicht; um die Drehung kuemmert sich der Impuls im naechsten Schritt.
     */
    contacts({ state, dt, emit }) {
      const gravity = totalGravity(state, scratchGravity);
      const restSpeed = REST_THRESHOLD_STEPS * Math.sqrt(v3dot(gravity, gravity)) * dt;
      const present = bodiesOf(state, scratchBodies);

      for (const body of present) {
        if (body.kinematic) continue;
        let matrix = inverseInertia.get(body.id);
        if (!matrix) {
          matrix = m3identity();
          inverseInertia.set(body.id, matrix);
        }
        worldInverseInertia(body, matrix);
      }

      let used = 0;
      const nextContact = (): Contact => {
        if (used === contactPool.length) contactPool.push(createContact());
        const contact = contactPool[used]!;
        used += 1;
        return contact;
      };

      // Koerper gegen Koerper.
      for (let i = 0; i < present.length; i += 1) {
        const a = present[i]!;
        for (let j = i + 1; j < present.length; j += 1) {
          const b = present[j]!;
          // Zwei festgehaltene Koerper koennen nichts bewegen.
          if (a.inverseMass + b.inverseMass === 0) continue;

          // Grobtest ueber die umschliessenden Kugeln, bevor die Trennachsen laufen.
          const dx = b.mechanics.position[0] - a.mechanics.position[0];
          const dy = b.mechanics.position[1] - a.mechanics.position[1];
          const dz = b.mechanics.position[2] - a.mechanics.position[2];
          const reach = a.boundingRadius + b.boundingRadius;
          if (dx * dx + dy * dy + dz * dz >= reach * reach) continue;
          if (!overlapBodies(a, b, scratchOverlap)) continue;
          // Dieselbe Tunnel-Grenze wie bei der Flaeche: so tief ineinander ist
          // kein Kontakt mehr, sondern ein Durchgetunnelter, und den
          // zurueckzuschieben wuerde den Fehler verstecken.
          const smaller = Math.min(a.boundingRadius, b.boundingRadius);
          if (scratchOverlap.depth > PENETRATION_LIMIT_FACTOR * smaller) continue;

          a.mechanics.contactCount += 1;
          b.mechanics.contactCount += 1;
          prepareContact(nextContact(), scratchOverlap, a, b, null, null, inverseInertia, restSpeed);
        }
      }
      const pairCount = used;

      // Koerper gegen Flaeche, ein Kontakt je Segment.
      for (const body of present) {
        if (body.kinematic) continue;
        const limit = PENETRATION_LIMIT_FACTOR * body.boundingRadius;
        for (const other of state.entities.values()) {
          if (other.kind !== "surface") continue;
          for (const segment of other.segments) {
            if (!overlapSurface(body, segment, scratchOverlap)) continue;
            if (scratchOverlap.depth > limit) continue;
            body.mechanics.contactCount += 1;
            prepareContact(nextContact(), scratchOverlap, null, body, other, segment, inverseInertia, restSpeed);
          }
        }
      }

      for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
        let changed = false;
        for (let k = 0; k < used; k += 1) {
          const contact = contactPool[k]!;
          if (solveContact(contact)) changed = true;
          if (solveFriction(contact)) changed = true;
        }
        if (!changed) break;
      }
      // omega wurde waehrend des Loesens mitgefuehrt; L ist die Wahrheit.
      for (const body of present) updateAngularVelocity(body);

      // Der Reibstoss gehoert in die Lage wie eine Kraft ueber den Schritt:
      // Velocity-Verlet bewegt um v*dt + 1/2*a*dt^2, und `integrate` kannte
      // die Reibung noch nicht. Ohne diesen Nachtrag kroeche ein haftender
      // Klotz auf der schiefen Ebene je Schritt um 1/2*g*sin(alpha)*dt^2
      // hangabwaerts - bei 30 Grad 2,5 mm/s, obwohl seine Geschwindigkeit
      // jeden Schritt wieder 0 ist. Die Normalrichtung braucht das nicht, dort
      // korrigiert die Eindringtiefe.
      const halfDt = 0.5 * dt;
      for (let k = 0; k < used; k += 1) {
        const contact = contactPool[k]!;
        const f = contact.friction;
        if (f[0] === 0 && f[1] === 0 && f[2] === 0) continue;
        if (contact.movingB) v3addScaled(contact.movingB.mechanics.position, f, halfDt * contact.movingB.inverseMass);
        if (contact.movingA) v3addScaled(contact.movingA.mechanics.position, f, -halfDt * contact.movingA.inverseMass);
      }

      // Lagekorrektur: erst die Paare, dann die Flaechen. Die Korrektur eines
      // Paars kann einen Koerper in eine Flaeche druecken, und die Flaeche muss
      // das letzte Wort haben - nichts darf aus ihr herausragen. Ohne
      // Schlupfzone, damit ein Koerper exakt aufliegt - bei dt = 1 ms sinkt er
      // pro Schritt nur 1/2*g*dt^2, also wenige Mikrometer ein.
      for (let k = 0; k < pairCount; k += 1) {
        const contact = contactPool[k]!;
        const a = contact.bodyA!;
        const b = contact.bodyB;
        const weightSum = a.inverseMass + b.inverseMass;
        v3addScaled(a.mechanics.position, contact.normal, (-contact.depth * a.inverseMass) / weightSum);
        v3addScaled(b.mechanics.position, contact.normal, (contact.depth * b.inverseMass) / weightSum);
        warnIfDeep(contact, state.t, emit);
      }
      for (let k = pairCount; k < used; k += 1) {
        const contact = contactPool[k]!;
        const n = contact.normal;
        const p = contact.bodyB.mechanics.position;
        const o = contact.originB;
        // Resttiefe: die Paare und andere Segmente koennen den Koerper seit dem
        // Erkennen schon verschoben haben - verschoben, nicht gedreht, also
        // zaehlt nur der Weg entlang der Normale.
        const depth = contact.depth - ((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]);
        if (depth > 0) v3addScaled(p, n, depth);
        warnIfDeep(contact, state.t, emit);
      }
    },
  };
}

/** Macht die Winkelgeschwindigkeit nach einem Eingriff wieder konsistent zum Drehimpuls. */
export function refreshDerivedState(body: RuntimeBody): void {
  updateAngularVelocity(body);
}

/** Nur fuer Tests und Diagnose: der Betrag des Drehimpulses. */
export function angularMomentumMagnitude(body: RuntimeBody): number {
  const value = body.mechanics.angularMomentum;
  return Math.sqrt(v3dot(value, value));
}
