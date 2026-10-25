import { createOverlap, overlapBodies } from "../collision.js";
import type { ModuleContext, PhysicsModule } from "../pipeline.js";
import {
  boxCornersLocal,
  type ResolvedSegment,
  type RuntimeBody,
  type RuntimeSurface,
  type SimState,
} from "../state.js";
import {
  m3fromQuat,
  m3identity,
  m3multiply,
  m3transform,
  m3transpose,
  q4integrate,
  v3addScaled,
  v3dot,
  v3rotateByQuat,
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
 * Mechanik - Stufe 1: Translation, Rotation, Kontakt ohne Reibung.
 *
 * Deckt `accumulate` (Kraefte), `integrate` (Lage und Geschwindigkeit) und
 * `contacts` (Normalimpulse) ab. `exchange` und `transform` bleiben leer; sie
 * gehoeren den spaeteren Modulen.
 */

/**
 * Ein erkannter Kontakt: ein Punkt des Koerpers liegt hinter einer Flaeche.
 */
interface Contact {
  surface: RuntimeSurface;
  segment: ResolvedSegment;
  /** Durchdringungstiefe entlang der Normale, positiv. */
  depth: number;
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
 * aufgeloest. Zehn Schritte Schwerkraft, nicht einer: in einem Stapel loest
 * jede Lage ihren Kontakt nach der darueber, und der Rest, den die obere dabei
 * behaelt, waechst mit der Stapelhoehe. Die Schwelle muss darueber liegen, sonst
 * huepft der oberste Koerper eines Stapels. Bei g = 9,81 m/s^2 und 1 ms sind
 * das knapp 0,1 m/s - ein Rueckprall in der Groesse eines Millimeters.
 *
 * An |g| gebunden statt eine feste Zahl: ohne Schwerkraft gibt es keine Ruhe
 * zu unterscheiden, und ein langsamer Stoss im Schwerefreien prallt dann wie
 * jeder andere ab.
 */
const REST_THRESHOLD_STEPS = 10;

// Arbeitsspeicher auf Modulebene. Der Integrator laeuft bei dt = 1 ms
// tausendfach pro simulierter Sekunde; frische Arrays pro Aufruf waeren
// Millionen kurzlebiger Objekte.
const scratchRotation: M3 = m3identity();
const scratchRotationT: M3 = m3identity();
const scratchProduct: M3 = m3identity();
const scratchInverseInertiaWorld: M3 = m3identity();
const scratchCorner: V3 = [0, 0, 0];

/**
 * Winkelgeschwindigkeit aus dem Drehimpuls: omega = I_welt^-1 * L mit
 * I_welt^-1 = R * I_koerper^-1 * R^T.
 */
function updateAngularVelocity(body: RuntimeBody): void {
  if (body.kinematic) {
    v3zero(body.mechanics.angularVelocity);
    return;
  }
  m3fromQuat(scratchRotation, body.mechanics.orientation);
  m3transpose(scratchRotationT, scratchRotation);
  m3multiply(scratchProduct, scratchRotation, body.inverseInertiaBody);
  m3multiply(scratchInverseInertiaWorld, scratchProduct, scratchRotationT);
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

/**
 * Sammelt alle Kontakte eines Koerpers mit einer Flaeche.
 *
 * Fuer den Block werden die acht Ecken geprueft, fuer die Kugel der
 * Mittelpunkt abzueglich Radius. Ein Punkt gilt als Kontakt, wenn er
 * (a) innerhalb der endlichen Plattenausdehnung liegt und (b) hinter der
 * Plattenebene, aber nicht tiefer als die Tunnel-Grenze.
 */
function collectContacts(body: RuntimeBody, surface: RuntimeSurface, into: Map<string, Contact>): void {
  const penetrationLimit = PENETRATION_LIMIT_FACTOR * body.boundingRadius;

  const testPoint = (point: readonly number[], radius: number, segment: ResolvedSegment): void => {
    const dx = point[0]! - segment.center[0];
    const dy = point[1]! - segment.center[1];
    const dz = point[2]! - segment.center[2];

    const alongNormal =
      dx * segment.normal[0] + dy * segment.normal[1] + dz * segment.normal[2] - radius;
    if (alongNormal >= 0 || alongNormal <= -penetrationLimit) return;

    const alongU = dx * segment.tangent[0] + dy * segment.tangent[1] + dz * segment.tangent[2];
    if (alongU > segment.halfExtentU || alongU < -segment.halfExtentU) return;
    const alongV = dx * segment.bitangent[0] + dy * segment.bitangent[1] + dz * segment.bitangent[2];
    if (alongV > segment.halfExtentV || alongV < -segment.halfExtentV) return;

    const depth = -alongNormal;
    const key = `${surface.id}/${segment.id}`;
    const existing = into.get(key);
    // Je Segment nur der tiefste Punkt: zwei Ecken auf derselben Platte duerfen
    // die Lagekorrektur nicht verdoppeln.
    if (existing === undefined || depth > existing.depth) {
      into.set(key, { surface, segment, depth });
    }
  };

  for (const segment of surface.segments) {
    if (body.shape.type === "sphere") {
      testPoint(body.mechanics.position, body.shape.radius, segment);
      continue;
    }
    for (const local of boxCornersLocal(body.shape)) {
      v3rotateByQuat(scratchCorner, local, body.mechanics.orientation);
      scratchCorner[0] += body.mechanics.position[0];
      scratchCorner[1] += body.mechanics.position[1];
      scratchCorner[2] += body.mechanics.position[2];
      testPoint(scratchCorner, 0, segment);
    }
  }
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

/** Geschwindigkeit eines Koerpers entlang `normal`; ein festgehaltener steht, was auch in seinem Feld steht. */
function speedAlong(body: RuntimeBody, normal: readonly number[]): number {
  return body.kinematic ? 0 : v3dot(body.mechanics.linearVelocity, normal);
}

/**
 * Loest alle Beruehrungen zwischen Koerpern auf.
 *
 * Wie bei der Flaeche: ein Impuls entlang der Kontaktnormale am Schwerpunkt,
 * kein Drehmoment, keine Tangentialwirkung (reibungsfrei). Der Impuls verteilt
 * sich nach den Massen:
 *
 *   j = -(1 + e) * v_rel / (1/m_a + 1/m_b),   v_rel = (v_b - v_a) . n
 *
 * Impuls und - bei e = 1 - Energie bleiben dabei exakt erhalten; ein
 * festgehaltener Koerper (1/m = 0) nimmt nichts auf und verhaelt sich wie eine
 * Wand. Die Lagekorrektur teilt die Eindringtiefe im selben Verhaeltnis auf.
 */
function resolveBodyPairs(
  list: readonly RuntimeBody[],
  restSpeed: number,
  t: number,
  emit: ModuleContext["emit"],
): void {
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]!;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j]!;
      const weightSum = a.inverseMass + b.inverseMass;
      // Zwei festgehaltene Koerper koennen nichts bewegen.
      if (weightSum === 0) continue;

      // Grobtest ueber die umschliessenden Kugeln, bevor die Trennachsen laufen.
      const dx = b.mechanics.position[0] - a.mechanics.position[0];
      const dy = b.mechanics.position[1] - a.mechanics.position[1];
      const dz = b.mechanics.position[2] - a.mechanics.position[2];
      const reach = a.boundingRadius + b.boundingRadius;
      if (dx * dx + dy * dy + dz * dz >= reach * reach) continue;
      if (!overlapBodies(a, b, scratchOverlap)) continue;

      const { normal, depth } = scratchOverlap;
      const smaller = Math.min(a.boundingRadius, b.boundingRadius);
      // Dieselbe Tunnel-Grenze wie bei der Flaeche: so tief ineinander ist kein
      // Kontakt mehr, sondern ein Durchgetunnelter, und den zurueckzuschieben
      // wuerde den Fehler verstecken.
      if (depth > PENETRATION_LIMIT_FACTOR * smaller) continue;

      a.mechanics.contactCount += 1;
      b.mechanics.contactCount += 1;

      const approach = speedAlong(b, normal) - speedAlong(a, normal);
      if (approach < 0) {
        const restitution = pairRestitution(a, b, -approach, restSpeed);
        const impulse = (-(1 + restitution) * approach) / weightSum;
        v3addScaled(a.mechanics.linearVelocity, normal, -impulse * a.inverseMass);
        v3addScaled(b.mechanics.linearVelocity, normal, impulse * b.inverseMass);
      }

      v3addScaled(a.mechanics.position, normal, (-depth * a.inverseMass) / weightSum);
      v3addScaled(b.mechanics.position, normal, (depth * b.inverseMass) / weightSum);

      if (depth > PENETRATION_WARNING_FACTOR * smaller) {
        emit({
          t,
          type: "warning",
          entityId: a.id,
          message:
            `Durchdringung von ${depth.toFixed(4)} m mit ${b.id} - mehr als ` +
            `${(PENETRATION_WARNING_FACTOR * 100).toFixed(0)} % der Koerpergroesse. ` +
            `Zeitschritt zu gross oder Geschwindigkeit zu hoch.`,
        });
      }
    }
  }
}

