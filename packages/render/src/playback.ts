import type { MechanicalState, Recording, Snapshot, Vec3, ViewLayer } from "@sandbox/schema";

/**
 * Abspiellogik: aus einer Aufzeichnung den Zustand zu einem beliebigen
 * Zeitpunkt gewinnen.
 *
 * Eine Aufzeichnung enthaelt 20 Schnappschuesse pro simulierter Sekunde,
 * dargestellt wird mit 60 Bildern pro Sekunde. Ohne Interpolation ruckelt die
 * Bewegung sichtbar. Interpolation ist deshalb kein Komfort, sondern die
 * Voraussetzung dafuer, dass die Aufzeichnungsrate klein bleiben darf - und
 * genau daran haengt, dass eine Aufzeichnung um zwei Groessenordnungen kleiner
 * ist als ein Video.
 *
 * **Warum das hier liegt und nicht im Kern:** Interpolation ist eine
 * Darstellungsaufgabe. Der Kern unterliegt der Determinismusregel (nur
 * + - * / und sqrt), eine ordentliche Quaternion-Interpolation braucht aber
 * Winkelfunktionen. Diese Trennung sauber zu halten ist mehr wert als die
 * Funktion ein Paket weiter unten zu haben.
 */

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpVec3(a: Vec3, b: Vec3, alpha: number): Vec3 {
  return [lerp(a[0], b[0], alpha), lerp(a[1], b[1], alpha), lerp(a[2], b[2], alpha)];
}

/**
 * Quaternion-Interpolation per normalisierter Linearinterpolation (nlerp).
 *
 * Zwischen zwei benachbarten Schnappschuessen liegen bei 20 Hz hoechstens 50 ms;
 * selbst bei mehreren Umdrehungen pro Sekunde ist der Winkel dazwischen klein,
 * und nlerp ist von der echten Slerp dann nicht zu unterscheiden. Dafuer braucht
 * es keine Winkelfunktionen und keine Behandlung des Falls, dass beide
 * Quaternionen fast parallel sind.
 *
 * Das Vorzeichen wird angeglichen: q und -q beschreiben dieselbe Drehung, aber
 * die Interpolation zwischen ihnen wuerde den langen Weg nehmen und einen
 * sichtbaren Sprung erzeugen.
 */
function nlerpQuat(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  alpha: number,
): [number, number, number, number] {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  const x = lerp(a[0], sign * b[0], alpha);
  const y = lerp(a[1], sign * b[1], alpha);
  const z = lerp(a[2], sign * b[2], alpha);
  const w = lerp(a[3], sign * b[3], alpha);
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (length === 0) return [0, 0, 0, 1];
  return [x / length, y / length, z / length, w / length];
}

function interpolateMechanics(
  a: MechanicalState,
  b: MechanicalState,
  alpha: number,
): MechanicalState {
  return {
    position: lerpVec3(a.position, b.position, alpha),
    orientation: nlerpQuat(a.orientation, b.orientation, alpha),
    linearVelocity: lerpVec3(a.linearVelocity, b.linearVelocity, alpha),
    angularVelocity: lerpVec3(a.angularVelocity, b.angularVelocity, alpha),
    force: lerpVec3(a.force, b.force, alpha),
    acceleration: lerpVec3(a.acceleration, b.acceleration, alpha),
    // Kontaktzahl ist ganzzahlig und nicht sinnvoll interpolierbar - der
    // frueherere Wert gilt bis zum naechsten Schnappschuss.
    contactCount: a.contactCount,
  };
}

/**
 * Der Zustand zum Zeitpunkt `t`, zwischen den umgebenden Schnappschuessen
 * interpoliert. Ausserhalb des aufgezeichneten Bereichs wird der Rand gehalten.
 *
 * Entitaeten, die nur in einem der beiden Schnappschuesse vorkommen, werden
 * *nicht* interpoliert: ein Koerper, der durch einen Eingriff hinzukommt, soll
 * erscheinen und nicht aus dem Nichts heranfliegen.
 */
export function snapshotAt(recording: Recording, t: number): Snapshot {
  const snapshots = recording.snapshots;
  if (snapshots.length === 0) return { t, entities: {} };
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  if (t <= first.t) return first;
  if (t >= last.t) return last;

  // Binaere Suche: bei einer langen Aufzeichnung wird pro Bild gesucht.
  let low = 0;
  let high = snapshots.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (snapshots[middle]!.t <= t) low = middle;
    else high = middle;
  }

  const before = snapshots[low]!;
  const after = snapshots[high]!;
  const span = after.t - before.t;
  const alpha = span === 0 ? 0 : (t - before.t) / span;

  const entities: Snapshot["entities"] = {};
  for (const [id, stateBefore] of Object.entries(before.entities)) {
    const stateAfter = after.entities[id];
    if (!stateAfter) continue;
    if (stateBefore.mechanics && stateAfter.mechanics) {
      entities[id] = {
        ...stateBefore,
        mechanics: interpolateMechanics(stateBefore.mechanics, stateAfter.mechanics, alpha),
      };
    } else {
      entities[id] = stateBefore;
    }
  }
  // Entitaeten, die erst im spaeteren Schnappschuss auftauchen, erscheinen dort
  // unveraendert - ohne Interpolation aus einer Lage, die sie nie hatten.
  for (const [id, stateAfter] of Object.entries(after.entities)) {
    if (!(id in before.entities) && alpha >= 1) entities[id] = stateAfter;
  }

  return { t, entities };
}

