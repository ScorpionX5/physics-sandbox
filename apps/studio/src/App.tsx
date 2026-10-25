import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyScenario,
  createInclinedPlaneScenario,
  type Scenario,
  type ViewLayer,
} from "@sandbox/schema";
import { runScenario } from "@sandbox/core";
import { directionAt } from "@sandbox/render";

import { InspectorPanel } from "./components/InspectorPanel.js";
import { LibraryPanel } from "./components/LibraryPanel.js";
import { Timeline } from "./components/Timeline.js";
import { ViewToolbar } from "./components/ViewToolbar.js";
import { Viewport, type ViewportHandle } from "./components/Viewport.js";
import { downloadScenario, fetchStoredScenario, openScenarioFile } from "./scenarioFile.js";
import {
  addChangeAt,
  addConstraint,
  addBody,
  addLibraryEntry,
  addLoad,
  addEntityAt,
  deleteEntity,
  orientationFromNormal,
  removeEntityAt,
  removeIntervention,
  renameEntity,
  renameScenario,
  roundInterventionTime,
  setAxesVisible,
  setInterventionTime,
  setTotalDuration,
  setViewCamera,
  setViewLayer,
} from "./scenarioEdits.js";

/**
 * Die Sandbox-Oberflaeche.
 *
 * Der Aufbau spiegelt die Architektur: **das Szenario ist die Quelle der
 * Wahrheit, die Aufzeichnung ist daraus abgeleitet.** Jede Bearbeitung erzeugt
 * ein neues Szenario, und ein `useMemo` laesst es durch den Simulationskern
 * laufen. Es gibt keinen Zustand, der "simuliert" heisst und veralten koennte.
 *
 * Der Lauf findet im Browser statt - `@sandbox/core` hat keine
 * Grafik-Abhaengigkeit und wird mitgebundelt. Ein Klick auf Play braucht
 * deshalb keinen Netzaufruf; der Dienst wird nur fuer den Bibliothekar
 * gebraucht.
 */

const AVAILABLE_LAYERS: ViewLayer[] = ["macroscopic", "kinematic", "atomic"];

interface Notice {
  kind: "info" | "error";
  text: string;
}

/** Der Wert von `?szenario=`: "durchstich" oder die Kennung eines abgelegten Szenarios. */
function requestedScenario(): string | null {
  return new URLSearchParams(globalThis.location?.search ?? "").get("szenario");
}

/**
 * Das Startszenario ist leer. Das Durchstich-Szenario liegt im Quellcode und
 * ist zum Pruefen ueber `?szenario=durchstich` erreichbar - bequem fuer die
 * Entwicklung, ohne dass jeder Start mit einem Beispiel beginnt, das man erst
 * wegraeumen muss. Jede andere Kennung ist ein abgelegtes Szenario; das kommt
 * aus dem Netz und wird deshalb erst nach dem ersten Bild geladen (Effekt in `App`).
 */
function initialScenario(): Scenario {
  return requestedScenario() === "durchstich" ? createInclinedPlaneScenario() : createEmptyScenario();
}

