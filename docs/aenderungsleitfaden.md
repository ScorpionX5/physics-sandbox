# Änderungsleitfaden

**Zweck dieses Dokuments:** schnell die *richtige* Stelle finden. Nicht eine
Stelle, die plausibel aussieht und an der eine Änderung scheinbar wirkt.

Die anderen Dokumente beantworten andere Fragen:

| Frage | Dokument |
|---|---|
| Was heißt dieser Begriff? | [glossar.md](glossar.md) |
| Warum ist das so gebaut? | [architektur.md](architektur.md) |
| Wie bediene ich die Sandbox? | [../README.md](../README.md) |
| **Wo muss ich etwas ändern?** | **dieses Dokument** |

---

## Die eine Regel, aus der fast alle Fehler folgen

> **Viele Werte stehen an mehreren Stellen. Genau eine davon ist die Wahrheit,
> die anderen sind Spiegel. Eine Änderung am Spiegel wirkt — kurz — und wird
> beim nächsten Bild überschrieben.**

Ein Spiegel ist immer daran erkennbar, dass ihn jemand *setzt*, ohne gefragt zu
werden: ein `useEffect`, ein `onFrame`-Rückruf, ein `useState`, das aus einem
Prop nachgezogen wird. Wer einen Wert ändern will, muss ihn dort ändern, wo er
*gelesen* wird, bevor er weitergegeben wird.

### Der Fall, an dem das zuerst auffiel: die Zeit

Aufgabe war: *beim Laden und Zurücksetzen muss die Zeit auf 0 stehen.* Die
naheliegende Stelle ist `setT(0)` in
[App.tsx](../apps/studio/src/App.tsx) — und sie ist die falsche. Denn:

```
Playhead.current  (packages/render/src/playback.ts)   ← hier LEBT die Zeit
   │ viewer.renderOnce() → onFrame(info)
   ▼
App.tsx: setT(info.t)                                 ← Spiegel, nur zur Anzeige
   │ prop t
   ▼
Timeline.tsx: Uhr, Schieberstellung                   ← Spiegel vom Spiegel
```

`setT(0)` setzt den Spiegel. Beim nächsten Bild meldet der Betrachter wieder
seine echte Zeit, und die Anzeige springt zurück. Richtig ist, den Abspielkopf
zu setzen — das passiert im Reset-Zweig von
[Viewport.tsx](../apps/studio/src/components/Viewport.tsx):

```ts
viewer.playhead.pause();
viewer.playhead.seek(0);
```

`setT(0)` in `loadScenario` bleibt trotzdem stehen: es verhindert, dass die
Anzeige für ein Bild die alte Zeit zeigt. Es ist Kosmetik, nicht die Wirkung.

**Merksatz:** React kennt die Abspielzeit nur vom Hörensagen. Wer sie ändern
will, geht über `viewport.current?.seek(…)` oder `viewer.playhead`.

---

## Zustandslandkarte

Nachschlagewerk: welcher Wert lebt wo, und wie ändert man ihn richtig.

