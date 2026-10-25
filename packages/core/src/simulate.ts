import type {
  EntityChange,
  EntitySpec,
  Environment,
  Intervention,
  Material,
  Recording,
  RunEvent,
  Scenario,
  Snapshot,
} from "@sandbox/schema";
import { applyEntityChange, entitySpecAt, interventionsInOrder, shapeVolume } from "@sandbox/schema";
import { createMechanicsModule, refreshDerivedState, setAngularVelocity } from "./modules/mechanics.js";
import { ModuleRegistry, type ModuleContext } from "./pipeline.js";
import { createRng, type Rng } from "./rng.js";
import {
  constraintSegments,
  boundingRadiusFor,
  createState,
  inertiaTensorFor,
  invertDiagonal,
  LibraryIndex,
  makeMechanicalState,
  resolveGravity,
  resolveSegments,
  type ContactProperties,
  type RuntimeBody,
  type RuntimeEntity,
  type RuntimeLoad,
  type RuntimeSurface,
  type SimState,
} from "./state.js";
import { q4copy, v3copy, v3set } from "./math/index.js";

/**
 * Die Kontaktwerte eines Materials, fuer Koerper und Ebene gleich.
 *
 * Ein fehlender Reibwert heisst reibungsfrei (siehe `MechanicalProperties`).
 * Aufgeloest wird hier und nicht im Mechanik-Modul, damit der Kontaktloeser
 * nie nach `undefined` fragen muss.
 */
function contactProperties(material: Material): ContactProperties {
  const mechanical = material.mechanical;
  return {
    restitution: mechanical.restitution,
    staticFriction: mechanical.staticFriction ?? 0,
    kineticFriction: mechanical.kineticFriction ?? 0,
    rollingFriction: mechanical.rollingFriction ?? 0,
  };
}

/**
 * Der Simulator: fuehrt ein Szenario aus und erzeugt eine Aufzeichnung.
 *
 * Er besitzt die Phasen `interventions` und `record`; alles Physikalische
 * gehoert den Modulen. Diese Trennung ist der Grund, warum eine spaetere
 * Physikdomaene nichts am Simulator aendert.
 */

export interface SimulatorOptions {
  /** Zusaetzliche Module. Mechanik ist immer dabei. */
  modules?: ModuleRegistry;
}

export class Simulator {
  readonly state: SimState;
  readonly registry: ModuleRegistry;
  private readonly scenario: Scenario;
  private readonly library: LibraryIndex;
  private readonly rng: Rng;
  private readonly events: RunEvent[] = [];
  private readonly context: ModuleContext;
  /**
   * Die Spec jeder Entitaet in der Szene, mit den Aenderungen bis jetzt. Daraus
   * werden Masse, Traegheit und Segmente neu gebaut, wenn eine Aenderung sie
   * betrifft - die Laufzeitwerte selbst lassen sich nicht zurueckrechnen.
   */
  private readonly specs = new Map<string, EntitySpec>();
  /** Die Eingriffe nach Zeit sortiert - einmal, nicht in jedem Schritt. */
  private readonly timeline: Intervention[];
  /** Index des naechsten noch nicht angewandten Eingriffs in `timeline`. */
  private nextInterventionIndex = 0;
  /**
   * Zahl der ausgefuehrten Zeitschritte.
   *
   * Die simulierte Zeit wird daraus *berechnet* (`steps * dt`) und nicht
   * aufsummiert. Ein `t += dt` driftet: nach 10000 Schritten von 1 ms liegt die
   * Summe um etwa 1e-12 unter 10 s. Das klingt harmlos, verschiebt aber
   * Eingriffe um einen Schritt und macht Schnappschusszeiten zu Werten wie
   * 0.05000000000000001 - unangenehm bei jedem Vergleich und beim Export.
   * Eine Multiplikation ist nach IEEE-754 korrekt gerundet und damit ebenso
   * deterministisch wie die Addition, nur ohne Akkumulation.
   */
  private steps = 0;

