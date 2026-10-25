# Hinweise für Arbeiten an diesem Projekt

Physik-Sandbox: ein Szenario wird gebaut, deterministisch simuliert und als
abspielbare Aufzeichnung dargestellt. Alles auf Deutsch — Dokumentation,
Oberfläche, Kommentare, CSS-Klassennamen. Code-Identifier sind englisch.

## Zuerst lesen

| Frage | Dokument |
|---|---|
| **Wo muss ich etwas ändern?** | **[docs/aenderungsleitfaden.md](docs/aenderungsleitfaden.md)** |
| Was heißt dieser Begriff? | [docs/glossar.md](docs/glossar.md) — verbindlich; ein neuer Begriff wird dort eingetragen, bevor er im Code auftaucht |
| Warum ist das so gebaut? | [docs/architektur.md](docs/architektur.md) |
| Wie bedient man es? | [README.md](README.md) |

Der Änderungsleitfaden ist nicht optional. Er enthält die Zustandslandkarte:
**welcher Wert an welcher Stelle lebt und welche Stellen nur Spiegel sind.** Ohne
sie landet eine Änderung mit hoher Wahrscheinlichkeit am Spiegel — sie wirkt für
ein Bild und wird dann überschrieben.

**Der Leitfaden pflegt sich nicht selbst.** Musste eine Stelle erst gesucht
werden, weil aus Name oder Ablage nicht hervorging, wo sie liegt, gehört der
Fund danach in den Leitfaden — Zustandslandkarte oder „Ich will … ändern", je
nachdem, was zutrifft. Genauso bei neu angelegten Dingen (Modul, Funktion,
Feld, Komponente, Datei): Fundstelle sofort eintragen, nicht erst, wenn in
einer späteren Sitzung wieder danach gesucht werden muss.

## Die vier Regeln, die nicht verhandelbar sind

1. **Das Szenario ist die Quelle der Wahrheit, die Aufzeichnung ist daraus
   abgeleitet.** Jede Bearbeitung erzeugt ein neues Szenario; ein `useMemo`
   simuliert neu. Es gibt keinen Zustand namens „simuliert".
2. **Die Abspielzeit lebt im `Playhead`, nicht in React.** React spiegelt sie
   nur. Ändern über `viewport.current?.seek(…)` bzw. `viewer.playhead`.
3. **`packages/core` rechnet deterministisch** — nur `+ - * /` und `sqrt`, kein
   `Math.sin`, kein `Math.random` (Zufall kommt aus `createRng(seed)`) — **und
   hat keine Grafik-Abhängigkeit.** Kein `three`, kein DOM.
4. **Die Darstellung wirkt nie auf den Zustand zurück.** Eine Ebene zu wechseln
   kann die Physik nicht ändern.

## Aufbau

```
packages/schema/   Zod-Schemas = das Dateiformat. Validiert KI-Ausgaben UND typisiert den Kern.
packages/core/     Simulation: Pipeline, Integrator, Mechanik-Modul, Aufzeichner.
packages/render/   Three.js, ein Renderer je Darstellungsebene, Abspielkopf, Interpolation.
apps/studio/       Oberfläche (React + Vite). Bearbeitungslogik liegt in scenarioEdits.ts, ohne React.
apps/service/      Bibliothekar (KI-Aufruf), Simulationsendpunkt, OpenAPI. Der API-Schlüssel bleibt hier.
```

## Gegenprobe

```bash
npm test          # alle Pakete
npm run typecheck # alle Pakete
npm run dev       # Oberfläche auf http://localhost:5173
```

Bei Änderungen an Abspielkopf, Kamera oder Ebenenwechsel gehört `npm run dev`
und Hinsehen zur Gegenprobe: dort sitzen die Spiegel, die kein Test sieht. Die
Zuordnung „geändert → zuständiger Test" steht am Ende des Änderungsleitfadens.

## Eigenschaften in der rechten Leiste

