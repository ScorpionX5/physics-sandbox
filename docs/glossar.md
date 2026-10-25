# Glossar

Verbindliche Begriffe für die Sandbox. **Deutscher Begriff** = Dokumentation,
Oberfläche, Gespräch. **Identifier** = Code, JSON-Felder, Werkzeugnamen.

Wer einen neuen Begriff braucht, trägt ihn hier ein, bevor er ihn im Code
benutzt. Zwei Namen für dieselbe Sache sind teurer als eine Diskussion darüber,
welcher der richtige ist.

---

## Stoffliche und szenische Bausteine

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Material** | `Material` | Stoffliche Definition *ohne* Ort, Menge und Form: Eisen, Holz, Sauerstoff. Trägt Daten für alle Darstellungsebenen plus Simulationsgrößen, nach Physikdomäne gruppiert (`mechanical`, `thermal`, `chemical`). Nur `mechanical` ist Pflicht. Wird nicht platziert, sondern einem Körper oder einer Ebene zugewiesen (`BodySpec.materialId`, `ConstraintSpec.materialId`). **Standard** (`STANDARD`, 1000 kg/m³, grau, Stoßzahl 0) ist das erste Material der Startbibliothek und damit das Material jedes neu angelegten Körpers und jeder neuen Ebene. |
| **Körper** (Bibliothekseintrag) | `Body` | Eine Form *ohne* Material, Ort und Größe — die Unterklasse steht in `behaviour.bodyType`. Bewusst ohne eigene Farbe: wie ein Körper aussieht, bestimmt sein Material. |
| **Quader** | `CUBOID`, `bodyType: "cuboid"` | Der einzige Körper der Bibliothek, eine Unterklasse von Körper. Die halben Kantenlängen am Eintrag sind nur die Voreinstellung beim Platzieren; die Größe steht an der Instanz (`BodySpec.phase.shape`). |
| **Randbedingung** | `Constraint` | Nicht-stoffliche Entität, die einer anderen Entität eine Lage oder Bewegung aufzwingt. Stufe 1 kennt `staticSurface` (unbewegliche Flächen). Bewusst ohne eigene Farbe: die Optik kommt vom Material der platzierten Instanz. |
| **Last** | `Load` | Nicht-stoffliche Entität, die auf andere Entitäten einwirkt, ohne ihnen eine Lage vorzuschreiben. Stufe 1 kennt `gravity` ("Gravitation", mit der Mechanik als lesendem Modul) und `heatSource` als Platzhalter ohne Modul. Eine Last verhält sich wie ein Körper oder eine Fläche — sie lässt sich platzieren, umbenennen, bearbeiten und löschen —, hat aber keine Lage: Stärke und Richtung stehen an der platzierten Instanz (`LoadSpec`), nicht Position und Drehung. |
| **Ebene** | `PLANE` | Die einzige Flächen-Grundform der Bibliothek, und die einzige Randbedingung, die Stufe 1 kennt: eine unbewegliche Rechteckplatte. Lage, Drehung, Größe und Material stehen an der *platzierten Instanz* — aus diesem einen Eintrag werden eine schiefe Ebene, ein Auslauf, eine Wand und ein Tisch. |
| **Gravitation** | `GRAVITATION` | Die einzige Last mit Modul, die Stufe 1 kennt: ein Schwerefeld. Stärke und Richtung stehen an der *platzierten Instanz* — aus diesem einen Eintrag lassen sich beliebig viele, verschieden starke und verschieden gerichtete Schwerefelder bauen; mehrere zugleich wirken addiert. |
| **Bibliothekseintrag** | `LibraryEntry` | Ein `Body`, `Material`, `Constraint` oder `Load` samt `Provenance` — Herkunft, Prompt, Modell, Prüfstatus. |
| **Bibliothek** | `Library` | Die Sammlung aller Einträge. Datei: `*.library.json`. |
| **Körper** (platziert) | `BodySpec` | Eine *Instanz* eines Körper-Eintrags in der Szene, mit genau einem Material. „Quader" ist der Eintrag, „Eisen" das Material; „dieser 2-kg-Eisenquader bei (0, 3, 0)" ist der Körper. Zwei Verweise: `bodyId` (Form) und `materialId`. Ein neu platzierter Körper bekommt das erste Material der Bibliothek (Standard). |
| **Erscheinungsform** | `Phase` | Aggregatzustand (`solid`/`liquid`/`gas`/`plasma`) plus Geometrie (`box`, `sphere`). |
| **Instanzgröße** | `ConstraintSpec.size` | Halbe Ausdehnung einer platzierten Fläche in Längs- und Querrichtung. Steht an der Instanz, nicht am Bibliothekseintrag; gilt nur für Flächen mit genau einem Segment. |
| **Lastinstanz** | `LoadSpec.magnitude` / `.direction` | Stärke (m/s²) und Richtungsvektor einer platzierten Last — derselbe Grund wie bei der Instanzgröße: ein Eintrag, beliebig viele verschiedene Instanzen. |
| **Entität** | `Entity` / `EntitySpec` | Oberbegriff: ein Körper, eine platzierte Randbedingung **oder** eine platzierte Last. Körper und Randbedingung haben eine Lage im Raum; eine Last nicht — sie wirkt unabhängig vom Ort auf jede Entität der Szene. |
| **Opazität** | `EntitySpec.opacity` | Deckkraft einer Entität, 0 (unsichtbar) bis 1 (voll deckend, Standard). Eigenschaft jeder Entität, auch der Last, die nichts zeichnet. Reine Darstellung, die Physik liest sie nie; sie wird mit der Deckkraft des Materials multipliziert. Nicht zu verwechseln mit der Darstellungsebene — die hat keine Opazität. |
| **Aktives Objekt** | `activeEntityId` | Die eine Entität, auf die sich die Oberfläche gerade richtet — höchstens eine. Sie ist in der rechten Leiste **aufgeklappt** und im Viewport **hervorgehoben** (orange Kanten). Aktiv wird sie durch einen Klick auf das Objekt im Viewport oder durch Aufklappen in der Leiste; ein Klick ins Leere oder Zuklappen macht sie wieder inaktiv. Reine Bedienungsgröße: sie steht nicht im Szenario und ändert die Simulation nicht. Nicht zu verwechseln mit dem *Zeitcursor*. |

