# Physik-Sandbox

Interaktive 3D-Sandbox für Physik- und Chemie-Abläufe. Man baut eine Szene,
legt zeitlich gestaffelte Eingriffe fest, drückt Play und wechselt zwischen
makroskopischer, kinematischer und atomarer Darstellung.

Zwei Nutzergruppen, ein Kern:

1. **Mensch am Werkzeug** — die Sandbox-Oberfläche (`apps/studio`).
2. **KI-Agent als Autor** — eine Lernplattform übergibt einen Lehrtext, ein
   Agent baut daraus ein Szenario. Die Grenze dafür steht (`apps/service`), der
   Agent selbst noch nicht.

Das Ergebnis ist **keine Videodatei**, sondern eine abspielbare, weiter
bedienbare Aufzeichnung: Kamera frei drehbar, Zeit scrubbar, Darstellungsebene
umschaltbar, Eingriffe änderbar und neu simulierbar.

**Stand:** Stufe 1 — klassische Mechanik (Translation, Rotation, Kontakt ohne
Reibung). Thermodynamik und Chemie haben ihren Platz im Schema und in der
Pipeline, sind aber noch nicht implementiert. Siehe
[Was noch nicht da ist](#was-noch-nicht-da-ist).

---

## Loslegen

```bash
npm install
npm test                    # alle Pakete
npm run dev                 # Sandbox-Oberfläche auf http://localhost:5173
npm run service             # Dienst auf http://127.0.0.1:8787 (optional)
```

Die Simulation läuft im Browser — für Play braucht es den Dienst nicht. Er wird
nur für den **Bibliothekar** gebraucht, den KI-Aufruf, der neue Objekte erzeugt.
Dafür sind Zugangsdaten nötig:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # oder: ant auth login
npm run service
```

Ohne Zugangsdaten läuft der Dienst trotzdem; `/v1/library/synthesize` antwortet
dann mit 503 und einem Hinweis.

---

## Bedienung

Beim Start ist das Szenario **leer**: 5 s lang, Schwerkraft an, sonst
nichts. Ein vorgefülltes Beispiel ist bequem für die erste Minute und im Weg für
jede danach.

**Etwas bauen:** links einen Eintrag anklicken (*Ebene* oder *Quader*), dann
in die Szene klicken. Flächen landen auf dem Klickpunkt, Körper etwas darüber —
damit sie fallen statt in der Fläche zu stecken. Ein neuer Körper ist aus dem
ersten Material der Bibliothek. Lage, Drehung, Größe und Material werden
danach rechts unter **Randbedingungen** bzw. **Körper** gepflegt; dort
den Eintrag anklicken. Die Bibliothek ist gegliedert in Randbedingungen, Lasten, Körper
und Materialien; Materialien werden nicht platziert, sondern einem Körper
zugewiesen. Die rechte Leiste ist nach den Entitätsklassen gegliedert —
Randbedingungen, Körper, Lasten, zuletzt die Eingriffe. Die Masse eines
Körpers ist kein eigenes Feld: sie ergibt sich aus Dichte des Materials und
Volumen.

**Lasten** (z. B. *Gravitation*) stehen links in einer eigenen Liste. Ein Klick
genügt — eine Last hat keine Lage und braucht deshalb keinen Klickpunkt in der
Szene. Stärke und Richtung werden rechts unter **Lasten** gepflegt, genau wie
bei Körpern und Randbedingungen durch Aufklappen.

**Ansicht:** die quadratischen Knöpfe mittig oben im Bild — *Standard*,
*Kinematik*, *Atome*, und ganz rechts *Ansicht einpassen*. Die Koordinatenachsen
sind x rot, y grün, z blau; die Achsenbeschriftungen der Zahlenfelder rechts
tragen dieselben Farben. **Z zeigt nach oben** — eine Höhe steht im dritten
Zahlenfeld, und die Schwerkraft zeigt nach −z. Jede Achse ist genau **1 m**
lang und damit zugleich der Maßstab im Bild. In der Standardansicht läuft x nach
unten links, y nach unten rechts und z nach oben; *Ansicht einpassen* stellt sie
wieder her.

**Zeit:** unten. Die beiden Zahlenfelder über dem Schieber sind der
**Zeitcursor** (die aktuelle Zeit) und die **Gesamtdauer**. Der Zeitcursor ist
mit dem Schieber gekoppelt; während der Wiedergabe ist sein Feld nur Anzeige.
Jeder Zeitpunkt mit Eingriffen hat eine **Raute** auf dem Schieber — mehrere
Eingriffe zur selben Zeit teilen sich eine. Ein Klick auf die Raute setzt den
Zeitcursor dorthin; die Raute unter dem Zeitcursor ist hervorgehoben. Wird die
Gesamtdauer gekürzt, bleiben Eingriffe dahinter bestehen, wirken aber nicht: sie
haben keine Raute und stehen ausgegraut in der Liste.

**Eingriffe:** auch das Hinzufügen eines Objekts ist ein Eingriff. Jeder neue
Eingriff entsteht zur Zeit des **Zeitcursors** (auf 0,01 s gerundet) — auch das
Platzieren aus der Bibliothek. Während der Wiedergabe lässt sich deshalb nichts
platzieren und kein Eingriff anlegen. Weitere Eingriffe — *Hinzufügen*,
*Entfernen*, *Ändern* — legt das Steuerelement unter der Liste **Eingriffe**
an: Objekt und Art wählen. Vorbelegt sind das aufgeklappte Objekt und je
nachdem, ob es am Zeitcursor da ist, *Entfernen* oder *Hinzufügen*. Die Zeit
eines Eingriffs lässt sich in der Liste ändern. Einen Eingriff aus der Liste zu
löschen lässt das Objekt bestehen.

*Ändern* setzt zu seiner Zeit genau eine Eigenschaft: Position, Drehung, Größe
bzw. Kantenlänge, Material, Opazität, Stärke, Richtung — und beim Körper auch
Geschwindigkeit und Winkelgeschwindigkeit, die sonst die Physik fortschreibt.
Ein *Ändern* klappt in der Liste auf; dort lassen sich Eigenschaft und Wert
bearbeiten. Ein neues *Ändern* an einem Körper ist mit Geschwindigkeit null
vorbelegt — das frühere „Anhalten“.

**Speichern und Laden:** oben rechts, als `*.scenario.json`-Datei.
*Zurücksetzen* fragt nach und leert dann alles.

### Das Durchstich-Beispiel

Nicht automatisch geladen, aber über `http://localhost:5173/?szenario=durchstich`
erreichbar: ein Eisenklotz fällt aus 1 m Höhe auf eine um 30° geneigte Ebene,
rutscht reibungsfrei ab und gleitet auf den horizontalen Auslauf. Bei t = 2 s
setzt ein *Ändern* seine Geschwindigkeit auf Null — reibungsfrei gibt es nichts,
was ihn sonst bremsen würde. Genau deshalb gibt es diesen Eingriff: er zeigt,
dass ein Eingriff den laufenden Zustand ändert.

Die Rampe ist dabei **zwei Instanzen derselben Festen Ebene**: eine um −30°
gedrehte und ein waagerechter Auslauf. Das lohnt den Blick in die
Eigenschaften — es ist der ganze Flächenentwurf in einem Beispiel.

Gegenproben, die etwas aussagen:

- Auf **Kinematik** umschalten: der Geschwindigkeitspfeil wächst beim Fall,
  knickt beim Aufprall in die Flächenrichtung, bleibt auf dem Auslauf konstant
  und verschwindet nach t = 2 s.
- Rechts unter **Lasten** die *Schwerkraft* anklicken und ihre Stärke auf 0
  setzen (oder *Entfernen* wählen) — der Klotz bleibt in der Luft stehen. Das
  ist die Gegenprobe dazu, dass Schwerkraft eine Last ist und kein
  eingebautes Gesetz.
- Den **Auslauf verkürzen** (rechts anklicken, Größe `L` auf 1 m): der Klotz
  fällt hinten herunter. Die Instanzgröße wirkt wirklich auf die Physik.

---

## Aufbau

```
packages/
  schema/   Zod-Schemas, Typen, Referenztabelle der Elemente, Prüfung
  core/     Zustandsschicht: Pipeline, Integrator, Mechanik-Modul, Aufzeichner
  render/   Darstellungsschicht: Three.js, ein Renderer je Ebene, Abspielkopf
apps/
  studio/   Die Sandbox-Oberfläche (React + Vite + Three.js)
  service/  Bibliothekar, Simulationsendpunkt, OpenAPI
```

Drei Eigenschaften tragen das:

- **`packages/schema` ist doppelt verwendet.** Dieselben Zod-Schemas validieren
  die KI-Antwort (über `zodOutputFormat`) *und* typisieren den Kern. Eine
  Schemaänderung kann nicht vergessen werden — sie bricht beide Seiten sofort.
- **`packages/core` hat keine Grafik-Abhängigkeit.** Derselbe Code läuft im
  Browser, in Node und im Test.
- **Der API-Schlüssel verlässt `apps/service` nie.**

Die Begriffe sind verbindlich festgelegt: **[docs/glossar.md](docs/glossar.md)**.
Die Entwurfsentscheidungen samt Begründungen und gemessenen Zahlen:
**[docs/architektur.md](docs/architektur.md)**.

Wer etwas ändern will, fängt hier an:
**[docs/aenderungsleitfaden.md](docs/aenderungsleitfaden.md)** — welcher Wert an
welcher Stelle lebt, welche Stellen nur Spiegel sind, und bei welcher Aufgabe
welche Dateien anzufassen sind.

---

## Verifikation

```bash
npm test          # 227 Tests über fünf Pakete
npm run typecheck # alle Pakete
```

Die Mechanik-Tests prüfen gegen analytische Lösungen, nicht gegen gespeicherte
Erwartungswerte:

| Test | Erwartung | gemessen |
|---|---|---|
| Freier Fall | `s = ½gt²`, `v = gt` | relativ < 10⁻⁹ |
| Gleiten auf 30°-Ebene | `a = g·sin 30° = 4,905 m/s²` | **4,905000000**, Abw. 8 · 10⁻¹⁵ |
| Horizontaler Auslauf | `a = 0` | exakt 0 |
| Durchdringung | ≥ 0 | −1,2 · 10⁻¹⁶ m |
| Drehimpuls, unsymmetrisch | `\|L\|` konstant | bitgenau |
| Energie im freien Fall | `mgh + ½mv²` konstant | relativ < 10⁻⁹ |
| Determinismus | zwei Läufe gleich | byte-identisch |
| Rundweg Winkel → Quaternion → Winkel | Eingabe = Ausgabe | < 10⁻⁹ ° |
| Datei schreiben → lesen → schreiben | Zeichen für Zeichen gleich | identisch |

Der Gleittest ist der wertvollste: er prüft Kontaktlöser, Impulsrichtung und
Integrator gemeinsam gegen eine Schulformel. Die scharfen Toleranzen sind kein
Zufall — Velocity-Verlet ist bei konstanter Beschleunigung exakt, und eine weiche
Toleranz hätte falsche Integratoren durchgelassen (siehe
[Architektur](docs/architektur.md#integrator)).

### Von Hand zu prüfen

Nicht alles ist automatisiert, und das sollte man wissen:

- **Wie es aussieht.** Die Geometrie-Mathematik der Renderer ist kopflos
  getestet (Plattenausrichtung, Rechtshändigkeit, Sichtbarkeit), das Bild
  selbst nicht. Dafür `npm run dev` und hinsehen.
- **Der echte Bibliothekar-Aufruf.** Er braucht Zugangsdaten und kostet Geld.
  Die deterministischen Teile — Zusammenbau, Geometrie, Prüfkette, und dass
  `zodOutputFormat` das Ausgabeschema umwandeln kann — sind getestet. Der Aufruf
  selbst von Hand:

  ```bash
  npm run librarian -w @sandbox/service -- "Kupfer"
  npm run librarian -w @sandbox/service -- "schiefe Ebene 20 Grad"
  ```

  Erwartung bei „Kupfer": ein Eintrag, dessen Dichte und molare Masse aus der
  Referenztabelle stammen (`correctedFields` nennt sie, falls das Modell
  abgewichen ist), mit Farbe und Gitterdaten vom Modell. Gegenprobe mit einem
  Unsinn-Prompt: die Prüfkette muss ihn ablehnen.

---

## Was noch nicht da ist

Mit Absicht, in dieser Reihenfolge:

| | Status |
|---|---|
| Reibung, Stoßzahl > 0, Luftwiderstand | Stufe 2. Materialdaten liegen bereit, kein Modul liest sie. |
| Kugeln und andere Körperformen in der Oberfläche | Das Schema kennt `sphere`, die Oberfläche legt nur Blöcke an. |
| Kontaktdrehmoment (Kippen, Kantenkontakt, Stapel) | Stufe 1b. Der Klotz berührt die schiefe Ebene mit einer Ecke statt mit der Fläche — sichtbarer Effekt, [erklärt](docs/architektur.md#was-stufe-1-bewusst-nicht-kann). |
| Thermodynamik | Stufe 3. Pipeline-Phase `exchange` ist registriert und leer. |
| Chemie | Stufe 4. Phase `transform` leer; Elementbilanz-Prüfung steht schon. |
| Subatomare, thermische, Feld-Ansicht | Schalenbesetzung wird berechnet, Renderer fehlen. |
| **Regisseur** (Haupt-KI-Agent) und Sandbox-Werkzeuge | Die Werkzeugliste steht in der [Architektur](docs/architektur.md); `summarizeEntity` ist der geplante Rückkanal `inspect_recording` und schon gebaut. |
| Videoexport | Deterministisch, also „Aufzeichnung offline rendern". |
| `@sandbox/player` als eigenes npm-Paket | `RecordingViewer` ist schon einbettbar, nur noch nicht separat gepackt. |

Alle haben ihren Platz im Schema, in den Pipeline-Phasen und in den
Schnittstellen — sie sind Implementierungen, keine Umbauten.
