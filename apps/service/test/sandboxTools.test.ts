import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createInclinedPlaneScenario, EARTH_GRAVITY, RAMP_ORIENTATION, Scenario } from "@sandbox/schema";

import { DIRECTOR_INSTRUCTIONS } from "../src/mcp.js";
import { assembleScenario, inspectScenario, type ScenarioDraft } from "../src/scenarioDraft.js";
import { createMemoryScenarioStore } from "../src/scenarioStore.js";
import { createServer } from "../src/server.js";

/**
 * Sandbox-Werkzeuge: Zusammenbau des Entwurfs, Pruefbericht und der
 * MCP-Endpunkt. Ohne Modell - die Agentenschleife laeuft in Hermes, hier wird
 * nur geprueft, was der Dienst daraus macht.
 */

/** Das Beispiel aus den Server-Anweisungen. Steht es dort falsch, lernt jeder Regisseur das Falsche. */
function instructionExample(): ScenarioDraft {
  const start = DIRECTOR_INSTRUCTIONS.indexOf("{");
  return JSON.parse(DIRECTOR_INSTRUCTIONS.slice(start)) as ScenarioDraft;
}

function assembled(draft: unknown): Scenario {
  const result = assembleScenario(draft);
  assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
  return result.scenario;
}

function close(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} statt ${expected}`);
}

describe("Szenarioentwurf - Zusammenbau", () => {
  it("baut aus dem Beispiel der Anweisungen den Durchstich nach", () => {
    const scenario = assembled(instructionExample());
    const reference = createInclinedPlaneScenario();
    const ramp = scenario.entities.find((spec) => spec.id === "rampe");
    const runOut = scenario.entities.find((spec) => spec.id === "auslauf");
    const referenceRamp = reference.entities.find((spec) => spec.id === "schiefe-ebene");
    const referenceRunOut = reference.entities.find((spec) => spec.id === "auslauf");
    assert.ok(ramp?.kind === "constraint" && referenceRamp?.kind === "constraint");
    assert.ok(runOut?.kind === "constraint" && referenceRunOut?.kind === "constraint");
    ramp.pose.orientation.forEach((value, i) => close(value, RAMP_ORIENTATION[i]!, 1e-12, `Rampe q${i}`));
    assert.deepEqual(ramp.size, referenceRamp.size);
    assert.deepEqual(runOut.size, referenceRunOut.size);
    // Die Bibliothek kommt mit, damit das Studio die Datei laden kann.
    assert.ok(scenario.library.some((entry) => entry.definition.id === "eisen"));
  });

  it("rechnet volle Kanten in halbe und Grad/s in rad/s um", () => {
    const scenario = assembled({
      name: "Einheiten",
      duration: 1,
      bodies: [{ id: "k", size: [0.4, 0.2, 0.1], position: [0, 0, 1], angularVelocity: [0, 0, 180] }],
      surfaces: [{ id: "boden", position: [0, 0, 0], length: 6, width: 2, thickness: 0.05 }],
      changes: [
        { t: 0.5, entityId: "boden", key: "size", value: [8, 4, 0.1] },
        { t: 0.5, entityId: "k", key: "size", value: [1, 1, 1] },
      ],
    });
    const body = scenario.entities.find((spec) => spec.id === "k");
    const floor = scenario.entities.find((spec) => spec.id === "boden");
    assert.ok(body?.kind === "body" && floor?.kind === "constraint");
    assert.deepEqual(body.phase.shape, { type: "box", halfExtents: [0.2, 0.1, 0.05] });
    close(body.velocity.angular[2], Math.PI, 1e-12, "Winkelgeschwindigkeit");
    assert.deepEqual(floor.size, [3, 1]);
    assert.equal(floor.thickness, 0.05);
    const changes = scenario.interventions.flatMap((i) => (i.op === "change" ? [i.change] : []));
    assert.deepEqual(changes, [
      { key: "dimensions", value: [4, 2, 0.1] },
      { key: "halfExtents", value: [0.5, 0.5, 0.5] },
    ]);
  });

  it("setzt ohne Angabe die Erdschwere und laesst sie bei gravity: [] weg", () => {
    const withDefault = assembled({ name: "a", duration: 1 });
    const load = withDefault.entities.find((spec) => spec.kind === "load");
    assert.ok(load?.kind === "load");
    assert.equal(load.magnitude, EARTH_GRAVITY);
    assert.equal(assembled({ name: "b", duration: 1, gravity: [] }).entities.length, 0);
  });

  it("nennt unbekannte Materialien, unbekannte Entitaeten und unpassende Schluessel", () => {
    const result = assembleScenario({
      name: "Fehler",
      duration: 1,
      bodies: [{ id: "k", materialId: "gold", size: [0.2, 0.2, 0.2], position: [0, 0, 1] }],
      changes: [
        { t: 0.5, entityId: "geist", key: "position", value: [0, 0, 0] },
        { t: 0.5, entityId: "k", key: "magnitude", value: 3 },
        { t: 0.5, entityId: "k", key: "rotation", value: 3 },
      ],
    });
    assert.ok(!result.ok);
    const text = result.errors.join("\n");
    assert.match(text, /unbekanntes Material "gold"/);
    assert.match(text, /changes\.0.*unbekannte Entitaet/);
    assert.match(text, /changes\.1.*passt nicht/);
    assert.match(text, /changes\.2.*drei Zahlen/);
  });

  it("lehnt doppelte Kennungen ab", () => {
    const result = assembleScenario({
      name: "Doppelt",
      duration: 1,
      bodies: [{ id: "x", size: [0.2, 0.2, 0.2], position: [0, 0, 1] }],
      surfaces: [{ id: "x", position: [0, 0, 0], length: 2, width: 2 }],
    });
    assert.ok(!result.ok);
    assert.match(result.errors.join("\n"), /"x" ist doppelt/);
  });
});

describe("Szenarioentwurf - Pruefbericht", () => {
  it("misst im freien Fall s = ½gt²", () => {
    const duration = 1;
    const report = inspectScenario({
      name: "Freier Fall",
      duration,
      bodies: [{ id: "k", size: [0.2, 0.2, 0.2], position: [0, 0, 10] }],
    });
    assert.ok(report.ok, report.errors.join("\n"));
    const body = report.bodies[0]!;
    close(body.endPosition[2], 10 - 0.5 * EARTH_GRAVITY * duration * duration, 0.02, "Endhoehe");
    close(body.maxSpeed, EARTH_GRAVITY * duration, 0.02, "Endgeschwindigkeit");
    assert.equal(body.minSurfaceDistance, null);
  });

  it("meldet einen Koerper, der in einer Platte steckt, als Fehler", () => {
    const report = inspectScenario({
      name: "Steckt",
      duration: 0.2,
      surfaces: [{ id: "boden", position: [0, 0, 0], length: 4, width: 4 }],
      bodies: [{ id: "k", size: [0.2, 0.2, 0.2], position: [0, 0, 0.02] }],
    });
    assert.ok(!report.ok);
    assert.match(report.errors.join("\n"), /"k" steckt/);
  });

  it("warnt vor einem Koerper, der an allen Flaechen vorbeifaellt, und vor Eingriffen nach dem Ende", () => {
    const report = inspectScenario({
      name: "Daneben",
      duration: 1.5,
      surfaces: [{ id: "boden", position: [0, 0, 0], length: 1, width: 1 }],
      bodies: [{ id: "k", size: [0.2, 0.2, 0.2], position: [5, 0, 1] }],
      changes: [{ t: 3, entityId: "k", key: "linearVelocity", value: [0, 0, 0] }],
    });
    assert.ok(report.ok, report.errors.join("\n"));
    const text = report.warnings.join("\n");
    assert.match(text, /faellt vermutlich an ihnen vorbei/);
    assert.match(text, /hinter der Gesamtdauer/);
  });

  it("findet im Beispiel der Anweisungen nichts zu beanstanden", () => {
    const report = inspectScenario(instructionExample());
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.ok(report.bodies[0]!.contactIntervals.length > 0, "der Klotz landet auf der Rampe");
  });
});

describe("MCP-Endpunkt", () => {
  const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  async function call(app: ReturnType<typeof createServer>, method: string, params: unknown, headers = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...MCP_HEADERS, ...headers },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    return { status: response.statusCode, body: response.statusCode === 200 ? response.json() : undefined };
  }

  it("listet die drei Werkzeuge mit Eingabeschema", async () => {
    const app = createServer();
    const { status, body } = await call(app, "tools/list", {});
    assert.equal(status, 200);
    const tools = body.result.tools as { name: string; inputSchema: { properties?: object } }[];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "bibliothek_auflisten",
      "szenario_abschliessen",
      "szenario_pruefen",
    ]);
    const check = tools.find((tool) => tool.name === "szenario_pruefen")!;
    assert.ok(check.inputSchema.properties && "bodies" in check.inputSchema.properties);
  });

  it("legt ein fertiges Szenario ab, das unter seinem Studio-Link abrufbar ist", async () => {
    const app = createServer({ store: createMemoryScenarioStore(), studioUrl: "https://lernen.example/studio/" });
    const { body } = await call(app, "tools/call", { name: "szenario_abschliessen", arguments: instructionExample() });
    assert.notEqual(body.result.isError, true, body.result.content[0].text);
    const { id, studioUrl } = JSON.parse(body.result.content[0].text) as { id: string; studioUrl: string };
    assert.equal(studioUrl, `https://lernen.example/studio/?szenario=${id}`);

    const stored = await app.inject({ method: "GET", url: `/v1/scenarios/${id}` });
    assert.equal(stored.statusCode, 200);
    assert.ok(Scenario.safeParse(stored.json()).success);
    assert.equal((await app.inject({ method: "GET", url: "/v1/scenarios/gibt-es-nicht" })).statusCode, 404);
  });

  it("legt einen fehlerhaften Entwurf nicht ab", async () => {
    const app = createServer();
    const { body } = await call(app, "tools/call", {
      name: "szenario_abschliessen",
      arguments: { name: "Kaputt", duration: 1, bodies: [{ id: "k", materialId: "gold", size: [1, 1, 1], position: [0, 0, 1] }] },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /gold/);
  });

  it("verlangt das Token, wenn eines gesetzt ist", async () => {
    const app = createServer({ mcpToken: "geheim" });
    assert.equal((await call(app, "tools/list", {})).status, 401);
    assert.equal((await call(app, "tools/list", {}, { authorization: "Bearer geheim" })).status, 200);
  });
});