| Wert | Die Wahrheit lebt in | Spiegel (nicht hier ändern) | Richtiger Zugriff |
|---|---|---|---|
| **Definition eines Objekts** (Lage, Form, Stärke …) | `Scenario.entities` ([scenario.ts](../packages/schema/src/scenario.ts)) — **nicht** der `add`-Eingriff, der verweist nur per `entityId` darauf | Eingriffsliste, `listEntities` | `withEntitySpec` und die Bearbeitungsfunktionen in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts). *Wann* ein Objekt in der Szene ist, sagen die `add`/`remove`-Eingriffe; `isEntityPresent(scenario, id, t)` liest das. Ein Objekt ohne `add` existiert, ist aber nie in der Szene. |
| **Wert einer Eingabeeigenschaft zur Zeit t** (Größe, Material, Opazität, Lage einer Randbedingung, Stärke …) | `Scenario.entities` + alle `change`-Eingriffe bis t, gefaltet von `entitySpecAt` / `applyEntityChange` ([changes.ts](../packages/schema/src/changes.ts)) | `Simulator.specs` (laufende Spec je Entität, [simulate.ts](../packages/core/src/simulate.ts)), die Varianten der Renderer (`entityStages`, `showVariant` in [common.ts](../packages/render/src/common.ts)), Vorbelegung `changeValueAt` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts)) | Startwert: die Eigenschaft in der rechten Leiste. Wert ab t: ein „Ändern"-Eingriff (`addChangeAt`, bearbeitet mit `setInterventionChange`). Nicht im Schnappschuss — wer die Faltung an einer Stelle ändert, ändert sie in `applyEntityChange`, sonst rechnen Physik und Bild verschieden. Zustandsgrößen eines Körpers (Lage, Geschwindigkeiten) faltet `applyEntityChange` bewusst **nicht** in die Spec; sie leben im Simulator und in der Aufzeichnung. |
| **Szenario** | `useState<Scenario>` in [App.tsx](../apps/studio/src/App.tsx) | — | Immer über `apply(…)` mit einer Funktion aus [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts). Niemals ein Szenario-Objekt an der Stelle mutieren. |
| **Aufzeichnung** (`Recording`) | abgeleitet: `useMemo` über `runScenario(scenario)` in App.tsx | `Viewport.recordingRef`, `RecordingViewer.recording`, `Playhead.recording` | Nicht setzen. Szenario ändern — die Aufzeichnung entsteht neu. Es gibt bewusst keinen Zustand namens „simuliert", der veralten könnte. |
| **Abspielzeit** | `Playhead.current` in [playback.ts](../packages/render/src/playback.ts) | `App.t`, `Timeline` (Uhr, Schieber), `ViewerFrameInfo.t` | `viewport.current?.seek(t)` aus der Oberfläche, `viewer.playhead.seek(t)` im Betrachter. |
| **läuft / pausiert** | `Playhead.playing` | `App.isPlaying`, Knopfbeschriftung in `Timeline` | `playhead.play()` / `playhead.pause()`, aus der Oberfläche über `ViewportHandle`. |
| **Zeitstreckung** | `Playhead.scale` | — | `playhead.setTimeScale(…)`; die Regiespur tut das über `setTimeScale`-Anweisungen. |
| **Simulierte Zeit im Lauf** | `SimState.t`, **berechnet** als `steps * dt` in `Simulator.step` ([simulate.ts](../packages/core/src/simulate.ts)) | Schnappschuss-`t`, Ereignis-`t` | Nie `t += dt` schreiben — das driftet und verschiebt Eingriffe um einen Schritt. Siehe Kommentar an `Simulator.steps`. Ausnahme bei den Schnappschüssen: Ein Eingriff wird von `recordInterventions` (simulate.ts) als Paar „davor/danach" mit der **Eingriffszeit** gestempelt, nicht mit `SimState.t`, damit der Zeitcursor am Eingriff schon dessen Wirkung zeigt. `snapshotAt` (playback.ts) nimmt bei gleicher Zeit den späteren. |
| **Darstellungsebene** | `Scenario.view.layer` ([scenario.ts](../packages/schema/src/scenario.ts), `ViewSettings`) | `RecordingViewer.currentLayer`, Knopfzustand in `ViewToolbar` | `setViewLayer` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts)) über `apply`; ein `useEffect` in Viewport schiebt den Wert in den Betrachter. App liest ihn aus `scenario.view`, es gibt kein eigenes `useState`. Das Ändern erzeugt ein neues Szenario und damit einen neuen Lauf (gleiche Physik). **Achtung:** mit `followDirection: true` darf der Betrachter die Ebene selbst wechseln, dann ist der Wert im Szenario veraltet. Das Studio setzt die Option deshalb nicht. |
| **Koordinatensystem ein/aus** (Standard: ein) | `Scenario.view.showAxes` | `RecordingViewer.axes.visible`, Knopf „Koordinatensystem" in `ViewToolbar` | `setAxesVisible` in scenarioEdits.ts über `apply`; `RecordingViewer.setAxesVisible` per Effekt in Viewport. |
| **Kamera** (Lage, Zielpunkt, Zoom) | **Laufend:** `RecordingViewer.camera` und `OrbitLikeControls.target` in [viewer.ts](../packages/render/src/viewer.ts). **Gespeichert:** `Scenario.view.camera` (`position`, `target`) | — | Die laufende Kamera steht **nicht** dauernd im Szenario (jede Mausbewegung hieße neu simulieren). `handleSave` in App.tsx liest sie über `viewport.current?.cameraPose()` und schreibt sie mit `setViewCamera` in die Datei; beim Laden setzt der `isReset`-Zweig in [Viewport.tsx](../apps/studio/src/components/Viewport.tsx) nach `frameScene()` die gespeicherte Lage (`setCameraPose`). Ohne gespeicherte Kamera bleibt es beim Einpassen. `setRecording` lässt die Kamera stehen — das ist gewollt, sonst spränge die Ansicht bei jedem platzierten Objekt. Zurücksetzen heißt `frameScene()` ausdrücklich aufrufen. |
| **Zeitcursor als Zeit neuer Eingriffe** | `Playhead.current` (siehe Abspielzeit) | `App.t`, gelesen von `onAddIntervention`, `handlePick`, `handleAddLoad` in App.tsx; hervorgehobene Raute in `Timeline`; Vorbelegung der Eingriffsart in `InspectorPanel` | Gelesen wird der Spiegel `App.t`, und das ist hier richtig, weil Anlegen nur bei pausierter Wiedergabe geht und `t` dann steht. Gesetzt wird nur über den zweiten Parameter `interventionAt` von `apply`/`applyAdd` in App.tsx: nach erfolgreichem Anlegen springt der Cursor auf die gerundete Eingriffszeit — sonst läge der Eingriff bei 1,236 s → 1,24 s hinter dem Cursor und das neue Objekt bliebe unsichtbar. Wer einen neuen Weg zum Anlegen eines Eingriffs baut, übergibt `t` dort mit. Gesperrt wird über `isPlaying`: `locked` an `LibraryPanel` und `InspectorPanel`, dazu bricht ein `useEffect` in App.tsx ein angefangenes Platzieren beim Start der Wiedergabe ab. Gerundet wird in den Bearbeitungsfunktionen (`roundInterventionTime`), nicht in App. |
| **Aktives Objekt** (aufgeklappt + hervorgehoben) | `App.activeEntityId` | „Aufgeklappt" in `InspectorPanel` (dort kein eigener Zustand, nur `expanded = activeEntityId`); Hervorhebung in `RecordingViewer.activeEntityId` und den orangen Kanten in `MacroscopicRenderer` | `setActiveEntityId` in App. Aus dem Viewport kommt es über `Viewport.onSelect` ← `viewer.pickEntity`, aus der Leiste über `onActivate`; zurück in den Viewport läuft es über das Prop `activeEntityId` → `viewer.setActiveEntity`. Wer eine Entität löscht oder ein Szenario lädt, muss die Auswahl mitziehen (siehe `onDeleteEntity`, `loadScenario`). Nicht im Szenario und nicht in der Aufzeichnung. Ein neu angelegtes Objekt wird sofort aktiv: `handlePick` und `handleAddLoad` gehen dafür über `applyAdd` (App.tsx), das die Auswahl auf die letzte Entität setzt — eine neue Anlege-Aktion nimmt `applyAdd` statt `apply`. |
| **Zeit eines Eingriffs** | `Intervention.t` in `Scenario.interventions` ([scenario.ts](../packages/schema/src/scenario.ts)) | Rauten auf dem Schieber (`interventionMarks`), Zeitfeld in der Eingriffsliste (`InspectorPanel`), `Simulator.timeline` | `setInterventionTime` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts) — rundet und sortiert ein. Nur die Eingriffe *desselben* Objekts müssen in ihrer Folge passen (`timelineProblem`); sonst springt die Zeit auf den nächsten möglichen Wert und der Rückruf `report` meldet es (App setzt daraus die Fehlermeldung). Andere Eingriffe werden nie verändert, und die Reihenfolge zu Eingriffen anderer Objekte darf sich ändern. `CommittedNumber` committet Enter + Verlassen nur einmal — sonst träfe der zweite Commit mit dem alten Index nach dem Umsortieren einen anderen Eingriff. Die Liste ist nicht zwingend sortiert (fremde Dateien); wer die Wirkreihenfolge braucht, liest `interventionsInOrder(scenario)` und sortiert nicht selbst. Neue Eingriffe fügt `insertIntervention` (scenarioEdits.ts) sortiert ein, hinter die Eingriffe derselben Zeit. |
| **Gesamtdauer** | `Scenario.duration` | Zahlenfeld „Gesamtdauer" in `Timeline`, `Playhead.duration` (aus der Aufzeichnung) | `setTotalDuration` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts), verdrahtet über `onDuration` in App.tsx. Eingriffe dahinter bleiben stehen; ob einer wirkt, sagt `isInterventionEffective` — dieselbe Grenze wie im Simulator (`duration - dt/2`), sonst zeigte die Liste einen Eingriff als wirksam, den der Lauf nie erreicht. |
| **Opazität eines Objekts** (0 = unsichtbar, Standard 1) | `opacity` an jeder Entität in `Scenario.entities` ([scenario.ts](../packages/schema/src/scenario.ts), `Opacity`) — Körper, Randbedingung und Last | Eigenschaft `opacity` in [entityProperties.ts](../apps/studio/src/entityProperties.ts) (Klasse Objekt), `userData.opacity` und Materialdeckkraft in den Netzen der Renderer | `setEntityOpacity` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts); ab einer Zeit ein „Ändern" mit Schlüssel `opacity`. Die Renderer bauen je Stand eine Variante mit ihrer Opazität (`applyEntityOpacity` in [common.ts](../packages/render/src/common.ts)) und schalten im `update` um; bei 0 bleibt die Variante ausgeblendet (`isShownBy`). Nicht im Schnappschuss — sie folgt aus dem Szenario (siehe „Wert einer Eingabeeigenschaft zur Zeit t"). |
| **Masse eines Körpers** | `BodySpec.mass`, **wenn gesetzt**; sonst `density · volume`, berechnet in `Simulator.createBody` | — | In der Oberfläche **keine Eigenschaft mehr**: die Masse kommt derzeit immer aus der Dichte. Das Schemafeld bleibt (fremde Dateien, Bibliothekar), `setBodyMass` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts) ebenfalls, ist aber nicht verdrahtet; `undefined` heißt „wieder aus Dichte rechnen". Wer es wieder anbietet, legt eine Eigenschaft in `ENTITY_PROPERTIES` an. |
| **Material eines Körpers oder einer Ebene** | `BodySpec.materialId` bzw. `ConstraintSpec.materialId` ([scenario.ts](../packages/schema/src/scenario.ts)) — Verweis auf einen `Material`-Eintrag in `scenario.library` Eigenschaft `material` (Auswahlwert) in [entityProperties.ts](../apps/studio/src/entityProperties.ts); `RuntimeBody.material` im Kern, `inventory.bodies[].material` und `inventory.constraints[].material` in den Renderern (die Ebene nutzt es bisher nur in `MacroscopicRenderer`; Kinematik und Atomar zeichnen ihre Kanten unabhängig davon). Die Eigenschaft gehört den Klassen Körper und Ebene (Gruppe Material). Der Randbedingungs-Eintrag (`PLANE`) hat **kein** `appearance` mehr — die Farbe kommt nur vom Material | `setEntityMaterial` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts). Beim Anlegen setzen `addBody` und `addConstraint` das erste Material der Bibliothek (`listMaterials(…)[0]`, in `BUILTIN_LIBRARY` ist das `STANDARD`), wenn keines angegeben ist — **nicht** App.tsx. Ältere Dateien ohne `materialId` an der Ebene lehnt das Schema ab. |
| **Form eines Körpers** (Unterklasse, z. B. Quader) | `BodySpec.bodyId` → `Body`-Eintrag in `scenario.library` ([library.ts](../packages/schema/src/library.ts), `BodyBehaviour`) für die Unterklasse; die wirksame Größe in `BodySpec.phase.shape` | Klassen-Icon in der Kopfzeile der rechten Leiste (`ClassIcon`, Klasse aus `entityClassOf`) | Die halben Kantenlängen am Eintrag (`CUBOID.behaviour.halfExtents`) sind nur die Voreinstellung in `addBody`; danach `setBodyHalfExtents`. Der Kern liest den Eintrag nie. |
| **Winkelgeschwindigkeit** | abgeleitet aus `angularMomentum` ([state.ts](../packages/core/src/state.ts), `refreshDerivedState`) | `MechanicalState.angularVelocity` in Schnappschüssen | Nie `angularVelocity` direkt zuweisen; `setAngularVelocity(body, omega)` rechnet den Drehimpuls um. Grund: [Architektur → Rotation](architektur.md#rotation). |
| **Weltkoordinaten der Flächensegmente** | `RuntimeSurface.segments`, aufgelöst aus `localSegments` + Lage | — | Nach jeder Lage- oder Größenänderung einer Fläche `resolveSegments(…)` neu aufrufen — sonst kollidiert der Körper mit der alten Lage. `applyChange` in simulate.ts macht genau das. |
| **Bibliothek** | `scenario.library` — **jedes Szenario trägt seine Einträge selbst** | `LibraryPanel`-Anzeige | `addLibraryEntry`. `BUILTIN_LIBRARY` ([builtin.ts](../packages/schema/src/builtin.ts)) ist nur der Startinhalt von `createEmptyScenario()`, keine globale Quelle zur Laufzeit. Ihre Reihenfolge zählt: das erste Material dort (`STANDARD`) ist das Standardmaterial neuer Körper und Ebenen. |
| **Schwerkraft** | Platzierte `LoadSpec`-Entitäten vom Typ `gravity` (`magnitude` + `direction`, je Instanz) — **kein** Umgebungsfeld mehr | `InspectorPanel`-Liste unter „Lasten" | `addLoad`/`setLoadMagnitude`/`setLoadDirection` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts)). Im Kern summiert `totalGravity(state)` ([mechanics.ts](../packages/core/src/modules/mechanics.ts)) alle platzierten Gravitations-Lasten; keine Last heißt Nullvektor, keine Schwerkraft. |
| **Größe einer Ebene** (Länge, Breite, Höhe) | `ConstraintSpec.size` (halbe Länge/Breite) und `ConstraintSpec.thickness` (Höhe = Plattendicke, ganz) an der Instanz; fehlt eines, gilt der Wert des Bibliothekssegments. Aufgelöst von `constraintSegments` ([state.ts](../packages/core/src/state.ts)) — Simulator, Auswertung und Renderer rufen dieselbe Funktion | Eigenschaft `size` (3D-Vektor x = L, y = B, z = Höhe) in [entityProperties.ts](../apps/studio/src/entityProperties.ts) | `setConstraintDimensions` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts)); lesen mit `constraintSizeOf` / `constraintThicknessOf`. |
| **Eigenschaften einer Entität** (welche, in welcher Gruppe, in welcher Form) | `ENTITY_PROPERTIES` in [entityProperties.ts](../apps/studio/src/entityProperties.ts): je Eigenschaft Klasse, Gruppe, Typ, Einheit, `get`/`set` | Zeilen in `InspectorPanel` (`PropertyRow`) | Keine Eigenschaft von Hand in den Inspektor schreiben. `propertyGroupsOf(scenario, spec)` liefert die Eigenschaften einer Entität nach Gruppen; die Klasse bestimmt `entityClassOf`. `get` liest das Szenario, `set` ist eine Bearbeitungsfunktion aus scenarioEdits.ts und läuft über `onEdit` → `apply`. Die Eigenschaft hat keinen eigenen Zustand. Regeln: [CLAUDE.md → Eigenschaften](../CLAUDE.md#eigenschaften-in-der-rechten-leiste). |
| **Zahlenfeld-Eingabe** | `draft`-State in `CommittedNumber` ([CommittedNumber.tsx](../apps/studio/src/components/CommittedNumber.tsx) — Zeitcursor, Gesamtdauer, Eingriffszeit) bzw. `NumberField`/`TextField` ([InspectorPanel.tsx](../apps/studio/src/components/InspectorPanel.tsx)) | — | Übernommen wird erst bei Verlassen oder Enter; `CommittedNumber` setzt Eingaben außerhalb von `min`/`max` auf die Grenze. Das Zeitcursor-Feld ist während der Wiedergabe `readOnly`, sonst überschriebe die laufende Uhr jede Eingabe. Wer das auf „bei jedem Tastendruck" umbaut, zerstört die Eingabe: die Simulation läuft neu und das Feld wird neu gerendert. |
| **Meldung / Fehlertext** | `App.notice`, plus `runError` aus dem `useMemo` | — | Fehler aus einer Bearbeitung werden in `apply` gefangen und angezeigt, nicht geworfen. |
| **Reset-Erkennung** | `App.resetToken` (Zähler), gespiegelt in `Viewport.lastResetToken` | — | Hochzählen heißt „neues Szenario, Zeit auf 0". Ohne diesen Zähler kann der Viewport nicht unterscheiden, ob eine neue Aufzeichnung aus einer Bearbeitung (Zeit erhalten) oder aus einem Laden (Zeit auf 0) kommt. |

---

## „Ich will … ändern"

Einstieg nach Aufgabe. Jede Zeile nennt *alle* Stellen — unvollständig geändert
ist schlimmer als nicht geändert, weil der Fehler dann erst im Lauf auffällt.

### Oberfläche

| Vorhaben | Anfassen |
|---|---|
| Verhalten beim **Laden / Zurücksetzen** | `loadScenario` in [App.tsx](../apps/studio/src/App.tsx) **und** den `isReset`-Zweig in [Viewport.tsx](../apps/studio/src/components/Viewport.tsx). Alles, was im Betrachter lebt (Zeit, Abspielzustand, Kamera, Pausenmerker), kann nur dort zurückgesetzt werden — der Zweig setzt den Abspielkopf auf 0 **und** über `frameScene()` die Ansicht auf die Standardwerte. |
| Eine **neue Eigenschaft** einer Entität (Eingabefeld in der rechten Leiste) | 1. Bearbeitungsfunktion in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts), Test in [scenarioEdits.test.ts](../apps/studio/test/scenarioEdits.test.ts). 2. Eintrag in `ENTITY_PROPERTIES` ([entityProperties.ts](../apps/studio/src/entityProperties.ts)): Klasse (die allgemeinste, für die sie gilt), Gruppe, Typ, Einheit, `get`/`set`; Gliederungstest in [entityProperties.test.ts](../apps/studio/test/entityProperties.test.ts) anpassen. **Nicht** InspectorPanel oder App.tsx anfassen — die Darstellung folgt aus dem Typ, die Verdrahtung ist das eine `onEdit`. Nur ein neuer *Typ* braucht einen Zweig in `PropertyRow` (InspectorPanel.tsx) und eine Spaltenbelegung im Raster `.eigenschaft` ([styles.css](../apps/studio/src/styles.css)). Eine neue *Klasse* (z. B. Kugel) kommt in `EntityClass`/`PARENT_CLASS` und `entityClassOf`. |
| **Aussehen der Eigenschaftszeilen** (Spalten, Einheitenbreite, Gruppenlinien) | `.eigenschaft`, `.eigenschaftsgruppe` und `.spalte-1…3` in [styles.css](../apps/studio/src/styles.css). Das Raster ist für alle Typen dasselbe; wer eine Spaltenbreite ändert, ändert sie für alle. |
| Eine neue **Art von Eingriff im Steuerelement** (wie *Hinzufügen*, *Entfernen*, *Ändern*) | Das Steuerelement `eingriff-anlegen` am Ende der Eingriffsliste in `InspectorPanel` (Auswahl Objekt, Art; Vorbelegung in den `picked…`/`…Choice`-Werten dort, die Art nach `isEntityPresent` am Zeitcursor), `InterventionKind` ebenda, die Verzweigung in `onAddIntervention` in App.tsx (dort kommt die Zeit dazu: der Zeitcursor), Bearbeitungsfunktion `…At(scenario, t, …)` in `scenarioEdits.ts` — und `describeIntervention` (jetzt in [entityProperties.ts](../apps/studio/src/entityProperties.ts), weil es die Namen der Eigenschaften braucht), sonst steht in der Eingriffsliste und im Tooltip der Raute kein brauchbarer Text. Am Objekt selbst gibt es keine Eingriffsknöpfe. |
| Eine Eigenschaft **per „Ändern" änderbar** machen | 1. Schlüssel in `EntityChange` ([scenario.ts](../packages/schema/src/scenario.ts)) und in `CHANGE_KEYS` mit `state` ([changes.ts](../packages/schema/src/changes.ts)); bei einer Eingabeeigenschaft der Zweig in `applyEntityChange`. 2. Wirkung im Kern: `applyChange` in [simulate.ts](../packages/core/src/simulate.ts) (Zustandsgröße direkt in die Mechanik, sonst aus der gefalteten Spec neu bauen). 3. Vorbelegung: Zweig in `changeValueAt` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts)). 4. Eingabefeld: `change` an der Eigenschaft in `ENTITY_PROPERTIES` (Umrechnung `fromChange`/`toChange`); gibt es keinen Startwert, `scope: "change"`. 5. Sichtbar wird eine Eingabeeigenschaft in den Renderern automatisch, sofern sie beim `build` aus der Spec gelesen wird — die Varianten entstehen aus `entityStages`. |
| **Zeitleiste** (Zeitcursor-Feld, Gesamtdauer-Feld, Rauten) | [Timeline.tsx](../apps/studio/src/components/Timeline.tsx). Welche Rauten es gibt, entscheidet `interventionMarks` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts) (nur wirksame, je Zeitpunkt eine), Farbe nach Lage zur gerundeten Zeitcursorzeit (`timeRelation` in scenarioEdits.ts, auch für den Zeittext in der Eingriffsliste des `InspectorPanel`, `.eingriff-zeit`): davor blau (`.vergangen`), darauf orange (`.gewaehlt`), danach grau. Zeitcursor-Feld und Schieber spulen beide über `onSeek` → `viewport.current?.seek` — die Kopplung läuft über den `Playhead`, nicht zwischen den beiden. Aussehen: `.uhr`, `.eingriffsmarken`, `.marke` in [styles.css](../apps/studio/src/styles.css). |
| **Eingriffsliste** (Zeitfeld, Ausgrauen unwirksamer Eingriffe, Aufklappen eines „Ändern") | `listInterventions` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts) liefert Reihenfolge, Index in `Scenario.interventions` und `effective`; gezeichnet in [InspectorPanel.tsx](../apps/studio/src/components/InspectorPanel.tsx), Zeitänderung über `onInterventionTime` → `setInterventionTime`. Ausgegraut: `.eingriffsliste li.unwirksam` in styles.css. Ein „Ändern" klappt per Klick auf den Text auf (`OpenChange` in InspectorPanel — Objekt, Zeit und laufende Nummer statt Listenindex, weil der sich beim Umsortieren verschiebt). Die Zeilen darunter liefert `changeRowsOf` ([entityProperties.ts](../apps/studio/src/entityProperties.ts)): Auswahl der Eigenschaft und der Wert als gebundene Eigenschaft, gezeichnet mit derselben `PropertyRow`; geschrieben wird über `onEdit` → `setInterventionChange`. Aussehen: `.eingriff-kopf`, `.eingriffsliste li.aenderbar`, `li.offen`. |
| Eine **Last** hinzufügen/bearbeiten (z. B. Gravitation) | Last verhält sich wie ein Objekt, nur ohne Lage: 1. `addLoad`/`setLoadMagnitude`/`setLoadDirection` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts). 2. Stärke/Richtung sind Eigenschaften der Klasse Gravitation in [entityProperties.ts](../apps/studio/src/entityProperties.ts); Position/Drehung hat eine Last nicht, weil sie unabhängig vom Ort wirkt. Die Liste „Lasten" in [InspectorPanel.tsx](../apps/studio/src/components/InspectorPanel.tsx) zeichnet sie wie jede andere Entität (`entityItem`). 3. `onAddLoad` in [LibraryPanel.tsx](../apps/studio/src/components/LibraryPanel.tsx): ein Klick fügt sofort hinzu, kein Platzieren per Szenenklick wie bei Körper/Randbedingung. 4. Verdrahtung in App.tsx. Ein neuer Last-*Typ* (wie „Gravitation") kommt zusätzlich in [library.ts](../packages/schema/src/library.ts) (`LoadBehaviour`) und — falls ein Modul ihn lesen soll — in `packages/core` (siehe „Neues Physikmodul"). |
| **Gliederung der rechten Leiste** (Überschriften, Reihenfolge, Leer-Hinweise) | [InspectorPanel.tsx](../apps/studio/src/components/InspectorPanel.tsx). Die Reihenfolge Randbedingungen → Körper → Lasten → Eingriffe spiegelt das Datenmodell: die drei Entitätsklassen, danach die Eingriffe — einschließlich des `add`: *wann* ein Objekt erscheint steht dort (`listInterventions`), nicht am Objekt; ein `add` aus der Liste zu löschen löscht nur den Eingriff (`removeIntervention`), das Objekt bleibt in `Scenario.entities`; ganz weg ist es erst über das × am Objekt (`deleteEntity`). Gefiltert wird über `spec.kind` aus `listEntities`; alle drei Listen zeichnen ihre Einträge mit demselben `entityItem`, die Eigenschaften kommen aus `propertyGroupsOf`. Einen Aufklapp-Knopf gibt es nicht: ein Klick irgendwo auf den Eintrag (`onClick` am `li` in `entityItem`) aktiviert ihn und klappt ihn damit auf; zugeklappt wird nur, indem etwas anderes aktiv wird oder ein Klick ins Leere des Viewports die Auswahl aufhebt. Das × und das Namensfeld (`TextField`) halten den Klick mit `stopPropagation` zurück. Vor dem Namen steht das Klassen-Icon der speziellsten Klasse (`entityClassOf`) mit dem Klassennamen als Tooltip; hat die Klasse noch kein Icon, steht dort ihr Name (`ENTITY_CLASS_LABELS`). |
| Ein **Klassen-Icon** (Bibliothek und Kopfzeile der rechten Leiste) oder der **Name einer Klasse** | Icons: `CLASS_ICONS` in [ClassIcon.tsx](../apps/studio/src/components/ClassIcon.tsx), eingebettetes SVG, nur für Klassen ohne Unterklassen. Namen: `ENTITY_CLASS_LABELS` in [entityProperties.ts](../apps/studio/src/entityProperties.ts). Welche Klasse ein Bibliothekseintrag hat, bestimmt `libraryEntryClassOf` (ebenda) — eine neue Klasse braucht dort einen Zweig wie in `entityClassOf`. In der Bibliothek zeigt `EntryMark` ([LibraryPanel.tsx](../apps/studio/src/components/LibraryPanel.tsx)) das Icon; nur ohne Icon fällt es auf den Farbtupfen zurück. Materialien sind keine Klasse und behalten den Farbtupfen; die Ebene hat ein Icon und braucht deshalb keine Farbe. Größe/Farbe: `.klassen-icon` in [styles.css](../apps/studio/src/styles.css). |
| **Gliederung der Bibliothek** (linke Leiste) | [LibraryPanel.tsx](../apps/studio/src/components/LibraryPanel.tsx). Reihenfolge Randbedingungen → Lasten → Körper → Materialien. Randbedingungen und Körper sind Knöpfe zum Platzieren (`onPlace`), Lasten fügen sofort hinzu (`onAddLoad`) — beides während der Wiedergabe gesperrt (`locked`), weil es einen `add`-Eingriff am Zeitcursor anlegt —, Materialien sind keine Knöpfe (`eintrag statisch`) — sie werden nur in der rechten Leiste zugewiesen. Was in `handlePick` (App.tsx) aus einem platzierten Eintrag wird, verzweigt über `entry.definition.kind`. |
| **Auswahl / Hervorhebung** des aktiven Objekts | Wahl per Klick: Klick-Handler in [Viewport.tsx](../apps/studio/src/components/Viewport.tsx) (Klick nach einem Zug von mehr als `CLICK_TOLERANCE_PX` zählt nicht, sonst wählte jedes Drehen der Ansicht) und `pickEntity` in [viewer.ts](../packages/render/src/viewer.ts), das `userData.entityId` der Netze liest — ein Renderer, dessen Netze wählbar sein sollen, setzt es. Aussehen: `setActiveEntity` im Renderer der Ebene (`MacroscopicRenderer`, Farbe `ACTIVE_COLOR`); Kinematik- und Atomebene heben noch nichts hervor, atomar ist aber wählbar. Beim Platzieren (`pickHeight` gesetzt) wählt ein Klick nichts. |
| **Beschriftungen, Texte, Hinweise** | Direkt in der Komponente. Ebenennamen stehen zentral in `LAYER_TITLES` ([ViewToolbar.tsx](../apps/studio/src/components/ViewToolbar.tsx)). |
| **Aussehen** (Farben, Raster, Abstände) | Nur [styles.css](../apps/studio/src/styles.css). Die Klassennamen sind deutsch und folgen den Bereichen (`links`, `mitte`, `rechts`, `zeitleiste`, `panel`). |
| **Startszenario** beim Aufruf der Seite | `initialScenario()` in App.tsx; die Szenarien selbst in [builtin.ts](../packages/schema/src/builtin.ts) (`createEmptyScenario`, `createInclinedPlaneScenario`). |
| **Platzierung** neuer Objekte (Größe, Lage, Ausrichtung) | `handlePick` in App.tsx; die Größe eines neuen Körpers kommt aus dem Körper-Eintrag (`behaviour.halfExtents`, für den Quader in `CUBOID` in [builtin.ts](../packages/schema/src/builtin.ts)), sein Material aus `addBody`. Trifft der Klick ein Objekt, liefert `pickPoint` ([viewer.ts](../packages/render/src/viewer.ts)) zusätzlich die Oberflächennormale: das Neue wird per `orientationFromNormal` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts)) so gedreht, dass seine z-Achse der Normale folgt, und ein Körper sitzt eine halbe Kante entlang der Normale über dem Punkt (Unterseite plan auf). Ohne Treffer (Punkt in der Luft) gibt es keine Drehung und der Punkt wird gerastert; mit Treffer nicht. Es gibt keine Hebung mehr. |
| **Rundung von Klickpunkten** (Rasterweite je Zoomstufe) | `BASE_DECIMALS` und `DECIMALS_PER_DECADE` in [snap.ts](../packages/render/src/snap.ts) — dort stehen die einzustellenden Zahlen. Bezugspunkt ist `RecordingViewer.frameDistance`, der Abstand des letzten `frameScene`; gerundet wird in `snapPoint` ([viewer.ts](../packages/render/src/viewer.ts)), aufgerufen im Klick-Handler von [Viewport.tsx](../apps/studio/src/components/Viewport.tsx), bevor `onPick` den Punkt erhält. Test: [snap.test.ts](../packages/render/test/snap.test.ts). |
| **Standardansicht** (Blickrichtung, Abstand, Zielpunkt) | `CAMERA_DIRECTION`, `CAMERA_DISTANCE_FACTOR` (nur noch der Rand von ca. 15 % um die eingepassten Punkte) und `FOCUS_LIFT` in [viewer.ts](../packages/render/src/viewer.ts). Der Zielpunkt wird in `sceneFocus()` berechnet, und `frameScene` benutzt genau diese Funktion: zwei Rechnungen hieße, dass die Kamera auf einen anderen Punkt blickt als den, um den die Maus dreht, und die Szene beim ersten Ziehen springt. |
| **Kameraverhalten** | `frameScene`, `scenePoints` und `sceneBounds` in [viewer.ts](../packages/render/src/viewer.ts); die Abstandsrechnung (kleinster Abstand, bei dem alle Punkte im Sichtfeld liegen, abhängig vom Seitenverhältnis) in `fitDistance` in [framing.ts](../packages/render/src/framing.ts), getestet in `framing.test.ts`; Maussteuerung in `OrbitLikeControls` in derselben Datei. Beides hängt an der Hochachse: `camera.up` steht im Konstruktor, und `OrbitLikeControls` rechnet über `toFrame`/`fromFrame` in das y-Polachsen-System von `THREE.Spherical` um. |
| **Länge der Koordinatenachsen** | `AXES_LENGTH` in [viewer.ts](../packages/render/src/viewer.ts). Feste 1 m, damit die Achse zugleich Maßstab ist; sie wird deshalb nur im Konstruktor gebaut, nicht mehr in `setRecording`. |
| **Die Hochachse** (welche Achse „oben" ist) | **z**, und die Konvention lebt an genau drei Stellen: `builtin.ts` (`earthGravityIntervention` der Startszenarien, Segmentnormale `[0, 0, 1]`, `RAMP_ORIENTATION` als Drehung um **y**), `scenarioEdits.ts` (Voreinstellung `direction: [0, 0, -1]` in `addLoad`) und `viewer.ts` (`camera.up`, `frameScene`, Lichter, `pickPoint`, `toFrame`/`fromFrame`). Dazu `surfaceSegments` in [librarian.ts](../apps/service/src/librarian.ts) für neu erzeugte Flächen. `packages/core` gehört **nicht** dazu — der Kern kennt nur den Schwerkraftvektor jeder Last. Begründung: [Architektur → Koordinaten](architektur.md#koordinaten-z-zeigt-nach-oben). |
| **Szenario-Name** (Feld im Kopf) | `renameScenario` in [scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts); Feld in App.tsx. `onChange` darf nicht trimmen — sonst ist ein Leerzeichen am Wortende sofort wieder weg, bevor das nächste Zeichen folgt, und es lässt sich nie eines eingeben. Getrimmt wird erst in `onBlur`. Die Umwandlung in einen Dateinamen (Leerzeichen → `-`) passiert unabhängig davon in [scenarioFile.ts](../apps/studio/src/scenarioFile.ts). |

### Physik und Kern

| Vorhaben | Anfassen |
|---|---|
| **Kraft hinzufügen** (Reibung, Luftwiderstand) | `accumulate` in [mechanics.ts](../packages/core/src/modules/mechanics.ts) — oder, wenn es eine eigene Domäne ist, ein neues Modul (siehe Checkliste unten). Materialdaten liegen bereits in `material.mechanical` (am `RuntimeBody`). |
| **Integrator** ändern | `integrate` in `mechanics.ts`. Vorher [Architektur → Integrator](architektur.md#integrator) lesen: die Testtoleranzen sind absichtlich scharf, weil Velocity-Verlet bei konstanter Beschleunigung exakt ist. |
| **Kontakte** (Drehmoment, Kantenkontakt, Stapel) | `contacts` in `mechanics.ts`. Was Stufe 1 bewusst nicht kann, steht in [Architektur](architektur.md#was-stufe-1-bewusst-nicht-kann). |
| **Neuer Eingriffstyp** (`Intervention.op`) | Erst prüfen, ob es nicht ein neuer *Schlüssel* für `change` ist (Zeile „per Ändern änderbar machen") — meistens ist es das. Sonst: 1. Union in [scenario.ts](../packages/schema/src/scenario.ts), mit `t: InterventionTime` wie jede andere Variante. 2. `applyIntervention` in [simulate.ts](../packages/core/src/simulate.ts) — die einzige Stelle, an der der Zustand von außen verändert wird. 3. `entityStages` in [common.ts](../packages/render/src/common.ts), falls er die Darstellung betrifft. 4. `listInterventions` in `scenarioEdits.ts`, `describeIntervention` in `entityProperties.ts`. 5. `deleteEntity` in `scenarioEdits.ts`, falls der Eingriff auf eine Entität verweist (ein zurückgebliebener Verweis bricht den Lauf). |
| **Zeitschritt / Aufzeichnungsrate** | `SimulationSettings` in `scenario.ts` (Standardwerte) und die Szenarienbauer in `builtin.ts`. Wirkung und Begründung der Zahlen: [Architektur → Aufzeichnung](architektur.md#aufzeichnung-statt-video--mit-gemessenen-zahlen). |
| **Neue Entitätsklasse oder neues Feld an jeder Entität** (wie `opacity`) | `Body-`/`Constraint-`/`LoadSpec` in `scenario.ts`; die Literale, die Entitäten von Hand bauen: `add…`-Funktionen in `scenarioEdits.ts`, `earthGravityEntity` in `builtin.ts`, Testhilfen. Eingabefeld: eine Eigenschaft der Klasse Objekt in `ENTITY_PROPERTIES` ([entityProperties.ts](../apps/studio/src/entityProperties.ts)), wie `opacity`. Darstellung: alle drei Ebenen in `packages/render/src/layers/`. |
| **Neue Körperform** | Schema kennt `box` und `sphere`. Nötig sind: `inertiaTensorFor`, `boundingRadiusFor`, `boxCornersLocal`-Pendant ([state.ts](../packages/core/src/state.ts)), `shapeVolume` ([geometry.ts](../packages/schema/src/geometry.ts)), der Kontakttest in `mechanics.ts` und die Darstellung in [macroscopic.ts](../packages/render/src/layers/macroscopic.ts). Damit sie in der Bibliothek erscheint, zusätzlich: eine Unterklasse in `BodyBehaviour` ([library.ts](../packages/schema/src/library.ts), neben `CuboidBody`), ein Eintrag in `BUILTIN_LIBRARY` (wie `CUBOID`), die Umsetzung Eintrag → `phase.shape` in `addBody` ([scenarioEdits.ts](../apps/studio/src/scenarioEdits.ts) — dort ist bisher fest `box` gesetzt), der Hub in `handlePick` (App.tsx, liest `halfExtents[2]`) und eine Klasse samt Größen-Eigenschaft in [entityProperties.ts](../apps/studio/src/entityProperties.ts) (`EntityClass`, `entityClassOf` — dort entscheidet `phase.shape.type` über den Quader; wie `edges` beim Quader). |
| **Neue Materialeigenschaft** | 1. `Material` in [library.ts](../packages/schema/src/library.ts). 2. Plausibilitätsprüfung in [validation.ts](../packages/schema/src/validation.ts) — jede KI-Ausgabe läuft durch sie. 3. Werte der mitgelieferten Materialien in `builtin.ts`. 4. Wer sie liest (Modul oder Renderer). |
| **Neue Physikdomäne** (Thermodynamik, Chemie) | Die Phasen `exchange` und `transform` sind registriert und leer: [pipeline.ts](../packages/core/src/pipeline.ts). Siehe Checkliste „Neues Physikmodul". |

### Darstellung

| Vorhaben | Anfassen |
|---|---|
| **Eine Ebene sieht falsch aus** | Die zugehörige Datei unter [packages/render/src/layers/](../packages/render/src/layers/). Jede Ebene liest denselben Schnappschuss und zeigt etwas anderes; eine Ebene zu ändern kann die Physik nicht beeinflussen. |
| **Neue Darstellungsebene** | 1. `ViewLayer` in `scenario.ts` (die Namen stehen schon alle drin). 2. Renderer in `layers/`, der `ViewLayerRenderer` erfüllt ([common.ts](../packages/render/src/common.ts)). 3. `createLayerRenderer` in `viewer.ts`. 4. Export in [render/src/index.ts](../packages/render/src/index.ts). 5. `LAYER_TITLES` + Symbol in `ViewToolbar.tsx`. 6. `AVAILABLE_LAYERS` in App.tsx. |
| **Interpolation zwischen Schnappschüssen** | `snapshotAt` in [playback.ts](../packages/render/src/playback.ts). Sie liegt bewusst *nicht* im Kern: sie braucht Winkelfunktionen, der Kern darf keine benutzen. |
| **Regiespur** (Annotationen, Kamerafahrten) | `directionAt` in `playback.ts` liefert nur einen *Vorschlag*; `applyDirection` in `viewer.ts` folgt ihm nur bei `followDirection: true`. Annotationen zeigt App.tsx selbst an. |

### Dateien und Dienst

| Vorhaben | Anfassen |
|---|---|
| **Dateiformat** eines Szenarios (auch `view`: Ebene, Achsen, Kamera — fehlt es, gelten die Standardwerte) | `Scenario` in `scenario.ts` (das Schema ist das Format) und `parseScenario` in [scenarioFile.ts](../apps/studio/src/scenarioFile.ts) für Prüfungen, die über das Schema hinausgehen. Geladen wird **immer** durch das Schema (Dateien mit `entity` im `add`-Eingriff, vor Einführung von `Scenario.entities` gespeichert, werden abgelehnt) — auch die eigene Datei von letzter Woche ist fremde Eingabe. |
| **Endpunkt des Dienstes** | [server.ts](../apps/service/src/server.ts) — und `openApiDocument()` in derselben Datei, sonst beschreibt die OpenAPI-Datei etwas anderes als der Dienst tut. |
| **Bibliothekar** (Prompt, Modell, Zusammenbau) | [librarian.ts](../apps/service/src/librarian.ts). Der API-Schlüssel verlässt `apps/service` nie. |

---

## Checklisten für die größeren Eingriffe

### Neues Physikmodul

1. Datei unter `packages/core/src/modules/`, die `PhysicsModule` erfüllt.
2. `reads` und `writes` deklarieren. **Ein Zustandsabschnitt gehört genau einem
   Modul** — `ModuleRegistry.register` lehnt ein zweites schreibendes Modul ab.
   Das ist kein Hinweis, das ist eine Ausnahme beim Start.
3. Nur die Phasen implementieren, die gebraucht werden. Die Reihenfolge der
   Phasen ist begründet und nicht verhandelbar (Tabelle in
   [pipeline.ts](../packages/core/src/pipeline.ts)).
4. Eigenen Zustandsabschnitt in `onEntityAdded` anlegen.
5. Den Abschnitt in `Simulator.snapshot()` mit aufzeichnen, sonst kommt er in
   der Aufzeichnung nicht an. Schema dazu: `EntityState` in
   [recording.ts](../packages/schema/src/recording.ts) (`thermal` und `chemical`
   sind schon deklariert).
6. Test gegen eine analytische Lösung, nicht gegen gespeicherte Erwartungswerte.

### Etwas an der Zeitstruktur ändern

Jeder Eingriff trägt seine Zeit `t`, das Szenario seine **Gesamtdauer**
`duration`. Etappen gibt es nicht mehr
([Architektur](architektur.md#zeit-eingriffe-mit-zeitpunkt-gesamtdauer-für-sich)).

- **Wirkreihenfolge** ist `interventionsInOrder` (`scenario.ts`): nach Zeit,
  bei gleicher Zeit Listenreihenfolge. Simulator, Inventar der Renderer,
  Auswertung und Oberfläche lesen sie alle so; eine eigene Sortierung irgendwo
  liefe bei gleichen Zeiten anders.
- **Wirksam oder nicht** sagt `isInterventionEffective` (scenarioEdits.ts) mit
  derselben Grenze wie `applyDueInterventions` im Simulator. Wer eine der
  beiden ändert, ändert die andere mit.
- **Rundung** auf 0,01 s (`INTERVENTION_TIME_STEP`, `roundInterventionTime`)
  passiert in jeder Bearbeitungsfunktion, die eine Zeit annimmt — nicht in der
  Oberfläche und nicht im Schema: eine fremde Datei darf feinere Zeiten haben.
- Wer eine zweite Quelle für eine Zeitangabe einführt (etwa einen benannten
  Zeitpunkt neben `Intervention.t`), bekommt zwei Werte, die auseinanderlaufen.

### Die Reihenfolge, in der etwas durch das System läuft

```
Oberfläche (App.tsx)
   │ apply(fn)  →  scenarioEdits.ts: Szenario rein, Szenario raus
   ▼
Scenario  ──useMemo──▶ runScenario()  (packages/core/src/simulate.ts)
                          │ Eingriffe (nach Zeit) → Pipeline-Phasen → Schnappschüsse
                          ▼
                       Recording  ──▶ RecordingViewer.setRecording()
                                        │ Playhead + Renderer je Ebene
                                        ▼
                                      Bild, und onFrame → App.setT (Spiegel)
```

Zwei Pfeile fehlen hier absichtlich: es führt **kein** Pfeil von der Darstellung
zurück in den Zustand, und **keiner** von der Aufzeichnung zurück ins Szenario.
Wer einen davon bauen will, baut mit hoher Wahrscheinlichkeit etwas Falsches.

---

## Zwei Dinge, die nie passieren dürfen

1. **Keine Winkelfunktionen und keine `Math.random`-Nutzung in
   `packages/core`.** Erlaubt sind `+ - * /` und `sqrt`. Das ist die
   Determinismusregel: eine serverseitig erzeugte Aufzeichnung muss im Browser
   bitgleich aussehen. Zufall kommt aus `createRng(seed)`
   ([rng.ts](../packages/core/src/rng.ts)). Begründung:
   [Architektur → Determinismus](architektur.md#determinismus).
2. **`packages/core` bekommt keine Grafik-Abhängigkeit.** Kein `three`, kein
   DOM. Derselbe Code läuft im Browser, in Node und im Test — darauf beruht,
   dass Play keinen Netzaufruf braucht.

---

## Gegenprobe nach einer Änderung

```bash
npm test          # alle Pakete
npm run typecheck # alle Pakete
npm run dev       # ansehen, was kopflos nicht prüfbar ist
```

Wo der Test für was steht:

| Geändert | Test |
|---|---|
| Physik, Integrator, Kontakte, Determinismus | [packages/core/test/mechanics.test.ts](../packages/core/test/mechanics.test.ts) |
| Schema, Geometrie, Prüfung, Formeln | [packages/schema/test/schema.test.ts](../packages/schema/test/schema.test.ts) |
| Interpolation, Abspielkopf, Regiespur | [packages/render/test/playback.test.ts](../packages/render/test/playback.test.ts) |
| Renderer-Mathematik (kopflos) | [packages/render/test/renderer.test.ts](../packages/render/test/renderer.test.ts) |
| Bearbeitungsfunktionen der Oberfläche | [apps/studio/test/scenarioEdits.test.ts](../apps/studio/test/scenarioEdits.test.ts) |
| Eigenschaften: Klassen, Vererbung, Gruppen, Umrechnung | [apps/studio/test/entityProperties.test.ts](../apps/studio/test/entityProperties.test.ts) |
| Bibliothekar, Zusammenbau, Prüfkette | [apps/service/test/librarian.test.ts](../apps/service/test/librarian.test.ts) |

**Kein Test deckt ab:** wie es aussieht, und den echten Bibliothekar-Aufruf.
Was dafür von Hand zu prüfen ist, steht im
[README](../README.md#von-hand-zu-prüfen). Bei allem, was den Abspielkopf, die
Kamera oder einen Ebenenwechsel betrifft, ist `npm run dev` Teil der Gegenprobe
— genau dort sitzen die Spiegel, die ein Test nicht sieht.
