import { ItemView, Plugin, defineRegistry, type ViewState } from 'fragment';
import type { AnnotationSessionAPI } from '@usefragment/annotation';
import { CardDraft, PRESET, registerTools } from './tools';
import { QuickAnkiView, VIEW_TYPE } from './view';

// ═══════════════════════════════════════════════════════════════════════════
//  Quick Anki : cadrer une zone d'une note ou d'un PDF (recto, verso, caches)
//  → une carte Anki. Paquets et cartes sont des ARTEFACTS du coffre ; ils partent
//  dans Anki (AnkiConnect) quand on termine.
// ═══════════════════════════════════════════════════════════════════════════

export const SCOPE = { kind: 'plugin', collection: 'quick-anki' } as const;
export const DECK = 'quick-anki:deck';
export const CARD = 'quick-anki:card';

export interface Deck { name: string; createdAt: number; sentAt?: number }
export interface Card { deck: string; doc: string; front: string; back: string; strokes: string[]; createdAt: number; noteId?: number }

/** Le contrat `doc-widget:host@1` (plugin cœur, hors de @usefragment/core). */
interface DocWidgetHost {
	open(o: { viewState: ViewState; file: string; from: number; to: number; anchor?: { mode: 'viewport'; x: number; y: number }; open?: boolean }): string | null;
	setOpen(id: string, open: boolean): void;
	list(file: string): { id: string; viewState: ViewState }[];
}
const docWidgetHost = defineRegistry<DocWidgetHost>('doc-widget:host@1');

export default class QuickAnki extends Plugin {
	readonly drafts = new Map<AnnotationSessionAPI, CardDraft>();
	data: { deck?: string } = {};

	async onload(): Promise<void> {
		this.data = ((await this.loadData()) as { deck?: string } | null) ?? {};
		registerTools(this);
		this.registerView(VIEW_TYPE, (leaf) => new QuickAnkiView(leaf, this));
		this.addCommand({
			id: 'start', name: 'Cadrer une carte', hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'k' }],
			checkCallback: (checking) => {
				const view = this.app.workspace.activeLeaf?.view;
				const doc = view instanceof ItemView ? view.getDocument() : null;
				if (!(view instanceof ItemView) || !doc) return false;
				if (!checking) this.start(view, doc);
				return true;
			},
		});
		this.addCommand({ id: 'open', name: 'Ouvrir les paquets', callback: () => void this.openWindow() });
		this.addRibbonIcon('layers', 'Quick Anki : les paquets', () => void this.openWindow());
	}

	/** Monte l'instance Quick Anki, arme le recto, montre le widget de stats. */
	private start(view: ItemView, doc: string): void {
		if (!view.isLayerActive('annotation', PRESET)) view.toggleLayer('annotation', PRESET);
		[...this.drafts.values()].find((d) => d.session.context.view === view)?.session.setTool('qa-recto');
		const host = this.app.registry.get(docWidgetHost).entries().at(-1)?.value;
		if (!host) return;
		const widget = host.list(doc).find((w) => w.viewState.type === VIEW_TYPE);
		if (widget) host.setOpen(widget.id, true);
		else host.open({
			viewState: { type: VIEW_TYPE, state: {} }, file: doc, from: 0, to: 0, open: true,
			anchor: { mode: 'viewport', x: 16, y: Math.max(16, view.contentEl.clientHeight - 300) },
		});
	}

	async openWindow(): Promise<void> {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.parent !== null) ?? this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.setActiveLeaf(leaf);
	}

	// ── Le stockage : des artefacts du plugin ─────────────────────────────

	async list<S>(type: string): Promise<{ id: string; state: S }[]> {
		await this.app.artefacts.ready;
		const recs = this.app.artefacts.list({ type, scope: { collection: SCOPE.collection } });
		const out = await Promise.all(recs.map(async (r) => ({ id: r.id, state: (await this.app.artefacts.state(r.id)) as S | null })));
		return out.filter((r): r is { id: string; state: S } => r.state !== null);
	}

	/** Le paquet courant (non envoyé), s'il existe encore. */
	currentDeck(): string | null {
		const id = this.data.deck;
		return id && this.app.artefacts.get(id) ? id : null;
	}

	async setCurrent(id: string | null): Promise<void> {
		this.data.deck = id ?? undefined;
		await this.saveData(this.data);
		this.app.workspace.trigger('quick-anki:draft', null);
	}

	async addCard(doc: string, front: Uint8Array, back: Uint8Array, strokes: string[]): Promise<void> {
		await this.app.artefacts.ready;
		let deck = this.currentDeck();
		if (!deck) {
			const name = (doc.split('/').pop() ?? doc).replace(/\.[^.]+$/, '');
			deck = this.app.artefacts.set(null, { type: DECK, scope: SCOPE, state: { name, createdAt: Date.now() } satisfies Deck }, 'user');
			await this.setCurrent(deck);
		}
		const card: Card = { deck, doc, front: base64(front), back: base64(back), strokes, createdAt: Date.now() };
		this.app.artefacts.set(null, { type: CARD, scope: SCOPE, state: card }, 'user');
	}
}

function base64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
