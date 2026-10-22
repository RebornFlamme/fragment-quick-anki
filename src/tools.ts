import { Component, Notice } from 'fragment';
import { annotationExtensions, annotationFilters, annotationKinds, annotationPresets, annotationTools,
	type AnnotationSessionAPI, type AnnotationTool, type Stroke } from '@usefragment/annotation';
import type QuickAnki from './main';
import { DraftHandles, rectPoints } from './handles';
import { CARD, DRAFT, SCOPE, readCard, toBase64, type Box, type Card, type Face } from './model';

// ═══════════════════════════════════════════════════════════════════════════
//  Les outils de cadrage : trois rectangles (recto, verso, cache) contribués aux
//  registres OUVERTS de l'annotation, une instance « Quick Anki » (preset) ; le
//  COMPOSEUR de la carte en cours (un seul, persisté : artefact `quick-anki:draft`)
//  et, par session, ce qui le relie aux traits (capture, poignées, touches).
// ═══════════════════════════════════════════════════════════════════════════

export const PRESET = 'quick-anki';
const COULEURS = { 'qa-recto': '#086ddd', 'qa-verso': '#08b94e', 'qa-cache': '#e0ac00' } as const;
type Outil = keyof typeof COULEURS;
export type Side = 'recto' | 'verso';

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
		// Hors de l'instance Quick Anki, l'outil ne trace rien (son cadre y serait invisible).
		if (session.context.instance.preset !== PRESET) return null;
		const anchor = anchorAt(at.clientX, at.clientY);
		if (!anchor) return null;
		const x0 = at.x - anchor.glyphX, y0 = at.y - anchor.glyphY;
		let x1 = x0, y1 = y0;
		const points = () => rectPoints(x0, y0, x1, y1);
		const width = () => session.style.width * session.kind(id).widthFactor;
		return {
			move: (p) => { x1 = p.x - anchor.glyphX; y1 = p.y - anchor.glyphY; },
			preview: () => ({ points: points(), originX: anchor.glyphX, originY: anchor.glyphY, color: COULEURS[id], width: width(), opacity: 1 }),
			end: () => {
				if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) return null;
				const stroke: Stroke = { id: crypto.randomUUID(), pos: anchor.pos, points: points(), color: COULEURS[id], width: width(), tool: id, calque: session.activeCalque };
				// Le trait est appliqué juste après `end` : le composeur le lit ensuite.
				queueMicrotask(() => void plugin.drafts.get(session)?.add(stroke));
				return [{ kind: 'stroke', id: stroke.id, value: stroke }];
			},
		};
	} };
}

const deuxImages = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const memeBoite = (a: Box, b: Box) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

// ── Le composeur : la carte en cours (nouvelle ou existante) ──────────────

export interface Cache { doc: string; stroke: string; box: Box }
export interface Compose {
	/** La carte éditée (null : nouvelle). Rien n'est écrit sur elle avant Valider. */
	cardId: string | null;
	recto: Face | null;
	verso: Face | null;
	/** Les caches du recto zone (même document). */
	caches: Cache[];
	/** Les traits tracés pendant la composition (effacés à Annuler). */
	created: { doc: string; stroke: string }[];
}

export class Composer {
	state: Compose | null = null;
	private draftId: string | null = null;

	constructor(private plugin: QuickAnki) {}

	/** Le brouillon d'avant (fermeture de l'app, rechargement) est repris. */
	async restore(): Promise<void> {
		const { artefacts } = this.plugin.app;
		await artefacts.ready;
		const rec = artefacts.list({ type: DRAFT, scope: { collection: SCOPE.collection } })[0];
		if (!rec) return;
		this.draftId = rec.id;
		this.state = (await artefacts.state<Compose>(rec.id)) ?? null;
		this.plugin.changed();
	}

