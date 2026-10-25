import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BUILTIN_LIBRARY,
  createInclinedPlaneScenario,
  LibraryEntry,
  Recording,
  Scenario,
  validateLibraryEntry,
  type ValidationResult,
} from "@sandbox/schema";
import { runScenario, summarizeEntity } from "@sandbox/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MissingCredentialsError, synthesizeEntry, type LibrarianModel } from "./librarian.js";
import { createSandboxMcpServer } from "./mcp.js";
import { createMemoryScenarioStore, type ScenarioStore } from "./scenarioStore.js";

/**
 * Der HTTP-Dienst.
 *
 * Zwei Aufgaben: er haelt den API-Schluessel vom Browser fern, und er
 * versioniert die Grenze zur Lernplattform. Da die Plattform parallel entsteht,
 * ist das OpenAPI-Schema aus denselben Zod-Schemas erzeugt wie der
 * Simulationskern - das Plattform-Team kann dagegen arbeiten, bevor hier etwas
 * fertig ist.
 *
 * Der Schluessel verlaesst diesen Prozess nie. Studio und Abspieler rufen den
 * Dienst, nicht die Claude API; ein Schluessel im Browser-Bundle ist
 * oeffentlich.
 */

export const SynthesizeRequest = z.object({
  /** Die Texteingabe - vom Benutzer oder vom Regisseur. */
  prompt: z.string().min(1).max(2000),
  /** Bereits belegte Ids, damit eine neue nicht kollidiert. */
  takenIds: z.array(z.string()).max(500).optional(),
});
export type SynthesizeRequest = z.infer<typeof SynthesizeRequest>;

