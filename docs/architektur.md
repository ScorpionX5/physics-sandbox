# Architektur

Die Entwurfsentscheidungen und warum sie so ausgefallen sind. Begriffe stehen im
[Glossar](glossar.md).

---

## Die zwei Probleme, die alles bestimmen

### 1. Erweiterbarkeit ist die Hauptanforderung

Die Physik wird domänenweise aufgebaut: Mechanik zuerst, Thermodynamik und
Chemie später. Die Mechanik darf deshalb keine Annahmen treffen, die später im
Weg stehen.

Die Antwort ist eine **Pipeline mit festen Phasen**, in die sich
**Physikmodule** einhängen:

| Phase | Mechanik (Stufe 1) | Thermodynamik (später) | Chemie (später) |
|---|---|---|---|
| `interventions` | kernseitig | — | — |
| `accumulate` | Schwerkraft aus den Gravitations-Lasten | Auftrieb, Druck | — |
| `integrate` | Lage und Geschwindigkeit | Temperatur-ODE | Stoffmengen-ODE |
| `contacts` | Normalimpulse | — | — |
| `exchange` | *leer* | Leitung, Strahlung, Konvektion | Diffusion |
| `transform` | *leer* | Schmelzen, Sieden | Reaktionen |
| `record` | kernseitig | — | — |

Die Reihenfolge ist nicht beliebig. `accumulate` vor `integrate`, weil der
Integrator die Kraftsumme braucht. `contacts` nach `integrate`, weil
Durchdringungen erst nach der Lageänderung feststellbar sind. `exchange` nach
`contacts`, weil Wärmeleitung über eine Berührung wissen muss, dass sie besteht —
die Kontaktliste der Mechanik ist genau die Information, die das
Thermodynamik-Modul dafür braucht.

Der Zustandsvektor ist entsprechend partitioniert:
`state.entities[id].mechanics`, später `.thermal`, `.chemical`. `ModuleRegistry`
lehnt ein zweites Modul ab, das denselben Abschnitt schreibt — die
Partitionierung ist durchgesetzt, nicht nur dokumentiert.

### 2. Zeitskalenlücke

Molekulardynamik rechnet in Femtosekunden; Rosten dauert Tage. Ein Modell kann
nicht gleichzeitig Atome korrekt bewegen und makroskopische Chemie zeigen — das
sind rund zwanzig Größenordnungen.

Deshalb ist die **Zustandsschicht** die einzige Quelle der Wahrheit und führt
wenige Zahlen pro Entität. Die **Darstellungsschicht** erzeugt Atome und
Partikel *abgeleitet* daraus und wirkt nie zurück.

---

## Determinismus

Nicht verhandelbar, weil daran drei Dinge hängen: dass Tests überhaupt möglich
sind, dass eine Aufzeichnung ein belastbares Artefakt ist, und dass ein
Videoexport nur „Aufzeichnung offline rendern" bedeutet.

- Fester `dt`, nie `deltaTime` aus dem Render-Loop.
- Seeded PRNG (`splitmix32`, rein ganzzahlig). Kein `Math.random`.
- Keine Uhr im Kern. Kein `Date.now`.
- **Keine transzendenten Funktionen im Kern.** `Math.sin`, `cos`, `tan`, `pow`,
  `exp`, `log` sind über JS-Engines nicht bitgenau spezifiziert; `+ - * /` und
  `sqrt` sind es nach IEEE-754.
- Eingriffe werden vor dem Lauf stabil nach Zeit sortiert
  (`interventionsInOrder`); bei gleicher Zeit zählt die Listenreihenfolge. Eine
  fremde Datei muss ihre Eingriffe also nicht sortiert liefern.
- Die simulierte Zeit wird als `schritte * dt` *berechnet*, nicht aufsummiert.
  Ein `t += dt` driftet: nach 10 000 Schritten von 1 ms liegt die Summe um etwa
  1 · 10⁻¹² unter 10 s, was Eingriffe um einen Schritt verschiebt und Schnappschusszeiten zu
  Werten wie `0.05000000000000001` macht.

Ein Test greppt die Quellen von `@sandbox/core` nach den verbotenen Aufrufen —
die Regel wird geprüft, nicht nur beschrieben.

Daraus folgt eine Konsequenz für die Geometrie: der Neigungswinkel einer Fläche
wird genau einmal beim Anlegen des Bibliothekseintrags in einen Normalenvektor
umgerechnet (`buildRampSegments` in `@sandbox/schema/geometry`) und als Vektor
gespeichert. Im Kern kommt keine Trigonometrie vor.

---

## Integrator

Velocity-Verlet für die Translation:

```
x(t+dt) = x(t) + v(t)·dt + ½·a·dt²
v(t+dt) = v(t) + a·dt
```

Die Reihenfolge ist wesentlich: die Lage benutzt die *alte* Geschwindigkeit. Bei
konstanter Beschleunigung — und die Schwerkraft ist konstant — reproduziert
diese Rekursion die geschlossene Lösung `s = ½gt²` und `v = gt` exakt, nicht nur
näherungsweise. Es bleibt Gleitkommarundung, relativ etwa 10⁻¹⁴.

**Deshalb kann der Falltest mit einer Toleranz von 10⁻⁹ prüfen statt mit einem
Prozent — und das ist der Punkt.** Vorwärts-Euler (`x += v·dt`) und
semi-impliziter Euler (`x += v_neu·dt`) weichen beide um genau `1/n` relativ ab,
nach 1000 Schritten also um 10⁻³. Mit 10⁻⁹ fällt das sofort auf, mit einem
Prozent nicht.

Sobald Kräfte von der Lage abhängen (Federn, Luftwiderstand), ist das Verfahren
zweiter Ordnung in der Lage statt exakt. Eine zweite `accumulate`-Auswertung im
Schritt würde es zum vollen Velocity-Verlet aufwerten — die Phasenreihenfolge
lässt das zu, ohne dass sich etwas anderes ändert.

### Rotation

Geführt wird der **Drehimpuls** `L`, nicht die Winkelgeschwindigkeit:

```
L(t+dt) = L(t) + τ·dt
ω       = I_welt⁻¹ · L      mit I_welt⁻¹ = R · I_körper⁻¹ · Rᵀ
q(t+dt) = normalize(q + ½·(ω ⊗ q)·dt)
```

Ohne Drehmoment ist `L += 0`, der Drehimpuls bleibt also auf **Bitgenauigkeit**
erhalten — die Drehimpulserhaltung ist damit keine Frage der Schrittweite. Würde
`ω` integriert, müsste bei einem unsymmetrischen Körper in jedem Schritt der
Kreiselterm `ω × (Iω)` mitgerechnet werden, mit Rundungsfehlern, die sich
aufsummieren.

Zwei Tests sichern das gegenseitig ab: bei einem unsymmetrischen Körper muss
`|L|` exakt konstant bleiben *und* `ω` muss wandern. Bliebe beides konstant,
würde der Kern die Rotation gar nicht rechnen.