  constructor(scenario: Scenario, options: SimulatorOptions = {}) {
    this.scenario = scenario;
    this.library = new LibraryIndex(scenario.library);
    this.state = createState(scenario.environment);
    this.rng = createRng(scenario.simulation.seed);

    this.registry = options.modules ?? new ModuleRegistry().register(createMechanicsModule());

    this.context = {
      state: this.state,
      dt: scenario.simulation.dt,
      rng: this.rng,
      emit: (event) => {
        this.events.push(event);
      },
    };

    this.timeline = interventionsInOrder(scenario);
  }

  // ------------------------------------------------------------ Entitaeten

  /**
   * Alles am Koerper, was aus Spec und Bibliothek folgt und nicht Zustand ist.
   * Eine Stelle fuer Anlegen und Aendern: sonst rechnete eine geaenderte
   * Kantenlaenge die Masse anders als ein so angelegter Koerper.
   */
  private bodyProperties(spec: Extract<EntitySpec, { kind: "body" }>) {
    const material = this.library.material(spec.materialId);
    const volume = shapeVolume(spec.phase.shape);
    // Masse aus Dichte und Volumen, falls nicht explizit gesetzt - so bleiben
    // Material und Koerper konsistent, und ein Klotz aus Eisen wiegt, was er soll.
    const mass = spec.mass ?? material.mechanical.density * volume;
    if (!(mass > 0)) {
      throw new Error(`Koerper "${spec.id}" haette die Masse ${mass}; Dichte und Volumen pruefen.`);
    }
    const inertiaBody = inertiaTensorFor(spec.phase.shape, mass);
    return {
      materialId: spec.materialId,
      material,
      shape: spec.phase.shape,
      boundingRadius: boundingRadiusFor(spec.phase.shape),
      mass,
      inverseMass: spec.kinematic ? 0 : 1 / mass,
      inertiaBody,
      inverseInertiaBody: spec.kinematic ? invertDiagonal([0, 0, 0, 0, 0, 0, 0, 0, 0]) : invertDiagonal(inertiaBody),
      ...contactProperties(material),
    };
  }

  private createBody(spec: Extract<EntitySpec, { kind: "body" }>): RuntimeBody {
    const body: RuntimeBody = {
      kind: "body",
      id: spec.id,
      name: spec.name ?? this.library.material(spec.materialId).name,
      ...this.bodyProperties(spec),
      kinematic: spec.kinematic,
      mechanics: makeMechanicalState(v3copy(spec.pose.position), q4copy(spec.pose.orientation)),
    };
    v3set(body.mechanics.linearVelocity, ...spec.velocity.linear);
    setAngularVelocity(body, spec.velocity.angular);
    return body;
  }

  /**
   * Material, Stosszahl und Reibwerte einer Ebene. Eine Stelle fuer Anlegen und
   * Aendern, wie `bodyProperties`: nach einem Materialwechsel prallt ein Koerper
   * sonst noch mit der alten Stosszahl ab und rutscht mit der alten Reibung.
   */
  private surfaceMaterial(spec: Extract<EntitySpec, { kind: "constraint" }>) {
    const material = this.library.material(spec.materialId);
    return { materialId: spec.materialId, material, ...contactProperties(material) };
  }

  private createSurface(spec: Extract<EntitySpec, { kind: "constraint" }>): RuntimeSurface {
    const constraint = this.library.constraint(spec.constraintId);
    if (constraint.behaviour.constraintType !== "staticSurface") {
      throw new Error(
        `Randbedingung "${spec.constraintId}" ist vom Typ "${constraint.behaviour.constraintType}". ` +
          `Stufe 1 kennt nur "staticSurface".`,
      );
    }

    // Instanzeigene Groesse: aus dem einen Eintrag "Ebene" lassen sich damit
    // sehr verschiedene Flaechen bauen.
    const localSegments = constraintSegments(constraint, spec, spec.id);
    const position = v3copy(spec.pose.position);
    const orientation = q4copy(spec.pose.orientation);
    return {
      kind: "surface",
      id: spec.id,
      name: spec.name ?? constraint.name,
      constraintId: spec.constraintId,
      constraint,
      localSegments,
      segments: resolveSegments(localSegments, position, orientation),
      position,
      orientation,
      ...this.surfaceMaterial(spec),
    };
  }

