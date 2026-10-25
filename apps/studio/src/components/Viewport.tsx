import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Recording, ViewLayer } from "@sandbox/schema";
import { RecordingViewer } from "@sandbox/render";

/**
 * Der 3D-Viewport.
 *
 * **Die Zeit gehoert dem Betrachter, nicht React.** Waehrend des Abspielens
 * laeuft der Abspielkopf im Bildtakt weiter; wuerde jeder Schritt durch
 * React-Zustand gehen, gaebe es sechzig Renderdurchlaeufe pro Sekunde und einen
 * Rueckkopplungskreis zwischen Zustand und Betrachter. Stattdessen meldet der
 * Betrachter seine Zeit nach oben (`onTime`), und React greift nur ein, wenn
 * der Benutzer spult.
 */

/**
 * Der einzige Weg, von React aus auf Zeit und Kamera zu wirken. Alles hier
 * greift auf den Betrachter durch, nicht auf React-Zustand.
 */
export interface ViewportHandle {
  seek(t: number): void;
  play(): void;
  pause(): void;
  frameScene(): void;
  /** Aktuelle Kamera, zum Mitspeichern im Szenario. */
  cameraPose(): { position: [number, number, number]; target: [number, number, number] } | undefined;
}

export interface ViewportProps {
  recording: Recording;
  layer: ViewLayer;
  showAxes: boolean;
  /** Meldet die aktuelle Abspielzeit und ob noch gespielt wird. */
  onTime(t: number, isPlaying: boolean): void;
  /** Ein Klick in die Szene, wenn `pickHeight` gesetzt ist. */
  onPick?: (point: [number, number, number], normal?: [number, number, number]) => void;
  /** Hoehe der Hilfsebene fuer das Platzieren. `undefined` schaltet Picken aus. */
  pickHeight?: number;
  /**
   * Bei jedem Laden oder Zuruecksetzen eines Szenarios auf einen neuen Wert
   * gesetzt. Anders als eine Bearbeitung (die die Abspielzeit erhaelt, siehe
   * unten) soll das den Abspielkopf auf 0 zuruecksetzen.
   */
  resetToken?: number;
  /** Das aktive Objekt der Oberflaeche; der Betrachter hebt es hervor. Nur ein Spiegel. */
  activeEntityId?: string;
  /** Klick auf ein Objekt (Id) oder ins Leere (`undefined`), wenn nicht platziert wird. */
  onSelect?: (entityId: string | undefined) => void;
}

/** Weiter als das gezogen, ist ein Klick ein Drehen oder Verschieben der Ansicht. */
const CLICK_TOLERANCE_PX = 4;