---

## Koordinaten: z zeigt nach oben

**Die Hochachse ist z.** „Oben" heißt +z, eine Höhe ist die z-Koordinate, die
Erdschwerkraft ist `[0, 0, -9.81]`, und x und y spannen die Waagerechte auf.

Gewählt ist das nicht nach Geschmack, sondern nach der Herkunft der Zahlen: in
Physik, Technik und CAD ist z die Hochachse, und ein Szenario wird aus
Lehrtexten und Zeichnungen heraus gebaut. Eine Höhe, die im Datenmodell `y`
heißt, müsste jedes Mal übersetzt werden — und einmal nicht übersetzt zu haben
fällt erst im Lauf auf.

Der Kern selbst kennt kein „oben": die Schwerkraft ist der Vektor einer
platzierten Gravitations-Last (Stärke mal normierte Richtung), und ein Test
lässt sie seitwärts zeigen, um genau das abzusichern. Die Konvention lebt
deshalb an drei Stellen und nur dort:

| Stelle | Was dort von z abhängt |
|---|---|
| `builtin.ts` | Richtung der Standard-Schwerkraft (`earthGravityIntervention`), Normale der Festen Ebene (`[0, 0, 1]`), Neigung der Rampe (Drehung um **y**, nicht um z — eine Drehung um die Hochachse würde die Platte nur herumschwenken) |
| `scenarioEdits.ts` | Voreinstellung `direction: [0, 0, -1]` in `addLoad` |
| `viewer.ts` | `camera.up`, die Standardansicht in `frameScene` (`CAMERA_DIRECTION`, `CAMERA_DISTANCE_FACTOR`, `INITIAL_CAMERA_DISTANCE_FACTOR`, `FOCUS_LIFT`), die Lichtrichtungen, die Rückfallebene in `pickPoint` und die Umrechnung der Kugelkoordinaten der Maussteuerung |

Daraus folgt die **Standardansicht**, die jedes Laden und Zurücksetzen
herstellt (`frameScene("initial")`, aufgerufen im `isReset`-Zweig des
Viewports — der Betrachter selbst lässt die Kamera beim Austausch der
Aufzeichnung bewusst stehen, sonst spränge sie bei jeder Bearbeitung): die Kamera steht über dem positiven x-y-Quadranten, in
der Waagerechten **15° von der x-Achse weg** (`CAMERA_DIRECTION` in
`viewer.ts`). Im Bild läuft damit **x nach unten links, y nach unten rechts und
z nach oben** — man sieht beiden waagerechten Achsen an, welche Richtung sie
meinen. Nicht auf der Winkelhalbierenden, weil dort zwei gleich lange Kanten
eines Klotzes deckungsgleich erscheinen und nicht mehr zu sehen ist, welche vorn
liegt; die flache Aufstellung zeigt stattdessen x als die lange Richtung im
Bild — und das ist die, in die der Klotz des Durchstichs läuft. Der Abstand ist
das **Fünffache** dessen, was das Szenario gerade formatfüllend zeigt
(`INITIAL_CAMERA_DISTANCE_FACTOR`) — so bleibt Umgebung und Platz zum Bauen im
Bild. *Ansicht einpassen* (`frameScene()`) rückt dagegen enger heran, auf das
1,15-Fache (`CAMERA_DISTANCE_FACTOR`): wer sie drückt, will das Szenario
formatfüllend und hat es mit der Bahn ohnehin vollständig in den Punkten. Geblickt wird nicht auf die Mitte des Szenarios, sondern eine halbe
Achsenlänge darüber (`FOCUS_LIFT`), wodurch die Szene im Bild tiefer sitzt und
oben Platz bleibt — dort passiert bei einem Fallversuch das Interessante, und
dort liegen die Ebenenknöpfe.

Three.js nimmt von Haus aus y als Hochachse an. Darum setzt der Betrachter
`camera.up` ausdrücklich auf `(0, 0, 1)`, und `OrbitLikeControls` rechnet seine
Kugelkoordinaten in ein Hilfssystem mit y-Polachse um und zurück
(`toFrame`/`fromFrame`) — `THREE.Spherical` kennt keine andere Konvention. Die
Umrechnung ist mit Absicht eine Drehung und keine Spiegelung, sonst liefe die
Szene beim Ziehen falsch herum.

Was *nicht* von der Weltachse abhängt: die lokalen Systeme. Eine Box-Geometrie
hat ihre Dicke weiterhin in lokaler y-Richtung, und `placeOnSegment` baut die
Basis aus Tangente und Normale des Segments — dort steht kein „oben" drin.

---

## Flächen: eine Grundform, viele Instanzen

Die Bibliothek enthält genau eine Flächen-Grundform, die **Ebene** — die
einzige **Randbedingung** (`Constraint`), die Stufe 1 kennt: eine unbewegliche
Rechteckplatte, die im Körpersystem waagerecht liegt. Lage, Drehung und Größe
stehen an der **platzierten Instanz** (`ConstraintSpec.pose` und
`ConstraintSpec.size`), nicht am Bibliothekseintrag.

Daraus folgt, dass die Rampe des Durchstichs zwei Instanzen derselben Ebene ist:
eine um +30° um die y-Achse gedrehte von 4 m Länge und ein waagerechter Auslauf
von 8,25 m. Sie überlappen an der Knickkante um 25 cm, damit eine Ecke an der
Naht nie außerhalb beider Rechtecke liegt und der Kontakt für einen Zeitschritt
ausfällt.

Der Grund für diesen Entwurf ist nicht Sparsamkeit, sondern Zerlegbarkeit: ein
Bibliothekseintrag „Schiefe Ebene mit Auslauf" lässt sich nachträglich nicht in
seine Teile zerlegen, und eine Neigung ist eine Eigenschaft der Aufstellung, nicht
des Materials. Deshalb erzeugt auch der **Bibliothekar** nur einzelne Flächen —
zwei Wege zu derselben Rampe wären teurer als einer.

Dass die Größe an der Instanz steht, gilt nur für Flächen mit **genau einem
Segment**: bei mehreren wäre nicht entscheidbar, welches gemeint ist, und
`constraintSegments` lehnt es ab, statt sie still auf das erste anzuwenden.
Dieselbe Funktion benutzen Simulator, Auswertung und Darstellung — rechnete die
Auswertung mit der Bibliotheksgröße, während die Physik die Instanzgröße nimmt,
würde der Durchdringungsbericht still falsche Abstände melden.

---

## Körper und Material: zwei Einträge, zwei Verweise

Ein platzierter Körper (`BodySpec`) verweist auf **zwei** Bibliothekseinträge:
auf einen **Körper** (`bodyId`, die Form — bisher nur der **Quader**) und auf
ein **Material** (`materialId` — Eisen, Holz …). Früher war der Körper eine
„Instanz eines Stoffs", die Form stand nur an der Instanz. Damit war die Form
kein Begriff der Bibliothek, und ein Materialwechsel hieß, den Körper neu
anzulegen.