> **Warum Material und Körper getrennt sind:** Dasselbe Material kommt mehrfach
> mit unterschiedlicher Masse und Form vor, und derselbe Quader soll aus Holz
> statt Eisen sein können, ohne ein neues Objekt zu werden. Außerdem ist die
> KI-Erzeugung pro Material cachebar — „Eisen" wird einmal synthetisiert und
> beliebig vielen Körpern zugewiesen.

---

## Eigenschaften in der rechten Leiste

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Klasse** | `EntityClass` | Wo eine Entität in der Vererbungsfolge steht: **Objekt** → **Körper** → **Quader**, **Objekt** → **Randbedingung** → **Ebene**, **Objekt** → **Last** → **Gravitation**. Eine Klasse erbt alle Eigenschaften ihrer Oberklassen. `entityClassOf` bestimmt die speziellste Klasse einer Entität. Reine Gliederung der Oberfläche, kein Feld im Szenario. |
| **Klassen-Icon** | `ClassIcon` | Quadratisches Symbol einer Klasse ohne Unterklassen (Quader, Ebene, Gravitation). Steht in der Bibliothek vor dem Eintragsnamen und in der rechten Leiste vor dem Namen der Entität, dort mit dem Klassennamen als Tooltip. |
| **Objekt** (Klasse) | `"object"` | Die Wurzel der Klassen — gleichbedeutend mit *Entität*. Nur in dieser Bedeutung wird das Wort benutzt (siehe „Begriffe, die absichtlich *nicht* benutzt werden"). |
| **Eigenschaft** | `EntityProperty` | Ein bearbeitbarer Wert einer Entität, wie er in der rechten Leiste erscheint: Name, Typ, Einheit, Gruppe, die Klassen, denen er zugeordnet ist, und wie er gelesen und geschrieben wird. Definiert in `ENTITY_PROPERTIES` ([entityProperties.ts](../apps/studio/src/entityProperties.ts)). Die Eigenschaft ist nicht die Wahrheit, sie liest und schreibt das Szenario. |
| **Eigenschaftstyp** | `PropertyType` | Bestimmt, wie eine Eigenschaft dargestellt wird: `vector3` (3D-Vektor), `vector2` (2D-Vektor), `percent` (Prozentwert), `choice` (Auswahlwert), `number` (numerischer Wert). |
| **Eigenschaftsgruppe** | `PropertyGroup` | Thematische Gruppe, in die Eigenschaften eingeordnet sind: **Geometrie**, **Material**, **Kinematik**, **Darstellung** — in dieser Reihenfolge, ohne eigene Überschrift, durch Linien getrennt. |

---

## Mechanischer Zustand

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Lage** | `Pose` | Position (`Vec3`) und Orientierung (`Quat`, als `[x, y, z, w]`). |
| **Geschwindigkeit** | `Velocity` | Translatorisch und Winkelgeschwindigkeit (rad/s, Achse × Betrag). |
| **Trägheit** | `Inertia` | Masse und Trägheitstensor im Körpersystem (`Mat3`, zeilenweise). |
| **Drehimpuls** | `angularMomentum` | Der intern geführte Rotationszustand. Winkelgeschwindigkeit wird daraus abgeleitet — siehe [Architektur](architektur.md#rotation). |
| **Kraftgesetz** | `ForceLaw` | Ein Beitrag zur Kraft- und Drehmomentsumme. Stufe 1: Schwerkraft aus den platzierten Gravitations-Lasten. |
| **Kontakt** | `Contact` | Eine erkannte Berührung: Segment und Durchdringungstiefe. |
| **Stoßzahl** | `restitution` | 0 = kein Zurückprallen, 1 = idealelastisch. Eigenschaft des **Materials** (`Material.mechanical.restitution`); die Ebene hat keine eigene, sie nimmt die ihres Materials. Gilt für jeden Stoß — Körper gegen Körper wie Körper gegen Ebene — als **Minimum der beiden Materialien**: Standard (0) macht jede Paarung unelastisch, zwei gleiche Materialien prallen mit ihrer eigenen Zahl. |
| **Ruheschwelle** | `REST_THRESHOLD_STEPS` | Aufprallgeschwindigkeit, unterhalb der ein Kontakt als Ruhe gilt und die Stoßzahl 0 ist: zehn Schritte Schwerkraft (10 · g · dt mit dem Betrag g der Schwerebeschleunigung; bei Erdschwere und 1 ms knapp 0,1 m/s). Verhindert, dass ein aufliegender Körper mit Stoßzahl > 0 in Mikrometern hüpft und seinen Kontakt in jedem zweiten Schritt verliert. |
| **Überlappung** | `Overlap` | Ergebnis des Geometrietests zweier Körper: Kontaktnormale (von Körper a nach b) und Eindringtiefe. Bewusst ohne Kontaktpunkt — der Stoßimpuls greift am Schwerpunkt an (Stufe 1). |
| **Festgehalten** | `kinematic` | Nimmt an Kontakten teil, wird aber nicht von Kräften bewegt. |

---

## Umgebung und zeitliche Struktur

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Umgebung** | `Environment` | Bedingungen, die auf *alle* Entitäten wirken, ohne selbst Entität zu sein. Schwerkraft gehört *nicht* mehr dazu — sie ist eine Last. Noch ohne Modul: später `ambientTemperature`, `ambientPressure`. |
| **Szenario** | `Scenario` | Die Datei, in der alles steht: Umgebung, Bibliothek, Entitäten, Eingriffe, Gesamtdauer, Regiespur, Simulationsparameter. Datei: `*.scenario.json`. |
| **Gesamtdauer** | `Scenario.duration` | Wie lange das Szenario läuft, in simulierten Sekunden. Ein eigenes Feld, unabhängig von den Eingriffen: sie zu kürzen löscht keinen Eingriff. |
| **Eingriff** | `Intervention` | Eine Änderung am Zustand zu einem Zeitpunkt `t`: `add`, `remove`, `change`, `setEnvironment`. Mehrere zur selben Zeit gelten im selben Zeitschritt, in Listenreihenfolge (`interventionsInOrder`). `add` verweist per Id auf eine Entität in `Scenario.entities`; die Definition liegt nicht im Eingriff. `move`, `setVelocity` und `setParameter` gibt es nicht mehr — Dateien damit lehnt das Schema ab. |
| **Ändern** (Eingriffsart) | `op: "change"`, `EntityChange` | Ein Eingriff, der genau **eine** Eigenschaft einer Entität setzt: ein **Änderungsschlüssel** (`change.key`, z. B. `position`, `linearVelocity`, `opacity`) und ein Wert in Speichereinheiten (Quaternion, halbe Kanten — wie in der Spec). Ersetzt das frühere „Anhalten" (= `linearVelocity` auf 0). Welche Schlüssel eine Entitätsart hat: `CHANGE_KEYS` ([changes.ts](../packages/schema/src/changes.ts)). |
| **Eingabeeigenschaft** | `isStateChange(...) === false` | Ein Wert, den das Szenario allein festlegt: Startwert in der Spec plus alle Änderungen bis `t` (Größe, Material, Opazität, Lage einer Randbedingung, Stärke …). Zu jeder Zeit ohne Simulation bekannt: `entitySpecAt`. |
| **Zustandsgröße** | `isStateChange(...) === true` | Ein Wert, den die Simulation fortschreibt: Lage, Geschwindigkeit und Winkelgeschwindigkeit eines Körpers. Eine Änderung setzt ihn zu `t`, danach rechnet die Physik weiter; wo er später steht, weiß nur die Aufzeichnung. |
| **Spec zur Zeit t** | `entitySpecAt(scenario, id, t)` | Die Spec einer Entität mit allen Änderungen ihrer Eingabeeigenschaften bis einschließlich `t` (Wirkreihenfolge). Gelesen von Simulator, Renderern und Oberfläche — dieselbe Faltung (`applyEntityChange`) an allen drei Stellen. |
| **Eingriffszeit** | `Intervention.t` | Zeitpunkt eines Eingriffs in Sekunden. Aus der Oberfläche auf 0,01 s gerundet (`roundInterventionTime`), damit gleich angezeigte Zeiten auch gleich sind. |
| **Wirksam** | `isInterventionEffective` | Ein Eingriff, den der Lauf erreicht: `t` liegt vor der Gesamtdauer (genauer: vor dem Beginn des letzten Zeitschritts plus dt/2). Ein unwirksamer bleibt im Szenario stehen und wirkt nur nicht. |
| **Zeitcursor** | `Playhead.current`, Spiegel `App.t` | Die aktuelle Abspielzeit — Schieber und Zahlenfeld unten in der Zeitleiste. Ein neuer Eingriff entsteht immer zur Zeit des Zeitcursors; während der Wiedergabe deshalb gar nicht. |
| **Raute** (Eingriffsmarke) | `interventionMarks` | Die Markierung auf dem Schieber für einen Zeitpunkt mit wirksamen Eingriffen. Alle Eingriffe derselben Zeit teilen sich eine Raute. |
| **Zeitschritt** | `Tick` | Ein fester Integrationsschritt, Standard 1 ms. Nie variabel. |
| **Zeitstreckung** | `TimeScale` | Simulierte Sekunden pro Realsekunde. Gesetzt über die Regieanweisung `setTimeScale`. |

> **Schwerkraft ist eine Last, kein eingebautes Gesetz.** Sie steht als
> platzierte `LoadSpec`-Entität ("Gravitation") mit Stärke und Richtung in der
> Szene, nicht als Umgebungsfeld. Mehrere Gravitations-Lasten zugleich wirken
> addiert; keine Last heißt keine Schwerkraft. Die Gegenprobe gehört zur
> Verifikation: die Last entfernen oder ihre Stärke auf 0 setzen, der Klotz
> bleibt in der Luft stehen.

> **Warum „Eingriff" statt „Frame".** „Frame" bedeutet im 3D-Umfeld
> unvermeidlich „gerendertes Einzelbild"; zwischen zwei Eingriffen liegen bei
> 60 fps mehrere hundert davon. Beide Bedeutungen im selben Code wären eine
> dauerhafte Fehlerquelle. `Frame` bleibt für Renderbilder reserviert.

> **Warum es keine Etappen mehr gibt.** Etappen waren Zeitabschnitte mit einer
> Dauer, an deren Anfang Eingriffe standen. Der Abschnitt selbst trug nichts
> außer seinem Namen — gebraucht wurde nur der Zeitpunkt. Seit jeder Eingriff
> seine Zeit selbst trägt, fällt die Zwischenebene weg: kein Auswählen einer
> Etappe vor dem Eingreifen, kein Verschieben späterer Abschnitte, wenn sich
> eine Dauer ändert.

---

## Simulationskern

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Zustandsschicht** | `StateLayer` / `SimState` | Autoritativer Kern. Reines TypeScript, keine Grafik-Abhängigkeit. |
| **Darstellungsschicht** | `PresentationLayer` | Leitet Geometrie aus dem Zustand ab. Wirkt nie zurück. |
| **Physikmodul** | `PhysicsModule` | Die Erweiterbarkeitseinheit. Deklariert gelesene und geschriebene Zustandsabschnitte und hängt sich in Pipeline-Phasen ein. |
| **Pipeline-Phase** | `PipelinePhase` | `interventions` → `accumulate` → `integrate` → `contacts` → `exchange` → `transform` → `record`. |
| **Prozess** | `Process` | Ein einzelner Term innerhalb eines Moduls (Wärmeleitung, Strahlung). Stufe 3. |
| **Reaktion** | `Reaction` | Prozess mit Stoffumsatz. Stufe 4. |
| **Zustand** | `State` / `EntityState` | Der Zustandsvektor, nach Modul partitioniert: `mechanics`, `thermal`, `chemical`. |
| **Schnappschuss** | `Snapshot` | Ein aufgezeichneter Zustand zu einem Zeitpunkt. |
| **Aufzeichnung** | `Recording` | Die Folge von Schnappschüssen plus Szenario und Seed. Das Artefakt, das an die Lernplattform geht. |
| **Lauf** | `Run` | Eine Ausführung eines Szenarios. |
| **Abspielkopf** | `Playhead` | Position in der Aufzeichnung, Abspielrichtung, Zeitstreckung. |
| **Abspieler** | `Player` / `RecordingViewer` | Die einbettbare Komponente, die eine Aufzeichnung interaktiv darstellt. |

> **Jedes Modul besitzt seinen Zustandsabschnitt exklusiv.** `ModuleRegistry`
> lehnt ein zweites Modul ab, das denselben Abschnitt schreibt. Das ist der
> Mechanismus, der die Partitionierung durchsetzt statt sie nur zu
> dokumentieren.

---

## Darstellung und Regie

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Darstellungsebene** | `ViewLayer` | `macroscopic`, `kinematic`, `atomic`, `subatomic`, `thermal`, `fields`. Stufe 1 implementiert die ersten drei. In der Oberfläche heißen sie **Standard**, **Kinematik** und **Atome**. | Ebene, Koordinatensystem (ein/aus) und Kamera werden im Szenario mitgespeichert (`Scenario.view`).
| **Koordinatenachsen** | — | x rot, y grün, z blau, je 1 m lang. Hängen an der Szene, nicht an einer Ebene; die Achsenbeschriftungen der Zahlenfelder tragen dieselben Farben. |
| **Hochachse** | — | **z.** „Oben" heißt +z, „unten" −z, eine Höhe ist die z-Koordinate, die Erdschwerkraft ist `[0, 0, -9.81]`. Gilt für Szenario, Kern und Darstellung gleichermaßen; x und y spannen die Waagerechte auf. |
| **Regiespur** | `DirectionTrack` | Zeitgesteuerte Spur von Anweisungen, die *nicht* die Physik betreffen. |
| **Regieanweisung** | `DirectionCue` | `setViewLayer`, `moveCamera`, `annotate`, `pause`, `setTimeScale`. |
| **Annotation** | `Annotation` | Eingeblendete Beschriftung, optional an eine Entität geheftet. |

> **Die Regie ist ein Vorschlag, keine Vorschrift.** Ein Lernender kann sie
> ignorieren, die Kamera selbst drehen und die Ebene selbst wechseln, ohne dass
> die Simulation sich ändert. Genau das unterscheidet eine Aufzeichnung von
> einem Video — und es ist durch einen Test abgesichert: zwei Läufe, einer mit
> leerer Regiespur, liefern identische Schnappschüsse.

---

## KI-Komponenten

| Deutsch | Identifier | Bedeutung |
|---|---|---|
| **Bibliothekar** | `Librarian` / `LibrarianModel` | Der eng umrissene KI-Aufruf: Text rein, geprüfter Bibliothekseintrag raus. Ein Aufruf, strukturierte Ausgabe, keine Werkzeuge. Modell: `claude-sonnet-5-5`. |
| **Entwurf** | `LibrarianDraft` | Was das Modell liefert, bevor Code und Prüfung daraus einen Eintrag machen. |
| **Regisseur** | `Director` | Der Haupt-KI-Agent: Lehrauftrag rein, vollständiges Szenario samt Regiespur raus. Agentenschleife mit Werkzeugen. Modell: `claude-opus-5-5`. **Noch nicht gebaut.** |
| **Lehrauftrag** | `Brief` | Die Eingabe an den Regisseur: Lehrtext, Lernziel, optional Lernerprofil. |
| **Sandbox-Werkzeuge** | `SandboxTools` | Die Werkzeugoberfläche für den Regisseur. **Noch nicht gebaut.** |
| **Prüfung** | `Validation` / `ValidationResult` | Schema- und Plausibilitätsprüfung jeder KI-Ausgabe. Es gibt keinen Weg an ihr vorbei in die Bibliothek. |
| **Herkunft** | `Provenance` | Woher ein Eintrag kommt, welches Modell, welcher Prompt, was korrigiert wurde. |

> **Die Geometrie rechnet der Code, nicht das Modell.** Der Bibliothekar
> liefert für eine Fläche hohe Parameter — Neigungswinkel, Längen, Breite — und
> `buildRampSegments` macht daraus orthonormale Achsen. Ein Modell um
> Basisvektoren zu bitten ist eine verlässliche Fehlerquelle.

> **Zahlen gewinnt die Referenztabelle.** Für Elemente braucht das Modell
> überhaupt keine Materialwerte zu erfinden, nur die Darstellung zu entwerfen.
> Weicht ein Wert um mehr als 5 % ab, gilt der Referenzwert, und `Provenance`
> vermerkt es.

---

## Begriffe, die absichtlich *nicht* benutzt werden

| Vermieden | Stattdessen | Grund |
|---|---|---|
| „Frame" für einen Bearbeitungszustand | **Eingriff** | `Frame` ist das gerenderte Einzelbild. |
| „Schiefe Ebene" als Bibliothekseintrag | **Ebene**, gedreht platziert | Eine Neigung ist eine Eigenschaft der Instanz, nicht des Eintrags. Ein fertiger Rampen-Eintrag ließe sich nachträglich nicht zerlegen. |
| „Etappe", `Stage` | **Eingriff** mit Zeit `t`, **Gesamtdauer** | Gibt es nicht mehr; ein Zeitabschnitt ohne eigenen Inhalt war eine Ebene zu viel. Alte Dateien mit `stages` lehnt das Schema ab. |
| „Abspielkopf" in der Oberfläche | **Zeitcursor** | `Playhead` bleibt der Name der Klasse im Code. |
| „Makroskopisch" in der Oberfläche | **Standard** | Für die Bedienung zu sperrig; der Begriff bleibt im Code und in der Doku. |
| „Apparat" | **Randbedingung** oder **Last**, je nachdem | Ein Apparat vermischte zwei verschiedene Rollen: eine Lage aufzwingen (Randbedingung) und einwirken, ohne die Lage vorzuschreiben (Last). |
| „Objekt" als Sammelname | **Material**, **Körper**, **Randbedingung**, **Last** oder **Entität** | Fünf verschiedene Dinge mit verschiedenen Feldern. Einzige Ausnahme: **Objekt** als Wurzel der *Klassen* — dort heißt es genau „Entität". |
| „Stoff", `Substance` | **Material** | Umbenannt, als Körper und Material getrennt wurden. „Stoffmenge" (mol) bleibt als physikalische Größe. |
| „Simulation" für die Datei | **Szenario** | „Simulation" ist der Vorgang; die Datei ist das Szenario, das Ergebnis die Aufzeichnung. |
| „Agent" ohne Zusatz | **Bibliothekar** oder **Regisseur** | Zwei sehr verschiedene KI-Aufrufe. |
| „Partikel" für Atome | **Atom** in der atomaren Ebene | „Partikel" ist der Darstellungseffekt, nicht das Simulationsobjekt. |
