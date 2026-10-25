import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BUILTIN_LIBRARY, IRON } from "@sandbox/schema";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  assembleEntry,
  LibrarianDraft,
  slugify,
  synthesizeEntry,
  type LibrarianModel,
} from "../src/librarian.js";
import { createServer, openApiDocument } from "../src/server.js";

/**
 * Was diese Tests pruefen - und was nicht.
 *
 * Geprueft wird der deterministische Teil: Zusammenbau des Eintrags,
 * Geometrieberechnung, Id-Erzeugung, Pruefkette und die Umwandlung des
 * Ausgabeschemas fuer die strukturierte Ausgabe. Dafuer wird die
 * Modellanbindung durch eine Attrappe ersetzt - das ist der Grund, warum
 * `LibrarianModel` eine Schnittstelle ist.
 *
 * *Nicht* geprueft wird der echte Aufruf gegen die Claude API. Er braucht
 * Zugangsdaten und kostet Geld; `npm run librarian -- "Eisen"` fuehrt ihn von
 * Hand aus.
 */

function fakeModel(draft: LibrarianDraft, modelId = "attrappe"): LibrarianModel {
  return { modelId, draft: async () => draft };
}

const IRON_DRAFT: LibrarianDraft = {
  kind: "material",
  note: "Standardwerte fuer reines Eisen.",
  material: {
    name: "Eisen",
    formula: "Fe",
    mechanical: { density: 7874, restitution: 0.4, staticFriction: 0.74, kineticFriction: 0.57, rollingFriction: 0.0005 },
    thermal: {
      specificHeatCapacity: 449,
      thermalConductivity: 80.4,
      emissivity: 0.3,
      meltingPoint: 1811,
      boilingPoint: 3134,
    },
    chemical: { molarMass: 55.845, atomicNumber: 26, neutronCount: 30 },
    appearance: {
      macroscopic: { color: "#8c8c94", metalness: 0.9, roughness: 0.35, opacity: 1 },
      atomic: { atomColor: "#b0b4bd", atomRadius: 126, lattice: "bcc", latticeConstant: 287 },
    },
  },
};

const PLANE_DRAFT: LibrarianDraft = {
  kind: "constraint",
  note: "Stahlplatte, 4 m lang und 2 m breit.",
  constraint: {
    name: "Stahlplatte",
    surface: { length: 4, width: 2, thickness: 0.06 },
  },
};

describe("Ausgabeschema fuer die strukturierte Ausgabe", () => {
  it("laesst sich in ein JSON-Schema umwandeln", () => {
    // Das ist der Test, der die riskanteste Annahme der Modellanbindung prueft,
    // ohne das Modell zu rufen: wenn `zodOutputFormat` das Schema nicht
    // umwandeln kann, scheitert jeder echte Aufruf - und zwar erst zur
    // Laufzeit, mit Zugangsdaten und Kosten.
    const format = zodOutputFormat(LibrarianDraft);
    assert.ok(format, "zodOutputFormat lieferte nichts");
    assert.equal(format.type, "json_schema");
  });

  it("nimmt einen Entwurf an, der dem Schema entspricht", () => {
    assert.equal(LibrarianDraft.safeParse(IRON_DRAFT).success, true);
    assert.equal(LibrarianDraft.safeParse(PLANE_DRAFT).success, true);
  });
});

describe("Id-Erzeugung", () => {
  it("macht aus deutschen Namen brauchbare Ids", () => {
    assert.equal(slugify("Eisen"), "eisen");
    assert.equal(slugify("Eisen(III)-oxid"), "eisen-iii-oxid");
    assert.equal(slugify("Schiefe Ebene 30 Grad"), "schiefe-ebene-30-grad");
  });

  it("loest Umlaute und Eszett auf, statt sie zu verlieren", () => {
    assert.equal(slugify("Kalilauge für Ätzen"), "kalilauge-fuer-aetzen");
    assert.equal(slugify("Messing"), "messing");
    assert.equal(slugify("Straße"), "strasse");
  });

  it("faellt auf einen Platzhalter zurueck, statt eine leere Id zu erzeugen", () => {
    assert.equal(slugify("***"), "eintrag");
    assert.equal(slugify("   "), "eintrag");
  });

  it("weicht einer bereits belegten Id aus", () => {
    const first = assembleEntry(IRON_DRAFT, { prompt: "Eisen", model: "attrappe" });
    assert.equal(first.entry!.definition.id, "eisen");
    const second = assembleEntry(IRON_DRAFT, {
      prompt: "Eisen",
      model: "attrappe",
      takenIds: ["eisen", "eisen-2"],
    });
    assert.equal(second.entry!.definition.id, "eisen-3");
  });
});