- **Form und Material wechseln unabhängig.** Derselbe Quader aus Holz statt Eisen
  ist eine Änderung an `materialId` (`setEntityMaterial`); ohne gesetzte Masse
  rechnet der Kern sie aus der neuen Dichte.
- **Der Körper-Eintrag hat keine Farbe.** Wie ein Körper aussieht, bestimmt das
  Material; eine eigene Farbe am Körper wäre eine zweite Quelle.
- **Der Kern liest nur das Material.** Die wirksame Form steht wie die Größe einer
  Fläche an der Instanz (`phase.shape`); der Körper-Eintrag liefert nur die
  Voreinstellung beim Platzieren. `LibraryIndex` überspringt Körper-Einträge.
- **Ein neuer Körper oder eine neue Ebene bekommt das erste Material der Bibliothek.** Eine Rückfrage
  beim Platzieren wäre ein Klick mehr für etwas, das sich rechts jederzeit
  umstellen lässt. Die Startbibliothek führt deshalb „Standard" (1000 kg/m³, grau) als erstes Material.
- **Auch die Ebene hat ihr Material statt einer eigenen Farbe.** Der Randbedingungs-Eintrag
  hat wie der Körper-Eintrag kein `appearance`; die Optik der Fläche kommt aus
  `ConstraintSpec.materialId`, und mit ihr Stoßzahl und Reibung.
- **Materialien werden nicht platziert.** In der Bibliothek stehen sie ohne
  Knopf; zugewiesen werden sie in der rechten Leiste.

Dateien aus der Zeit vor der Trennung (`kind: "substance"`, `substanceId`)
lehnt das Schema ab — dieselbe Haltung wie bei jeder älteren Datei.

---

## Kontakte

Ein **Kontakt** besteht aus Normale, Tiefe und **Kontaktpunkten**. Die
Geometrie dazu liegt in [collision.ts](../packages/core/src/collision.ts), der
Löser in `contacts` in [mechanics.ts](../packages/core/src/modules/mechanics.ts).

### Kontaktpunkte: die Ecken der Kontaktfläche

Ein Flächensegment wird für den Test als **flache Platte mit seiner Dicke**
behandelt, also als Quader. Körper gegen Ebene ist damit dieselbe Rechnung wie
Quader gegen Quader: der Satz der Trennachsen (15 Achsen; Flächenachsen haben
Vorrang vor Kantenachsen, sonst springt die Normale bei fast paralleler Lage)
liefert Normale und Tiefe, danach entstehen die Punkte:

- **Flächenachse:** die einfallende Fläche des anderen Quaders — die der
  Bezugsfläche am stärksten zugewandte — wird an den vier Seiten der
  Bezugsfläche beschnitten (Sutherland–Hodgman). Jede Ecke hinter der
  Bezugsebene ist ein Kontaktpunkt. Liegt ein Quader flach auf, sind das die
  vier Ecken der *gemeinsamen* Fläche; ragt er über einen Rand, die Ecken des
  aufliegenden Teils; steht er auf einer Kante, deren zwei Endpunkte.
- **Kantenachse:** zwei Kanten kreuzen sich, der Kontaktpunkt ist die Mitte
  ihrer nächsten Punkte.
- **Kugel:** ein Punkt, ihr tiefster.

Dass die Platte Dicke hat, ist nicht Kosmetik: kippt ein Quader über den
Plattenrand, drückt die **Plattenkante** gegen seine Unterseite, und die Kraft
steht senkrecht auf *dieser*, nicht auf der Platte. Mit der Plattennormale gäbe
es reibungsfrei keine waagerechte Kraft; der Schwerpunkt käme nie über den
Rand hinaus, und der Quader schaukelte für immer auf der Kante. Eine Ausnahme:
die **Unterseite schiebt nie** (`upward` in `considerAxis`). Ein Körper, der
tiefer als die halbe Plattendicke eingesunken ist, wird trotzdem nach oben
herausgeschoben — eine Fläche hat eine Oberseite. Tiefer als die doppelte
Körpergröße zählt nicht mehr als Kontakt, sondern als durchgetunnelt
(`PENETRATION_LIMIT_FACTOR`).

### Wo die Kraft angreift: nicht im Flächenmittelpunkt

Naheliegend wäre, die Kontaktfläche auf ihren Mittelpunkt zu verdichten. Das
ist falsch: die resultierende Kraft greift im **Druckmittelpunkt** an, und der
liegt zwar immer in der Kontaktfläche, aber nur im Sonderfall in ihrer Mitte.
Ein Quader, dessen Schwerpunkt über den Plattenrand ragt, berührt die Platte
mit derselben Fläche wie einer, der sicher liegt — der eine wird über die ganze
Fläche getragen, der andere nur noch an der Kante, und genau deshalb kippt er.
Wo die Kraft angreift, ist eine Frage der Dynamik, nicht der Geometrie.

Der Löser verteilt den Impuls deshalb selbst auf die Kontaktpunkte. Gesucht sind
Impulse `λᵢ ≥ 0` so, dass nach dem Stoß an jedem Punkt die Normalgeschwindigkeit
mindestens ihr Ziel erreicht, und ein Punkt nur dann trägt, wenn er genau darauf
steht — ein Kontakt zieht nicht:

```
w = K·λ + b ≥ 0,   λ ≥ 0,   λᵢ·wᵢ = 0
Kᵢⱼ = 1/m_a + 1/m_b + (r_aᵢ × n)·I_a⁻¹(r_aⱼ × n) + (r_bᵢ × n)·I_b⁻¹(r_bⱼ × n)
```

`K` sagt, wie stark ein Einheitsimpuls am Punkt j die Normalgeschwindigkeit am
Punkt i ändert — durch Verschieben und durch Drehen. Gelöst wird das kleine
Komplementaritätsproblem **exakt**, durch Ausprobieren der tragenden
Teilmengen, kleinste zuerst (`solveContact`). Mehr als drei Punkte braucht es
nie: entlang einer Normale hat ein starrer Körper drei Freiheitsgrade
(Verschieben, zwei Kippungen), und jeder Druckmittelpunkt liegt in einem Dreieck
aus drei Ecken der Kontaktfläche. Die Aufteilung auf vier Ecken einer
aufliegenden Fläche ist deshalb nicht eindeutig — die Bewegung, die
herauskommt, schon. Die Reihenfolge der Teilmengen ist fest, der Lauf bleibt
deterministisch.

Exakt statt iterativ, weil die Tests es verlangen: der Gleittest erwartet
`g·sin 30°` auf 10⁻¹³, die Stoßtests die Stoßgesetze auf 10⁻⁹. Ein übliches
Gauß-Seidel-Verfahren über die Einzelpunkte erreicht das nicht in vertretbar
vielen Durchläufen, und sein Rest hinterlässt eine kleine Drehung, die von
Schritt zu Schritt mitgeschleppt wird. Aus demselben Grund ist die Toleranz
relativ (`SOLVER_TOLERANCE`, 10⁻¹² der aufzuhebenden Geschwindigkeit): eine
feste Schranke von 10⁻¹⁰ m/s ließ einen Stapel nach drei Sekunden um 10⁻⁹ m
seitlich wandern. Iteriert wird nur *zwischen* Kontakten — Stapel, ein Klotz an
der Knickkante —, höchstens `SOLVER_ITERATIONS`-mal, bis sich nichts mehr
ändert.

