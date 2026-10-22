import { Component, Notice } from 'fragment';
import { annotationExtensions, annotationFilters, annotationKinds, annotationPresets, annotationTools,
	type AnnotationSessionAPI, type AnnotationTool, type Stroke } from './annotation';
import type QuickAnki from './main';

// ═══════════════════════════════════════════════════════════════════════════
//  Les outils de cadrage : trois rectangles (recto, verso, cache) contribués aux
//  registres OUVERTS de l'annotation, une instance « Quick Anki » (preset) et,
//  par session, le BROUILLON de la carte en cours (extension).
// ═══════════════════════════════════════════════════════════════════════════

export const PRESET = 'quick-anki';
const COULEURS = { 'qa-recto': '#086ddd', 'qa-verso': '#08b94e', 'qa-cache': '#e0ac00' } as const;
type Outil = keyof typeof COULEURS;

export interface Box { x: number; y: number; w: number; h: number }
export interface Part { strokeId: string; box: Box; png?: Uint8Array }
export interface Draft { recto?: Part; verso?: Part; caches: Part[] }

export function registerTools(plugin: QuickAnki): void {
	const outils: [Outil, string, string][] = [
		['qa-recto', 'Recto (r)', 'square-dashed'], ['qa-verso', 'Verso (v)', 'square-dashed-bottom'], ['qa-cache', 'Cache (c)', 'square'],
	];
	outils.forEach(([id, label, icon], i) => {
		plugin.registerRegistryContribution(annotationTools, id, rectTool(plugin, id, label, icon, i));
		plugin.registerRegistryContribution(annotationKinds, id, { above: true, opacity: 1, widthFactor: 0.5 });
	});
	plugin.registerRegistryContribution(annotationPresets, PRESET, {
		id: PRESET, name: 'Quick Anki', icon: 'square-dashed', tools: outils.map((o) => o[0]), filter: (s) => s.tool.startsWith('qa-'),
	});
	// Les cadres ne se voient QUE dans l'instance Quick Anki.
	plugin.registerOrderedEntry(annotationFilters, (s, session) => !s.tool.startsWith('qa-') || session.context.instance.preset === PRESET);
	plugin.registerRegistryContribution(annotationExtensions, PRESET, { create: (session) => new CardDraft(plugin, session) });
}

/** Un rectangle tiré d'un coin à l'autre (modèle : le crayon d'annotation). */
function rectTool(plugin: QuickAnki, id: Outil, label: string, icon: string, order: number): AnnotationTool {
	return { id, label, icon, order, begin: ({ session, anchorAt }, at) => {
		const anchor = anchorAt(at.clientX, at.clientY);
		if (!anchor) return null;
		const x0 = at.x - anchor.glyphX, y0 = at.y - anchor.glyphY;
		let x1 = x0, y1 = y0;
		// Coins DOUBLÉS : le tracé lisse de l'annotation (courbes par les milieux) devient des côtés droits.
		const points = () => [[x0, y0], [x1, y0], [x1, y0], [x1, y1], [x1, y1], [x0, y1], [x0, y1], [x0, y0], [x0, y0]].map(([dx, dy]) => ({ dx, dy }));
		const width = () => session.style.width * session.kind(id).widthFactor;
		return {
			move: (p) => { x1 = p.x - anchor.glyphX; y1 = p.y - anchor.glyphY; },
			preview: () => ({ points: points(), originX: anchor.glyphX, originY: anchor.glyphY, color: COULEURS[id], width: width(), opacity: 1 }),
			end: () => {
				if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) return null;
				const stroke: Stroke = { id: crypto.randomUUID(), pos: anchor.pos, points: points(), color: COULEURS[id], width: width(), tool: id, calque: session.activeCalque };
				// Le trait est appliqué juste après `end` : le brouillon le lit ensuite.
				queueMicrotask(() => void plugin.drafts.get(session)?.add(stroke));
				return [{ kind: 'stroke', id: stroke.id, value: stroke }];
			},
		};
	} };
}

const deuxImages = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Le brouillon de la carte d'UN document, dans la session Quick Anki. */
export class CardDraft extends Component {
	draft: Draft = { caches: [] };

	constructor(private plugin: QuickAnki, readonly session: AnnotationSessionAPI) {
		super();
	}

	onload(): void {
		const { session, plugin } = this;
		if (session.context.instance.preset !== PRESET) return;
		plugin.drafts.set(session, this);
		this.register(() => plugin.drafts.delete(session));
		const scope = session.context.scope;
		const touches: [string, () => unknown][] = [
			['r', () => session.setTool('qa-recto')], ['v', () => session.setTool('qa-verso')], ['c', () => session.setTool('qa-cache')],
			['Enter', () => this.validate()], ['Backspace', () => this.discard()],
		];
		for (const [key, action] of touches) {
			const h = scope.register([], key, () => {
				if (!session.activeTool?.startsWith('qa-')) return undefined;
				void action();
				return false;
			});
			this.register(() => scope.unregister(h));
		}
		// Le document change : le brouillon ne vaut plus.
		this.registerEvent(session.context.app.workspace.on('view-document-change', (view: unknown) => {
			if (view === session.context.view) this.reset();
		}));
	}

