import { useEffect, useRef, useState } from "react";
import { MAX_DURATION, type EntitySpec, type Scenario, type Vec3 } from "@sandbox/schema";
import {
  INTERVENTION_TIME_STEP,
  isEntityPresent,
  listEntities,
  listInterventions,
  roundInterventionTime,
  sameTime,
  timeRelation,
} from "../scenarioEdits.js";
import { CommittedNumber, formatSeconds } from "./CommittedNumber.js";
import {
  changePropertiesOf,
  changeRowsOf,
  describeIntervention,
  ENTITY_CLASS_LABELS,
  entityClassOf,
  propertyGroupsOf,
  type EntityProperty,
} from "../entityProperties.js";
import { ClassIcon, hasClassIcon } from "./ClassIcon.js";

/**
 * Der rechte Bereich: die Entitaeten der Szene, nach ihrer Klasse getrennt,
 * und die Eingriffe als eigene Liste.
 *
 * **Die Gliederung folgt dem Datenmodell.** Eine Entitaet ist entweder eine
 * Randbedingung, ein Koerper oder eine Last; je eine Ueberschrift, in dieser
 * Reihenfolge. Eine gemeinsame Liste "Objekte" gab es frueher und sie war
 * irrefuehrend: "Objekt" ist kein Begriff des Modells, sondern Sammelname
 * fuer fuenf verschiedene Dinge mit verschiedenen Feldern (siehe Glossar).
 *
 * **Entitaeten gehoeren dem Szenario, nicht einem Zeitpunkt.** Deshalb je eine
 * einzige Liste; wann eine Entitaet erscheint, steht als Eingriff
 * ("hinzufügen") in der Eingriffsliste.
 *
 * **Jede Entitaet wird gleich dargestellt**: Kopfzeile, darunter ihre
 * Eigenschaften. Welche das sind, in welcher Gruppe und in welcher Form,
 * steht nicht hier, sondern in `entityProperties.ts` - hier wird nur je
 * Eigenschaftstyp eine Zeile gezeichnet.
 *
 * Die **Eingriffsliste** enthaelt alle Eingriffe, auch das Hinzufuegen einer
 * Entitaet: dort steht, wann sie erscheint. Neue Eingriffe entstehen nur dort,
 * im Steuerelement unter der Liste (Objekt, Art), und immer zur Zeit des
 * Zeitcursors - nicht am Objekt. Ein `add` aus der Liste zu loeschen loescht
 * das Objekt nicht, es bleibt in seiner Liste und ist dann nie in der Szene.
 *
 * Ein "Ändern"-Eingriff klappt in der Liste auf wie eine Entitaet: darunter die
 * Wahl der Eigenschaft und ihr Wert, gezeichnet mit derselben `PropertyRow`
 * wie die Startwerte (`changeRowsOf`).
 */

export interface InspectorPanelProps {
  scenario: Scenario;
  /** Zeitcursor (Spiegel) - dort entsteht ein neuer Eingriff. */
  t: number;
  /** Waehrend der Wiedergabe: kein neuer Eingriff, der Zeitcursor steht nicht still. */
  locked: boolean;
  /** Das aktive Objekt: aufgeklappt in dieser Leiste, hervorgehoben im Viewport. */
  activeEntityId: string | undefined;
  onActivate(entityId: string | undefined): void;
  onRename(entityId: string, name: string): void;
  /** Eine Bearbeitung des Szenarios - App reicht sie an `apply` weiter. */
  onEdit(change: (scenario: Scenario) => Scenario): void;
  onDeleteEntity(entityId: string): void;
  /** Legt den Eingriff zur Zeit des Zeitcursors an - die Zeit setzt App. */
  onAddIntervention(entityId: string, kind: InterventionKind): void;
  /** `index` ist die Position in `Scenario.interventions`. */
  onRemoveIntervention(index: number): void;
  onInterventionTime(index: number, t: number): void;
}

/** Was das Steuerelement unter "Eingriffe" anlegen kann. */
export type InterventionKind = "add" | "remove" | "change";

/**
 * Welcher "Ändern"-Eingriff aufgeklappt ist: Objekt, Zeit und die wievielte
 * Aenderung dieses Objekts zu dieser Zeit (`"letzte"`, bis sie gefunden ist).
 *
 * Nicht der Index in `Scenario.interventions`: der verschiebt sich, sobald
 * davor etwas eingefuegt oder umsortiert wird. Und nicht der Schluessel: der
 * aendert sich, wenn die Eigenschaft gewechselt wird, und der Eintrag klappte
 * mitten in der Bearbeitung zu.
 */