Jede bearbeitbare Eigenschaft einer Entität ist in `ENTITY_PROPERTIES`
([apps/studio/src/entityProperties.ts](apps/studio/src/entityProperties.ts))
definiert, nicht von Hand im Inspektor. Begriffe: [Glossar → Eigenschaften](docs/glossar.md#eigenschaften-in-der-rechten-leiste).

- **Klasse:** Eine Eigenschaft gehört einer Klasse und vererbt sich an deren
  Unterklassen. Klassen: Objekt → Körper → Quader, Objekt → Randbedingung →
  Ebene, Objekt → Last → Gravitation. Eine neue Eigenschaft wird der
  allgemeinsten Klasse zugeordnet, für die sie gilt.
- **Gruppe:** Geometrie → Material → Kinematik → Darstellung, in dieser
  Reihenfolge. Gruppen haben keine Überschrift, sie sind nur durch eine
  horizontale Linie getrennt. Leere Gruppen entfallen.
- **Name:** links, immer gleich formatiert (`.eigenschaft-name`, wie
  „Position").
- **Typ bestimmt die Darstellung** — nie die einzelne Eigenschaft. Alle Typen
  liegen auf demselben Spaltenraster (`.eigenschaft` in styles.css), die
  Einheitenspalte ist überall gleich breit, auch wenn sie leer bleibt:
  - **3D-Vektor** (`vector3`): Felder x, y, z in Achsenfarben, dann Einheit.
  - **2D-Vektor** (`vector2`): zwei Felder rechtsbündig — sie stehen unter y
    und z eines 3D-Vektors —, dann Einheit.
  - **Prozentwert** (`percent`): Regler über die freie Breite, Zahlenfeld unter
    z, Einheit %.
  - **Auswahlwert** (`choice`): Auswahlfeld über die ganze Breite bis zur
    Einheitenspalte; die Einheitenspalte bleibt frei.
  - **Numerischer Wert** (`number`): nur Zahlenfeld unter z (gleich breit wie
    ein Vektorfeld) und Einheit, rechtsbündig.
- **Änderungen:** Eine Eigenschaft mit `change` (Schlüssel + Umrechnung
  Speicherwert ↔ Anzeige) erscheint auch im „Ändern"-Eingriff, mit derselben
  Zeile. `scope: "change"` heißt: nur dort, nicht bei den Startwerten (z. B.
  Geschwindigkeit, Winkelgeschw.). Welche Schlüssel der Kern für eine
  Entitätsart kennt, steht in `CHANGE_KEYS`
  ([packages/schema/src/changes.ts](packages/schema/src/changes.ts)).
- Ein neuer Typ braucht einen Zweig in `PropertyRow`
  ([InspectorPanel.tsx](apps/studio/src/components/InspectorPanel.tsx)) und eine
  Spaltenbelegung im Raster — und einen Eintrag in dieser Liste.

## Stil

- Kommentare erklären **warum**, nicht was. Vorhandene Kommentare sind so
  geschrieben; bei neuem Code genauso weitermachen.
- Physiktests prüfen gegen analytische Lösungen (`s = ½gt²`,
  `a = g·sin α`), nicht gegen gespeicherte Erwartungswerte.
- Stufe 1 ist klassische Mechanik. Was bewusst noch fehlt und in welcher
  Reihenfolge es kommt, steht im [README](README.md#was-noch-nicht-da-ist) — das
  sind Implementierungen, keine Umbauten.
- Keine erklärenden Hinweistexte oder Tooltips in der Oberfläche einfügen, die
  nur beschreiben, wie eine Bedienung funktioniert ("ein Klick fügt sofort
  hinzu", "Stärke lässt sich rechts bearbeiten"). Die Bedienung soll sich
  selbst erklären; wenn das nicht gelingt, ist das ein Hinweis auf schlechtes
  UI-Design, kein Fall für einen erklärenden Text.