export function createMechanicsModule(): PhysicsModule {
  // Pro Koerper wiederverwendete Kontaktkarte - auch hier geht es um die
  // Allokationen pro Zeitschritt.
  const contactsByBody = new Map<string, Map<string, Contact>>();
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
        contactsByBody.set(entity.id, new Map());
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
     * Reibungsfrei: nur die Normalkomponente der Geschwindigkeit wird
     * veraendert, die Tangentialkomponente bleibt unberuehrt. Das ist der Grund,
     * warum der Klotz die schiefe Ebene hinabbeschleunigt und auf dem Auslauf
     * mit konstanter Geschwindigkeit weitergleitet - und warum es einen Eingriff
     * braucht, um ihn anzuhalten.
     *
     * Der Impuls wird am Schwerpunkt angesetzt und erzeugt damit *kein*
     * Drehmoment. Der Klotz kippt also nicht: auf der schiefen Ebene beruehrt er
     * die Flaeche mit einer Ecke statt mit der Flaeche. Das ist die sichtbare
     * Seite der Stufe-1b-Luecke (Kontaktdrehmoment, Kantenkontakt) und
     * bewusst so - Kipp-Dynamik braucht einen iterativen Kontaktloeser, und
     * Rotationsintegration und Kontaktaufloesung gleichzeitig zu entwickeln
     * verzoegert beides.
     */
    contacts({ state, dt, emit }) {
      const gravity = totalGravity(state, scratchGravity);
      const restSpeed = REST_THRESHOLD_STEPS * Math.sqrt(v3dot(gravity, gravity)) * dt;

      // Koerper gegen Koerper zuerst, Flaechen zuletzt: die Lagekorrektur eines
      // Paars kann einen Koerper in eine Flaeche druecken, und die Flaeche muss
      // das letzte Wort haben - nichts darf aus ihr herausragen.
      const present = bodiesOf(state, scratchBodies);
      resolveBodyPairs(present, restSpeed, state.t, emit);

      for (const entity of present) {
        if (entity.kinematic) continue;
        const found = contactsByBody.get(entity.id) ?? new Map<string, Contact>();
        contactsByBody.set(entity.id, found);
        found.clear();

        for (const other of state.entities.values()) {
          if (other.kind !== "surface") continue;
          collectContacts(entity, other, found);
        }

        entity.mechanics.contactCount += found.size;
        if (found.size === 0) continue;

        const warningDepth = PENETRATION_WARNING_FACTOR * entity.boundingRadius;
        for (const contact of found.values()) {
          const normal = contact.segment.normal;

          const normalSpeed = v3dot(entity.mechanics.linearVelocity, normal);
          if (normalSpeed < 0) {
            // v -= (1 + e) * v_n * n: entfernt die Normalkomponente und gibt
            // bei e > 0 den entsprechenden Anteil zurueck.
            const restitution = pairRestitution(entity, contact.surface, -normalSpeed, restSpeed);
            v3addScaled(entity.mechanics.linearVelocity, normal, -(1 + restitution) * normalSpeed);
          }

          // Lagekorrektur: den Koerper genau aus der Flaeche herausschieben.
          // Ohne Schlupfzone, damit er exakt aufliegt - bei dt = 1 ms sinkt er
          // pro Schritt nur 1/2*g*dt^2, also wenige Mikrometer ein.
          v3addScaled(entity.mechanics.position, normal, contact.depth);

          if (contact.depth > warningDepth) {
            emit({
              t: state.t,
              type: "warning",
              entityId: entity.id,
              message:
                `Durchdringung von ${contact.depth.toFixed(4)} m an Segment ` +
                `${contact.segment.id} - mehr als ${(PENETRATION_WARNING_FACTOR * 100).toFixed(0)} % ` +
                `der Koerpergroesse. Zeitschritt zu gross oder Geschwindigkeit zu hoch.`,
            });
          }
        }
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

