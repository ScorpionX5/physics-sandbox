#!/usr/bin/env node
/**
 * Testrunner fuer die Pakete des Monorepos.
 *
 * Node 20 erkennt bei `--test <verzeichnis>` nur .js-Dateien und unterstuetzt
 * noch keine Glob-Muster in der Kommandozeile; cmd.exe expandiert Globs in
 * npm-Skripten ohnehin nicht. Dieses Skript sammelt die Testdateien selbst und
 * uebergibt sie explizit - damit laeuft `npm test` unter Windows und POSIX
 * gleich.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const packageRoot = process.cwd();
const searchRoots = process.argv.slice(2);
const roots = searchRoots.length > 0 ? searchRoots : ["test"];

async function collect(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(full)));
    } else if (/\.test\.(ts|tsx|mts)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

const files = (await Promise.all(roots.map((root) => collect(resolve(packageRoot, root))))).flat();

if (files.length === 0) {
  console.log(`Keine Testdateien unter ${roots.join(", ")} gefunden - nichts zu tun.`);
  process.exit(0);
}

console.log(`${files.length} Testdatei(en): ${files.map((f) => relative(packageRoot, f)).join(", ")}`);

// Der Loader muss als file:-URL uebergeben werden: ein nackter
// Windows-Pfad wie D:\... wird von --import als Protokoll "d:" gelesen.
const loader = pathToFileURL(join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;

const child = spawn(process.execPath, ["--import", loader, "--test", ...files], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