  private createLoad(spec: Extract<EntitySpec, { kind: "load" }>): RuntimeLoad {
    const load = this.library.load(spec.loadId);
    return {
      kind: "load",
      id: spec.id,
      name: spec.name ?? load.name,
      loadId: spec.loadId,
      load,
      magnitude: spec.magnitude,
      direction: v3copy(spec.direction),
      gravity: resolveGravity(spec.direction, spec.magnitude),
    };
  }

  private addEntity(spec: EntitySpec): void {
    if (this.state.entities.has(spec.id)) {
      throw new Error(`Entitaet "${spec.id}" existiert bereits im Szenario.`);
    }
    const entity: RuntimeEntity =
      spec.kind === "body"
        ? this.createBody(spec)
        : spec.kind === "constraint"
          ? this.createSurface(spec)
          : this.createLoad(spec);
    this.state.entities.set(spec.id, entity);
    this.specs.set(spec.id, spec);
    this.registry.notifyEntityAdded(entity, this.context);
  }

  private requireEntity(id: string, op: string): RuntimeEntity {
    const entity = this.state.entities.get(id);
    if (!entity) {
      throw new Error(`Eingriff "${op}" verweist auf die unbekannte Entitaet "${id}".`);
    }
    return entity;
  }

  // ------------------------------------------------------------ Eingriffe

  /**
   * Wendet einen Eingriff an. Das ist die einzige Stelle, an der der Zustand
   * von aussen veraendert wird - alles andere laeuft ueber die Module.
   */
  private applyIntervention(intervention: Intervention): void {
    switch (intervention.op) {
      case "add": {
        // Mit den Aenderungen bis jetzt: ein wieder eingefuegtes Objekt behaelt
        // seine geaenderte Groesse, sein Material, seine Opazitaet.
        const spec = entitySpecAt(this.scenario, intervention.entityId, intervention.t);
        if (!spec) {
          throw new Error(
            `Eingriff "add" verweist auf die unbekannte Entitaet "${intervention.entityId}".`,
          );
        }
        this.addEntity(spec);
        return;
      }

      case "remove":
        this.requireEntity(intervention.entityId, "remove");
        this.state.entities.delete(intervention.entityId);
        this.specs.delete(intervention.entityId);
        return;

      case "change": {
        const entity = this.requireEntity(intervention.entityId, "change");
        this.applyChange(entity, intervention.change);
        return;
      }

      case "setEnvironment":
        // Teilweise Aenderung: nur die genannten Felder werden ueberschrieben,
        // damit ein Eingriff die Schwerkraft aendern kann, ohne die
        // Umgebungstemperatur zu loeschen.
        Object.assign(this.state.environment, stripUndefined(intervention.environment));
        return;
    }
  }

