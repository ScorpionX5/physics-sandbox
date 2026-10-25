import * as THREE from "three";
import { resolveSegments } from "@sandbox/core";
import type { Recording, ViewLayer } from "@sandbox/schema";
import { AtomicRenderer } from "./layers/atomic.js";
import { KinematicRenderer } from "./layers/kinematic.js";
import { MacroscopicRenderer } from "./layers/macroscopic.js";
import { fitDistance } from "./framing.js";
import { directionAt, Playhead, type ActiveDirection } from "./playback.js";
import { roundToDecimals, snapDecimals } from "./snap.js";
import { scenarioInventory, type LayerContext, type ViewLayerRenderer } from "./common.js";

/**
 * Der Betrachter: haelt Szene, Kamera und je einen Renderer pro
 * Darstellungsebene und spielt eine Aufzeichnung ab.
 *
 * Dieselbe Klasse bedient beide Faelle - die Sandbox-Oberflaeche und den
 * eingebetteten Abspieler in der Lernplattform. Der Unterschied liegt nur darin,
 * welche Bedienelemente aussen herum stehen.
 *
 * **Was hier und nur hier lebt:** die Kamera (Lage, Zielpunkt, Zoom - weder in
 * React noch im Szenario, darum bleibt sie beim Austausch der Aufzeichnung
 * stehen), der Abspielkopf (`playhead`) und der Merker der schon befolgten
 * Pause-Anweisung. Die Darstellungsebene fuehrt dagegen die Oberflaeche;
 * `currentLayer` ist deren Kopie, ausser bei `followDirection: true`.
 */

export interface ViewerOptions {
  /** Ebenen, die angeboten werden. Standard: makroskopisch, kinematisch, atomar. */
  layers?: ViewLayer[];
  /** Startebene. */
  initialLayer?: ViewLayer;
  /** Hintergrundfarbe. */
  background?: number;
  /** Der Regiespur folgen (Ebenenwechsel, Kamerafahrten). */
  followDirection?: boolean;
  /** Koordinatenachsen sichtbar. Standard: ja. */
  showAxes?: boolean;
}

export interface ViewerFrameInfo {
  t: number;
  isPlaying: boolean;
  layer: ViewLayer;
  direction: ActiveDirection;
}

const DEFAULT_LAYERS: ViewLayer[] = ["macroscopic", "kinematic", "atomic"];

/** Laenge der Koordinatenachsen in Metern - gleichzeitig der Massstab im Bild. */
export const AXES_LENGTH = 1;

/**
 * Blickrichtung der Standardansicht, als Vektor vom Zielpunkt zur Kamera.
 *
 * Die Kamera steht ueber dem positiven x-y-Quadranten, flach ueber der
 * x-Achse: in der Waagerechten 15 Grad von x weg in Richtung y. Damit laeuft
 * die x-Achse im Bild nach unten links und die y-Achse nach unten rechts,
 * waehrend z nach oben zeigt - man sieht beiden waagerechten Achsen an, welche
 * Richtung sie meinen.
 *
 * Warum nicht die Winkelhalbierende, also 45 Grad: dort erscheinen zwei gleich
 * lange Kanten eines Klotzes deckungsgleich, und es ist nicht mehr zu sehen,
 * welche vorn liegt. Die flache Aufstellung zeigt stattdessen die x-Richtung
 * als die lange Richtung im Bild - und das ist die, in die der Klotz des
 * Durchstichs laeuft.
 *
 * Der z-Anteil ist flacher als die Waagerechte: ein steiler Blick von oben
 * macht Hoehen unlesbar, und genau Hoehen sind der Gegenstand der Mechanik.
 *
 * Der Vektor steht ausgerechnet hier statt als Winkel: `sin`/`cos` waeren in
 * der Darstellungsschicht erlaubt, aber zwei Winkel plus Umrechnung sind nicht
 * lesbarer als die drei Zahlen, auf die sie fuehren.
 */
const CAMERA_DIRECTION = new THREE.Vector3(0.93, 0.25, 0.45);