export function recordingDuration(recording: Recording): number {
  const last = recording.snapshots[recording.snapshots.length - 1];
  return last?.t ?? 0;
}

// ---------------------------------------------------------------- Regiespur

export interface ActiveDirection {
  /** Die zuletzt angewiesene Darstellungsebene, falls die Regie eine setzt. */
  layer: ViewLayer | undefined;
  /** Zu diesem Zeitpunkt sichtbare Annotationen. */
  annotations: { text: string; entityId: string | undefined }[];
  /** Die zuletzt angewiesene Zeitstreckung. */
  timeScale: number | undefined;
  /** Kamerafahrt, die gerade gilt. */
  camera: { position: Vec3; target: Vec3; alpha: number } | undefined;
  /** Liegt auf diesem Zeitpunkt eine Pause-Anweisung? */
  pauseAt: number | undefined;
}

/**
 * Wertet die Regiespur zum Zeitpunkt `t` aus.
 *
 * Die Regie ist bewusst von der Physik getrennt: ein Lernender kann sie
 * ignorieren, die Kamera selbst drehen und die Ebene selbst wechseln, ohne dass
 * die Simulation sich aendert. Deshalb liefert diese Funktion nur einen
 * *Vorschlag* - ob die Benutzeroberflaeche ihm folgt, entscheidet sie selbst.
 */
export function directionAt(recording: Recording, t: number): ActiveDirection {
  const result: ActiveDirection = {
    layer: undefined,
    annotations: [],
    timeScale: undefined,
    camera: undefined,
    pauseAt: undefined,
  };

  for (const cue of recording.scenario.directionTrack) {
    switch (cue.cue) {
      case "setViewLayer":
        if (cue.t <= t) result.layer = cue.layer;
        break;
      case "setTimeScale":
        if (cue.t <= t) result.timeScale = cue.timeScale;
        break;
      case "annotate":
        if (cue.t <= t && t < cue.t + cue.duration) {
          result.annotations.push({ text: cue.text, entityId: cue.entityId });
        }
        break;
      case "moveCamera":
        if (cue.t <= t) {
          const alpha = cue.duration === 0 ? 1 : Math.min(1, (t - cue.t) / cue.duration);
          result.camera = { position: cue.position, target: cue.target, alpha };
        }
        break;
      case "pause":
        // Nur die naechstgelegene Pause vor t ist interessant; der Abspieler
        // entscheidet, ob er sie schon beachtet hat.
        if (cue.t <= t && (result.pauseAt === undefined || cue.t > result.pauseAt)) {
          result.pauseAt = cue.t;
        }
        break;
    }
  }
  return result;
}

/**
 * Der Abspielkopf: verwaltet die Position in der Aufzeichnung, Abspielrichtung
 * und Zeitstreckung.
 *
 * **Hier lebt die Abspielzeit.** `App.t` im Studio ist nur ein Spiegel, den
 * `onFrame` in jedem Bild nachzieht; ihn zu setzen aendert nichts. Wer die Zeit
 * aendern will - spulen, auf 0 setzen, pausieren -, ruft `seek`, `play` oder
 * `pause` an diesem Objekt auf, aus der Oberflaeche ueber `ViewportHandle`.
 *
 * Bewusst von jeder Darstellung getrennt - der Abspieler im
 * Lernplattform-Frontend und das Studio benutzen denselben Abspielkopf, und
 * Tests koennen ihn ohne WebGL pruefen.
 */
export class Playhead {
  /** Die echte Abspielzeit in simulierten Sekunden. Siehe Klassenkommentar. */
  private current = 0;
  private playing = false;
  private scale = 1;

  /**
   * Die Aufzeichnung ist fest: ein Abspielkopf gehoert zu genau einer. Beim
   * Austausch der Aufzeichnung baut `RecordingViewer.setRecording` einen neuen
   * - und dabei geht die Zeit verloren, wenn sie nicht vorher gesichert und
   * danach wieder gesetzt wird. Genau das tut der Bearbeitungszweig in
   * apps/studio/src/components/Viewport.tsx.
   */
  constructor(private readonly recording: Recording) {}

  get t(): number {
    return this.current;
  }

  get duration(): number {
    return recordingDuration(this.recording);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Simulierte Sekunden pro Realsekunde. */
  get timeScale(): number {
    return this.scale;
  }

  setTimeScale(value: number): void {
    if (!(value > 0)) throw new Error(`Zeitstreckung muss positiv sein, war ${value}.`);
    this.scale = value;
  }

  play(): void {
    // Am Ende startet ein Play wieder von vorn - sonst passiert scheinbar
    // nichts, und der Benutzer haelt den Abspieler fuer kaputt.
    if (this.current >= this.duration) this.current = 0;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  seek(t: number): void {
    this.current = Math.min(Math.max(t, 0), this.duration);
  }

  /** Schiebt die Abspielzeit um eine Realzeitspanne weiter. */
  advance(realSeconds: number): void {
    if (!this.playing) return;
    this.current += realSeconds * this.scale;
    if (this.current >= this.duration) {
      this.current = this.duration;
      this.playing = false;
    }
  }

  snapshot(): Snapshot {
    return snapshotAt(this.recording, this.current);
  }
}
