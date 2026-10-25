import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inspectScenario, libraryOverview, ScenarioDraft } from "./scenarioDraft.js";
import type { ScenarioStore } from "./scenarioStore.js";

/**
 * Die **Sandbox-Werkzeuge** als MCP-Server - die Schnittstelle, ueber die der
 * Regisseur (ein Agent in Hermes) Szenarien baut.
 *
 * Die Agentenschleife laeuft beim Aufrufer, nicht hier: dieser Dienst fuehrt
 * kein Gespraech und braucht fuer den Regisseur keinen API-Schluessel. Er
 * liefert, was ein Modell nicht selbst kann - die Bibliothek kennen,
 * simulieren, nachmessen - und legt das Ergebnis dort ab, wo das Studio es
 * findet.
 *
 * Drei Werkzeuge statt eines Bearbeitungskatalogs: ein Entwurf ist immer ein
 * ganzes Szenario (siehe scenarioDraft.ts).
 */

export interface SandboxMcpOptions {
  store: ScenarioStore;
  /** Basisadresse des Studios, an die `?szenario=<kennung>` angehaengt wird. */
  studioUrl: string;
}

/**
 * Steht in den Server-Anweisungen *und* ist der Grund fuer die ausfuehrlichen
 * Werkzeugbeschreibungen: nicht jeder MCP-Client gibt die Anweisungen ans
 * Modell weiter, die Werkzeugbeschreibungen schon.
 */
export const DIRECTOR_INSTRUCTIONS = `Physik-Sandbox: baut deterministisch simulierte Physikszenarien (klassische Mechanik) fuer Lernende.

Ablauf:
1. bibliothek_auflisten - welche Materialien es gibt.
2. Einen Szenarioentwurf schreiben und mit szenario_pruefen simulieren. Der Bericht nennt Fehler, Warnungen und je Koerper Start- und Endlage, Hoechstgeschwindigkeit und Kontaktzeiten. Nachbessern, bis keine Fehler bleiben und die Zahlen zeigen, was das Szenario zeigen soll.
3. szenario_abschliessen mit demselben Entwurf - liefert den Studio-Link fuer die Lernplattform.

Konventionen:
- z zeigt nach oben. Einheiten SI: Meter, Sekunden, m/s, Grad, Grad/s.
- Koerper sind Quader; size sind die vollen Kantenlaengen. position ist der Mittelpunkt: ein 0.2-m-Quader auf dem Boden bei z = 0 hat z = 0.1.
- Flaechen sind unbewegliche Platten. Ungedreht waagerecht, Normale +z, Laenge entlang lokal x. rotation [0, a, 0] neigt um a Grad, die Platte faellt dann in +x ab. Platten, die aneinanderstossen, um einige Zentimeter ueberlappen lassen.
- Schwerkraft ist ohne Angabe die Erdschwere; gravity: [] schaltet sie ab.
- Eingriffe (changes) setzen eine Eigenschaft zu einem Zeitpunkt, z. B. linearVelocity [0,0,0] haelt einen Koerper an.
- Regiespur (directionTrack): setViewLayer (macroscopic, kinematic), moveCamera, annotate (kurzer Text, optional an einen Koerper geheftet), pause, setTimeScale. Sie aendert nie die Physik.

Beispiel (Klotz rutscht eine 30-Grad-Rampe hinab auf einen Auslauf):
{"name":"Klotz auf der schiefen Ebene","duration":4,
 "surfaces":[{"id":"rampe","materialId":"glatt","position":[-1.732,0,1],"rotation":[0,30,0],"length":4,"width":2},
             {"id":"auslauf","materialId":"glatt","position":[4,0,0],"length":8.25,"width":2}],
 "bodies":[{"id":"klotz","name":"Eisenklotz","materialId":"eisen","size":[0.2,0.2,0.2],"position":[-1.732,0,2.2]}],
 "changes":[{"t":2,"entityId":"klotz","key":"linearVelocity","value":[0,0,0]}],
 "directionTrack":[{"cue":"annotate","t":0.05,"text":"Freier Fall: die Geschwindigkeit waechst linear.","entityId":"klotz","duration":1.2},
                   {"cue":"setViewLayer","t":1.2,"layer":"kinematic"}]}`;

/** Ohne Einrueckung: ein Pruefbericht mit drei Koerpern waere sonst zur Haelfte Leerzeichen im Kontextfenster. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function createSandboxMcpServer(options: SandboxMcpOptions): McpServer {
  const server = new McpServer(
    { name: "physik-sandbox", version: "1.0.0" },
    { instructions: DIRECTOR_INSTRUCTIONS },
  );

  server.registerTool(
    "bibliothek_auflisten",
    {
      title: "Bibliothek auflisten",
      description:
        "Die Materialien der Standardbibliothek mit Kennung, Dichte (kg/m^3), Stosszahl und Reibwerten. " +
        "Ein Entwurf darf nur diese Kennungen als materialId verwenden.",
      annotations: { readOnlyHint: true },
    },
    async () => json(libraryOverview()),
  );

  server.registerTool(
    "szenario_pruefen",
    {
      title: "Szenario pruefen",
      description:
        "Baut einen Szenarioentwurf zusammen, simuliert ihn und berichtet: errors (so nicht verwendbar), " +
        "warnings (laeuft, sieht aber nach einem Versehen aus) und je Koerper Start-/Endlage, Weg, " +
        "Hoechstgeschwindigkeit, Kontaktintervalle und minSurfaceDistance (negativ = steckt in einer Flaeche). " +
        "Legt nichts ab. Einheiten: Meter, Sekunden, Grad; z ist oben; size = volle Kantenlaengen.",
      inputSchema: ScenarioDraft,
      annotations: { readOnlyHint: true },
    },
    async (draft) => {
      const { scenario: _scenario, ...report } = inspectScenario(draft);
      return { ...json(report), isError: !report.ok };
    },
  );

  server.registerTool(
    "szenario_abschliessen",
    {
      title: "Szenario abschliessen",
      description:
        "Prueft den Entwurf wie szenario_pruefen und legt ihn ab, wenn er fehlerfrei ist. Liefert die " +
        "Kennung und den Studio-Link, unter dem die Lernplattform das Szenario zeigt.",
      inputSchema: ScenarioDraft,
    },
    async (draft) => {
      const { scenario, ...report } = inspectScenario(draft);
      if (!report.ok || !scenario) return { ...json(report), isError: true };
      const id = await options.store.put(scenario);
      const url = new URL(options.studioUrl);
      url.searchParams.set("szenario", id);
      return json({ id, studioUrl: url.href, warnings: report.warnings });
    },
  );

  return server;
}