describe("Zusammenbau eines Materials", () => {
  it("erzeugt einen Eintrag, der dem handgepflegten Eisen entspricht", () => {
    const result = assembleEntry(IRON_DRAFT, { prompt: "Eisen", model: "attrappe" });
    assert.equal(result.ok, true, result.errors.join("; "));
    const definition = result.entry!.definition;
    assert.equal(definition.kind, "material");
    if (definition.kind !== "material") return;
    assert.equal(definition.id, IRON.id);
    assert.equal(definition.mechanical.density, IRON.mechanical.density);
    assert.equal(definition.chemical?.atomicNumber, 26);
  });

  it("vermerkt Herkunft, Prompt und Modell", () => {
    const result = assembleEntry(IRON_DRAFT, {
      prompt: "Eisen",
      model: "claude-sonnet-5-5",
      createdAt: "2026-10-24T12:00:00.000Z",
    });
    const provenance = result.entry!.provenance;
    assert.equal(provenance.source, "librarian");
    assert.equal(provenance.prompt, "Eisen");
    assert.equal(provenance.model, "claude-sonnet-5-5");
    assert.equal(provenance.createdAt, "2026-10-24T12:00:00.000Z");
    assert.ok(
      provenance.warnings.some((warning) => warning.startsWith("Bibliothekar:")),
      "die Begruendung des Modells fehlt",
    );
  });

  it("ueberstimmt eine erfundene Dichte mit dem Referenzwert", () => {
    // Der eigentliche Zweck der Pruefkette. Es gibt keinen Weg an ihr vorbei in
    // die Bibliothek - sonst waere sie beim ersten Zeitdruck das erste, was
    // wegfaellt.
    const wrong: LibrarianDraft = {
      ...IRON_DRAFT,
      material: { ...IRON_DRAFT.material!, mechanical: { ...IRON_DRAFT.material!.mechanical, density: 1200 } },
    };
    const result = assembleEntry(wrong, { prompt: "Eisen", model: "attrappe" });
    assert.equal(result.ok, true);
    assert.equal(
      result.entry!.definition.kind === "material" && result.entry!.definition.mechanical.density,
      7874,
    );
    assert.ok(result.correctedFields.includes("mechanical.density"));
  });

  it("lehnt einen in sich widerspruechlichen Eintrag ab, statt zu raten", () => {
    const contradictory: LibrarianDraft = {
      ...IRON_DRAFT,
      material: {
        ...IRON_DRAFT.material!,
        name: "Phantasium",
        formula: undefined,
        chemical: undefined,
        thermal: { meltingPoint: 3000, boilingPoint: 1000 },
      },
    };
    const result = assembleEntry(contradictory, { prompt: "Phantasium", model: "attrappe" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("Schmelzpunkt")));
    assert.equal(result.entry, undefined, "ein abgelehnter Eintrag darf nicht zurueckkommen");
  });

  it("meldet einen Entwurf, der seinen eigenen Diskriminator nicht erfuellt", () => {
    const broken: LibrarianDraft = { kind: "material", note: "", material: undefined };
    const result = assembleEntry(broken, { prompt: "irgendwas", model: "attrappe" });
    assert.equal(result.ok, false);
    assert.ok(result.errors[0]!.includes("material"));
  });
});

