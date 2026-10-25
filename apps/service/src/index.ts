import { createClaudeLibrarian, type LibrarianModel } from "./librarian.js";
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
const app = createServer({ ...(librarian ? { librarian } : {}), logger: true });

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Dienst laeuft auf http://${HOST}:${PORT}`);
  console.log(`OpenAPI-Schema: http://${HOST}:${PORT}/v1/openapi.json`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