interface OpenChange {
  entityId: string;
  t: number;
  ordinal: number | "letzte";
}

/** Indizes der "Ändern"-Eingriffe eines Objekts zu einer Zeit, in Listenreihenfolge. */
function changesAt(scenario: Scenario, entityId: string, t: number): number[] {
  const indices: number[] = [];
  scenario.interventions.forEach((intervention, index) => {
    if (intervention.op === "change" && intervention.entityId === entityId && sameTime(intervention.t, t)) {
      indices.push(index);
    }
  });
  return indices;
}

function openIndex(scenario: Scenario, open: OpenChange | undefined): number | undefined {
  if (!open) return undefined;
  const indices = changesAt(scenario, open.entityId, open.t);
  return open.ordinal === "letzte" ? indices.at(-1) : indices[open.ordinal];
}

/** Die Kennung eines "Ändern"-Eingriffs fuer `OpenChange`. */
function changeIdentity(scenario: Scenario, index: number): OpenChange | undefined {
  const intervention = scenario.interventions[index];
  if (!intervention || intervention.op !== "change") return undefined;
  const indices = changesAt(scenario, intervention.entityId, intervention.t);
  return { entityId: intervention.entityId, t: intervention.t, ordinal: indices.indexOf(index) };
}

/** Zahlenfeld, das erst mit Enter oder beim Verlassen uebernimmt. */
function NumberField({
  value,
  step = 0.1,
  min,
  max,
  ariaLabel,
  placeholder,
  disabled,
  onCommit,
}: {
  value: number | undefined;
  step?: number;
  min?: number;
  max?: number;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit(value: number | undefined): void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <input
      type="number"
      className="zahlenfeld"
      value={draft}
      step={step}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      {...(placeholder ? { placeholder } : {})}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          (event.target as HTMLInputElement).blur();
        }
        if (event.key === "Escape") setDraft(value === undefined ? "" : String(value));
      }}
    />
  );
}

/** Die Einheit steht in jeder Zeile in derselben Spalte, auch wenn sie leer ist. */
function Unit({ unit }: { unit: string }) {
  return <span className={unit === "°" ? "einheit einheit-grad" : "einheit"}>{unit}</span>;
}