export const SynthesizeResponse = z.object({
  ok: z.boolean(),
  entry: LibraryEntry.optional(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  correctedFields: z.array(z.string()),
});

export const RunRequest = z.object({ scenario: Scenario });

export const RunResponse = z.object({
  recording: Recording,
  /** Zusammenfassung je Koerper - was der Regisseur ueber `inspect_recording` liest. */
  summaries: z.array(
    z.object({
      entityId: z.string(),
      tFirst: z.number(),
      tLast: z.number(),
      sampleCount: z.number(),
      startPosition: z.tuple([z.number(), z.number(), z.number()]),
      endPosition: z.tuple([z.number(), z.number(), z.number()]),
      pathLength: z.number(),
      maxSpeed: z.number(),
      tAtMaxSpeed: z.number(),
      endSpeed: z.number(),
      contactIntervals: z.array(z.object({ from: z.number(), to: z.number() })),
    }),
  ),
});

export interface ServerOptions {
  /**
   * Die Modellanbindung. Fehlt sie, antwortet `/v1/library/synthesize` mit 503
   * statt mit einem Absturz - der Dienst ist auch ohne Zugangsdaten nutzbar,
   * nur eben ohne Bibliothekar.
   */
  librarian?: LibrarianModel;
  /** Wo `szenario_abschliessen` ablegt und `/v1/scenarios/:id` liest. Ohne Angabe: im Speicher. */
  store?: ScenarioStore;
  /** Basisadresse des Studios fuer die Links, die der MCP-Server zurueckgibt. */
  studioUrl?: string;
  /**
   * Ist er gesetzt, verlangt `/mcp` `Authorization: Bearer <token>`. Der
   * Endpunkt legt Dateien ab und laeuft auf einem Server, den auch andere
   * erreichen - ohne Token kann jeder dort schreiben.
   */
  mcpToken?: string;
  logger?: boolean;
}

/** Was in einer Validierungsantwort nach aussen geht. */
function toSynthesizeResponse(result: ValidationResult): z.infer<typeof SynthesizeResponse> {
  return {
    ok: result.ok,
    ...(result.entry ? { entry: result.entry } : {}),
    errors: result.errors,
    warnings: result.warnings,
    correctedFields: result.correctedFields,
  };
}

export function createServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const store = options.store ?? createMemoryScenarioStore();
  const studioUrl = options.studioUrl ?? "http://localhost:5173/";

  app.get("/v1/health", async () => ({
    status: "ok",
    librarian: options.librarian ? options.librarian.modelId : null,
  }));

  /**
   * Die Startbibliothek. Handgepflegt und damit das Vergleichsmaterial fuer die
   * Pruefung: ein KI-Eintrag fuer Eisen sollte nach der Korrektur hier landen.
   */
  app.get("/v1/library", async () => ({ schemaVersion: 1, entries: BUILTIN_LIBRARY }));

  /** Das Durchstich-Szenario - damit das Plattform-Team etwas zum Abspielen hat. */
  app.get("/v1/scenarios/durchstich", async () => createInclinedPlaneScenario());

  /** Ein vom Regisseur abgelegtes Szenario - das Studio laedt es ueber `?szenario=<kennung>`. */
  app.get<{ Params: { id: string } }>("/v1/scenarios/:id", async (request, reply) => {
    const scenario = await store.get(request.params.id);
    if (!scenario) return reply.code(404).send({ errors: [`Kein Szenario mit der Kennung "${request.params.id}".`] });
    return scenario;
  });

  /**
   * Die Sandbox-Werkzeuge fuer den Regisseur, als MCP ueber Streamable HTTP.
   *
   * Zustandslos: je Anfrage ein frischer Server und Transport. Die Werkzeuge
   * halten nichts zwischen zwei Aufrufen - ein Entwurf ist jedes Mal das ganze
   * Szenario -, also gibt es keine Sitzung, die ein Neustart verlieren koennte.
   */
  app.post("/mcp", async (request, reply) => {
    if (options.mcpToken && request.headers.authorization !== `Bearer ${options.mcpToken}`) {
      return reply.code(401).send({ errors: ["Authorization: Bearer <MCP_TOKEN> fehlt oder stimmt nicht."] });
    }
    const server = createSandboxMcpServer({ store, studioUrl });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  // Ohne Sitzung gibt es keinen Rueckkanal (GET) und nichts zu beenden (DELETE).
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_request, reply) =>
        reply.code(405).header("allow", "POST").send({ errors: ["Nur POST - der MCP-Endpunkt ist zustandslos."] }),
    });
  }

  app.post("/v1/library/synthesize", async (request, reply) => {
    const parsed = SynthesizeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        warnings: [],
        correctedFields: [],
      });
    }
    if (!options.librarian) {
      return reply.code(503).send({
        ok: false,
        errors: [
          "Der Bibliothekar ist nicht eingerichtet. Setze ANTHROPIC_API_KEY oder melde dich " +
            "mit `ant auth login` an und starte den Dienst neu.",
        ],
        warnings: [],
        correctedFields: [],
      });
    }

    try {
      const result = await synthesizeEntry(options.librarian, parsed.data.prompt, {
        ...(parsed.data.takenIds ? { takenIds: parsed.data.takenIds } : {}),
      });
      // Ein abgelehnter Eintrag ist kein Serverfehler: die Anfrage war in
      // Ordnung, die Antwort des Modells nicht. 422 sagt genau das.
      return reply.code(result.ok ? 200 : 422).send(toSynthesizeResponse(result));
    } catch (error) {
      request.log.error({ error }, "Bibliothekar fehlgeschlagen");
      // Fehlende Zugangsdaten sind kein Fehler des Modells: der Benutzer
      // braucht den Hinweis, wie er sie einrichtet, nicht die Meldung, das
      // Modell sei nicht erreichbar.
      const missingCredentials = error instanceof MissingCredentialsError;
      return reply.code(missingCredentials ? 503 : 502).send({
        ok: false,
        errors: [
          missingCredentials
            ? (error as Error).message
            : `Aufruf des Modells fehlgeschlagen: ${(error as Error).message}`,
        ],
        warnings: [],
        correctedFields: [],
      });
    }
  });

  /** Prueft einen von Hand oder extern erzeugten Eintrag, ohne das Modell zu rufen. */
  app.post("/v1/library/validate", async (request, reply) => {
    const result = validateLibraryEntry(request.body);
    return reply.code(result.ok ? 200 : 422).send(toSynthesizeResponse(result));
  });

  app.post("/v1/runs", async (request, reply) => {
    const parsed = RunRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    try {
      const recording = runScenario(parsed.data.scenario);
      const bodyIds = new Set<string>();
      for (const snapshot of recording.snapshots) {
        for (const id of Object.keys(snapshot.entities)) bodyIds.add(id);
      }
      return reply.send({
        recording,
        summaries: [...bodyIds].map((id) => summarizeEntity(recording, id)),
      });
    } catch (error) {
      // Ein Szenario, das schemakonform ist, aber nicht laufen kann (fehlender
      // Bibliothekseintrag, Eingriff auf ein fehlendes Objekt), ist ein Fehler der Anfrage.
      return reply.code(422).send({ errors: [(error as Error).message] });
    }
  });

  app.get("/v1/openapi.json", async () => openApiDocument());

  return app;
}

