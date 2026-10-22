import { Component } from 'fragment';
import type { AnnotationSessionAPI, Stroke } from '@usefragment/annotation';
import type { Box } from './model';

// ═══════════════════════════════════════════════════════════════════════════
//  Les poignées des cadres du brouillon : 4 coins + 4 côtés, pour redimensionner
//  un recto / verso / cache après l'avoir tracé. Visibles tant qu'un outil Quick
//  Anki est armé ; l'intérieur du cadre reste libre (on trace un cache DANS le
//  recto). Au relâché, le trait est réécrit (annulable) et le brouillon prévenu.
// ═══════════════════════════════════════════════════════════════════════════

const POIGNEES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Poignee = typeof POIGNEES[number];

/** Les 4 coins d'un rectangle, DOUBLÉS : le tracé lissé de l'annotation garde des côtés droits. */
export function rectPoints(x0: number, y0: number, x1: number, y1: number): { dx: number; dy: number }[] {
	return [[x0, y0], [x1, y0], [x1, y0], [x1, y1], [x1, y1], [x0, y1], [x0, y1], [x0, y0], [x0, y0]].map(([dx, dy]) => ({ dx, dy }));
}

export class DraftHandles extends Component {
	private els = new Map<string, HTMLElement>();

	constructor(
		private readonly session: AnnotationSessionAPI,
		/** Les traits du brouillon, par id. */
		private readonly ids: () => string[],
		/** Un cadre a été redimensionné (son trait est déjà réécrit). */
		private readonly resized: () => void,
	) {
		super();
	}

	onload(): void {
		const s = this.session;
		this.registerEvent(s.on('change', () => this.render()));
		this.register(s.surface.onChange(() => this.render()));
		this.register(s.context.overlays.onGeometryChange(() => this.render()));
		this.register(() => { for (const el of this.els.values()) el.remove(); this.els.clear(); });
		this.render();
	}

	/** Recale les cadres sur leurs traits ; aucun si aucun outil Quick Anki n'est armé. */
	render(): void {
		const s = this.session;
		const armed = s.activeTool?.startsWith('qa-') ?? false;
		const strokes = armed ? s.strokes().filter((t) => this.ids().includes(t.id)) : [];
		for (const [id, el] of this.els) {
			if (!strokes.some((t) => t.id === id)) { el.remove(); this.els.delete(id); }
		}
		for (const stroke of strokes) {
			const g = s.geometry(stroke);
			let el = this.els.get(stroke.id);
			if (!g) { el?.remove(); this.els.delete(stroke.id); continue; }
			if (!el) { el = this.monter(stroke.id); this.els.set(stroke.id, el); }
			if (el.classList.contains('is-dragging')) continue;
			el.style.setProperty('--qa-color', stroke.color);
			poser(el, { x: g.x, y: g.y, w: g.w, h: g.h });
		}
	}

	private monter(id: string): HTMLElement {
		const el = document.createElement('div');
		el.className = 'qa-handles';
		for (const h of POIGNEES) {
			const p = el.appendChild(document.createElement('div'));
			p.className = 'qa-handle';
			p.dataset.h = h;
			p.style.left = h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%';
			p.style.top = h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%';
			p.addEventListener('pointerdown', (e) => this.tirer(e, id, h, el));
		}
		this.register(this.session.context.overlays.mount(el, 'document'));
		return el;
	}

	/** Un geste sur une poignée : la boîte suit le pointeur, le trait est réécrit au relâché. */
	private tirer(e: PointerEvent, id: string, h: Poignee, el: HTMLElement): void {
		const s = this.session;
		const stroke = s.strokes().find((t) => t.id === id);
		const g = stroke && s.geometry(stroke);
		if (!stroke || !g || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const cible = e.currentTarget as HTMLElement;
		cible.setPointerCapture(e.pointerId);
		el.classList.add('is-dragging');
		const depart = { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
		let box = { ...depart };
		const bouger = (ev: PointerEvent) => {
			const p = s.context.overlays.clientToDocument(ev.clientX, ev.clientY);
			if (!p) return;
			box = { ...depart };
			if (h.includes('w')) box.x0 = p.x;
			if (h.includes('e')) box.x1 = p.x;
			if (h.includes('n')) box.y0 = p.y;
			if (h.includes('s')) box.y1 = p.y;
			poser(el, normaliser(box));
		};
		const finir = () => {
			cible.removeEventListener('pointermove', bouger);
			cible.removeEventListener('pointerup', finir);
			cible.removeEventListener('pointercancel', finir);
			el.classList.remove('is-dragging');
			const b = normaliser(box);
			const glyph = s.surface.coordsAtPos(stroke.pos);
			if (!glyph || b.w < 8 || b.h < 8) { this.render(); return; }
			// Les points sont des écarts au glyphe d'ancrage (la géométrie = glyphe + points).
			const x0 = b.x - glyph.left, y0 = b.y - glyph.top;
			const next: Stroke = { ...stroke, points: rectPoints(x0, y0, x0 + b.w, y0 + b.h) };
			s.apply([{ kind: 'stroke', id, value: next }]);
			this.resized();
		};
		cible.addEventListener('pointermove', bouger);
		cible.addEventListener('pointerup', finir);
		cible.addEventListener('pointercancel', finir);
	}
}

function normaliser(b: { x0: number; y0: number; x1: number; y1: number }): Box {
	return { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1), w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) };
}

function poser(el: HTMLElement, b: Box): void {
	el.style.left = `${b.x}px`;
	el.style.top = `${b.y}px`;
	el.style.width = `${b.w}px`;
	el.style.height = `${b.h}px`;
}