/** Zahl fuer die Anzeige: ohne Rundungsrauschen aus der Umrechnung. */
function shown(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Eine Eigenschaft als Zeile. Alle Typen liegen auf demselben Spaltenraster
 * (siehe `.eigenschaft` in styles.css), damit Felder und Einheiten ueber alle
 * Zeilen hinweg untereinander stehen.
 */
function PropertyRow({
  scenario,
  spec,
  property,
  onEdit,
}: {
  scenario: Scenario;
  spec: EntitySpec;
  property: EntityProperty;
  onEdit(change: (scenario: Scenario) => Scenario): void;
}) {
  const ariaLabel = `${property.label} von ${spec.name ?? spec.id}`;
  const name = <span className="eigenschaft-name">{property.label}</span>;

  switch (property.type) {
    case "vector3": {
      const value = property.get(scenario, spec);
      const set = (axis: number, next: number | undefined): void => {
        if (next === undefined) return;
        const updated: Vec3 = [value[0], value[1], value[2]];
        updated[axis] = next;
        onEdit((current) => property.set(current, spec.id, updated));
      };
      return (
        <div className="eigenschaft">
          {name}
          {(["x", "y", "z"] as const).map((axis, index) => (
            <label key={axis} className={`achse achse-${axis} spalte-${index + 1}`}>
              <span>{axis}</span>
              <NumberField
                value={shown(value[index]!)}
                step={property.step}
                ariaLabel={`${ariaLabel} ${axis}`}
                onCommit={(next) => set(index, next)}
              />
            </label>
          ))}
          <Unit unit={property.unit} />
        </div>
      );
    }
    case "vector2": {
      const value = property.get(scenario, spec);
      const set = (axis: number, next: number | undefined): void => {
        if (next === undefined) return;
        const updated: [number, number] = [value[0], value[1]];
        updated[axis] = next;
        onEdit((current) => property.set(current, spec.id, updated));
      };
      // Rechtsbuendig: die beiden Felder stehen unter y und z eines 3D-Vektors.
      return (
        <div className="eigenschaft">
          {name}
          {property.axes.map((axis, index) => (
            <label key={axis} className={`achse spalte-${index + 2}`}>
              <span>{axis}</span>
              <NumberField
                value={shown(value[index]!)}
                step={property.step}
                {...(property.min !== undefined ? { min: property.min } : {})}
                ariaLabel={`${ariaLabel} ${axis}`}
                onCommit={(next) => set(index, next)}
              />
            </label>
          ))}
          <Unit unit={property.unit} />
        </div>
      );
    }
    case "percent": {
      const percent = Math.round(property.get(scenario, spec) * 100);
      const commit = (next: number): void =>
        onEdit((current) => property.set(current, spec.id, Math.min(Math.max(next, 0), 100) / 100));
      return (
        <div className="eigenschaft">
          {name}
          {/* Regler und Feld lesen beide den Wert aus dem Szenario: keiner hat einen
              eigenen Zustand, der Rueckgabewert des einen ist die Eingabe des anderen. */}
          <input
            type="range"
            className="regler"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-label={`${ariaLabel} (Regler)`}
            onChange={(event) => commit(Number(event.target.value))}
          />
          <NumberField
            value={percent}
            step={property.step}
            min={0}
            max={100}
            ariaLabel={ariaLabel}
            onCommit={(next) => next !== undefined && commit(next)}
          />
          <Unit unit="%" />
        </div>
      );
    }
    case "choice":
      // Die Einheitenspalte bleibt frei; das Auswahlfeld reicht bis an sie heran.
      return (
        <div className="eigenschaft">
          {name}
          <select
            className="auswahlfeld"
            value={property.get(scenario, spec)}
            aria-label={ariaLabel}
            onChange={(event) => {
              const next = event.target.value;
              onEdit((current) => property.set(current, spec.id, next));
            }}
          >
            {property.options(scenario, spec).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "number":
      return (
        <div className="eigenschaft">
          {name}
          <NumberField
            value={shown(property.get(scenario, spec))}
            step={property.step}
            {...(property.min !== undefined ? { min: property.min } : {})}
            ariaLabel={ariaLabel}
            onCommit={(next) =>
              next !== undefined && onEdit((current) => property.set(current, spec.id, next))
            }
          />
          <Unit unit={property.unit} />
        </div>
      );
  }
}

function TextField({
  value,
  ariaLabel,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      className="namensfeld"
      value={draft}
      aria-label={ariaLabel}
      // Umbenennen ist kein Aktivieren: der Klick ins Feld erreicht den Eintrag nicht.
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== "" && draft !== value) onCommit(draft);
        else setDraft(value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

export function InspectorPanel({
  scenario,
  t,
  locked,
  activeEntityId,
  onActivate,
  onRename,
  onEdit,
  onDeleteEntity,
  onAddIntervention,
  onRemoveIntervention,
  onInterventionTime,
}: InspectorPanelProps) {
  const allEntities = listEntities(scenario);
  const constraintEntities = allEntities.filter((entry) => entry.spec.kind === "constraint");
  const bodyEntities = allEntities.filter((entry) => entry.spec.kind === "body");
  const loadEntities = allEntities.filter((entry) => entry.spec.kind === "load");
  const interventions = listInterventions(scenario);
  // Aufgeklappt ist genau das aktive Objekt - kein eigener Zustand, sonst liefen
  // Leiste und Viewport auseinander.
  const expanded = activeEntityId;
  const panelRef = useRef<HTMLElement>(null);
  // Wurde das Objekt im Viewport angeklickt, soll sein Eintrag sichtbar werden.
  useEffect(() => {
    if (activeEntityId === undefined) return;
    const items = panelRef.current?.querySelectorAll<HTMLElement>("[data-entitaet]");
    items?.forEach((item) => {
      if (item.dataset.entitaet === activeEntityId) item.scrollIntoView({ block: "nearest" });
    });
  }, [activeEntityId]);

  // Steuerelement "Eingriff anlegen": jede Auswahl ist ein Vorschlag, bis die
  // Benutzerin sie ueberschreibt. Das Objekt folgt der Auswahl im Studio, die
  // Art dem Zustand des Objekts am Zeitcursor.
  const [pickedEntity, setPickedEntity] = useState<string | undefined>(undefined);
  const [pickedKind, setPickedKind] = useState<InterventionKind | undefined>(undefined);
  useEffect(() => setPickedEntity(undefined), [expanded]);

  const [openChange, setOpenChange] = useState<OpenChange | undefined>(undefined);
  const openChangeIndex = openIndex(scenario, openChange);
  // "letzte" gilt nur bis zum ersten Treffer; danach festhalten, sonst wanderte
  // die Auswahl mit jedem spaeter angelegten Eingriff derselben Zeit mit.
  useEffect(() => {
    if (openChange?.ordinal !== "letzte" || openChangeIndex === undefined) return;
    setOpenChange(changeIdentity(scenario, openChangeIndex));
  }, [scenario, openChange, openChangeIndex]);

  const entityChoice =
    pickedEntity !== undefined && allEntities.some(({ spec }) => spec.id === pickedEntity)
      ? pickedEntity
      : allEntities.some(({ spec }) => spec.id === expanded)
        ? (expanded ?? "")
        : "";
  const chosenSpec = allEntities.find(({ spec }) => spec.id === entityChoice)?.spec;
  // Der neue Eingriff setzt auf dem Zustand am Zeitcursor auf - gerundet wie
  // der Eingriff selbst: ein Objekt, das dort da ist, kann nur entfernt (oder
  // angehalten) werden, eines, das dort fehlt, nur hinzugefuegt.
  const cursorTime = roundInterventionTime(Math.min(Math.max(t, 0), MAX_DURATION));
  const presentAtCursor =
    chosenSpec !== undefined && isEntityPresent(scenario, chosenSpec.id, cursorTime);
  const kindAllowed: Record<InterventionKind, boolean> = {
    add: !presentAtCursor,
    remove: presentAtCursor,
    change: presentAtCursor && changePropertiesOf(scenario, chosenSpec).length > 0,
  };
  const kindChoice: InterventionKind =
    pickedKind !== undefined && kindAllowed[pickedKind]
      ? pickedKind
      : presentAtCursor
        ? "remove"
        : "add";

  /** Kopfzeile mit Klassen-Icon, Name und Loeschknopf - fuer jede Klasse gleich. */
  const header = (spec: EntitySpec, deleteTitle: string) => {
    const entityClass = entityClassOf(scenario, spec);
    return (
      <div className="entitaet-kopf">
        {/* Die Ueberschrift nennt schon die Oberklasse; das Icon zeigt die
            speziellste. Hat sie noch keines, steht ihr Name dort. */}
        {hasClassIcon(entityClass) ? (
          <ClassIcon entityClass={entityClass} withTitle />
        ) : (
          <span className="entitaet-art">{ENTITY_CLASS_LABELS[entityClass]}</span>
        )}
        <TextField
          value={spec.name ?? spec.id}
          ariaLabel={`Name von ${spec.id}`}
          onCommit={(name) => onRename(spec.id, name)}
        />
        <button
          type="button"
          className="loeschen"
          onClick={(event) => {
            // Sonst aktivierte der Klick danach noch den Eintrag, den es nicht mehr gibt.
            event.stopPropagation();
            onDeleteEntity(spec.id);
          }}
          title={deleteTitle}
        >
          ×
        </button>
      </div>
    );
  };

  /** Eine Entitaet jeder Klasse: Kopfzeile, aufgeklappt ihre Eigenschaften in Gruppen. */
  const entityItem = ({ spec }: (typeof allEntities)[number]) => {
    const open = expanded === spec.id;
    const deleteTitle =
      spec.kind === "constraint"
        ? "Randbedingung ganz aus dem Szenario löschen"
        : spec.kind === "body"
          ? "Körper ganz aus dem Szenario löschen"
          : "Last ganz aus dem Szenario löschen";
    return (
      // Ein Klick irgendwo auf den Eintrag aktiviert ihn. Kein Umschalten: sonst
      // klappte jeder Klick in die Eigenschaften den Eintrag wieder zu.
      <li
        key={spec.id}
        data-entitaet={spec.id}
        className={open ? "offen" : undefined}
        onClick={() => {
          if (!open) onActivate(spec.id);
        }}
      >
        {header(spec, deleteTitle)}

        {open && (
          <div className="eigenschaften">
            {propertyGroupsOf(scenario, spec).map(({ group, properties }) => (
              <div key={group} className="eigenschaftsgruppe">
                {properties.map((property) => (
                  <PropertyRow
                    key={property.id}
                    scenario={scenario}
                    spec={spec}
                    property={property}
                    onEdit={onEdit}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="panel" ref={panelRef}>
      <h2>Randbedingungen</h2>
      {constraintEntities.length === 0 ? (
        <p className="hinweis">
          Noch keine Randbedingungen in der Szene. Eine Randbedingung aus der Bibliothek wählen und
          in die Szene klicken.
        </p>
      ) : (
        <ul className="entitaetenliste">{constraintEntities.map(entityItem)}</ul>
      )}

      <h2>Körper</h2>
      {bodyEntities.length === 0 ? (
        <p className="hinweis">
          Noch keine Körper in der Szene. Einen Körper aus der Bibliothek wählen und in die Szene
          klicken.
        </p>
      ) : (
        <ul className="entitaetenliste">{bodyEntities.map(entityItem)}</ul>
      )}

      <h2>Lasten</h2>
      {loadEntities.length === 0 ? (
        <p className="hinweis">
          Noch keine Lasten in der Szene. Eine Last aus der Bibliothek wählen, um sie hinzuzufügen.
        </p>
      ) : (
        <ul className="entitaetenliste">{loadEntities.map(entityItem)}</ul>
      )}

      <h2>Eingriffe</h2>
      {interventions.length === 0 ? (
        <p className="hinweis">Keine Eingriffe.</p>
      ) : (
        <ul className="eingriffsliste">
          {interventions.map((entry) => {
            const changeable = entry.intervention.op === "change";
            const open = changeable && entry.index === openChangeIndex;
            const rows = open ? changeRowsOf(scenario, entry.index) : undefined;
            const className = [
              entry.effective ? undefined : "unwirksam",
              changeable ? "aenderbar" : undefined,
              open ? "offen" : undefined,
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li key={entry.index} className={className || undefined}>
                <div className="eingriff-kopf">
                  <span className={`eingriff-zeit ${timeRelation(entry.intervention.t, cursorTime)}`}>
                    <CommittedNumber
                      value={entry.intervention.t}
                      min={0}
                      max={MAX_DURATION}
                      step={INTERVENTION_TIME_STEP}
                      format={formatSeconds}
                      ariaLabel={`Zeit von „${describeIntervention(scenario, entry.intervention)}“`}
                      unit="s"
                      onCommit={(time) => {
                        // Der Eingriff wandert hinter die Eingriffe der neuen Zeit;
                        // aufgeklappt bleibt er, wenn er dort ankommt.
                        if (open) {
                          setOpenChange({
                            entityId: openChange!.entityId,
                            t: roundInterventionTime(time),
                            ordinal: "letzte",
                          });
                        }
                        onInterventionTime(entry.index, time);
                      }}
                    />
                  </span>
                  <span
                    className="eingriff-text"
                    onClick={
                      changeable
                        ? () => setOpenChange(open ? undefined : changeIdentity(scenario, entry.index))
                        : undefined
                    }
                  >
                    {describeIntervention(scenario, entry.intervention)}
                  </span>
                  <button
                    type="button"
                    className="loeschen"
                    onClick={() => {
                      if (open) setOpenChange(undefined);
                      onRemoveIntervention(entry.index);
                    }}
                    title="Eingriff entfernen"
                  >
                    ×
                  </button>
                </div>
                {rows && (
                  <div className="eigenschaften">
                    <div className="eigenschaftsgruppe">
                      {rows.rows.map((property) => (
                        <PropertyRow
                          key={property.id}
                          scenario={scenario}
                          spec={rows.spec}
                          property={property}
                          onEdit={onEdit}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {allEntities.length > 0 && (
        <div className="eingriff-anlegen">
          <label>
            Objekt
            <select value={entityChoice} onChange={(event) => setPickedEntity(event.target.value)}>
              <option value="" hidden />
              {allEntities.map(({ spec }) => (
                <option key={spec.id} value={spec.id}>
                  {spec.name ?? spec.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Eingriffsart
            <select
              value={kindChoice}
              onChange={(event) => setPickedKind(event.target.value as InterventionKind)}
            >
              <option value="add" disabled={!kindAllowed.add}>
                Hinzufügen
              </option>
              <option value="remove" disabled={!kindAllowed.remove}>
                Entfernen
              </option>
              <option value="change" disabled={!kindAllowed.change}>
                Ändern
              </option>
            </select>
          </label>
          <button
            type="button"
            className="icon-knopf plus-knopf"
            disabled={chosenSpec === undefined || locked}
            onClick={() => {
              // Ein neuer "Ändern"-Eingriff steht hinter denen seiner Zeit und
              // klappt gleich auf - ohne Wert waere er nur ein Platzhalter.
              if (kindChoice === "change") {
                setOpenChange({ entityId: entityChoice, t: cursorTime, ordinal: "letzte" });
              }
              onAddIntervention(entityChoice, kindChoice);
            }}
            aria-label="Eingriff anlegen"
          >
            +
          </button>
        </div>
      )}
    </section>
  );
}
