import { ENTITY_CLASS_LABELS, type EntityClass } from "../entityProperties.js";

/**
 * Die Icons der Klassen ohne Unterklassen - in der Bibliothek vor dem Namen,
 * in der rechten Leiste in der Kopfzeile jeder Entitaet.
 *
 * Nur die Blattklassen bekommen eines: eine Entitaet hat immer genau eine
 * speziellste Klasse, und nur die soll man ihr ansehen. Eingebettetes SVG mit
 * `currentColor` aus demselben Grund wie in der Ansichtsleiste.
 */

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Flacher Quader in Schraegansicht - breiter als hoch, damit er sich vom Wuerfel der Ansichtsleiste abhebt. */
function CuboidIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.8 10.2h13.6v9.6H2.8z" />
      <path d="M2.8 10.2 7.6 5.4h13.6l-4.8 4.8" />
      <path d="M21.2 5.4V15l-4.8 4.8" />
    </svg>
  );
}

/** Rechteckplatte in Aufsicht von schraeg - die Ebene. */
function PlaneIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.8 17.6 8 6.4h13.2L16 17.6z" />
      <path d="M9.4 17.6 14.6 6.4" />
      <path d="M5.4 12h13.2" />
    </svg>
  );
}

/** Drei Feldlinien nach unten - ein Schwerefeld hat keinen Ort, nur eine Richtung. */
function GravityIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M6 3.5v14M12 3.5v17M18 3.5v14" />
      <path d="m3.6 15.2 2.4 2.6 2.4-2.6M9.6 18l2.4 2.6 2.4-2.6M15.6 15.2l2.4 2.6 2.4-2.6" />
    </svg>
  );
}

const CLASS_ICONS: Partial<Record<EntityClass, () => JSX.Element>> = {
  cuboid: CuboidIcon,
  plane: PlaneIcon,
  gravity: GravityIcon,
};

export function hasClassIcon(entityClass: EntityClass | undefined): entityClass is EntityClass {
  return entityClass !== undefined && CLASS_ICONS[entityClass] !== undefined;
}

/**
 * Das Icon einer Klasse. Mit `withTitle` traegt es den Klassennamen als
 * Tooltip - in der rechten Leiste steht der Name sonst nirgends, in der
 * Bibliothek steht er schon daneben.
 */
export function ClassIcon({
  entityClass,
  withTitle = false,
}: {
  entityClass: EntityClass;
  withTitle?: boolean;
}) {
  const Icon = CLASS_ICONS[entityClass];
  if (!Icon) return null;
  const label = ENTITY_CLASS_LABELS[entityClass];
  return (
    <span
      className="klassen-icon"
      {...(withTitle ? { title: label, role: "img", "aria-label": label } : {})}
    >
      <Icon />
    </span>
  );
}