/**
 * Vielfaches des Abstands, der das Szenario gerade formatfuellend zeigt.
 *
 * Mehr als eins, damit am Rand etwas Luft bleibt. Die Bahn steckt schon in den
 * Punkten, die `frameScene` einpasst; der Faktor ist nur noch der Rand, nicht
 * mehr die Reserve fuer eine grobe Huelle (die lag bei 2 und zoomte zu weit
 * heraus).
 */
const CAMERA_DISTANCE_FACTOR = 1.15;

/**
 * Anhebung des Zielpunkts gegenueber der Mitte des Szenarios, Meter.
 *
 * Die Kamera blickt nicht auf die Mitte, sondern eine halbe Achsenlaenge
 * darueber. Damit rutscht die Szene im Bild nach unten und macht oben Platz -
 * dort passiert bei einem Fallversuch das Interessante, und dort liegen die
 * Ebenenknoepfe.
 */
const FOCUS_LIFT = 0.5;

/**
 * Ergebnis von `pickPoint`. `normal` gibt es nur, wenn ein Objekt getroffen
 * wurde - dann ist die Richtung, in die dessen Oberflaeche zeigt, die Ausrichtung
 * fuer das Platzierte. Ohne `normal` ist es ein Punkt in der Luft auf der
 * Rueckfallebene.
 */
export interface PickResult {
  point: THREE.Vector3;
  normal?: THREE.Vector3;
}