  /**
   * Setzt eine Eigenschaft einer Entitaet in der Szene.
   *
   * Zustandsgroessen eines Koerpers gehen direkt in die Mechanik; alles andere
   * laeuft ueber die Spec (`applyEntityChange`, dieselbe Faltung wie
   * `entitySpecAt`), aus der die abhaengigen Laufzeitwerte neu entstehen. Die
   * Mechanik eines Koerpers bleibt dabei stehen: ein Materialwechsel aendert
   * die Masse, nicht die Geschwindigkeit, und der Drehimpuls bleibt erhalten.
   */
  private applyChange(entity: RuntimeEntity, change: EntityChange): void {
    const previous = this.specs.get(entity.id)!;
    const spec = applyEntityChange(previous, change);
    this.specs.set(entity.id, spec);

    if (entity.kind === "body" && spec.kind === "body") {
      const mechanics = entity.mechanics;
      switch (change.key) {
        case "position":
          v3set(mechanics.position, ...change.value);
          return;
        case "orientation":
          mechanics.orientation[0] = change.value[0];
          mechanics.orientation[1] = change.value[1];
          mechanics.orientation[2] = change.value[2];
          mechanics.orientation[3] = change.value[3];
          // Gedreht wird der Koerper, nicht sein Drehimpuls: die Winkel-
          // geschwindigkeit folgt aus dem Traegheitstensor in der neuen Lage.
          refreshDerivedState(entity);
          return;
        case "linearVelocity":
          v3set(mechanics.linearVelocity, ...change.value);
          return;
        case "angularVelocity":
          setAngularVelocity(entity, change.value);
          return;
        default:
          Object.assign(entity, this.bodyProperties(spec));
          refreshDerivedState(entity);
          return;
      }
    }

    if (entity.kind === "surface" && spec.kind === "constraint") {
      v3set(entity.position, ...spec.pose.position);
      for (let i = 0; i < 4; i += 1) entity.orientation[i] = spec.pose.orientation[i]!;
      entity.localSegments = constraintSegments(entity.constraint, spec, spec.id);
      // Flaechen sind unbeweglich, aber verschiebbar: nach einer
      // Lageaenderung muessen die Weltkoordinaten der Segmente neu
      // berechnet werden, sonst kollidiert der Koerper mit der alten Lage.
      entity.segments = resolveSegments(entity.localSegments, entity.position, entity.orientation);
      Object.assign(entity, this.surfaceMaterial(spec));
      return;
    }

    if (entity.kind === "load" && spec.kind === "load") {
      entity.magnitude = spec.magnitude;
      entity.direction = v3copy(spec.direction);
      entity.gravity = resolveGravity(spec.direction, spec.magnitude);
    }
  }

  /**
   * Wendet alle Eingriffe an, deren Zeit erreicht ist.
   *
   * Ein Eingriff, dessen Zeit zwischen zwei Schritten liegt, gilt am naechst-
   * gelegenen Schritt (Toleranz dt/2). Eingriffe hinter der Gesamtdauer werden
   * nie erreicht und bleiben damit wirkungslos, ohne dass sie jemand loeschen
   * muesste.
   */
  private applyDueInterventions(): void {
    while (this.dueInterventionTime() !== undefined) {
      this.applyIntervention(this.timeline[this.nextInterventionIndex]!);
      this.nextInterventionIndex += 1;
    }
  }

  /** Zeit des naechsten Eingriffs, falls er in diesem Schritt faellig ist. */
  private dueInterventionTime(): number | undefined {
    const intervention = this.timeline[this.nextInterventionIndex];
    if (!intervention) return undefined;
    return intervention.t > this.state.t + this.scenario.simulation.dt * 0.5 ? undefined : intervention.t;
  }

  // ------------------------------------------------------------ Lauf

  private snapshot(t = this.state.t): Snapshot {
    const entities: Snapshot["entities"] = {};
    for (const entity of this.state.entities.values()) {
      if (entity.kind !== "body") continue;
      const mechanics = entity.mechanics;
      entities[entity.id] = {
        mechanics: {
          position: [...mechanics.position],
          orientation: [...mechanics.orientation],
          linearVelocity: [...mechanics.linearVelocity],
          angularVelocity: [...mechanics.angularVelocity],
          force: [...mechanics.force],
          acceleration: [...mechanics.acceleration],
          contactCount: mechanics.contactCount,
        },
      };
    }
    return { t, entities };
  }

  /** Ein Zeitschritt: die Phasen der Pipeline in fester Reihenfolge. */
  step(): void {
    this.applyDueInterventions();
    this.registry.runPhase("accumulate", this.context);
    this.registry.runPhase("integrate", this.context);
    this.registry.runPhase("contacts", this.context);
    this.registry.runPhase("exchange", this.context);
    this.registry.runPhase("transform", this.context);
    this.steps += 1;
    this.state.t = this.steps * this.context.dt;
  }

