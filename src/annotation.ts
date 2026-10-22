// Le contrat du plugin d'annotation de Fragment (`annotation:*@1`), recopié de
// `@usefragment/annotation` le temps que ce paquet soit publié sur npm : on le
// remplacera alors par la dépendance. Les registres sont partagés par leur id.
import { defineRegistry, defineOrderedRegistry, type Component, type EventRef, type LayerContext, type OrderedRegistry, type TFile, type Toolbar } from 'fragment';
/** Un point du tracé, en écart au glyphe d'ancrage. */
export interface Point {
    dx: number;
    dy: number;
}
export type ToolKind = string;
export interface Stroke {
    id: string;
    pos: number;
    points: readonly Point[];
    color: string;
    width: number;
    tool: string;
    calque: string;
}
export interface Calque {
    id: string;
    name: string;
    order: string;
    color?: string;
}
export type AnnotationEdit = {
    kind: 'stroke';
    id: string;
    value: Stroke | null;
} | {
    kind: 'calque';
    id: string;
    value: Calque | null;
};
export interface HistoryEntry {
    before: AnnotationEdit[];
    after: AnnotationEdit[];
}
export type StrokeInput = Omit<Stroke, 'id' | 'calque'> & {
    id?: string;
    calque?: string;
};
import type { DocumentSurface, Marker } from "fragment";
/** Le contrat du PLUGIN annotations ; aucune connaissance de ce contrat dans core. */
export interface AnnotationSessionAPI {
    readonly context: LayerContext;
    readonly surface: DocumentSurface;
    /** Le fichier du coffre annoté, s'il y en a un. */
    readonly file: TFile | null;
    /** La CLÉ du document annoté (note, PDF, conversation…). */
    readonly doc: string | null;
    readonly activeTool: string | null;
    readonly activeCalque: string;
    readonly style: {
        color: string;
        width: number;
    };
    strokes(): readonly Stroke[];
    visibleStrokes(): readonly Stroke[];
    calques(): readonly Calque[];
    tools(): readonly AnnotationTool[];
    kind(tool: string): StrokeKind;
    activate(): void;
    setTool(id: string | null): void;
    setStyle(style: Partial<{
        color: string;
        width: number;
    }>): void;
    setActiveCalque(id: string): void;
    setCalqueVisible(id: string, visible: boolean): void;
    isCalqueVisible(id: string): boolean;
    apply(edits: readonly AnnotationEdit[]): void;
    addStroke(input: StrokeInput): Stroke;
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): boolean;
    redo(): boolean;
    on(name: 'change', cb: () => void): EventRef;
    /**
     * OÙ est un trait : sa forme dans le plan document (le repère de `coordsAtPos`,
     * celui des rects de `coordsForRange`) — boîte et points absolus. `null` s'il
     * n'est pas rendu (hors fenêtre, bloc replié).
     */
    geometry(stroke: Stroke): StrokeGeometry | null;
}
/** Un trait dans le plan document : sa boîte et ses points absolus. */
export interface StrokeGeometry {
    x: number;
    y: number;
    w: number;
    h: number;
    points: {
        x: number;
        y: number;
    }[];
}
export interface GesturePoint {
    x: number;
    y: number;
    clientX: number;
    clientY: number;
}
export interface GestureAnchor {
    pos: number;
    glyphX: number;
    glyphY: number;
}
export interface GestureContext {
    session: AnnotationSessionAPI;
    surface: DocumentSurface;
    anchorAt(x: number, y: number): GestureAnchor | null;
}
export interface Gesture {
    move(point: GesturePoint): void;
    preview?(): {
        originX: number;
        originY: number;
        points: readonly Point[];
        color: string;
        width: number;
        opacity: number;
    } | null;
    end(): readonly AnnotationEdit[] | null;
    cancel?(): void;
}
export interface AnnotationTool {
    id: string;
    label: string;
    icon: string;
    order?: number;
    begin(context: GestureContext, point: GesturePoint): Gesture | null;
}
export interface StrokeKind {
    above: boolean;
    opacity: number;
    widthFactor: number;
    hitTest?(stroke: Stroke, dx: number, dy: number): boolean;
}
export interface AnnotationPreset {
    id: string;
    name: string;
    icon?: string;
    tools?: readonly string[];
    filter?(stroke: Stroke, session: AnnotationSessionAPI): boolean;
}
export interface AnnotationToolbarItem {
    id: string;
    order?: number;
    mount(toolbar: Toolbar, session: AnnotationSessionAPI): (() => void) | void;
}
/** Chaque instance possède son enfant. Le contributeur fournit la fabrique, jamais un singleton. */
export interface AnnotationExtension {
    create(session: AnnotationSessionAPI): Component;
}
export interface AnnotationMarkerProvider {
    above: boolean;
    markers(session: AnnotationSessionAPI): readonly Marker[];
}
export const annotationTools = defineRegistry<OrderedRegistry<AnnotationTool>>('annotation:tools@1');
export const annotationKinds = defineRegistry<OrderedRegistry<StrokeKind>>('annotation:kinds@1');
export const annotationPresets = defineRegistry<OrderedRegistry<AnnotationPreset>>('annotation:presets@1');
export const annotationToolbar = defineRegistry<OrderedRegistry<AnnotationToolbarItem>>('annotation:toolbar@1');
export const annotationExtensions = defineRegistry<OrderedRegistry<AnnotationExtension>>('annotation:extensions@1');
export const annotationFilters = defineOrderedRegistry<(stroke: Stroke, session: AnnotationSessionAPI) => boolean>('annotation:filters@1');
export const annotationMarkers = defineOrderedRegistry<AnnotationMarkerProvider>('annotation:markers@1');