export function App() {
  // Quelle der Wahrheit. Geaendert wird nur ueber `apply` mit einer Funktion
  // aus scenarioEdits.ts - niemals durch Mutieren des Objekts.
  const [scenario, setScenario] = useState<Scenario>(initialScenario);
  // Ebene und Achsen stehen im Szenario (`view`); ein Effekt in Viewport
  // schiebt sie in den Betrachter. (Nur bei `followDirection: true` duerfte der
  // Betrachter die Ebene selbst wechseln - das Studio setzt die Option deshalb
  // nicht.)
  const { layer, showAxes } = scenario.view;
  // ACHTUNG, Spiegel: die Abspielzeit lebt im `Playhead` des Betrachters
  // (packages/render/src/playback.ts) und wird hier nur zur Anzeige
  // mitgefuehrt - `onTime` setzt sie in jedem Bild neu. `setT(...)` aendert
  // deshalb nichts am Abspielen; dafuer ist `viewport.current?.seek(...)` da.
  // Siehe docs/aenderungsleitfaden.md, Abschnitt "Die Zeit".
  const [t, setT] = useState(0);
  // Ebenfalls Spiegel von `Playhead.isPlaying`.
  const [isPlaying, setIsPlaying] = useState(false);
  // Das aktive Objekt: die Wahrheit fuer "aufgeklappt" in der rechten Leiste und
  // "hervorgehoben" im Viewport. Beide sind Spiegel und setzen es nur ueber
  // `setActiveEntityId`.
  const [activeEntityId, setActiveEntityId] = useState<string | undefined>(undefined);
  const [placing, setPlacing] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // Zaehlt bei jedem Laden/Zuruecksetzen hoch, damit der Viewport zwischen
  // "neues Szenario" (Zeit auf 0) und "Bearbeitung" (Zeit erhalten) unterscheiden kann.
  const [resetToken, setResetToken] = useState(0);

  // Ein neuer Eingriff entsteht zur Zeit des Zeitcursors. Waehrend der
  // Wiedergabe steht der nicht still - ein angefangenes Platzieren endet deshalb
  // mit dem Start.
  useEffect(() => {
    if (isPlaying) setPlacing(undefined);
  }, [isPlaying]);

  const viewport = useRef<ViewportHandle>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  // Meldungen (Fehler wie Erfolg) verschwinden, wenn woanders hingeklickt
  // wird - wie bei der Namens-Fehlermeldung, die bisher nur zufaellig durch
  // den Rename-`onBlur` verschwand. `runError` bleibt davon unberuehrt: er
  // zeigt einen echten, fortbestehenden Zustand und laesst sich nicht
  // weg­klicken.
  useEffect(() => {
    if (!notice) return;
    const dismissOnOutsideClick = (event: MouseEvent) => {
      if (noticeRef.current?.contains(event.target as Node)) return;
      setNotice(undefined);
    };
    document.addEventListener("click", dismissOnOutsideClick);
    return () => document.removeEventListener("click", dismissOnOutsideClick);
  }, [notice]);

  /**
   * Die Aufzeichnung ist eine reine Ableitung des Szenarios. Scheitert der
   * Lauf, bleibt die letzte brauchbare Aufzeichnung stehen und der Fehler wird
   * angezeigt - ein leerer Viewport waere eine schlechtere Antwort auf einen
   * Bearbeitungsfehler.
   */
  const lastGood = useRef(runScenario(createEmptyScenario()));
  const { recording, runError } = useMemo(() => {
    try {
      const fresh = runScenario(scenario);
      lastGood.current = fresh;
      return { recording: fresh, runError: undefined };
    } catch (error) {
      return { recording: lastGood.current, runError: (error as Error).message };
    }
  }, [scenario]);

  const direction = useMemo(() => directionAt(recording, t), [recording, t]);

  /**
   * Wendet eine Bearbeitung an und zeigt ihre Fehlermeldung, statt sie zu verschlucken.
   *
   * `interventionAt` ist die Zeit, zu der die Bearbeitung einen Eingriff
   * anlegt. Der Eingriff liegt auf der gerundeten Zeit, die auch hinter dem
   * Zeitcursor liegen kann (1,236 s -> 1,24 s); dann zeigte der Cursor den Stand
   * davor, und das neue Objekt waere unsichtbar. Der Cursor wandert deshalb auf
   * dieselbe gerundete Zeit. Nur bei Erfolg: ein Fehler laesst den Cursor stehen.
   */
  const apply = useCallback((change: (current: Scenario) => Scenario, interventionAt?: number) => {
    setScenario((current) => {
      try {
        // Vor der Bearbeitung geleert, damit sie selbst eine Meldung setzen kann.
        setNotice(undefined);
        const next = change(current);
        if (interventionAt !== undefined) {
          viewport.current?.seek(roundInterventionTime(interventionAt));
        }
        return next;
      } catch (error) {
        setNotice({ kind: "error", text: (error as Error).message });
        return current;
      }
    });
  }, []);

  /**
   * Wie `apply`, macht aber das neu angelegte Objekt zum aktiven. Die
   * `add…`-Funktionen haengen es immer ans Ende von `entities`; die Auswahl
   * wird nur bei Erfolg gesetzt, ein Fehler laesst sie unberuehrt.
   */
  const applyAdd = useCallback(
    (change: (current: Scenario) => Scenario, interventionAt?: number) => {
      apply((current) => {
        const next = change(current);
        if (next.entities.length > current.entities.length) {
          setActiveEntityId(next.entities[next.entities.length - 1]!.id);
        }
        return next;
      }, interventionAt);
    },
    [apply],
  );

  /**
   * Laden und Zuruecksetzen laufen beide hier durch.
   *
   * **Das Zuruecksetzen der Abspielzeit passiert nicht hier.** `setT(0)` und
   * `setIsPlaying(false)` setzen nur die Anzeige, damit sie nicht fuer ein Bild
   * den alten Stand zeigt. Wirksam wird es ueber `resetToken`: der Viewport
   * erkennt daran ein neues Szenario und setzt den Abspielkopf im Betrachter
   * zurueck (`viewer.playhead.seek(0)`). Wer hier etwas zuruecksetzen will, das
   * im Betrachter lebt - Zeit, Kamera, Ebene -, muss es im Reset-Zweig von
   * Viewport.tsx tun.
   */
  const loadScenario = useCallback((next: Scenario, message?: string) => {
    setScenario(next);
    setActiveEntityId(undefined);
    setPlacing(undefined);
    setNotice(message === undefined ? undefined : { kind: "info", text: message });
    setT(0);
    setIsPlaying(false);
    setResetToken((token) => token + 1);
  }, []);

  // Ein Szenario, das der Regisseur abgelegt hat - so bettet die Lernplattform
  // das Studio ein. Geladen wie eine Datei, damit Zeit und Kamera zuruecksetzen.
  useEffect(() => {
    const requested = requestedScenario();
    if (!requested || requested === "durchstich") return;
    const abort = new AbortController();
    void fetchStoredScenario(requested, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      if (result.ok) loadScenario(result.scenario);
      else setNotice({ kind: "error", text: `Szenario nicht ladbar: ${result.errors.join(" | ")}` });
    });
    return () => abort.abort();
  }, [loadScenario]);

  const handleTime = useCallback((time: number, playing: boolean) => {
    setT(time);
    setIsPlaying(playing);
  }, []);

  const handlePick = useCallback(
    (point: [number, number, number], normal?: [number, number, number]) => {
      const entryId = placing;
      if (!entryId || isPlaying) return;
      const entry = scenario.library.find((candidate) => candidate.definition.id === entryId);
      if (!entry) return;

      // Auf einem getroffenen Objekt richtet sich das Neue nach dessen
      // Oberflaeche aus; in der Luft bleibt es ungedreht.
      const orientation = normal && orientationFromNormal(normal);

      applyAdd((current) => {
        if (entry.definition.kind === "constraint") {
          // Flaechen liegen auf dem Anklickpunkt: man setzt sie dorthin, wo
          // sie liegen sollen.
          return addConstraint(current, {
            t,
            constraintId: entryId,
            position: point,
            orientation,
          });
        }
        if (entry.definition.kind !== "body") return current;
        // Der Koerper sitzt mit der Unterseite auf dem Anklickpunkt: der
        // Mittelpunkt liegt eine halbe Kante ueber ihm, entlang der Normale.
        // Das Material waehlt `addBody` (das erste der Bibliothek).
        const lift = normal ? entry.definition.behaviour.halfExtents[2] : 0;
        return addBody(current, {
          t,
          bodyId: entryId,
          position: normal
            ? [point[0] + normal[0] * lift, point[1] + normal[1] * lift, point[2] + normal[2] * lift]
            : point,
          orientation,
        });
      }, t);
      setPlacing(undefined);
    },
    [applyAdd, isPlaying, placing, scenario.library, t],
  );

  // Eine Last hat keine Lage - anders als Koerper und Flaechen braucht sie
  // keinen Klickpunkt und wird direkt zur Zeit des Zeitcursors hinzugefuegt.
  const handleAddLoad = useCallback(
    (loadId: string) => {
      if (isPlaying) return;
      applyAdd((current) => addLoad(current, { t, loadId }), t);
    },
    [applyAdd, isPlaying, t],
  );

  function handleSave(): void {
    // Die Kamera lebt im Betrachter und wird erst hier ins Szenario geschrieben:
    // bei jeder Mausbewegung ein neues Szenario hiesse, jedes Mal neu zu simulieren.
    const pose = viewport.current?.cameraPose();
    downloadScenario(pose ? setViewCamera(scenario, pose) : scenario);
  }

  async function handleLoad(): Promise<void> {
    const result = await openScenarioFile();
    if (!result) return;
    if (!result.ok) {
      setNotice({ kind: "error", text: `Datei nicht lesbar: ${result.errors.join(" | ")}` });
      return;
    }
    loadScenario(result.scenario, `"${result.scenario.name}" geladen.`);
  }

  function handleReset(): void {
    // Rueckfrage, weil Zuruecksetzen alles verwirft und es kein Rueckgaengig
    // gibt. Wer gespeichert hat, verliert nichts - wer nicht, soll es merken.
    const confirmed = globalThis.confirm(
      "Szenario wirklich zurücksetzen? Alle nicht gespeicherten Änderungen gehen verloren.",
    );
    if (!confirmed) return;
    // Keine Erfolgsmeldung: der Klick auf "Zurücksetzen" ist derselbe Klick,
    // der sie als "woanders hingeklickt" sofort wieder wegräumen würde.
    loadScenario(createEmptyScenario());
  }

  return (
    <div className="arbeitsflaeche">
      <header className="kopf">
        <h1>Physik-Sandbox</h1>
        <input
          type="text"
          className="szenarioname"
          value={scenario.name}
          aria-label="Name des Szenarios"
          onChange={(event) => apply((current) => renameScenario(current, event.target.value))}
          onBlur={() => apply((current) => renameScenario(current, current.name.trim()))}
        />
        <span className="luecke" />
        <div className="dateiknoepfe">
          <button type="button" onClick={handleSave}>
            Speichern
          </button>
          <button type="button" onClick={() => void handleLoad()}>
            Laden
          </button>
          <button type="button" onClick={handleReset}>
            Zurücksetzen
          </button>
        </div>
      </header>

      <aside className="links">
        <LibraryPanel
          scenario={scenario}
          placing={placing}
          locked={isPlaying}
          onPlace={setPlacing}
          onCancelPlacing={() => setPlacing(undefined)}
          onAddLoad={handleAddLoad}
          onEntrySynthesized={(entry) => apply((current) => addLibraryEntry(current, entry))}
          onMessage={(kind, text) => setNotice({ kind, text })}
        />
      </aside>

      <main className="mitte">
        <div className="viewport-rahmen">
          <Viewport
            ref={viewport}
            recording={recording}
            layer={layer}
            showAxes={showAxes}
            onTime={handleTime}
            onPick={handlePick}
            onSelect={setActiveEntityId}
            {...(activeEntityId !== undefined ? { activeEntityId } : {})}
            resetToken={resetToken}
            {...(placing !== undefined ? { pickHeight: 0 } : {})}
          />

          <ViewToolbar
            layers={AVAILABLE_LAYERS}
            current={layer}
            onSelect={(next) => apply((current) => setViewLayer(current, next))}
            onFrameScene={() => viewport.current?.frameScene()}
            showAxes={showAxes}
            onToggleAxes={() => apply((current) => setAxesVisible(current, !current.view.showAxes))}
          />

          {layer === "atomic" && (
            <p className="schematisch-hinweis">
              Schematisch: Gitterform und Packungsdichte sind echt, die Zellgröße nicht.
            </p>
          )}

          {direction.annotations.length > 0 && (
            <div className="annotationen">
              {direction.annotations.map((annotation, index) => (
                <p key={index} className="annotation">
                  {annotation.text}
                </p>
              ))}
            </div>
          )}

          {(notice || runError) && (
            <div
              ref={noticeRef}
              className={`meldung ${runError ? "fehler" : notice?.kind}`}
              role="status"
            >
              {runError ? `Das Szenario läuft nicht: ${runError}` : notice?.text}
              <button type="button" className="schliessen" onClick={() => setNotice(undefined)}>
                ×
              </button>
            </div>
          )}
        </div>

        <Timeline
          scenario={scenario}
          recording={recording}
          t={t}
          isPlaying={isPlaying}
          onSeek={(time) => viewport.current?.seek(time)}
          onPlay={() => viewport.current?.play()}
          onPause={() => viewport.current?.pause()}
          onDuration={(duration) => apply((current) => setTotalDuration(current, duration))}
        />
      </main>

      <aside className="rechts">
        <InspectorPanel
          scenario={scenario}
          t={t}
          locked={isPlaying}
          activeEntityId={activeEntityId}
          onActivate={setActiveEntityId}
          onRename={(entityId, name) => apply((current) => renameEntity(current, entityId, name))}
          onEdit={apply}
          onDeleteEntity={(entityId) => {
            if (entityId === activeEntityId) setActiveEntityId(undefined);
            apply((current) => deleteEntity(current, entityId));
          }}
          onAddIntervention={(entityId, kind) => {
            // `t` ist der Spiegel des Zeitcursors; lesen ist hier richtig, weil
            // der Knopf nur bei pausierter Wiedergabe geht und `t` dann steht.
            if (isPlaying) return;
            apply(
              (current) =>
                kind === "add"
                  ? addEntityAt(current, t, entityId)
                  : kind === "remove"
                    ? removeEntityAt(current, t, entityId)
                    : addChangeAt(current, t, entityId),
              t,
            );
          }}
          onRemoveIntervention={(index) => apply((current) => removeIntervention(current, index))}
          onInterventionTime={(index, time) =>
            apply((current) =>
              setInterventionTime(current, index, time, (text) =>
                setNotice({ kind: "error", text }),
              ),
            )
          }
        />
      </aside>
    </div>
  );
}