describe("Zusammenbau einer Randbedingung", () => {
  it("setzt die Achsen selbst, statt sie vom Modell zu uebernehmen", () => {
    // Das Modell liefert nur Laenge, Breite und Dicke; Normale und Tangente
    // setzt der Code. Ein Modell um orthonormale Basisvektoren zu bitten ist
    // eine verlaessliche Fehlerquelle.
    const result = assembleEntry(PLANE_DRAFT, { prompt: "Stahlplatte", model: "attrappe" });
    assert.equal(result.ok, true, result.errors.join("; "));
    const definition = result.entry!.definition;
    assert.equal(definition.kind, "constraint");
    if (definition.kind !== "constraint" || definition.behaviour.constraintType !== "staticSurface") return;

    for (const segment of definition.behaviour.segments) {
      assert.ok(Math.abs(Math.hypot(...segment.normal) - 1) < 1e-12, "Normale nicht normiert");
      assert.ok(Math.abs(Math.hypot(...segment.tangent) - 1) < 1e-12, "Tangente nicht normiert");
      const dot =
        segment.normal[0] * segment.tangent[0] +
        segment.normal[1] * segment.tangent[1] +
        segment.normal[2] * segment.tangent[2];
      assert.ok(Math.abs(dot) < 1e-12, "Achsen nicht senkrecht");
    }
  });

  it("rechnet Laenge und Breite in halbe Ausdehnungen um", () => {
    const result = assembleEntry(
      {
        kind: "constraint",
        note: "Tischplatte",
        constraint: {
          name: "Tisch",
          surface: { length: 3, width: 1.5, thickness: 0.04 },
        },
      },
      { prompt: "Tisch", model: "attrappe" },
    );
    assert.equal(result.ok, true, result.errors.join("; "));
    const definition = result.entry!.definition;
    if (definition.kind !== "constraint" || definition.behaviour.constraintType !== "staticSurface") {
      assert.fail("kein staticSurface");
    }
    assert.equal(definition.behaviour.segments.length, 1);
    const segment = definition.behaviour.segments[0]!;
    assert.equal(segment.halfExtentU, 1.5, "3 m Laenge sind 1,5 m halbe Ausdehnung");
    assert.equal(segment.halfExtentV, 0.75);
    assert.equal(segment.thickness, 0.04);
  });

  it("erzeugt immer eine einzelne, waagerechte Flaeche", () => {
    // Keine fertigen Rampen: Neigung, Lage und Groesse gehoeren an die
    // platzierte Instanz, damit der Benutzer sie nachtraeglich aendern kann.
    const result = assembleEntry(PLANE_DRAFT, { prompt: "Stahlplatte", model: "attrappe" });
    assert.equal(result.ok, true, result.errors.join("; "));
    const definition = result.entry!.definition;
    assert.ok(definition.kind === "constraint" && definition.behaviour.constraintType === "staticSurface");
    assert.equal(definition.behaviour.segments.length, 1);
    assert.deepEqual(definition.behaviour.segments[0]!.normal, [0, 0, 1]);
    assert.deepEqual(definition.behaviour.segments[0]!.tangent, [1, 0, 0]);
  });

  it("lehnt eine Flaeche ohne positive Abmessungen ab", () => {
    const result = assembleEntry(
      {
        ...PLANE_DRAFT,
        constraint: { ...PLANE_DRAFT.constraint!, surface: { length: 0, width: 2, thickness: 0.05 } },
      },
      { prompt: "Nichts", model: "attrappe" },
    );
    assert.equal(result.ok, false);
  });
});

describe("Durchlauf des Bibliothekars", () => {
  it("fuehrt Modellaufruf, Zusammenbau und Pruefung zusammen", async () => {
    const result = await synthesizeEntry(fakeModel(IRON_DRAFT, "claude-sonnet-5-5"), "Eisen", {
      now: () => "2026-10-24T12:00:00.000Z",
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.entry!.provenance.model, "claude-sonnet-5-5");
  });

  it("lehnt eine leere Eingabe ab, ohne das Modell zu rufen", async () => {
    let called = false;
    const model: LibrarianModel = {
      modelId: "attrappe",
      draft: async () => {
        called = true;
        return IRON_DRAFT;
      },
    };
    const result = await synthesizeEntry(model, "   ");
    assert.equal(result.ok, false);
    assert.equal(called, false, "das Modell wurde fuer eine leere Eingabe gerufen");
  });
});

describe("HTTP-Dienst", () => {
  it("meldet sich auch ohne Bibliothekar als erreichbar", async () => {
    const app = createServer();
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok", librarian: null });
    await app.close();
  });

  it("antwortet mit 503, solange der Bibliothekar fehlt", async () => {
    // Ohne Zugangsdaten soll der Dienst laufen, nur eben ohne Bibliothekar -
    // Simulation und Pruefung brauchen kein Modell.
    const app = createServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/synthesize",
      payload: { prompt: "Eisen" },
    });
    assert.equal(response.statusCode, 503);
    assert.ok(response.json().errors[0].includes("ANTHROPIC_API_KEY"));
    await app.close();
  });

  it("liefert einen geprueften Eintrag, wenn der Bibliothekar da ist", async () => {
    const app = createServer({ librarian: fakeModel(IRON_DRAFT) });
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/synthesize",
      payload: { prompt: "Eisen" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().entry.definition.id, "eisen");
    await app.close();
  });

  it("antwortet mit 422, wenn die Pruefung die Modellantwort ablehnt", async () => {
    // Die Anfrage war in Ordnung, die Antwort des Modells nicht. 422 sagt genau
    // das - 500 waere falsch, 200 waere eine Luege.
    const broken: LibrarianDraft = { kind: "constraint", note: "", constraint: undefined };
    const app = createServer({ librarian: fakeModel(broken) });
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/synthesize",
      payload: { prompt: "irgendwas" },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().ok, false);
    await app.close();
  });

  it("antwortet mit 400 auf eine fehlerhafte Anfrage", async () => {
    const app = createServer({ librarian: fakeModel(IRON_DRAFT) });
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/synthesize",
      payload: { prompt: "" },
    });
    assert.equal(response.statusCode, 400);
    await app.close();
  });

  it("antwortet mit 502, wenn der Modellaufruf scheitert", async () => {
    const failing: LibrarianModel = {
      modelId: "attrappe",
      draft: async () => {
        throw new Error("Netz weg");
      },
    };
    const app = createServer({ librarian: failing });
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/synthesize",
      payload: { prompt: "Eisen" },
    });
    assert.equal(response.statusCode, 502);
    assert.ok(response.json().errors[0].includes("Netz weg"));
    await app.close();
  });

  it("fuehrt ein Szenario aus und gibt Aufzeichnung samt Zusammenfassung zurueck", async () => {
    const app = createServer();
    const scenario = await app.inject({ method: "GET", url: "/v1/scenarios/durchstich" });
    assert.equal(scenario.statusCode, 200);

    const run = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: { scenario: scenario.json() },
    });
    assert.equal(run.statusCode, 200, run.body.slice(0, 300));
    const body = run.json();
    assert.ok(body.recording.snapshots.length > 50);
    assert.equal(body.summaries.length, 1);
    assert.equal(body.summaries[0].entityId, "klotz");
    assert.ok(body.summaries[0].maxSpeed > 4);
    await app.close();
  });

  it("antwortet mit 422 auf ein Szenario, das nicht laufen kann", async () => {
    const app = createServer();
    const scenario = await app.inject({ method: "GET", url: "/v1/scenarios/durchstich" });
    const broken = scenario.json();
    broken.library = [];
    const run = await app.inject({ method: "POST", url: "/v1/runs", payload: { scenario: broken } });
    assert.equal(run.statusCode, 422);
    assert.ok(run.json().errors[0].includes("Bibliothek"));
    await app.close();
  });

  it("prueft einen Eintrag auch ohne Modell", async () => {
    const app = createServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/validate",
      payload: BUILTIN_LIBRARY[0],
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    await app.close();
  });

  it("liefert die Startbibliothek", async () => {
    const app = createServer();
    const response = await app.inject({ method: "GET", url: "/v1/library" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().entries.length, BUILTIN_LIBRARY.length);
    await app.close();
  });
});

