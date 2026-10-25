# Physik-Sandbox

Interaktive 3D-Sandbox für Physik- und Chemie-Abläufe. Man baut eine Szene,
legt zeitlich gestaffelte Eingriffe fest, drückt Play und wechselt zwischen
makroskopischer, kinematischer und atomarer Darstellung.

Zwei Nutzergruppen, ein Kern:

1. **Mensch am Werkzeug** — die Sandbox-Oberfläche (`apps/studio`).
2. **KI-Agent als Autor** — eine Lernplattform übergibt einen Lehrtext, ein
   Agent (der **Regisseur**, in Hermes) baut daraus über MCP ein Szenario, das
   die Plattform als eingebettetes Studio zeigt. Siehe
   [Regisseur anbinden](#regisseur-anbinden-hermes).

Das Ergebnis ist **keine Videodatei**, sondern eine abspielbare, weiter
bedienbare Aufzeichnung: Kamera frei drehbar, Zeit scrubbar, Darstellungsebene
umschaltbar, Eingriffe änderbar und neu simulierbar.

**Stand:** Stufe 1 und Reibung aus Stufe 2 — klassische Mechanik (Translation,
Rotation, Kontakt mit Kontaktdrehmoment: Körper kippen über Ecken und Kanten;
Haft-, Gleit-, Bohr- und Rollreibung aus den Materialien der Paarung). Thermodynamik und Chemie haben ihren Platz im Schema und in der
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

### Regisseur anbinden (Hermes)

Der Dienst bietet unter `/mcp` die Sandbox-Werkzeuge an. Auf dem Server:

```bash
HOST=0.0.0.0 PORT=8787 \
MCP_TOKEN=<langes-zufallstoken> \
STUDIO_URL=https://plattform.example/studio/ \
SCENARIO_DIR=/var/lib/physik-sandbox/szenarien \
npm run service
```

In `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  physik:
    url: https://sandbox.example/mcp
    headers:
      Authorization: "Bearer <langes-zufallstoken>"
```

Hermes sieht dann `mcp_physik_bibliothek_auflisten`, `mcp_physik_szenario_pruefen`
und `mcp_physik_szenario_abschliessen`. Letzteres liefert einen Link
`STUDIO_URL?szenario=<kennung>`, den die Plattform als `<iframe>` einbettet. Das
Studio holt das Szenario über `/v1/scenarios/<kennung>` — dafür muss `/v1` unter
der Adresse des Studios zum Dienst weitergeleitet werden, wie es der Vite-Proxy
in der Entwicklung tut.

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

Reibungsfrei ist es, weil Rampe und Auslauf aus **Glatt** sind. Wer beiden
Ebenen Standard gibt, sieht den Unterschied: der Klotz bremst beim Aufprall,
rutscht langsamer ab und bleibt auf dem Auslauf von selbst stehen.

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

### Weitere Beispiele

In `examples/` liegen fertige Szenarien, die sich über **Laden** öffnen lassen:

| Datei | Inhalt |
|---|---|
| `zentraler-stoss.scenario.json` | Eisen- und Aluminiumquader stoßen mittig, ohne Schwerkraft |
| `aussermittiger-stoss.scenario.json` | dieselben Quader, versetzt — der Stoß bringt sie ins Drehen |
| `collision.scenario.json` | zwei 1 m lange Stäbe treffen sich versetzt mit je 20 m/s |
| `waagerechter-wurf.scenario.json` | Aluminiumquader gleitet über eine glatte Ebene und fliegt über die Kante waagerecht ab |
| `bouncing.scenario.json` | drei Quader aus Eisen, Holz und Aluminium fallen auf Eisenebenen |
| `schiefe-ebene.scenario.json` | Holzquader auf Aluminiumrampe; Zusatzlast ab 2,7 s, die Rampe wird bei 3 s gedreht |

---

## Aufbau

```
packages/
  schema/   Zod-Schemas, Typen, Referenztabelle der Elemente, Prüfung
  core/     Zustandsschicht: Pipeline, Integrator, Mechanik-Modul, Aufzeichner
  render/   Darstellungsschicht: Three.js, ein Renderer je Ebene, Abspielkopf
apps/
  studio/   Die Sandbox-Oberfläche (React + Vite + Three.js)
  service/  Bibliothekar, Simulationsendpunkt, Sandbox-Werkzeuge (MCP), OpenAPI
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
npm test          # 373 Tests über fünf Pakete
npm run typecheck # alle Pakete
```

Die Mechanik-Tests prüfen gegen analytische Lösungen, nicht gegen gespeicherte
Erwartungswerte:

| Test | Erwartung | gemessen |
|---|---|---|
| Freier Fall | `s = ½gt²`, `v = gt` | relativ < 10⁻⁹ |
| Gleiten auf 30°-Ebene | `a = g·sin 30° = 4,905 m/s²` | **4,905000000**, Abw. 1,3 · 10⁻¹³ |
| Horizontaler Auslauf | `a = 0` | exakt 0 |
| Durchdringung | ≥ 0 | −1,2 · 10⁻¹⁶ m |
| Drehimpuls, unsymmetrisch | `\|L\|` konstant | bitgenau |
| Energie im freien Fall | `mgh + ½mv²` konstant | relativ < 10⁻⁹ |
| Kippen über eine Plattenkante, reibungsfrei | `α = m·g·d / (I + m·d²)` | relativ 0,5 % |
| Kippen um die haftende Kante | `α = g(d − f) / (I/m + d² + h²)` | relativ 0,2 % |
| Gleiten mit Reibung, 30° | `a = g(sin α − μ_G cos α)` | relativ 2 · 10⁻¹⁴ |
| Haften, 20° | liegt still | 1 · 10⁻⁹ m in 1 s |
| Bremsweg | `s = v₀² / (2 μ_G g)` | relativ 8 · 10⁻⁷ |
| Kugel: Gleiten → Rollen | `v = 5/7 · v₀` | relativ 4 · 10⁻¹⁵ |
| Kugel rollt die Ebene hinab | `a = 5/7 · g sin α` | relativ 8 · 10⁻¹⁵ |
| Rollreibung | `a = −5/7 · g · f / r` | relativ 3 · 10⁻¹³ |
| Stoß auf eine Ecke, e = 1 | Translation + Rotation konstant | relativ 3 · 10⁻¹⁶ |
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
| Luftwiderstand | Rest von Stufe 2. Reibung ist da. |
| Reibwerte je Paarung | Reibung steht je Material und wird als geometrisches Mittel gepaart. Eine Tabelle gemessener Paarungen, die davor greift, wäre eine Ergänzung in `pairFriction`. |
| Kugeln und andere Körperformen in der Oberfläche | Das Schema kennt `sphere`, die Oberfläche legt nur Blöcke an. |
| Thermodynamik | Stufe 3. Pipeline-Phase `exchange` ist registriert und leer. |
| Chemie | Stufe 4. Phase `transform` leer; Elementbilanz-Prüfung steht schon. |
| Subatomare, thermische, Feld-Ansicht | Schalenbesetzung wird berechnet, Renderer fehlen. |
| Neue Materialien durch den Regisseur | Der Regisseur wählt nur aus der Startbibliothek. Den Bibliothekar als viertes Werkzeug anzubieten wäre eine Ergänzung in `mcp.ts` und `assembleScenario`. |
| Eigener Einbettungsmodus des Studios | Die Plattform bettet das volle Studio ein. Eine reduzierte Ansicht nur zum Abspielen fehlt. |
| Videoexport | Deterministisch, also „Aufzeichnung offline rendern". |
| `@sandbox/player` als eigenes npm-Paket | `RecordingViewer` ist schon einbettbar, nur noch nicht separat gepackt. |

Alle haben ihren Platz im Schema, in den Pipeline-Phasen und in den
Schnittstellen — sie sind Implementierungen, keine Umbauten.
