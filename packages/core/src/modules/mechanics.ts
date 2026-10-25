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
    contacts({ state, emit }) {
      for (const entity of state.entities.values()) {
        if (entity.kind !== "body" || entity.kinematic) continue;
        const found = contactsByBody.get(entity.id) ?? new Map<string, Contact>();
        contactsByBody.set(entity.id, found);
        found.clear();

        for (const other of state.entities.values()) {
          if (other.kind !== "surface") continue;
          collectContacts(entity, other, found);
        }

        entity.mechanics.contactCount = found.size;
        if (found.size === 0) continue;

        const warningDepth = PENETRATION_WARNING_FACTOR * entity.boundingRadius;
        for (const contact of found.values()) {
          const normal = contact.segment.normal;
          const restitution = Math.min(entity.restitution, contact.surface.restitution);

          const normalSpeed = v3dot(entity.mechanics.linearVelocity, normal);
          if (normalSpeed < 0) {
            // v -= (1 + e) * v_n * n: entfernt die Normalkomponente und gibt
            // bei e > 0 den entsprechenden Anteil zurueck.
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