	/** Une carte neuve, ou l'édition d'une existante (ses faces copiées). */
	async start(cardId: string | null): Promise<void> {
		if (this.state) this.cancel();
		// Une COPIE : le composeur recale ses boîtes en place, la carte d'origine reste intacte.
		const lu = cardId ? readCard(await this.plugin.app.artefacts.state(cardId)) : null;
		const card = lu ? structuredClone(lu) : null;
		const r = card?.recto;
		this.state = {
			cardId: card ? cardId : null, recto: card?.recto ?? null, verso: card?.verso ?? null, created: [],
			caches: r?.kind === 'zone' ? r.masks.map((m, i) => ({
				doc: r.doc, stroke: r.maskStrokes[i] ?? '', box: { x: r.box.x + m.x * r.box.w, y: r.box.y + m.y * r.box.h, w: m.w * r.box.w, h: m.h * r.box.h },
			})) : [],
		};
		this.save();
	}

	/** Pose (ou retire) une face. Un trait remplacé, tracé pendant la composition, part tout de suite. */
	setFace(side: Side, face: Face | null): void {
		const s = this.state;
		if (!s) return;
		const old = s[side];
		if (old?.kind === 'zone' && (face?.kind !== 'zone' || face.stroke !== old.stroke)) this.eraseCreated([old.stroke]);
		s[side] = face;
		if (side === 'recto' && face?.kind !== 'zone') {
			this.eraseCreated(s.caches.map((c) => c.stroke));
			s.caches = [];
		}
		this.save();
	}

	addCache(c: Cache): void {
		this.state?.caches.push(c);
		this.save();
	}

	/** Refaire toute la carte : les deux faces et les caches se vident. */
	clearAll(): void {
		this.setFace('recto', null);
		this.setFace('verso', null);
	}

	/** Les traits que la carte composée référence. */
	private strokes(s: Pick<Compose, 'recto' | 'verso' | 'caches'>): string[] {
		return [s.recto, s.verso].flatMap((f) => (f?.kind === 'zone' ? [f.stroke] : [])).concat(s.caches.map((c) => c.stroke));
	}

	/** Les traits d'un document (poignées, recalage). */
	zones(doc: string): { stroke: string; side: Side | 'cache' }[] {
		const s = this.state;
		if (!s) return [];
		const out: { stroke: string; side: Side | 'cache' }[] = [];
		for (const side of ['recto', 'verso'] as const) {
			const f = s[side];
			if (f?.kind === 'zone' && f.doc === doc) out.push({ stroke: f.stroke, side });
		}
		for (const c of s.caches) if (c.doc === doc) out.push({ stroke: c.stroke, side: 'cache' });
		return out;
	}

	/** Valider : la carte est écrite (nouvelle dans le paquet courant, ou l'existante mise à jour). */
	async validate(): Promise<boolean> {
		for (const d of this.plugin.drafts.values()) await d.idle();
		const s = this.state;
		const { artefacts } = this.plugin.app;
		// Un cadre annulé (Ctrl+Z) ne fait plus de face.
		for (const side of ['recto', 'verso'] as const) {
			const f = s?.[side];
			if (s && f?.kind === 'zone' && !this.alive(f.doc, f.stroke)) s[side] = null;
		}
		if (s) s.caches = s.caches.filter((c) => this.alive(c.doc, c.stroke));
		if (!s?.recto) { this.save(); new Notice('Il faut d’abord un recto.'); return false; }
		const deck = this.plugin.currentDeck();
		const old = s.cardId ? readCard(await artefacts.state(s.cardId)) : null;
		if (!old && !deck) { new Notice('Crée d’abord un paquet.'); return false; }
		let recto = s.recto;
		if (recto.kind === 'zone') {
			const r = recto.box;
			recto = { ...recto, maskStrokes: s.caches.map((c) => c.stroke),
				masks: s.caches.map(({ box: c }) => ({ x: (c.x - r.x) / r.w, y: (c.y - r.y) / r.h, w: c.w / r.w, h: c.h / r.h })) };
		}
		const now = Date.now();
		if (old && s.cardId) artefacts.set(s.cardId, { state: { ...old, recto, verso: s.verso, updatedAt: now } satisfies Card }, 'user');
		else artefacts.set(null, { type: CARD, scope: SCOPE, state: { deck: deck!, recto, verso: s.verso, createdAt: now, updatedAt: now } satisfies Card }, 'user');
		// Les cadres de l'ancienne version qui ne servent plus partent.
		if (old) {
			const garde = new Set(this.strokes(s));
			const avant = old.recto.kind === 'zone' ? old.recto : null;
			const anciens = [old.recto, old.verso].flatMap((f) => (f?.kind === 'zone' ? [{ doc: f.doc, stroke: f.stroke }] : []))
				.concat((avant?.maskStrokes ?? []).map((stroke) => ({ doc: avant!.doc, stroke })));
			this.erase(anciens.filter((a) => !garde.has(a.stroke)));
		}
		this.end();
		return true;
	}