/**
 * Erzeugt das OpenAPI-Dokument aus den Zod-Schemas.
 *
 * Aus *denselben* Schemas, die auch den Kern typisieren - deshalb kann das
 * Dokument nicht veralten. `z.toJSONSchema` kommt aus Zod 4; der Zielmodus
 * "input" ist richtig, weil ein Aufrufer Felder mit Standardwerten weglassen
 * darf.
 */
export function openApiDocument(): unknown {
  const schema = (value: z.ZodType, io: "input" | "output" = "output"): unknown =>
    z.toJSONSchema(value, { io, unrepresentable: "any" });

  const jsonBody = (value: unknown) => ({
    required: true,
    content: { "application/json": { schema: value } },
  });
  const jsonResponse = (description: string, value: unknown) => ({
    description,
    content: { "application/json": { schema: value } },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Physik-Sandbox",
      version: "1.0.0",
      description:
        "Grenze zwischen Sandbox und Lernplattform. Alle Nutzlasten stammen aus den " +
        "Zod-Schemas von @sandbox/schema und koennen damit nicht von der Implementierung " +
        "abweichen.",
    },
    paths: {
      "/v1/health": {
        get: {
          summary: "Erreichbarkeit und ob der Bibliothekar eingerichtet ist",
          responses: { "200": jsonResponse("Status", { type: "object" }) },
        },
      },
      "/v1/library": {
        get: {
          summary: "Die Startbibliothek",
          responses: {
            "200": jsonResponse("Bibliothek", {
              type: "object",
              properties: { schemaVersion: { const: 1 }, entries: { type: "array", items: schema(LibraryEntry) } },
            }),
          },
        },
      },
      "/v1/scenarios/durchstich": {
        get: {
          summary: "Das Durchstich-Szenario (Klotz auf der schiefen Ebene)",
          responses: { "200": jsonResponse("Szenario", schema(Scenario)) },
        },
      },
      "/v1/scenarios/{id}": {
        get: {
          summary: "Ein vom Regisseur ueber MCP abgelegtes Szenario",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": jsonResponse("Szenario", schema(Scenario)),
            "404": jsonResponse("Unbekannte Kennung", { type: "object" }),
          },
        },
      },
      "/v1/library/synthesize": {
        post: {
          summary: "Bibliothekar: Text rein, geprueftes Objekt raus",
          requestBody: jsonBody(schema(SynthesizeRequest, "input")),
          responses: {
            "200": jsonResponse("Geprueftes Objekt", schema(SynthesizeResponse)),
            "422": jsonResponse("Antwort des Modells von der Pruefung abgelehnt", schema(SynthesizeResponse)),
            "502": jsonResponse("Aufruf des Modells fehlgeschlagen", schema(SynthesizeResponse)),
            "503": jsonResponse("Bibliothekar nicht eingerichtet", schema(SynthesizeResponse)),
          },
        },
      },
      "/v1/library/validate": {
        post: {
          summary: "Einen vorhandenen Eintrag pruefen, ohne das Modell zu rufen",
          requestBody: jsonBody(schema(LibraryEntry, "input")),
          responses: {
            "200": jsonResponse("Eintrag in Ordnung", schema(SynthesizeResponse)),
            "422": jsonResponse("Eintrag abgelehnt", schema(SynthesizeResponse)),
          },
        },
      },
      "/v1/runs": {
        post: {
          summary: "Szenario ausfuehren und Aufzeichnung zurueckgeben",
          requestBody: jsonBody({
            type: "object",
            required: ["scenario"],
            properties: { scenario: schema(Scenario, "input") },
          }),
          responses: {
            "200": jsonResponse("Aufzeichnung mit Zusammenfassungen", schema(RunResponse)),
            "422": jsonResponse("Szenario nicht ausfuehrbar", { type: "object" }),
          },
        },
      },
    },
  };
}