	/** Un cadre vient d'être posé. */
	async add(stroke: Stroke): Promise<void> {
		const tool = stroke.tool as Outil;
		if (tool === 'qa-recto') this.session.setTool('qa-verso');
		await deuxImages();
		const g = this.session.geometry(stroke);
		if (!g) return;
		const part: Part = { strokeId: stroke.id, box: { x: g.x, y: g.y, w: g.w, h: g.h } };
		if (tool === 'qa-cache') this.draft.caches.push(part);
		else {
			part.png = (await this.capture(part.box, stroke.width)) ?? undefined;
			const side = tool === 'qa-recto' ? 'recto' : 'verso';
			const old = this.draft[side];
			this.draft[side] = part;
			// Un nouveau recto (verso) remplace l'ancien : son cadre part.
			if (old) this.erase([old.strokeId]);
		}
		this.changed();
	}

	/** L'image de la zone à l'écran, sans son cadre, bornée au pane. */
	private async capture(box: Box, width: number): Promise<Uint8Array | null> {
		const { overlays, paneEl, app } = this.session.context;
		const a = overlays.documentToClient(box.x, box.y), b = overlays.documentToClient(box.x + box.w, box.y + box.h);
		if (!a || !b) return null;
		const inset = width * ((b.x - a.x) / box.w || 1) + 2;
		const pane = paneEl.getBoundingClientRect();
		const x0 = Math.max(pane.left, a.x + inset), y0 = Math.max(pane.top, a.y + inset);
		const x1 = Math.min(pane.right, b.x - inset), y1 = Math.min(pane.bottom, b.y - inset);
		if (x1 <= x0 || y1 <= y0) return null;
		document.body.classList.add('qa-capturing');
		try {
			await deuxImages();
			return await app.windowHost.capture({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
		} catch (e) {
			console.error('quick-anki : capture', e);
			return null;
		} finally {
			document.body.classList.remove('qa-capturing');
		}
	}

	/** Entrée : la carte est enregistrée dans le paquet courant. */
	async validate(): Promise<void> {
		const vivants = new Set(this.session.strokes().map((s) => s.id));
		const d = this.draft;
		if (d.recto && !vivants.has(d.recto.strokeId)) d.recto = undefined;
		if (d.verso && !vivants.has(d.verso.strokeId)) d.verso = undefined;
		d.caches = d.caches.filter((c) => vivants.has(c.strokeId));
		const doc = this.session.doc;
		if (!d.recto?.png || !doc) {
			this.changed();
			new Notice('Trace d’abord un recto (r).');
			return;
		}
		const front = await masquer(d.recto, d.caches);
		const back = d.verso?.png ?? d.recto.png;
		const strokes = [d.recto, d.verso, ...d.caches].flatMap((p) => (p ? [p.strokeId] : []));
		await this.plugin.addCard(doc, front, back, strokes);
		this.reset();
		this.session.setTool('qa-recto');
	}

	/** Retour arrière : le brouillon et ses cadres disparaissent. */
	discard(): void {
		const d = this.draft;
		this.erase([d.recto, d.verso, ...d.caches].flatMap((p) => (p ? [p.strokeId] : [])));
		this.reset();
		this.session.setTool('qa-recto');
	}

	private erase(ids: string[]): void {
		const vivants = new Set(this.session.strokes().map((s) => s.id));
		this.session.apply(ids.filter((id) => vivants.has(id)).map((id) => ({ kind: 'stroke', id, value: null })));
	}

	private reset(): void {
		this.draft = { caches: [] };
		this.changed();
	}

	private changed(): void {
		this.session.context.app.workspace.trigger('quick-anki:draft', this.session.doc);
	}
}

/** Le recto avec ses caches peints en aplats opaques, à leur place proportionnelle. */
async function masquer(recto: Part, caches: Part[]): Promise<Uint8Array> {
	const img = await createImageBitmap(new Blob([recto.png! as BlobPart], { type: 'image/png' }));
	const canvas = document.createElement('canvas');
	canvas.width = img.width;
	canvas.height = img.height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(img, 0, 0);
	ctx.fillStyle = COULEURS['qa-cache'];
	const r = recto.box, kx = img.width / r.w, ky = img.height / r.h;
	for (const { box: c } of caches) ctx.fillRect((c.x - r.x) * kx, (c.y - r.y) * ky, c.w * kx, c.h * ky);
	const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
	return new Uint8Array(await blob!.arrayBuffer());
}