	/** Annuler : la carte d'origine reste intacte ; les traits tracés depuis partent. */
	cancel(): void {
		const s = this.state;
		if (!s) return;
		this.erase(s.created);
		this.end();
	}

	private end(): void {
		this.state = null;
		for (const d of this.plugin.drafts.values()) if (d.session.activeTool?.startsWith('qa-')) d.session.setTool(null);
		this.save();
	}

	/** Le trait existe-t-il encore ? (document fermé : on le suppose.) */
	private alive(doc: string, stroke: string): boolean {
		const d = [...this.plugin.drafts.values()].find((x) => x.session.doc === doc);
		return !d || d.session.strokes().some((t) => t.id === stroke);
	}

	private eraseCreated(ids: string[]): void {
		const s = this.state;
		if (!s) return;
		const morts = s.created.filter((c) => ids.includes(c.stroke));
		s.created = s.created.filter((c) => !ids.includes(c.stroke));
		this.erase(morts);
	}

	private erase(list: { doc: string; stroke: string }[]): void {
		for (const d of this.plugin.drafts.values()) {
			const ids = list.filter((l) => l.doc === d.session.doc).map((l) => l.stroke);
			const vivants = new Set(d.session.strokes().map((t) => t.id));
			const edits = ids.filter((id) => vivants.has(id)).map((id) => ({ kind: 'stroke' as const, id, value: null }));
			if (edits.length) d.session.apply(edits);
		}
	}

	/** Le brouillon est persisté à chaque changement ; vide → l'artefact part. */
	save(): void {
		const { artefacts } = this.plugin.app;
		if (this.state) {
			if (this.draftId && artefacts.get(this.draftId)) artefacts.set(this.draftId, { state: this.state }, 'user');
			else this.draftId = artefacts.set(null, { type: DRAFT, scope: SCOPE, state: this.state }, 'user');
		} else if (this.draftId) {
			if (artefacts.get(this.draftId)) artefacts.del(this.draftId, 'user');
			this.draftId = null;
		}
		for (const d of this.plugin.drafts.values()) d.render();
		this.plugin.changed();
	}
}

// ── Par session de l'instance Quick Anki : traits → composeur ─────────────

export class CardDraft extends Component {
	private handles: DraftHandles | null = null;
	private syncing = false;
	private resync = false;

	constructor(private plugin: QuickAnki, readonly session: AnnotationSessionAPI) {
		super();
	}

	private get composer(): Composer { return this.plugin.composer; }

	onload(): void {
		const { session, plugin } = this;
		if (session.context.instance.preset !== PRESET) return;
		plugin.drafts.set(session, this);
		this.register(() => plugin.drafts.delete(session));
		const scope = session.context.scope;
		const touches: [string, () => unknown][] = [
			['r', () => session.setTool('qa-recto')], ['v', () => session.setTool('qa-verso')], ['c', () => session.setTool('qa-cache')],
		];
		for (const [key, action] of touches) {
			const h = scope.register([], key, () => {
				if (!session.activeTool?.startsWith('qa-')) return undefined;
				void action();
				return false;
			});
			this.register(() => scope.unregister(h));
		}
		this.handles = this.addChild(new DraftHandles(session, () => this.ids(), () => this.sync()));
		// Un cadre change de taille (poignée, ANNULER / RÉTABLIR, texte qui se réagence) :
		// sa boîte suit et son image est reprise — sinon la carte garderait l'ancienne.
		this.registerEvent(session.on('change', () => this.sync()));
		let outil = session.activeTool;
		this.registerEvent(session.on('change', () => {
			if (outil?.startsWith('qa-') && !session.activeTool) {
				plugin.justDisarmed = true;
				window.setTimeout(() => { plugin.justDisarmed = false; }, 0);
			}
			outil = session.activeTool;
		}));
	}