export class RecordingViewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private head: Playhead;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly layerRenderers = new Map<ViewLayer, ViewLayerRenderer>();
  private readonly controls: OrbitLikeControls;
  /**
   * Abstand, den `frameScene` zuletzt eingestellt hat - die "anfängliche
   * Zoomstufe", von der aus das Klickraster feiner oder gröber wird.
   */
  private frameDistance = 1;
  private readonly followDirection: boolean;
  private currentLayer: ViewLayer;
  private recording: Recording;
  private animationHandle: number | undefined;
  private lastFrameTime: number | undefined;
  private frameListener: ((info: ViewerFrameInfo) => void) | undefined;
  /** Zeitpunkt der letzten befolgten Pause-Anweisung - jede wirkt nur einmal. */
  private honouredPause: number | undefined;
  private axes: THREE.AxesHelper | undefined;
  private activeEntityId: string | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    recording: Recording,
    options: ViewerOptions = {},
  ) {
    this.recording = recording;
    this.head = new Playhead(recording);
    this.followDirection = options.followDirection ?? false;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.scene.background = new THREE.Color(options.background ?? 0x11161d);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    // Z ist die Hochachse der Sandbox, Three.js nimmt von Haus aus Y an. Ohne
    // diese Zeile legt `lookAt` die Kamera auf die Seite, und die Szene steht
    // gekippt im Bild.
    this.camera.up.set(0, 0, 1);
    this.addLighting();

    const requested = options.layers ?? DEFAULT_LAYERS;
    for (const layer of requested) {
      const layerRenderer = createLayerRenderer(layer, recording);
      if (!layerRenderer) continue;
      this.layerRenderers.set(layer, layerRenderer);
      this.scene.add(layerRenderer.root);
    }
    if (this.layerRenderers.size === 0) {
      throw new Error(`Keine der angeforderten Ebenen ist implementiert: ${requested.join(", ")}`);
    }

    this.currentLayer = options.initialLayer ?? requested[0]!;
    if (!this.layerRenderers.has(this.currentLayer)) {
      this.currentLayer = [...this.layerRenderers.keys()][0]!;
    }

    this.buildLayers();
    this.addAxes();
    this.axes!.visible = options.showAxes ?? true;
    // Vor dem Einpassen: der Abstand haengt am Seitenverhaeltnis.
    this.resize();
    this.frameScene();
    this.controls = new OrbitLikeControls(this.camera, canvas, this.sceneFocus());
    this.renderOnce();
  }

  // ------------------------------------------------------------ Aufbau

  /**
   * Koordinatenachsen: x rot, y gruen, z blau, z nach oben.
   *
   * Sie haengen an der Szene und nicht an einer Darstellungsebene - die
   * Orientierung im Raum ist in jeder Ansicht dieselbe Frage. Die Laenge ist
   * feste 1 m, damit sie zugleich Massstab ist: wer wissen will, wie gross der
   * Klotz ist, haelt ihn gegen die Achse. Eine mitwachsende Laenge saehe in
   * jeder Szene gleich gut aus und taugte dafuer nicht.
   */
  private addAxes(): void {
    if (this.axes) {
      this.scene.remove(this.axes);
      this.axes.geometry.dispose();
      (this.axes.material as THREE.Material).dispose();
    }
    const axes = new THREE.AxesHelper(AXES_LENGTH);
    axes.name = "achsen";
    // Immer sichtbar, auch wenn eine Flaeche darueber liegt: die Achsen sind
    // Orientierungshilfe, nicht Teil der Szene.
    const material = axes.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.85;
    axes.renderOrder = 1;
    this.axes = axes;
    this.scene.add(axes);
  }

  private addLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x202830, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    // Von oben heisst +z, nicht +y.
    sun.position.set(4, 6, 8);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8fb4ff, 0.4);
    fill.position.set(-6, -4, 3);
    this.scene.add(fill);
  }

  private buildLayers(): void {
    const context: LayerContext = { scenario: this.recording.scenario, seed: this.recording.seed };
    for (const [layer, layerRenderer] of this.layerRenderers) {
      layerRenderer.build(context);
      layerRenderer.setActiveEntity?.(this.activeEntityId);
      layerRenderer.root.visible = layer === this.currentLayer;
    }
  }

  /**
   * Die Punkte, die im Bild sein sollen: die Ecken aller Flaechen (in
   * Weltkoordinaten, mit Lage und Dicke), alle Startpositionen und die ganze
   * Bahn. Ohne diese Abschaetzung steht die Kamera entweder in einem Koerper
   * oder kilometerweit weg.
   *
   * Punkte statt einer Box, weil `frameScene` den Abstand aus dem Sichtfeld
   * rechnet: eine Box aus dem Inventar waere eine zweite, gröbere Huelle.
   */
  private scenePoints(): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const inventory = scenarioInventory(this.recording.scenario);

    for (const { spec, segments } of inventory.constraints) {
      // Dieselbe Aufloesung wie im Simulator, damit eine geneigte Rampe auch
      // im Bild geneigt eingeht.
      const resolved = resolveSegments(segments, [...spec.pose.position], [...spec.pose.orientation]);
      for (const segment of resolved) {
        const centre = new THREE.Vector3(...segment.center);
        const u = new THREE.Vector3(...segment.tangent).multiplyScalar(segment.halfExtentU);
        const v = new THREE.Vector3(...segment.bitangent).multiplyScalar(segment.halfExtentV);
        const w = new THREE.Vector3(...segment.normal).multiplyScalar(segment.thickness / 2);
        for (const su of [-1, 1]) {
          for (const sv of [-1, 1]) {
            for (const sw of [-1, 1]) {
              points.push(
                centre.clone().addScaledVector(u, su).addScaledVector(v, sv).addScaledVector(w, sw),
              );
            }
          }
        }
      }
    }
    for (const { spec } of inventory.bodies) {
      points.push(new THREE.Vector3(...spec.pose.position));
    }
    // Auch die ganze Bahn: der Klotz soll nicht aus dem Bild gleiten.
    for (const snapshot of this.recording.snapshots) {
      for (const state of Object.values(snapshot.entities)) {
        if (state.mechanics) points.push(new THREE.Vector3(...state.mechanics.position));
      }
    }
    if (points.length === 0) points.push(new THREE.Vector3());
    return points;
  }

  private sceneBounds(): THREE.Box3 {
    const box = new THREE.Box3().setFromPoints(this.scenePoints());
    // Ein einzelner Punkt hat keine Ausdehnung; ohne Mindestgroesse waere der
    // Abstand null.
    const size = box.getSize(new THREE.Vector3());
    if (size.length() < 1e-6) box.setFromCenterAndSize(box.getCenter(new THREE.Vector3()), new THREE.Vector3(1, 1, 1));
    return box;
  }

  /**
   * Der Punkt, auf den die Kamera blickt: die Mitte des Szenarios, um
   * `FOCUS_LIFT` angehoben.
   *
   * Dieselbe Rechnung wie in `frameScene` zu haben waere eine zweite Quelle -
   * dann zeigte die Kamera auf einen anderen Punkt als den, um den die
   * Maussteuerung dreht, und die Szene wuerde beim ersten Ziehen springen.
   */
  private sceneFocus(): THREE.Vector3 {
    const focus = this.sceneBounds().getCenter(new THREE.Vector3());
    focus.z += FOCUS_LIFT;
    return focus;
  }

  /**
   * Setzt die Kamera so, dass das ganze Szenario ins Bild passt.
   *
   * Der Abstand ist der kleinste, bei dem jeder Punkt aus `scenePoints` im
   * Sichtfeld liegt - vertikal nach `fov`, horizontal nach `fov` und
   * Seitenverhaeltnis. Eine umschliessende Kugel waere bequemer, zeigte aber
   * die flache Standardansicht deutlich zu klein.
   */
  frameScene(): void {
    const focus = this.sceneFocus();
    const radius = Math.max(this.sceneBounds().getSize(new THREE.Vector3()).length() / 2, 0.5);

    const toCamera = CAMERA_DIRECTION.clone().normalize();
    const fitted = fitDistance(this.scenePoints(), focus, toCamera, this.camera.up, this.camera.fov, this.camera.aspect);
    const distance = Math.max(fitted * CAMERA_DISTANCE_FACTOR, radius * 0.1);

    this.frameDistance = distance;
    this.camera.position.copy(focus).addScaledVector(toCamera, distance);
    this.camera.near = Math.max(radius / 1000, 0.001);
    this.camera.far = distance + radius * 20;
    this.camera.lookAt(focus);
    this.camera.updateProjectionMatrix();
    this.controls?.setTarget(focus);
  }

  setAxesVisible(visible: boolean): void {
    if (this.axes) this.axes.visible = visible;
    this.renderOnce();
  }

  /** Kameralage und Blickziel, wie sie gerade stehen - zum Speichern im Szenario. */
  cameraPose(): { position: [number, number, number]; target: [number, number, number] } {
    const { position } = this.camera;
    const { target } = this.controls;
    return { position: [position.x, position.y, position.z], target: [target.x, target.y, target.z] };
  }

  setCameraPose(pose: { position: readonly number[]; target: readonly number[] }): void {
    this.camera.position.set(pose.position[0]!, pose.position[1]!, pose.position[2]!);
    // Das Ziel zuletzt: `setTarget` rechnet die Kugelkoordinaten der Maussteuerung
    // aus der neuen Kameralage, sonst spraenge die Ansicht beim ersten Ziehen.
    this.controls.setTarget(new THREE.Vector3(pose.target[0]!, pose.target[1]!, pose.target[2]!));
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ Ebenen

  get layer(): ViewLayer {
    return this.currentLayer;
  }

  get availableLayers(): ViewLayer[] {
    return [...this.layerRenderers.keys()];
  }

  layerTitle(layer: ViewLayer): string {
    return this.layerRenderers.get(layer)?.title ?? layer;
  }

  /** Hinweis, dass die Ebene schematisch ist - die Oberflaeche muss ihn zeigen. */
  schematicNote(layer: ViewLayer = this.currentLayer): string | undefined {
    return this.layerRenderers.get(layer)?.schematicNote;
  }

  setLayer(layer: ViewLayer): void {
    if (!this.layerRenderers.has(layer)) {
      throw new Error(
        `Darstellungsebene "${layer}" ist nicht geladen. Verfuegbar: ${this.availableLayers.join(", ")}`,
      );
    }
    this.currentLayer = layer;
    for (const [candidate, layerRenderer] of this.layerRenderers) {
      layerRenderer.root.visible = candidate === layer;
    }
    this.renderOnce();
  }

  /**
   * Der Abspielkopf. Beim Austausch der Aufzeichnung wird er ersetzt, deshalb
   * ist er kein `readonly`-Feld, sondern ein Zugriff.
   */
  get playhead(): Playhead {
    return this.head;
  }

  /**
   * Tauscht die Aufzeichnung aus, ohne Kamera und Ebene zu verlieren.
   *
   * **Die Abspielzeit geht dabei verloren:** der Abspielkopf gehoert zu einer
   * Aufzeichnung und wird hier neu gebaut, also steht die Zeit danach auf 0 und
   * es laeuft nichts. Wer sie erhalten will, sichert `playhead.t` und
   * `playhead.isPlaying` vorher und setzt beides danach wieder - so macht es
   * der Bearbeitungszweig in apps/studio/src/components/Viewport.tsx. Beim
   * Laden eines neuen Szenarios ist das Zuruecksetzen dagegen gewuenscht.
   *
   * **Die Kamera bleibt dagegen stehen,** auch beim Laden: wer sie
   * zuruecksetzen will, ruft danach `frameScene()`. Umgekehrt waere es
   * falsch - eine Bearbeitung tauscht die Aufzeichnung ebenfalls aus, und bei
   * jedem platzierten Objekt in die Standardansicht zu springen waere
   * unbenutzbar.
   */
  setRecording(recording: Recording): void {
    this.recording = recording;
    this.head = new Playhead(recording);
    const kinematic = this.layerRenderers.get("kinematic");
    if (kinematic instanceof KinematicRenderer) kinematic.setRecording(recording);
    this.buildLayers();
    // Die Achsen bleiben stehen: ihre Laenge ist fest und haengt nicht mehr an
    // der Ausdehnung der Aufzeichnung.
    this.honouredPause = undefined;
    this.renderOnce();
  }

  // ------------------------------------------------------------ Abspielen

  onFrame(listener: (info: ViewerFrameInfo) => void): void {
    this.frameListener = listener;
  }

  private applyDirection(direction: ActiveDirection): void {
    if (!this.followDirection) return;
    if (direction.layer && direction.layer !== this.currentLayer && this.layerRenderers.has(direction.layer)) {
      this.setLayer(direction.layer);
    }
    if (direction.timeScale !== undefined && direction.timeScale !== this.playhead.timeScale) {
      this.playhead.setTimeScale(direction.timeScale);
    }
    if (direction.camera) {
      const target = new THREE.Vector3(...direction.camera.target);
      const position = new THREE.Vector3(...direction.camera.position);
      this.camera.position.lerp(position, direction.camera.alpha);
      this.controls.setTarget(this.controls.target.clone().lerp(target, direction.camera.alpha));
    }
    // Eine Pause-Anweisung wirkt genau einmal; sonst liesse sich nach ihr nicht
    // weiterspielen.
    if (direction.pauseAt !== undefined && direction.pauseAt !== this.honouredPause) {
      this.honouredPause = direction.pauseAt;
      this.playhead.pause();
    }
  }

  /** Zeichnet ein Bild zum aktuellen Stand des Abspielkopfs. */
  renderOnce(): ViewerFrameInfo {
    const snapshot = this.playhead.snapshot();
    const direction = directionAt(this.recording, this.playhead.t);
    this.applyDirection(direction);
    this.layerRenderers.get(this.currentLayer)?.update(snapshot);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const info: ViewerFrameInfo = {
      t: this.playhead.t,
      isPlaying: this.playhead.isPlaying,
      layer: this.currentLayer,
      direction,
    };
    this.frameListener?.(info);
    return info;
  }

  /** Startet die Bildschleife. Der Abspielkopf laeuft nur, wenn `play` aktiv ist. */
  start(): void {
    if (this.animationHandle !== undefined) return;
    const loop = (now: number): void => {
      this.animationHandle = requestAnimationFrame(loop);
      const previous = this.lastFrameTime ?? now;
      // Grosse Spruenge abschneiden: ein Tabwechsel wuerde sonst die halbe
      // Aufzeichnung ueberspringen.
      const delta = Math.min((now - previous) / 1000, 0.1);
      this.lastFrameTime = now;
      this.playhead.advance(delta);
      this.renderOnce();
    };
    this.animationHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.animationHandle !== undefined) cancelAnimationFrame(this.animationHandle);
    this.animationHandle = undefined;
    this.lastFrameTime = undefined;
  }

  /**
   * Wandelt eine Bildschirmposition in einen Punkt der Szene um - fuer das
   * Platzieren von Objekten mit der Maus.
   *
   * Getroffen wird zuerst die Geometrie der aktiven Ebene (also die Flaechen der
   * Randbedingung); liegt dort nichts, wird gegen eine waagerechte Ebene in der Hoehe
   * `fallbackHeight` geschnitten. Ohne diesen Rueckfall liesse sich nichts in
   * die Luft setzen - und genau das braucht das Durchstich-Szenario.
   */
  pickPoint(clientX: number, clientY: number, fallbackHeight = 0): PickResult | undefined {
    const raycaster = this.rayAt(clientX, clientY);
    if (!raycaster) return undefined;

    const active = this.layerRenderers.get(this.currentLayer);
    if (active) {
      const hits = raycaster.intersectObject(active.root, true);
      const solid = hits.find((hit) => (hit.object as THREE.Mesh).isMesh && isShown(hit.object));
      if (solid?.face) {
        // Die Flaechennormale liegt im Objektraum; zur Kamera hin gedreht, weil
        // eine einseitige Flaeche auch von hinten getroffen werden kann.
        const normal = solid.face.normal.clone().transformDirection(solid.object.matrixWorld);
        if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
        return { point: solid.point.clone(), normal };
      }
    }

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -fallbackHeight);
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, point) ? { point } : undefined;
  }

  private rayAt(clientX: number, clientY: number): THREE.Raycaster | undefined {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    return raycaster;
  }

  /**
   * Die Entitaet unter einer Bildschirmposition, falls die aktive Ebene eine
   * zeigt. Der Renderer markiert seine Netze mit `userData.entityId`; hier
   * wird nur gelesen, nichts zurueckgeschrieben.
   *
   * Unsichtbare Netze zaehlen nicht: ein Koerper, der erst spaeter
   * erscheint, ist gebaut, aber nicht da - und der Raycaster fragt
   * `visible` nicht selbst.
   */
  pickEntity(clientX: number, clientY: number): string | undefined {
    const raycaster = this.rayAt(clientX, clientY);
    const active = this.layerRenderers.get(this.currentLayer);
    if (!raycaster || !active) return undefined;
    for (const hit of raycaster.intersectObject(active.root, true)) {
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.isMesh || !isShown(mesh)) continue;
      const id: unknown = mesh.userData.entityId;
      if (typeof id === "string") return id;
    }
    return undefined;
  }

  /**
   * Das aktive Objekt, wie es die Oberflaeche fuehrt - hier nur eine Kopie,
   * die jede Ebene hervorhebt. Sie ueberlebt `setRecording`, weil der Betrachter
   * sie nach jedem Neubau der Ebenen wieder weiterreicht.
   */
  setActiveEntity(entityId: string | undefined): void {
    this.activeEntityId = entityId;
    for (const layerRenderer of this.layerRenderers.values()) {
      layerRenderer.setActiveEntity?.(entityId);
    }
    this.renderOnce();
  }

  /** Rundet einen Klickpunkt auf das Raster der aktuellen Zoomstufe. */
  snapPoint(point: THREE.Vector3): THREE.Vector3 {
    const decimals = snapDecimals(this.controls.distance, this.frameDistance);
    return new THREE.Vector3(
      roundToDecimals(point.x, decimals),
      roundToDecimals(point.y, decimals),
      roundToDecimals(point.z, decimals),
    );
  }

  resize(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.stop();
    this.controls.dispose();
    if (this.axes) {
      this.scene.remove(this.axes);
      this.axes.geometry.dispose();
      (this.axes.material as THREE.Material).dispose();
      this.axes = undefined;
    }
    for (const layerRenderer of this.layerRenderers.values()) layerRenderer.dispose();
    this.layerRenderers.clear();
    this.renderer.dispose();
  }
}