describe("OpenAPI-Dokument", () => {
  it("laesst sich aus den Zod-Schemas erzeugen", () => {
    // Aus *denselben* Schemas, die den Kern typisieren - deshalb kann das
    // Dokument nicht veralten. Dieser Test ist die Zusicherung an das
    // Plattform-Team, dass es dagegen arbeiten kann, bevor hier etwas fertig ist.
    const document = openApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    assert.equal(document.openapi, "3.1.0");
    for (const path of [
      "/v1/health",
      "/v1/library",
      "/v1/library/synthesize",
      "/v1/library/validate",
      "/v1/runs",
      "/v1/scenarios/durchstich",
    ]) {
      assert.ok(document.paths[path], `Pfad ${path} fehlt im OpenAPI-Dokument`);
    }
    // Muss serialisierbar sein - sonst nuetzt es niemandem.
    assert.ok(JSON.stringify(document).length > 1000);
  });

  it("wird vom Dienst ausgeliefert", async () => {
    const app = createServer();
    const response = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().openapi, "3.1.0");
    await app.close();
  });
});

describe("Fehlende Zugangsdaten", () => {
  it("antwortet mit 503 und einem Hinweis, nicht mit 502", async () => {
    // Der Unterschied ist nicht kosmetisch: 502 sagt "Modell kaputt", 503 mit
    // Hinweis sagt "du musst dich anmelden". Der Startlauf hat genau das
    // zunaechst falsch gemeldet, weil `new Anthropic()` ohne Schluessel nicht
    // wirft, sondern erst der Aufruf scheitert.
    const { MissingCredentialsError } = await import("../src/librarian.js");
    const unauthenticated: LibrarianModel = {
      modelId: "claude-sonnet-5-5",
      draft: async () => {
        throw new MissingCredentialsError();
      },
    };
    const app = createServer({ librarian: unauthenticated });
    const response = await app.inject({
      method: "POST",
      url: "/v1/library/synthesize",
      payload: { prompt: "Eisen" },
    });
    assert.equal(response.statusCode, 503);
    const message = response.json().errors[0] as string;
    assert.ok(message.includes("ANTHROPIC_API_KEY"), message);
    assert.ok(message.includes("ant auth login"), message);
    assert.equal(
      message.includes("fehlgeschlagen"),
      false,
      "fehlende Zugangsdaten duerfen nicht als Modellfehler erscheinen",
    );
    await app.close();
  });
});