	render(): void {
		this.handles?.render();
	}

	private ids(): string[] {
		const doc = this.session.doc;
		return doc ? this.composer.zones(doc).map((z) => z.stroke) : [];
	}

	/** Un cadre vient d'être posé. */
	async add(stroke: Stroke): Promise<void> {
		const tool = stroke.tool as Outil;
		const doc = this.session.doc;
		if (!doc) return;
		if (!this.composer.state) await this.composer.start(null);
		const s = this.composer.state!;
		s.created.push({ doc, stroke: stroke.id });
		if (tool === 'qa-recto' && !s.verso) this.session.setTool('qa-verso');
		await deuxImages();
		const g = this.session.geometry(stroke);
		if (!g || this.composer.state !== s) return;
		const box = { x: g.x, y: g.y, w: g.w, h: g.h };
		if (tool === 'qa-cache') {
			if (s.recto?.kind !== 'zone' || s.recto.doc !== doc) {
				new Notice('Un cache se trace sur un recto en zone, dans le même document.');
				s.created.pop();
				this.session.apply([{ kind: 'stroke', id: stroke.id, value: null }]);
				return;
			}
			this.composer.addCache({ doc, stroke: stroke.id, box });
			return;
		}
		const png = await this.capture(box, stroke.width);
		if (this.composer.state !== s) return;
		this.composer.setFace(tool === 'qa-recto' ? 'recto' : 'verso',
			{ kind: 'zone', doc, stroke: stroke.id, box, png: png ? toBase64(png) : '', masks: [], maskStrokes: [] });
	}

	/** Recale la boîte (et l'image) de chaque cadre du composeur dans ce document, une passe à la fois. */
	private sync(): void {
		if (this.syncing) { this.resync = true; return; }
		this.syncing = true;
		void (async () => {
			try {
				do {
					this.resync = false;
					await deuxImages();
					const s = this.composer.state;
					const doc = this.session.doc;
					if (!s || !doc) continue;
					let changed = false;
					const parts: { box: Box; face?: Side; width: number; stroke: Stroke }[] = [];
					for (const side of ['recto', 'verso'] as const) {
						const f = s[side];
						const stroke = f?.kind === 'zone' && f.doc === doc ? this.session.strokes().find((t) => t.id === f.stroke) : undefined;
						if (f?.kind === 'zone' && stroke) parts.push({ box: f.box, face: side, width: stroke.width, stroke });
					}
					for (const c of s.caches) {
						const stroke = c.doc === doc ? this.session.strokes().find((t) => t.id === c.stroke) : undefined;
						if (stroke) parts.push({ box: c.box, width: stroke.width, stroke });
					}
					for (const p of parts) {
						const g = this.session.geometry(p.stroke);
						if (!g || memeBoite(g, p.box)) continue;
						Object.assign(p.box, { x: g.x, y: g.y, w: g.w, h: g.h });
						const f = p.face && s[p.face];
						if (f?.kind === 'zone') {
							const png = await this.capture(f.box, p.width);
							f.png = png ? toBase64(png) : f.png;
						}
						changed = true;
					}
					if (changed && this.composer.state === s) this.composer.save();
				} while (this.resync);
			} finally {
				this.syncing = false;
			}
		})();
	}

	/** Attendre un recalage en cours (Valider juste après Ctrl+Z). */
	async idle(): Promise<void> {
		while (this.syncing) await deuxImages();
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
}