export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(
  { recording, layer, showAxes, onTime, onPick, pickHeight, resetToken, activeEntityId, onSelect },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<RecordingViewer | null>(null);
  // In Refs gespiegelt, damit die Rueckrufe nicht im Effekt-Abhaengigkeitsfeld
  // stehen muessen - sonst wuerde der Betrachter bei jedem Render neu gebaut.
  const onTimeRef = useRef(onTime);
  const onPickRef = useRef(onPick);
  const pickHeightRef = useRef(pickHeight);
  const onSelectRef = useRef(onSelect);
  const pointerDownAt = useRef<{ x: number; y: number } | undefined>(undefined);
  const activeEntityRef = useRef(activeEntityId);
  const recordingRef = useRef(recording);
  const layerRef = useRef(layer);
  const showAxesRef = useRef(showAxes);
  const firstRecording = useRef(true);
  const lastResetToken = useRef(resetToken);
  onTimeRef.current = onTime;
  onPickRef.current = onPick;
  pickHeightRef.current = pickHeight;
  onSelectRef.current = onSelect;
  activeEntityRef.current = activeEntityId;
  recordingRef.current = recording;
  layerRef.current = layer;
  showAxesRef.current = showAxes;

  /**
   * Der Betrachter wird **einmal** gebaut und danach nur noch gefuettert.
   *
   * Das ist wesentlich: die Aufzeichnung ist eine Ableitung des Szenarios und
   * bekommt bei jeder Bearbeitung eine neue Identitaet. Haenge der Effekt an
   * ihr, wuerde jedes platzierte Objekt den WebGL-Kontext abreissen und neu
   * aufbauen - und dabei Kameralage und Ebene verlieren. Genau dafuer hat der
   * Betrachter `setRecording`.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewer = new RecordingViewer(canvas, recordingRef.current, {
      layers: ["macroscopic", "kinematic", "atomic"],
      initialLayer: layerRef.current,
      showAxes: showAxesRef.current,
    });
    const savedCamera = recordingRef.current.scenario.view.camera;
    if (savedCamera) viewer.setCameraPose(savedCamera);
    viewer.onFrame((info) => onTimeRef.current(info.t, info.isPlaying));
    viewer.setActiveEntity(activeEntityRef.current);
    viewer.start();
    viewerRef.current = viewer;

    const observer = new ResizeObserver(() => viewer.resize());
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    // Beim ersten Durchlauf hat der Konstruktor die Aufzeichnung schon.
    if (!viewer || firstRecording.current) {
      firstRecording.current = false;
      lastResetToken.current = resetToken;
      return;
    }
    // Ein neues oder zurueckgesetztes Szenario beginnt bei 0. Nur eine
    // Bearbeitung des laufenden Szenarios erhaelt Abspielzeit und -zustand:
    // wer bei t = 1,8 s ein Objekt platziert, will nicht an den Anfang
    // zurueckgeworfen werden.
    //
    // **Das ist die Stelle fuer "beim Laden zuruecksetzen".** Alles, was im
    // Betrachter lebt und nicht in React - Abspielzeit, Abspielzustand,
    // Kamera -, kann nur hier zurueckgesetzt werden. Ein `setT(0)` in App.tsx
    // setzt bloss die Anzeige; der Abspielkopf meldet im naechsten Bild wieder
    // seinen echten Wert. Siehe docs/aenderungsleitfaden.md.
    const isReset = resetToken !== lastResetToken.current;
    lastResetToken.current = resetToken;
    if (isReset) {
      viewer.setRecording(recording);
      viewer.playhead.pause();
      viewer.playhead.seek(0);
      // Auch die Ansicht faengt neu an: Blickrichtung, Zielpunkt und Zoom
      // zurueck auf die Standardwerte. Der Betrachter tut das nicht von
      // selbst, weil eine Bearbeitung die Aufzeichnung genauso austauscht -
      // dort muss die Kamera stehen bleiben.
      viewer.frameScene("initial");
      // Eine mitgespeicherte Kamera geht vor dem Einpassen.
      const savedCamera = recording.scenario.view.camera;
      if (savedCamera) viewer.setCameraPose(savedCamera);
    } else {
      const wasPlaying = viewer.playhead.isPlaying;
      const previousTime = viewer.playhead.t;
      viewer.setRecording(recording);
      viewer.playhead.seek(previousTime);
      if (wasPlaying) viewer.playhead.play();
    }
    viewer.renderOnce();
  }, [recording, resetToken]);

  useEffect(() => {
    viewerRef.current?.setLayer(layer);
  }, [layer]);

  useEffect(() => {
    viewerRef.current?.setAxesVisible(showAxes);
  }, [showAxes]);

  useEffect(() => {
    viewerRef.current?.setActiveEntity(activeEntityId);
  }, [activeEntityId]);

  useImperativeHandle(
    ref,
    () => ({
      seek: (t) => {
        viewerRef.current?.playhead.seek(t);
        viewerRef.current?.renderOnce();
      },
      play: () => viewerRef.current?.playhead.play(),
      pause: () => viewerRef.current?.playhead.pause(),
      frameScene: () => {
        viewerRef.current?.frameScene();
        viewerRef.current?.renderOnce();
      },
      cameraPose: () => viewerRef.current?.cameraPose(),
    }),
    [],
  );

  return (
    <canvas
      ref={canvasRef}
      className="viewport"
      data-platzieren={pickHeight !== undefined ? "an" : undefined}
      onPointerDown={(event) => {
        pointerDownAt.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        const viewer = viewerRef.current;
        if (!viewer) return;
        const down = pointerDownAt.current;
        if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) {
          return;
        }
        const height = pickHeightRef.current;
        const pick = onPickRef.current;
        if (height === undefined || !pick) {
          onSelectRef.current?.(viewer.pickEntity(event.clientX, event.clientY));
          return;
        }
        const hit = viewer.pickPoint(event.clientX, event.clientY, height);
        if (!hit) return;
        // Gerastert wird nur ein Punkt in der Luft: auf einem getroffenen
        // Objekt liegt der Punkt dort, wo geklickt wurde, sonst schwebte das
        // Platzierte neben der Oberflaeche.
        const point = hit.normal ? hit.point : viewer.snapPoint(hit.point);
        pick(
          [point.x, point.y, point.z],
          hit.normal && [hit.normal.x, hit.normal.y, hit.normal.z],
        );
      }}
    />
  );
});