  /**
   * Fuehrt das Szenario aus und gibt die Aufzeichnung zurueck.
   *
   * Schnappschuesse entstehen in festen Abstaenden der *simulierten* Zeit, nicht
   * jeden Zeitschritt: bei dt = 1 ms und 20 Hz Aufzeichnungsrate ist das jeder
   * fuenfzigste Schritt. Die Aufzeichnung bleibt damit klein, waehrend die
   * Physik fein genug rechnet.
   */
  run(): Recording {
    const { dt, recordRate, seed } = this.scenario.simulation;
    const totalSteps = Math.round(this.scenario.duration / dt);
    const stepsPerSnapshot = Math.max(1, Math.round(1 / (recordRate * dt)));
    const snapshots: Snapshot[] = [];

    // Erster Schnappschuss nach den Eingriffen bei t = 0, damit er den
    // Anfangszustand zeigt und nicht eine leere Szene.
    this.applyDueInterventions();
    this.registry.runPhase("accumulate", this.context);
    snapshots.push(this.snapshot());

    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
      this.recordInterventions(snapshots);
      this.step();
      if ((stepIndex + 1) % stepsPerSnapshot === 0) {
        snapshots.push(this.snapshot());
      }
    }

    return {
      schemaVersion: 1,
      scenario: this.scenario,
      seed,
      dt,
      recordRate,
      snapshots,
      events: this.events,
    };
  }

  /**
   * Haelt einen faelligen Eingriff als Paar von Schnappschuessen mit derselben
   * Zeit fest: Stand davor, Stand danach.
   *
   * Ohne das Paar zeigte die Wiedergabe einen Eingriff erst am naechsten
   * regulaeren Schnappschuss - bei 20 Hz bis zu 50 ms zu spaet. Ein Objekt,
   * das zur Zeit des Zeitcursors eingefuegt wird, waere am Cursor unsichtbar,
   * ein entferntes verschwaende schon vorher. `snapshotAt` waehlt bei gleicher
   * Zeit den spaeteren Schnappschuss, am Eingriff selbst gilt also der Stand
   * danach.
   *
   * Gestempelt wird mit der Zeit des Eingriffs, nicht mit der des Schritts:
   * geht dt nicht in der Eingriffszeit auf, liegt der Schritt bis zu dt/2
   * dahinter, und ein Cursor genau auf der Eingriffszeit saehe wieder den
   * Stand davor. Der Unterschied im Zustand ist kleiner als ein Zeitschritt.
   *
   * Kein `accumulate` vor dem Stand danach: es setzte die Kontaktzahl der
   * vorhandenen Koerper zurueck, und dieser Schnappschuss zeigte sie
   * faelschlich ohne Kontakt. Ein neuer Koerper traegt deshalb hier noch
   * Kraft null; ab dem naechsten Schnappschuss stimmt sie.
   */
  private recordInterventions(snapshots: Snapshot[]): void {
    const at = this.dueInterventionTime();
    if (at === undefined) return;
    const last = snapshots[snapshots.length - 1]!;
    // Der letzte Schnappschuss zeigt den Stand vor dem Eingriff schon; liegt er
    // durch das Stempeln auf der Eingriffszeit sogar dahinter, wird er auf sie
    // vorgezogen, damit die Zeiten nicht rueckwaerts laufen.
    if (last.t >= at) last.t = at;
    else snapshots.push(this.snapshot(at));
    this.applyDueInterventions();
    snapshots.push(this.snapshot(at));
  }
}

function stripUndefined(partial: Partial<Environment>): Partial<Environment> {
  const result: Partial<Environment> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** Bequemer Einstieg: Szenario rein, Aufzeichnung raus. */
export function runScenario(scenario: Scenario, options?: SimulatorOptions): Recording {
  return new Simulator(scenario, options).run();
}
