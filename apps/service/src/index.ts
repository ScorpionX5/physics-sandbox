import { createClaudeLibrarian, type LibrarianModel } from "./librarian.js";
import { createFileScenarioStore } from "./scenarioStore.js";
import { createServer } from "./server.js";

/**
 * Einstiegspunkt des Dienstes.
 *
 * Der Bibliothekar wird nur eingerichtet, wenn Zugangsdaten vorhanden sind.
 * Ohne sie laeuft der Dienst trotzdem: Simulation, Pruefung und das
 * OpenAPI-Dokument brauchen kein Modell, und das Plattform-Team soll nicht auf
 * einen Schluessel warten muessen.
 */

const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = process.env["HOST"] ?? "127.0.0.1";
/** Wohin `szenario_abschliessen` ablegt. Relativ zum Arbeitsverzeichnis des Dienstes. */
const SCENARIO_DIR = process.env["SCENARIO_DIR"] ?? "data/scenarios";
/** Wo die Lernplattform das Studio ausliefert - daraus werden die Links. */
const STUDIO_URL = process.env["STUDIO_URL"] ?? "http://localhost:5173/";
const MCP_TOKEN = process.env["MCP_TOKEN"];

/**
 * Ob Zugangsdaten vorhanden sind.
 *
 * Ein nicht gesetztes `ANTHROPIC_API_KEY` bedeutet *nicht*, dass es keine
 * Zugangsdaten gibt: das SDK loest in der Reihenfolge `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, dann das OAuth-Profil von `ant auth login` auf. Der
 * Versuch, den Client zu bauen, ist deshalb die ehrlichere Pruefung als ein
 * Blick auf eine einzelne Umgebungsvariable.
 */
async function setUpLibrarian(): Promise<LibrarianModel | undefined> {
  try {
    const librarian = await createClaudeLibrarian({
      model: process.env["LIBRARIAN_MODEL"] ?? "claude-sonnet-5-5",
    });
    console.log(`Bibliothekar bereit (Modell: ${librarian.modelId}).`);
    return librarian;
  } catch (error) {
    console.warn(
      `Bibliothekar nicht eingerichtet: ${(error as Error).message}\n` +
        "Der Dienst laeuft ohne ihn; /v1/library/synthesize antwortet mit 503.\n" +
        "Zum Einschalten: ANTHROPIC_API_KEY setzen oder `ant auth login` ausfuehren.",
    );
    return undefined;
  }
}

const librarian = await setUpLibrarian();
if (!MCP_TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost") {
  console.warn(`MCP_TOKEN ist nicht gesetzt: /mcp ist auf ${HOST} fuer jeden erreichbar, der den Dienst erreicht.`);
}
const app = createServer({
  ...(librarian ? { librarian } : {}),
  store: createFileScenarioStore(SCENARIO_DIR),
  studioUrl: STUDIO_URL,
  ...(MCP_TOKEN ? { mcpToken: MCP_TOKEN } : {}),
  logger: true,
});

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Dienst laeuft auf http://${HOST}:${PORT}`);
  console.log(`OpenAPI-Schema: http://${HOST}:${PORT}/v1/openapi.json`);
  console.log(`MCP (Sandbox-Werkzeuge): http://${HOST}:${PORT}/mcp`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
