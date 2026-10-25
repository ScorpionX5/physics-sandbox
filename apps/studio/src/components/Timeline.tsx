import type { Recording, Scenario } from "@sandbox/schema";
import { MAX_DURATION } from "@sandbox/schema";
import { describeIntervention } from "../entityProperties.js";
import {
  interventionMarks,
  INTERVENTION_TIME_STEP,
  roundInterventionTime,
  timeRelation,
} from "../scenarioEdits.js";
import { CommittedNumber, formatSeconds } from "./CommittedNumber.js";

/**
 * Die Zeitleiste: Transport, Zeitcursor, Gesamtdauer und je Zeitpunkt mit
 * Eingriffen eine Raute.
 *
 * Der Zeitcursor ist die Abspielzeit. Sein Zahlenfeld und der Schieber zeigen
 * beide den Spiegel `t` und spulen beide ueber `onSeek` - gekoppelt sind sie
 * ueber den `Playhead`, nicht untereinander.
 */

export interface TimelineProps {
  scenario: Scenario;
  recording: Recording;
  /**
   * Nur zur Anzeige (Zeitcursor-Feld und Schieberstellung). Die Abspielzeit
   * lebt im `Playhead` des Betrachters - spulen geht ausschliesslich ueber
   * `onSeek`.
   */
  t: number;
  /** Ebenfalls nur zur Anzeige; umgeschaltet wird mit `onPlay`/`onPause`. */
  isPlaying: boolean;
  onSeek(t: number): void;
  onPlay(): void;
  onPause(): void;
  onDuration(duration: number): void;
}

/** Mediaplayer-Symbole fuer die Transportknoepfe, statt Text. */
function SymbolAnfang() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="3" y="3" width="2" height="10" fill="currentColor" />
      <path d="M13 3 5 8l8 5Z" fill="currentColor" />
    </svg>
  );
}

function SymbolEnde() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="11" y="3" width="2" height="10" fill="currentColor" />
      <path d="M3 3l8 5-8 5Z" fill="currentColor" />
    </svg>
  );
}

function SymbolPlay() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 2.5v11l10-5.5Z" fill="currentColor" />
    </svg>
  );
}

function SymbolPause() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3" height="11" fill="currentColor" />
      <rect x="9.5" y="2.5" width="3" height="11" fill="currentColor" />
    </svg>
  );
}

export function Timeline({
  scenario,
  recording,
  t,
  isPlaying,
  onSeek,
  onPlay,
  onPause,
  onDuration,
}: TimelineProps) {
  const total = scenario.duration;
  const marks = interventionMarks(scenario);
  // Dieselbe Rundung wie beim Anlegen: hervorgehoben ist die Raute, zu der ein
  // jetzt angelegter Eingriff kaeme.
  const cursorTime = roundInterventionTime(Math.min(Math.max(t, 0), MAX_DURATION));

  return (
    <section className="zeitleiste">
      <div className="transport">
        <button type="button" onClick={() => onSeek(0)} className="transport-knopf" aria-label="Anfang" title="Anfang">
          <SymbolAnfang />
        </button>
        <button
          type="button"
          onClick={isPlaying ? onPause : onPlay}
          className="transport-knopf"
          aria-label={isPlaying ? "Pause" : "Wiedergabe"}
          title={isPlaying ? "Pause" : "Wiedergabe"}
        >
          {isPlaying ? <SymbolPause /> : <SymbolPlay />}
        </button>
        <button
          type="button"
          onClick={() => onSeek(total)}
          className="transport-knopf"
          aria-label="Ende"
          title="Ende"
        >
          <SymbolEnde />
        </button>
      </div>
      <div className="uhr">
        {/* Waehrend der Wiedergabe nur Anzeige: die Uhr laeuft in jedem Bild
            weiter und ueberschriebe jede Eingabe sofort. */}
        <CommittedNumber
          value={Math.min(t, total)}
          min={0}
          max={total}
          step={INTERVENTION_TIME_STEP}
          format={formatSeconds}
          readOnly={isPlaying}
          ariaLabel="Zeitcursor"
          title="Zeitcursor"
          unit="s"
          onCommit={onSeek}
        />
        <span className="uhr-trenner">/</span>
        <CommittedNumber
          value={total}
          min={INTERVENTION_TIME_STEP}
          max={MAX_DURATION}
          step={1}
          format={formatSeconds}
          ariaLabel="Gesamtdauer"
          title="Gesamtdauer"
          unit="s"
          onCommit={onDuration}
        />
      </div>

      <div className="schieber-bereich">
        <input
          type="range"
          min={0}
          max={total}
          step={1 / recording.recordRate}
          value={Math.min(t, total)}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="Zeitcursor"
        />
        <div className="eingriffsmarken">
          {marks.map((mark) => (
            <button
              key={mark.t}
              type="button"
              className={`marke ${timeRelation(mark.t, cursorTime)}`}
              style={{ left: `${(mark.t / total) * 100}%` }}
              title={[
                `t = ${formatSeconds(mark.t)} s`,
                ...mark.interventions.map((intervention) =>
                  describeIntervention(scenario, intervention),
                ),
              ].join("\n")}
              onClick={() => onSeek(mark.t)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