Zum Normalimpuls kommt je Kontakt die Reibung (siehe [Reibung](#reibung)).
Im Durchstich sind Rampe und Auslauf aus **Glatt**, dem reibungsfreien Material:
dann wirken alle Impulse entlang der Kontaktnormale, und die
Tangentialkomponente der Schwerpunktsgeschwindigkeit bleibt unberührt — auch
während der Klotz kippt. Das ist der Grund, warum er die schiefe Ebene mit genau
`g·sin α` hinabbeschleunigt und auf dem Auslauf mit konstanter Geschwindigkeit
weitergleitet, und warum es den Eingriff bei t = 2 s braucht, um ihn anzuhalten.

Was man im Durchstich sieht: der Klotz fällt achsenparallel auf die 30°-Rampe,
trifft mit einer Ecke auf und bekommt dabei rund 18 rad/s. Er hebt kurz ab,
landet über die Flächenlage hinaus auf der anderen Kante, schaukelt zurück und
liegt ab etwa 0,65 s flach auf — der Mittelpunkt eine halbe Kante über der
Rampe, nicht mehr wie früher 0,137 m auf der Ecke. An der Knickkante kippt er
ein zweites Mal, auf den Auslauf.

**Lagekorrektur.** Nach dem Lösen wird die Eindringtiefe herausgeschoben, ohne
Schlupfzone, damit ein Körper exakt aufliegt. Sie verschiebt nur und dreht
nicht; die Drehung besorgt der Impuls im nächsten Schritt. Reihenfolge: erst
alle Körperpaare, dann die Ebenen. Die Korrektur eines Paars kann einen Körper
in eine Ebene drücken; die Ebene hat das letzte Wort, damit nichts aus ihr
herausragt.

### Stoßzahl

**Die Stoßzahl gehört zur Paarung, gespeichert wird sie am Material.** Physikalisch
hat nicht „Eisen" eine Stoßzahl, sondern Eisen gegen Stahl. Das Modell nimmt
trotzdem eine Zahl je Material und verrechnet sie als **Minimum** der beiden
Beteiligten — für Körper gegen Körper wie für Körper gegen Ebene, die dafür das
Material ihrer Instanz mitbringt. Das Minimum hat die Eigenschaft, die man für
das Standardverhalten braucht: Standard hat Stoßzahl 0, also bleibt alles, was
mit Standard zusammenstößt, liegen, egal aus welchem Material es ist. Ein neues
Szenario verhält sich damit wie vor den Stoßzahlen.

Die Stoßzahl wirkt je Kontaktpunkt: das Ziel eines Punkts ist `−e·v⁻`, das
`e`-fache seiner Aufprallgeschwindigkeit vor dem Lösen. Beim zentralen Stoß
zweier Körper (alle Punkte gleich schnell, die Kraft durch beide Schwerpunkte)
ergibt das genau

```
j = −(1 + e) · v_rel / (1/m_a + 1/m_b),   v_rel = (v_b − v_a) · n
```

Der Impuls bleibt erhalten, bei e = 1 auch die Energie — auch beim Stoß auf eine
Ecke, bei dem ein Teil davon in Drehung übergeht; ein festgehaltener Körper
(`1/m = 0`) wirkt wie eine Wand.

**Ruheschwelle.** Ein aufliegender Körper fällt in jedem Schritt um `g·dt` in
seine Unterlage. Mit e > 0 gäbe jeder Kontakt davon den Anteil e zurück: der
Körper hüpfte in Mikrometern, und `contactCount` wechselte tausendmal pro
Sekunde zwischen 0 und 1. Unterhalb von `10 · |g| · dt` (bei Erdschwere und 1 ms
knapp 0,1 m/s) gilt deshalb e = 0. Zehn statt eines Schritts, weil ein Körper,
der sich nach dem Kippen auf eine Fläche legt, mit der zuletzt aufschlagenden
Kante etwas schneller ankommt als `g·dt`. Ohne Schwerkraft ist die Schwelle 0
und jeder Stoß prallt ab.

### Reibung

**Gemessen wird Reibung an einer Paarung, gespeichert wird sie am Material.**
Tabellen nennen „Stahl auf Stahl" oder „Holz auf Stahl"; einen Reibwert von
„Stahl" allein gibt es physikalisch nicht, und für die Kombination zweier
Werkstoffe gibt es keine Formel, die aus der Physik folgt. Reibung hängt an der
Oberfläche, an Schmierung, Feuchte und Temperatur. Jede Simulation, die
Materialien frei kombinieren lässt, braucht trotzdem eine Regel: Box2D und
Bullet nehmen das **geometrische Mittel** `√(μ_a·μ_b)`, PhysX und Unity
standardmäßig das arithmetische Mittel, wahlweise Minimum, Maximum oder Produkt.

Hier gilt das geometrische Mittel (`pairFriction` in mechanics.ts), für alle drei
Werte. Es liefert das Erwartete: zwei gleiche Materialien reiben mit ihrem
eigenen Wert — der Wert am Material ist deshalb der **gegen sich selbst**, so
fragt ihn auch der Bibliothekar ab —, und ein reibungsfreies Material (Glatt, 0)
macht jede Paarung reibungsfrei. Das Minimum, das die Stoßzahl nimmt, ließe ein
rutschiges Material jede Paarung allein bestimmen; das arithmetische Mittel ließe
Eisen auf Glatt noch mit halber Eisenreibung haften. Weil das Mittel monoton ist,
bleibt die Gleitreibung der Paarung unter der Haftreibung, wenn das für beide
Materialien gilt (die Prüfung lehnt μ_G > μ_H ab). Eine Paarungstabelle, die für
bekannte Paarungen den gemessenen Wert vor die Regel setzt, wäre eine Ergänzung
in genau dieser Funktion, kein Umbau.

Fehlt ein Reibwert am Material, ist es reibungsfrei — so verhielt sich jedes
Material vor der Reibung, und ältere Dateien laufen unverändert.

**Was gerechnet wird**, je Kontakt nach dem Normalimpuls (`solveFriction`):

| | Grenze | Wirkung |
|---|---|---|
| **Haftreibung** | `μ_H · N` | hebt die Relativbewegung am Druckmittelpunkt ganz auf, wenn der dafür nötige Stoß unter der Grenze bleibt |
| **Gleitreibung** | `μ_G · N` | sonst: derselbe Stoß, auf `μ_G · N` gekürzt |
| **Bohrreibung** | `μ · N · r_K` | dasselbe für die Drehung um die Normale, `r_K` aus der Kontaktfläche |
| **Rollreibung** | `f · N` | ein Moment gegen das Abrollen; `f` ist eine Länge (Hebelarm der Rollreibung) |

`N` ist die Summe der Normalimpulse des Kontakts; alles ist als Impuls je
Zeitschritt gerechnet, nicht als Kraft. Der Reibstoß greift am
**Druckmittelpunkt** an, dem mit den Normalimpulsen gewichteten Mittel der
Kontaktpunkte. Dass die Aufteilung auf die Ecken nicht eindeutig ist (drei
genügen), stört nicht: Summe und Moment der Normalimpulse sind eindeutig, und
nur die bestimmen den Druckmittelpunkt. Der Angriffspunkt zählt, weil die
Reibung unter dem Schwerpunkt angreift und einen gebremsten Klotz nach vorn
kippt; die Normalimpulse wandern daraufhin nach vorn. Deshalb wechseln sich
Normal- und Reibstoß je Kontakt ab, bis beide zueinander passen.

Haften oder Gleiten entscheidet sich in jedem Schritt neu am Stoß, der die
Bewegung ganz aufheben würde — nicht an einer Geschwindigkeitsschwelle. Ein
liegender Klotz auf 25° bleibt bei μ_G = 0,4 < tan 25° < μ_H = 0,5 liegen; ein
angestoßener gleitet weiter. Die Rollreibung ist eine Länge, weil sie aus der
Verformung an der Auflage kommt: das Moment ist `f·N`, der Rollwiderstand eines
Rads `f/r`. Sie wirkt auf jeden Kontakt, also auch auf einen Quader, der über
eine Kante kippt — dort ist sie um Größenordnungen kleiner als das Kippmoment.

**Lagenachtrag.** Der Reibstoß gehört in die Lage wie eine Kraft über den
Schritt: Velocity-Verlet bewegt um `v·dt + ½·a·dt²`, und `integrate` kennt die
Reibung noch nicht. Ohne Nachtrag (`½·dt·Δv` aus dem Reibstoß) kröche ein
haftender Klotz auf 30° um `½·g·sin α·dt²` je Schritt hangab, 2,5 mm/s, obwohl
seine Geschwindigkeit jeden Schritt wieder 0 ist. Mit dem Nachtrag bleibt die
Gleitbewegung so exakt wie der freie Fall: `a = g(sin α − μ_G cos α)` auf 10⁻¹⁴.
Die Normalrichtung braucht keinen, dort korrigiert die Eindringtiefe.

### Was Stufe 1 und 2 bewusst nicht können

- **Reibung und Stoßzahl zusammen können Energie erzeugen.** Mit Newtons
  Stoßzahl (Ziel `−e·v⁻` je Punkt) und Coulomb-Reibung kann ein elastischer
  Stoß außerhalb des Schwerpunkts mehr Energie hinterlassen, als vorher da war —
  Kanes Paradoxon. Bei einem Würfel, der mit e = 1 schräg auf eine Ecke fällt,
  sind es knapp 2 %. In Stichproben mit den mitgelieferten Materialien
  (e ≤ 0,4; 54 Eckstöße verschiedener Lage und Geschwindigkeit) trat es nicht auf. Abhilfe wäre die Stoßzahl nach Poisson (auf den
  Impuls bezogen statt auf die Geschwindigkeit).
- **Bohrreibung ist genähert.** Der wirksame Radius der Kontaktfläche ist zwei
  Drittel des mittleren Eckabstands vom Mittelpunkt, nicht das druckgewichtete
  Mittel über die Fläche (für ein Quadrat ein Viertel zu hoch). Schieben und
  Bohren werden getrennt begrenzt, nicht gemeinsam. Eine Kugel (ein Punkt) hat
  keine Bohrreibung.
- **Haften konvergiert langsam.** Normal- und Reibstoß stimmen sich über das
  Kippmoment ab; bei einem haftenden Quader schrumpft der Rest je Durchlauf um
  etwa 40 %, nach `SOLVER_ITERATIONS` bleiben einige 10⁻¹⁰ m/s — das
  sind Nanometer je Sekunde.
- Die Lagekorrektur **dreht nicht**. Bei den kleinen Eindringtiefen von
  1-ms-Schritten fällt das nicht auf; bei großen Zeitschritten kann ein schräg
  einsinkender Körper dadurch etwas angehoben werden, statt aufgerichtet.
- Kontakte werden in jedem Schritt **neu erkannt**, ohne Gedächtnis über
  Schritte hinweg. Für wenige Körper genügt das; für hohe Stapel wäre das
  Weiterreichen der Impulse des letzten Schritts die nächste Verbesserung.

### Eigener Löser statt Physik-Engine

Der Durchstich käme auch mit Rapier oder cannon-es zustande. Trotzdem eigener
Löser:

1. **Der Zustand muss in einer Hand bleiben.** Eine fremde Engine besitzt die
   Positionen; Temperaturen und Stoffmengen lägen daneben. Zwei Quellen der
   Wahrheit brechen genau da, wo die Kopplung interessant wird.
2. **Determinismus über Plattformen.** Eine WASM-Engine ist bei gleicher
   Binärversion deterministisch, aber nicht garantiert zwischen Linux-Server und
   Windows-Browser.
3. **Der Fall ist klein.** Wenige Körper gegen fixierte Flächen und gegeneinander,
   ein exakter Normallöser je Kontakt, Reibung als Coulomb-Grenze daneben: ein
   paar hundert Zeilen.

**Umkehrpunkt:** Sobald viele Körper mit Stapeln, Gelenken und bleibenden
Kontakten dazukommen, ist ein eigener Löser Arbeit, die Rapier schon geleistet
hat. Dann wird die Mechanik hinter einer `SolverBackend`-Grenze gekapselt und
ausgetauscht — mit der Konsequenz, dass Bit-Determinismus über Plattformen
fällt. Die Modulgrenze hält die Entscheidung offen.

---

## Aufzeichnung statt Video — mit gemessenen Zahlen

Die Aufzeichnung speichert **keine Partikelpositionen**. Atome und Elektronen
werden beim Abspielen aus `(Seed, Entitäts-Id, Zustand, t)` prozedural erzeugt.
Gespeichert wird nur der Zustandsvektor.

Gemessen (JSON, gzip):

| Fall | roh | gzip |
|---|---|---|
| Durchstich: 1 Körper, 4 s, 20 Hz | 28 kB | **2,9 kB** |
| 10 Körper, 60 s, 20 Hz | 3 306 kB | **368 kB** |

Zum Vergleich: ein 60-Sekunden-Clip in 1080p liegt bei 5–20 MB. Die Aufzeichnung
ist also 15- bis 50-fach kleiner **und** behält freie Kamera, Scrubbing,
umschaltbare Darstellungsebene und die Möglichkeit, Eingriffe zu ändern und neu zu
simulieren.

> **Korrektur gegenüber der ersten Planung.** Dort stand „~1 MB roh / ~50 kB
> gzip" für den 10-Körper-Fall. Gemessen sind es 3,3 MB / 368 kB — etwa das
> Siebenfache. Ursache ist JSON mit voller Float-Präzision: `-1.7320000000000002`
> sind zwanzig Zeichen, und pro Körper und Schnappschuss stehen neunzehn solche
> Zahlen (Lage 3, Orientierung 4, Geschwindigkeiten 6, Kraft 3, Beschleunigung
> 3). Das Argument für die Aufzeichnung hält, die Zahl war zu optimistisch.

Gemessene Hebel, falls das Format später knapp wird:

| Maßnahme | gzip | Preis |
|---|---|---|
| wie gebaut | 368 kB | — |
| auf 6 Dezimalstellen runden | 221 kB | keiner, der sichtbar wäre |
| nur Lage und Orientierung, als Felder | 115 kB | die kinematische Ansicht verliert ihre Daten |

Die Rundung ist der naheliegende erste Schritt: 40 % für wenige Zeilen und ohne
Formatänderung. Sie ist **nicht** implementiert — der Durchstich kommt ohne sie
aus, und ein Exportformat zu bauen, das niemand verlangt hat, hätte den Umfang
ausgeweitet.

### Warum Kraft und Beschleunigung überhaupt aufgezeichnet werden

Beide wären aus dem Verlauf ableitbar — aber eine Ableitung aus
20-Hz-Schnappschüssen ist genau im Stoßzeitpunkt unbrauchbar, also dort, wo man
sie am meisten sehen will. Die kinematische Ansicht zeichnet sie als Pfeile.
Damit hat jedes Feld des Schemas einen Leser, und das ist die Bedingung dafür,
dass es überhaupt im Schema stehen darf.

---

## Darstellungsebenen

| Ebene | Liest | Zeigt | Status |
|---|---|---|---|
| `macroscopic` | Lage, Orientierung | Körper und Flächen als Volumen | fertig |
| `kinematic` | Lage, Geschwindigkeit, Kraft, Beschleunigung | Pfeile, Bahnkurve | fertig |
| `atomic` | Lage, Gitterform, Packungsdichte | Kugelgitter, starr mitbewegt | fertig (schematisch) |
| `subatomic` | Ordnungszahl, Schalenbesetzung | Kern und Elektronenschalen | Berechnung fertig, Renderer fehlt |
| `thermal` | Temperatur, Wärmeströme | Falschfarbenfeld | mit Thermodynamik |
| `fields` | Gravitations-Lasten, Kraftfelder | Feldlinien | später |

Umgeschaltet wird über quadratische Icon-Knöpfe, die mittig oben **auf** dem
Grafikbereich liegen — die Ansichtswahl gehört zum Bild, nicht in eine
Seitenleiste. In der Oberfläche heißen die Ebenen **Standard**, **Kinematik**
und **Atome**; die technischen Namen bleiben im Code.

Koordinatenachsen (x rot, y grün, z blau, z nach oben) hängen an der Szene und
nicht an einer Ebene: die Orientierung im Raum ist in jeder Ansicht dieselbe
Frage. Ihre Länge ist feste **1 m** und wächst nicht mit der Szene mit, denn sie
beantwortet zwei Fragen auf einmal: wo ist der Ursprung, und wie groß ist der
Klotz. Eine mitwachsende Achse sähe in jeder Szene gleich gut aus und taugte als
Maßstab nicht. Die Achsenbeschriftungen der Zahlenfelder im Inspektor tragen
dieselben Farben, damit ein Feld und die Achse, auf die es wirkt,
zusammengehören.

### Die atomare Ansicht ist schematisch, und sie sagt es

Eisen hat eine Gitterkonstante von 287 pm; ein Klotz von 20 cm Kante enthält
etwa 3 · 10²³ Atome. Darstellbar sind einige Tausend. Jede atomare Ansicht einer
makroskopischen Probe ist also um zwanzig Größenordnungen daneben — die Frage
ist nur, ob sie das zugibt.

Was **echt** ist: die Gitterform (kubisch, raumzentriert, flächenzentriert) und
das Verhältnis von Atomradius zu Gitterkonstante, also die Packungsdichte. Beide
stammen aus dem Bibliothekseintrag. Was **schematisch** ist: die absolute
Zellgröße.

`AtomicRenderer.schematicNote` ist Teil der Schnittstelle, damit die Oberfläche
den Hinweis nicht weglassen kann, ohne es zu merken.

### Elektronenkonfiguration wird berechnet, nicht erfragt

Aus der Ordnungszahl per Aufbauprinzip. Die Besetzungsreihenfolge ist eine feste
Regel, und ein Modell, das 118 Konfigurationen aus dem Gedächtnis schreibt, irrt
sich gelegentlich. Die echten Ausnahmen (Cr, Cu, Pd, …) stehen als Override im
Bibliothekseintrag. Das entfernt eine ganze Klasse von Halluzinationen.

---

## Prüfung der KI-Ausgaben

Schema-Validierung allein genügt nicht: Eisen mit der Dichte von Styropor
passiert jedes Zod-Schema. Die Haltung ist **korrigieren, wo eine belastbare
Referenz existiert; ablehnen, wo der Eintrag in sich widersprüchlich ist.**

1. **Vorzeichen und Bereiche** — Dichte, Molmasse > 0; Stoßzahl in [0, 1].
2. **Querbezüge** — Schmelzpunkt unter Siedepunkt. Nicht reparierbar, weil
   unklar ist, welcher Wert gemeint war → Ablehnung.
3. **Geometrische Konsistenz** — Normalen normiert (wird korrigiert, die Richtung
   steht fest), Tangente senkrecht zur Normale (Ablehnung, die Ebene wäre nicht
   eindeutig).
4. **Formelkonsistenz** — die molare Masse muss zur Summenformel passen. Ein
   Parser für `Fe2O3`, `Ca(OH)2`, `CuSO4` rechnet sie nach.
5. **Elementbilanz von Reaktionen** — `4 Fe + 3 O₂ → 2 Fe₂O₃` passiert,
   `Fe + O₂ → Fe₂O₃` nicht. Steht bereit für Stufe 4 und ist schon jetzt
   getestet; eine Bilanzprüfung, die erst mit der Chemie entsteht, entsteht
   erfahrungsgemäß nie.
6. **Referenztabelle** der Elemente 1–118. Weicht ein KI-Wert um mehr als 5 % ab,
   gilt der Referenzwert, und `Provenance.correctedFields` vermerkt es.

Punkt 6 ist der wichtigste und der billigste: für Elemente braucht die KI
überhaupt keine Zahlen zu erfinden, nur die Darstellung zu entwerfen.

Abdeckung der Tabelle, ehrlich benannt: Ordnungszahl, Symbol, deutscher Name und
molare Masse für alle 118. Dichte, Schmelz- und Siedepunkt nur für die im
Unterricht gängigen Elemente; für die übrigen kann die Prüfung sie nicht
gegenprüfen und übernimmt den KI-Wert mit Hinweis.

---

## Modellwahl und API-Eigenheiten

- **Bibliothekar**: `claude-sonnet-5-5`. Ein Aufruf mit festem Schema; Opus wäre
  Verschwendung bei einem Aufruf pro Material.
- **Regisseur**: läuft in Hermes, das Modell wählt Hermes. Empfohlen bleibt ein
  starkes Modell (`claude-opus-5-5`, `effort: "high"`): ein schwächeres braucht
  mehr Prüfrunden, kommt durch die Prüfung aber nicht mit einem kaputten
  Szenario durch.

Zwei Eigenheiten bestimmen den Code:

- `tool_choice: {type: "any"}` gibt auf Claude Sonnet 5.5 und Claude Opus 5.5
  einen 400er. Der Bibliothekar nutzt deshalb `messages.parse()` mit
  `output_config.format`, nicht einen erzwungenen Werkzeugaufruf. Für einen
  Datensatz statt einer Aktion ist das ohnehin das passendere Mittel.
- Wer den Regisseur doch selbst mit der Claude API baut: der Loop muss
  `stop_reason === "pause_turn"` behandeln, sonst bricht ein langer Lauf
  stillschweigend ab.

Zur Alternative zwischen Material und Randbedingung: sie ist als Diskriminator plus zwei
optionale Felder modelliert, nicht als diskriminierte Union. Letztere wird zu
`anyOf` mit Konstanten, und das ist für strukturierte Ausgaben je nach
Modellversion heikel. Ein Test prüft ohne Netzaufruf, dass
`zodOutputFormat(LibrarianDraft)` das Schema umwandeln kann — sonst scheitert
jeder echte Aufruf erst zur Laufzeit, mit Zugangsdaten und Kosten.

---

## Zeit: Eingriffe mit Zeitpunkt, Gesamtdauer für sich

Jeder Eingriff trägt seinen Zeitpunkt `t`; die **Gesamtdauer** steht als eigenes
Feld `Scenario.duration`. Die beiden hängen nicht aneinander — darin liegt der
Unterschied zu den früheren Etappen, bei denen die Gesamtlänge die Summe der
Etappendauern war und jede Dauer alle späteren Abschnitte verschob.

Zwei Quellen für dieselbe Zeitangabe gibt es dabei nicht: ein Eingriff hat genau
eine Zeit, das Szenario genau eine Dauer. Was früher abgeleitet wurde
(Startzeit einer Etappe), wird nicht mehr gebraucht.

| Eingabe | Was sich ändert |
|---|---|
| Zeit eines Eingriffs | Nur dieser Eingriff. Er reiht sich hinter die Eingriffe, die schon zur neuen Zeit stehen. Passt danach die Zeitfolge des Objekts nicht mehr (ein `add` hinter seinem „Ändern"), wird die Änderung abgelehnt statt still aufgeräumt. |
| Gesamtdauer | Nur das Ende. Eingriffe dahinter bleiben stehen und sind **unwirksam** — ausgegraut in der Liste, ohne Raute. Wird die Dauer wieder verlängert, wirken sie wieder. |
| Neuer Eingriff | Entsteht zur Zeit des Zeitcursors, gerundet auf 0,01 s; während der Wiedergabe gar nicht. |

Gerundet wird, weil der Zeitcursor nach einer Pause auf einer beliebigen Zeit
steht. Ungerundet lägen zwei Eingriffe, die beide „1.23 s" zeigen, in zwei
Rauten nebeneinander. Der Simulator wendet einen Eingriff am nächstgelegenen
Zeitschritt an; einer genau bei `t = Gesamtdauer` wird nie erreicht.

Ein leeres Szenario dauert 5 s und hat einen Eingriff: das Hinzufügen der
Schwerkraft bei t = 0.

### Ändern: eine Eigenschaft je Eingriff, Eingabewerte aus dem Szenario

Ein „Ändern"-Eingriff (`op: "change"`) setzt genau eine Eigenschaft — ersetzt
haben ihn die früheren `move`, `setVelocity` und `setParameter`: vier Wege, einen
Wert zu setzen, waren drei zu viel. Die Eigenschaften zerfallen in zwei Sorten
(`CHANGE_KEYS` in `packages/schema/src/changes.ts`):

- **Zustandsgrößen** — Lage, Geschwindigkeit, Winkelgeschwindigkeit eines
  Körpers. Die Änderung setzt den Wert zur Zeit `t`, danach rechnet die Physik.
  Wo der Körper später ist, weiß nur die Aufzeichnung.
- **Eingabeeigenschaften** — alles andere, auch die Lage einer Randbedingung
  (eine Fläche bewegt sich nie von selbst). Ihr Wert zu jeder Zeit folgt allein
  aus dem Szenario: `entitySpecAt` faltet die Startwerte mit allen Änderungen.

Deshalb stehen Eingabewerte **nicht** im Schnappschuss. Der Simulator baut aus
der gefalteten Spec Masse, Trägheit und Segmente neu; die Renderer bauen beim
`build` je Spec, die eine Entität annimmt, eine eigene Variante und schalten im
`update` nur um (`entityStages`, `showVariant` in `packages/render/src/common.ts`).
Geometrie entsteht so nie während der Wiedergabe, und auch das Atomgitter eines
anderen Materials stimmt. Dieselbe Faltung (`applyEntityChange`) an allen drei
Stellen hält sie gleich — auch bei gleichen Zeiten, die in Listenreihenfolge gelten.

Die Vorbelegung eines neuen „Ändern" liest nur das Szenario, nie die Aufzeichnung:
eine Zustandsgröße startet bei null (Geschwindigkeit) bzw. der Startlage. Sonst
führte ein Pfeil von der Aufzeichnung zurück ins Szenario.

**Später: Interpolation.** Weil jeder Eingriff genau einen Schlüssel trägt,
sind die Änderungen desselben Schlüssels einer Entität die Stützstellen einer
Rampe („Ebene dreht sich von hier bis dort"). Ein optionales Feld am `change`
kann dann heißen: vom vorigen Wert bis hierher interpolieren. `entitySpecAt`
und die Renderer müssten dafür zwischen zwei Ständen rechnen statt umzuschalten,
der Simulator den Wert je Schritt setzen — Quaternionen per nlerp, also ohne
Winkelfunktionen.

---

## Szenarien speichern und laden

Als Dateien (`*.scenario.json`), nicht im Browser-Speicher: ein Szenario ist
damit teilbar, versionierbar und liegt dort, wo der Benutzer es wiederfindet.
Browser-Daten sind an einen Browser gebunden und beim Löschen der Website-Daten
weg.

Geladen wird **immer durch das Schema**. Eine Datei von der Platte ist fremde
Eingabe — auch die eigene von letzter Woche, die noch einem älteren Schema folgt.
Über das Schema hinaus prüft `parseScenario`, dass die Datei ihre
Bibliothekseinträge mitbringt; sonst scheitert erst der Lauf, und die
Fehlermeldung käme an der falschen Stelle.

Die Datei ist eingerückt, weil sie von Hand lesbar und in Git diffbar sein soll —
ein Szenario ist Quelltext, nicht Transportformat.

Das Startszenario der Oberfläche ist **leer**. Ein vorgefülltes Beispiel ist
bequem für die erste Minute und im Weg für jede danach. Das Durchstich-Szenario
liegt als `createInclinedPlaneScenario()` im Quellcode und ist über
`?szenario=durchstich` erreichbar.

---

## Grenze zur Lernplattform

Da die Plattform parallel entsteht, ist die Grenze versioniert und aus
**denselben** Zod-Schemas erzeugt, die den Kern typisieren — das Dokument kann
damit nicht veralten.

| Endpunkt | Zweck |
|---|---|
| `GET /v1/health` | Erreichbarkeit, und ob der Bibliothekar eingerichtet ist |
| `GET /v1/library` | Die Startbibliothek |
| `GET /v1/scenarios/durchstich` | Ein Szenario zum Abspielen |
| `GET /v1/scenarios/{id}` | Ein vom Regisseur abgelegtes Szenario |
| `POST /mcp` | Die Sandbox-Werkzeuge für den Regisseur (MCP, Streamable HTTP) |
| `POST /v1/library/synthesize` | Bibliothekar: Text rein, geprüftes Objekt raus |
| `POST /v1/library/validate` | Einen Eintrag prüfen, ohne das Modell zu rufen |
| `POST /v1/runs` | Szenario rein, Aufzeichnung samt Zusammenfassungen raus |
| `GET /v1/openapi.json` | Das Schema, generiert (86 kB) |

Statuscodes mit Bedeutung: **422** heißt „die Anfrage war in Ordnung, die
Antwort des Modells nicht" — ein abgelehnter Eintrag ist kein Serverfehler.
**503** heißt „keine Zugangsdaten", mit Hinweis, wie man sie einrichtet; **502**
heißt „der Modellaufruf ist gescheitert". Der Unterschied ist nicht kosmetisch:
502 sagt „Modell kaputt", 503 sagt „du musst dich anmelden".

Der API-Schlüssel verlässt den Dienst nie. Studio und Abspieler rufen den
Dienst, nicht die Claude API.

### Die Simulation läuft im Browser

`@sandbox/core` hat keine Grafik-Abhängigkeit und wird ins Studio-Bundle
mitgenommen. Ein Klick auf Play braucht deshalb keinen Netzaufruf; der Dienst
wird nur für den Bibliothekar gebraucht — also für den einen Fall, in dem ein
Schlüssel im Spiel ist.

Dasselbe gilt für die Lernplattform: sie kann eine Aufzeichnung serverseitig
erzeugen *oder* das Szenario an den Browser geben und dort laufen lassen. Beide
Wege liefern dasselbe Ergebnis, weil der Kern deterministisch ist.

### Der Regisseur als MCP-Client

```
Lernplattform ──Lehrauftrag──▶ Hermes (Regisseur, eigenes Modell)
                                  │  MCP über HTTP, Bearer-Token
                                  ▼
                       apps/service  POST /mcp
                         bibliothek_auflisten
                         szenario_pruefen      ◀─ beliebig oft
                         szenario_abschliessen ─▶ Szenarioablage
                                  │ Studio-Link
                                  ▼
Lernplattform bettet ein: <iframe src="…/studio/?szenario=<kennung>">
                                  │ GET /v1/scenarios/<kennung>
                                  ▼
                       Studio lädt, simuliert im Browser
```

Drei Entscheidungen:

1. **Ein ganzes Szenario je Aufruf, keine Einzelschritte.** Das Szenario ist die
   Quelle der Wahrheit; ein Werkzeug je Bearbeitung (`add_body`, `move` …)
   hieße, die Bearbeitungslogik aus `scenarioEdits.ts` für das Modell ein
   zweites Mal zu bauen und einen Zwischenstand auf dem Server zu pflegen. So
   ist der MCP-Endpunkt zustandslos: je Anfrage ein frischer Server, nichts
   geht bei einem Neustart verloren.
2. **Bedieneinheiten im Entwurf.** Der `ScenarioDraft` nimmt Grad, volle
   Kanten und Grad/s — dieselben Einheiten wie die rechte Leiste — und nur
   Kennungen aus der Startbibliothek. Quaternionen, halbe Kanten und die
   eingebettete Bibliothek erzeugt `assembleScenario`. Derselbe Grund wie beim
   Bibliothekar: die Geometrie rechnet der Code.
3. **Ablegen statt Durchreichen.** Ein Szenario mit Bibliothek hat schon bei einem Körper 4–8 kB;
   es durch das Modell zur Plattform abschreiben zu lassen ist unzuverlässig,
   und in eine URL passt es nicht. Der Regisseur bekommt einen Link, die
   Plattform bettet ihn ein.

Die Prüfung unterscheidet **Fehler** (Szenario wird nicht abgelegt: Schema,
unbekannte Kennung, unpassender Änderungsschlüssel, Körper steckt mehr als 1 cm
in einer Platte) von **Warnungen** (läuft, sieht aber nach einem Versehen aus:
Körper fällt an allen Flächen vorbei, Eingriff nach dem Ende). Ein Körper neben
der Rampe kann gewollt sein, einer in der Platte nie.

Der API-Schlüssel des Dienstes spielt dabei keine Rolle: das Modell des
Regisseurs bezahlt und konfiguriert Hermes.

---

## Reihenfolge der Physikdomänen

| Stufe | Inhalt | Neue Kopplung |
|---|---|---|
| **1** | Mechanik: Translation, Rotation, Kontakt ohne Reibung, Stoßzahl (Körper–Körper und Körper–Ebene), Kontaktdrehmoment (Kippen, Kantenkontakt, Stapel) | Rotation ↔ Kontakt |
| **2** | Reibung (Haft-, Gleit-, Bohr-, Rollreibung — erledigt), Luftwiderstand | Materialdaten ↔ Mechanik |
| **3** | Thermodynamik: Leitung, Strahlung, Konvektion, Phasenübergänge | **Reibungswärme** — Stufe 2 speist Stufe 3 |
| **4** | Chemie: Reaktionen, Arrhenius-Kinetik, Stoffumsatz | **Temperatur treibt Reaktionsrate** — Stufe 3 speist Stufe 4 |

Jede Stufe hat eine echte Kopplung an die vorige, und zwar genau die, die
didaktisch interessant ist. Die Reihenfolge ist deshalb nicht nur
Aufwandssortierung, sondern baut die Kopplungen in der Richtung auf, in der sie
physikalisch wirken.

Wenn die Chemie `exp` für die Arrhenius-Gleichung braucht, kommt eine eigene,
versionierte Implementierung in `@sandbox/core` — keine Engine-Funktion. Die
Determinismusregel gilt weiter.
