import { useEffect, useRef, useState } from "react";

/**
 * Ein Zahlenfeld, das erst beim Verlassen oder mit Enter uebernimmt.
 *
 * Bei jedem Tastendruck zu uebernehmen wuerde nicht funktionieren: eine halb
 * eingetippte "1" aus "1.5" verschiebt einen Eingriff, die Simulation laeuft
 * neu, und der Rest der Eingabe landet im neu gerenderten Feld. Deshalb haelt
 * das Feld einen eigenen Entwurf, bis die Eingabe abgeschlossen ist.
 *
 * Eine Eingabe ausserhalb von `min`/`max` wird auf die Grenze gesetzt, nicht
 * verworfen - so zeigt das Feld danach, was wirklich gilt.
 */

export const formatSeconds = (value: number): string => value.toFixed(2);

export function CommittedNumber({
  value,
  min,
  max,
  step,
  disabled,
  readOnly,
  className,
  ariaLabel,
  title,
  unit,
  format = String,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Zeigt `value`, nimmt aber keine Eingabe an - etwa die laufende Uhr. */
  readOnly?: boolean;
  className?: string;
  ariaLabel: string;
  title?: string;
  /** Steht im Feld, gehoert aber nicht zum Wert: nicht markier- und nicht editierbar. */
  unit?: string;
  format?: (value: number) => string;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(format(value));
  const inputRef = useRef<HTMLInputElement>(null);
  // Von aussen geaenderte Werte uebernehmen - etwa die Uhr waehrend der
  // Wiedergabe oder ein Eingriff, der durch eine andere Bearbeitung wandert.
  // Zuletzt uebernommene Eingabe. Enter und das folgende Verlassen des Felds
  // committen beide, bevor neu gerendert wird; das zweite Mal haette noch den
  // alten `onCommit` - bei einem Eingriff mit dem alten Index, der nach dem
  // Umsortieren einen anderen Eingriff meint.
  const committed = useRef<number | undefined>(undefined);
  useEffect(() => {
    committed.current = undefined;
    setDraft(format(value));
  }, [value, format]);

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    const clamped = Math.min(Math.max(parsed, min ?? -Infinity), max ?? Infinity);
    if (clamped === value) {
      setDraft(format(value));
      return;
    }
    if (clamped === committed.current) return;
    committed.current = clamped;
    setDraft(format(clamped));
    onCommit(clamped);
  };

  // Der Spinner (Klick oder Pfeiltaste) loest ein natives "change" aus, noch
  // bevor das Feld den Fokus verliert - anders als beim Tippen, das nur
  // "input" ausloest. Nur so bleiben die Nachkommastellen auch waehrend des
  // Hoch-/Runterschaltens formatiert, statt erst beim Verlassen des Felds.
  useEffect(() => {
    const input = inputRef.current;
    if (!input || readOnly) return;
    const handleNativeChange = (event: Event): void => commit((event.target as HTMLInputElement).value);
    input.addEventListener("change", handleNativeChange);
    return () => input.removeEventListener("change", handleNativeChange);
  }, [value, format, onCommit, readOnly, min, max]);

  const field = (
    <input
      ref={inputRef}
      type="number"
      className={className ? `zahlenfeld ${className}` : "zahlenfeld"}
      value={draft}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      {...(step !== undefined ? { step } : {})}
      disabled={disabled}
      readOnly={readOnly}
      aria-label={ariaLabel}
      title={title}
      onChange={(event) => {
        committed.current = undefined;
        setDraft(event.target.value);
      }}
      onBlur={(event) => {
        if (!readOnly) commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (readOnly) return;
        if (event.key === "Enter") {
          commit((event.target as HTMLInputElement).value);
          (event.target as HTMLInputElement).blur();
        }
        if (event.key === "Escape") setDraft(format(value));
      }}
    />
  );
  if (!unit) return field;
  return (
    <span className="zahlenfeld-mit-einheit">
      {field}
      <span className="zahlenfeld-einheit" aria-hidden="true">
        {unit}
      </span>
    </span>
  );
}
