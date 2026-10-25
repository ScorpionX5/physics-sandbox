import type { ViewLayer } from "@sandbox/schema";

/**
 * Die Ansichtsleiste: quadratische Icon-Knoepfe, mittig oben *auf* dem
 * Grafikbereich - wie die Ansichtssteuerung in einem CAD-Programm.
 *
 * Sie liegt im Viewport und nicht in einer Seitenleiste, weil sie zum Bild
 * gehoert: man wechselt die Ansicht, waehrend man hinsieht, und nicht, waehrend
 * man Eigenschaften pflegt.
 *
 * Die Icons sind eingebettetes SVG statt einer Icon-Bibliothek - vier Symbole
 * rechtfertigen keine Abhaengigkeit, und so lassen sie sich mit `currentColor`
 * ohne weiteres an das Farbschema binden.
 */

export interface ViewToolbarProps {
  layers: ViewLayer[];
  current: ViewLayer;
  onSelect(layer: ViewLayer): void;
  onFrameScene(): void;
  showAxes: boolean;
  onToggleAxes(): void;
}

/** Beschriftung der Ebenen, wie sie im Hinweistext erscheinen soll. */
const LAYER_TITLES: Record<ViewLayer, string> = {
  macroscopic: "Standard",
  kinematic: "Kinematik",
  atomic: "Atome",
  subatomic: "Kerne",
  thermal: "Temperatur",
  fields: "Felder",
};

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Wuerfel in Schraegansicht - die koerperliche, makroskopische Darstellung. */
function StandardIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M12 2.8 20.2 7v10L12 21.2 3.8 17V7z" />
      <path d="M3.8 7 12 11.4 20.2 7" />
      <path d="M12 11.4v9.8" />
    </svg>
  );
}

/** Pfeil mit Bahnkurve - Geschwindigkeit und Beschleunigung. */
function KinematicIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 19c3.4 0 6.1-1.6 8-4.6C12.9 11.3 15.6 9 19 9" />
      <path d="M14.6 7.4 19 9l-1.6 4.4" />
      <circle cx="4.6" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Gitter aus Kugeln - die atomare Darstellung. */
function AtomicIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="6.5" cy="6.5" r="2.3" />
      <circle cx="17.5" cy="6.5" r="2.3" />
      <circle cx="6.5" cy="17.5" r="2.3" />
      <circle cx="17.5" cy="17.5" r="2.3" />
      <path d="M8.8 6.5h6.4M8.8 17.5h6.4M6.5 8.8v6.4M17.5 8.8v6.4" />
    </svg>
  );
}

/** Rahmen mit Pfeilen nach aussen - die Ansicht einpassen. */
function FrameIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3.8 9V5.4a1.6 1.6 0 0 1 1.6-1.6H9" />
      <path d="M15 3.8h3.6a1.6 1.6 0 0 1 1.6 1.6V9" />
      <path d="M20.2 15v3.6a1.6 1.6 0 0 1-1.6 1.6H15" />
      <path d="M9 20.2H5.4a1.6 1.6 0 0 1-1.6-1.6V15" />
      <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="0.8" />
    </svg>
  );
}

/** Drei Achsen von einem Ursprung - das Koordinatensystem. */
function AxesIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M12 14V3.5M12 14l8 4.8M12 14l-8 4.8" />
      <path d="M9.6 5.9 12 3.5l2.4 2.4" />
      <path d="M16 18.9l4 -.1-1.8-3.6" />
      <path d="M8 18.9l-4-.1 1.8-3.6" />
      <circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

const LAYER_ICONS: Partial<Record<ViewLayer, () => JSX.Element>> = {
  macroscopic: StandardIcon,
  kinematic: KinematicIcon,
  atomic: AtomicIcon,
};

export function ViewToolbar({
  layers,
  current,
  onSelect,
  onFrameScene,
  showAxes,
  onToggleAxes,
}: ViewToolbarProps) {
  return (
    <div className="ansichtsleiste" role="toolbar" aria-label="Darstellung">
      {layers.map((layer) => {
        const Icon = LAYER_ICONS[layer];
        if (!Icon) return null;
        const title = LAYER_TITLES[layer];
        return (
          <button
            key={layer}
            type="button"
            className={layer === current ? "icon-knopf aktiv" : "icon-knopf"}
            onClick={() => onSelect(layer)}
            title={title}
            aria-label={title}
            aria-pressed={layer === current}
          >
            <Icon />
          </button>
        );
      })}
      <span className="leisten-trenner" />
      <button
        type="button"
        className="icon-knopf"
        onClick={onFrameScene}
        title="Ansicht einpassen"
        aria-label="Ansicht einpassen"
      >
        <FrameIcon />
      </button>
      <button
        type="button"
        className={showAxes ? "icon-knopf aktiv" : "icon-knopf"}
        onClick={onToggleAxes}
        title="Koordinatensystem"
        aria-label="Koordinatensystem"
        aria-pressed={showAxes}
      >
        <AxesIcon />
      </button>
    </div>
  );
}

export { LAYER_TITLES };