/**
 * Ob ein Objekt samt allen Eltern sichtbar ist. Der Raycaster fragt `visible`
 * nicht selbst; ohne diese Pruefung finge ein ausgeblendetes Objekt (noch nicht
 * hinzugefuegt, oder Opazitaet 0) Klicks ab, die auf etwas dahinter zielen.
 */
function isShown(object: THREE.Object3D | null): boolean {
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

function createLayerRenderer(layer: ViewLayer, recording: Recording): ViewLayerRenderer | undefined {
  switch (layer) {
    case "macroscopic":
      return new MacroscopicRenderer();
    case "kinematic": {
      const kinematic = new KinematicRenderer();
      kinematic.setRecording(recording);
      return kinematic;
    }
    case "atomic":
      return new AtomicRenderer();
    default:
      // subatomic, thermal und fields kommen mit ihren Stufen. Eine nicht
      // implementierte Ebene wird uebersprungen statt vorgetaeuscht.
      return undefined;
  }
}

/**
 * Minimale Orbit-Steuerung.
 *
 * Bewusst selbst geschrieben statt `OrbitControls` aus `three/examples`: der
 * Betrachter soll als Bibliothek ohne Beispiel-Unterpfade einbettbar sein, und
 * gebraucht werden nur Drehen, Zoomen und Verschieben. Das sind achtzig Zeilen.
 */
class OrbitLikeControls {
  target = new THREE.Vector3();
  /**
   * Die Kugelkoordinaten liegen in einem Hilfssystem, dessen Polachse y ist -
   * `THREE.Spherical` kennt nur diese Konvention. `toFrame` und `fromFrame`
   * drehen zwischen Welt (z oben) und Hilfssystem hin und her. Die Drehung ist
   * mit Absicht eine Drehung und keine Spiegelung: sonst liefe die Szene beim
   * Ziehen nach links herum.
   */
  private spherical = new THREE.Spherical();
  private dragging: "orbit" | "pan" | undefined;
  private lastX = 0;
  private lastY = 0;
  private readonly onPointerDown: (event: PointerEvent) => void;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerUp: (event: PointerEvent) => void;
  private readonly onWheel: (event: WheelEvent) => void;
  private readonly onContextMenu: (event: Event) => void;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    target: THREE.Vector3,
  ) {
    this.target.copy(target);
    this.syncFromCamera();

    this.onPointerDown = (event) => {
      this.dragging = event.button === 2 || event.shiftKey ? "pan" : "orbit";
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.element.setPointerCapture?.(event.pointerId);
    };
    this.onPointerMove = (event) => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastX;
      const dy = event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      if (this.dragging === "orbit") {
        this.spherical.theta -= dx * 0.005;
        this.spherical.phi -= dy * 0.005;
        // Nicht ueber die Pole hinaus: die Szene wuerde umklappen.
        this.spherical.phi = Math.min(Math.max(this.spherical.phi, 0.05), Math.PI - 0.05);
      } else {
        const scale = this.spherical.radius * 0.0015;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
      }
      this.apply();
    };
    this.onPointerUp = (event) => {
      this.dragging = undefined;
      this.element.releasePointerCapture?.(event.pointerId);
    };
    this.onWheel = (event) => {
      event.preventDefault();
      this.spherical.radius *= event.deltaY > 0 ? 1.1 : 1 / 1.1;
      this.spherical.radius = Math.min(Math.max(this.spherical.radius, 0.05), 5000);
      this.apply();
    };
    this.onContextMenu = (event) => event.preventDefault();

    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerUp);
    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("contextmenu", this.onContextMenu);
  }

  private syncFromCamera(): void {
    this.spherical.setFromVector3(toFrame(this.camera.position.clone().sub(this.target)));
  }

  get distance(): number {
    return this.spherical.radius;
  }

  setTarget(target: THREE.Vector3): void {
    this.target.copy(target);
    this.syncFromCamera();
  }

  private apply(): void {
    this.camera.position
      .copy(this.target)
      .add(fromFrame(new THREE.Vector3().setFromSpherical(this.spherical)));
    this.camera.lookAt(this.target);
  }

  update(): void {
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerUp);
    this.element.removeEventListener("wheel", this.onWheel);
    this.element.removeEventListener("contextmenu", this.onContextMenu);
  }
}

/** Welt (z oben) -> Hilfssystem der Kugelkoordinaten (y oben). */
function toFrame(v: THREE.Vector3): THREE.Vector3 {
  return v.set(v.x, v.z, -v.y);
}

/** Hilfssystem (y oben) -> Welt (z oben). */
function fromFrame(v: THREE.Vector3): THREE.Vector3 {
  return v.set(v.x, -v.z, v.y);
}
