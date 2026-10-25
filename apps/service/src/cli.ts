/**
 * Bibliothekar von Hand aufrufen - fuer die Pruefung, die kein Test leisten
 * kann, weil sie Zugangsdaten braucht und Geld kostet.
 *
 *   npm run librarian -w @sandbox/service -- "Eisen"
 *   npm run librarian -w @sandbox/service -- "schiefe Ebene 20 Grad"
 *
 * Ausgegeben wird der geprueft Eintrag samt allem, was die Pruefkette
 * korrigiert hat. Genau das ist der interessante Teil: welche Zahlen die
 * Referenztabelle ueberstimmt hat.
 */
import { createClaudeLibrarian, MissingCredentialsError, synthesizeEntry } from "./librarian.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (prompt === "") {
  console.error('Aufruf: npm run librarian -w @sandbox/service -- "Eisen"');
  process.exit(2);
}

try {
  const librarian = await createClaudeLibrarian({
    model: process.env["LIBRARIAN_MODEL"] ?? "claude-sonnet-5-5",
  });
  console.error(`Modell: ${librarian.modelId}\nEingabe: ${prompt}\n`);

  const result = await synthesizeEntry(librarian, prompt);

  if (!result.ok) {
    console.error("Von der Pruefung abgelehnt:");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const entry = result.entry!;
  console.error(`Eintrag: ${entry.definition.name} (id: ${entry.definition.id})`);
  if (result.correctedFields.length > 0) {
    console.error(`\nGegen die Referenztabelle korrigiert: ${result.correctedFields.join(", ")}`);
  } else {
    console.error("\nNichts zu korrigieren - die Werte des Modells haben die Pruefung bestanden.");
  }
  for (const warning of result.warnings) console.error(`  Hinweis: ${warning}`);

  // Der Eintrag selbst auf stdout, damit er sich weiterleiten laesst.
  console.log(JSON.stringify(entry, null, 2));
} catch (error) {
  if (error instanceof MissingCredentialsError) {
    console.error(error.message);
    process.exit(3);
  }
  console.error(`Fehlgeschlagen: ${(error as Error).message}`);
  process.exit(1);
}
