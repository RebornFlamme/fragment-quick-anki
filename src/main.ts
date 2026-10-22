import { ItemView, Modal, Notice, Plugin, Setting, defineRegistry, type ViewState } from 'fragment';
import type { AnnotationSessionAPI } from '@usefragment/annotation';
import { CardDraft, Composer, PRESET, annulable, registerTools } from './tools';
import { QuickAnkiView, VIEW_TYPE } from './view';
import { deleteNotes } from './anki';
import { CARD, DECK, SCOPE, readCard, readDeck, status, type Card, type Deck } from './model';

// ═══════════════════════════════════════════════════════════════════════════
//  Quick Anki : un PAQUET, puis ses cartes ; chaque face est une zone d'un
//  document (rectangle tracé) ou du Markdown rendu. Paquets, cartes et brouillon
//  sont des ARTEFACTS du coffre ; ils partent dans Anki (AnkiConnect) à l'envoi.
//  Droit à l'erreur : refaire une face, annuler une édition, défaire une suppression.
// ═══════════════════════════════════════════════════════════════════════════

/** Le contrat `doc-widget:host@1` (plugin cœur, hors de @usefragment/core). */
interface DocWidgetHost {
	open(o: { viewState: ViewState; file: string; from: number; to: number; anchor?: { mode: 'viewport'; x: number; y: number }; open?: boolean }): string | null;
	close(id: string): void;
	setOpen(id: string, open: boolean): void;
	list(file: string): { id: string; viewState: ViewState }[];
}
const docWidgetHost = defineRegistry<DocWidgetHost>('doc-widget:host@1');
const MARGE = 16;

export default class QuickAnki extends Plugin {
	/** Les sessions de l'instance Quick Anki ouvertes (une par vue de document). */
	readonly drafts = new Map<AnnotationSessionAPI, CardDraft>();
	readonly composer = new Composer(this);
	data: { deck?: string } = {};
	private buttons = new Map<ItemView, HTMLElement>();
	private observers = new Map<ItemView, ResizeObserver>();
	private repinTimer = 0;
	/** Un outil Quick Anki vient d'être désarmé (pendant la frappe en cours). */
	justDisarmed = false;

	async onload(): Promise<void> {
		this.data = ((await this.loadData()) as { deck?: string } | null) ?? {};
		registerTools(this);
		this.registerView(VIEW_TYPE, (leaf) => new QuickAnkiView(leaf, this));
		this.addCommand({
			id: 'start', name: 'Nouvelle carte', hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'k' }],
			checkCallback: (checking) => {
				const view = this.documentView();
				if (!view) return false;
				if (!checking) void this.newCard(view);
				return true;
			},
		});
		this.addCommand({ id: 'open', name: 'Ouvrir les paquets', callback: () => void this.openWindow() });
		this.addRibbonIcon('layers', 'Quick Anki : les paquets', () => void this.openWindow());
		// Le bouton d'en-tête, sur toute vue de document du workspace.
		this.app.workspace.onLayoutReady(() => this.decorate());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.decorate()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.decorate()));
		this.register(() => {
			for (const el of this.buttons.values()) el.remove();
			for (const ro of this.observers.values()) ro.disconnect();
			window.clearTimeout(this.repinTimer);
		});
		// Entrée / Échap valident / annulent la carte en cours, outil Quick Anki armé ou depuis
		// le widget. Écouté sur `window` en capture, APRÈS le Keymap de l'app : Échap y a déjà
		// désarmé l'outil (annotation) — `justDisarmed` dit qu'il l'était à cette frappe.
		const touche = (e: KeyboardEvent): void => {
			if ((e.key !== 'Enter' && e.key !== 'Escape') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !this.composer.state) return;
			const t = e.target as HTMLElement | null;
			if (t?.closest('input, textarea, .modal-container, .menu')) return;
			const arme = this.justDisarmed || [...this.drafts.values()].some((d) => d.session.activeTool?.startsWith('qa-'));
			// Un bouton focalisé garde Entrée (le cliquer), sauf outil armé.
			if (!arme && (!t?.closest('.quick-anki-view') || (e.key === 'Enter' && t.closest('button')))) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Enter') void this.composer.validate();
			else this.composer.cancel();
		};
		window.addEventListener('keydown', touche, true);
		this.register(() => window.removeEventListener('keydown', touche, true));
		await this.composer.restore();
	}

	// ── Le widget ──────────────────────────────────────────────────────────

	/** La vue de document active (feuille du workspace), sinon null. */
	documentView(): ItemView | null {
		const view = this.app.workspace.activeLeaf?.view;
		return view instanceof ItemView && view.getDocument() && view.leaf.parent !== null ? view : null;
	}

	/** La vue d'un document dans le workspace (pour armer un outil, lire une sélection). */
	viewOf(doc: string): ItemView | null {
		const active = this.documentView();
		if (active?.getDocument() === doc) return active;
		let found: ItemView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const v = leaf.view;
			if (!found && v instanceof ItemView && leaf.parent !== null && v.getDocument() === doc) found = v;
		});
		return found;
	}

	private decorate(): void {
		const vivantes = new Set<ItemView>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof ItemView) || leaf.parent === null || !view.getDocument() || view instanceof QuickAnkiView) return;
			vivantes.add(view);
			// Un widget déjà là (rechargement du plugin, layout restauré) : il est recalé lui aussi.
			if (this.widgetOf(view.getDocument()!)) this.observe(view);
			if (this.buttons.has(view)) return;
			const el = view.addAction('copy-plus', 'Quick Anki', () => this.toggle(view));
			el.classList.add('qa-header-action');
			this.buttons.set(view, el);
		});
		for (const [view, el] of this.buttons) if (!vivantes.has(view)) { el.remove(); this.buttons.delete(view); }
		for (const [view, ro] of this.observers) if (!vivantes.has(view)) { ro.disconnect(); this.observers.delete(view); }
	}

	private host(): DocWidgetHost | null {
		return this.app.registry.get(docWidgetHost).entries().at(-1)?.value ?? null;
	}

	private widgetOf(doc: string): string | null {
		return this.host()?.list(doc).find((w) => w.viewState.type === VIEW_TYPE)?.id ?? null;
	}

	/** Le bouton d'en-tête : ouvre ou referme le widget sur la vue. */
	toggle(view: ItemView): void {
		const doc = view.getDocument();
		const host = this.host();
		if (!doc || !host) return;
		const id = this.widgetOf(doc);
		if (id) host.close(id);
		else this.showWidget(view);
	}

	showWidget(view: ItemView): void {
		const doc = view.getDocument();
		const host = this.host();
		if (!doc || !host) return;
		const id = this.widgetOf(doc);
		if (id) host.setOpen(id, true);
		else host.open({
			viewState: { type: VIEW_TYPE, state: {} }, file: doc, from: 0, to: 0, open: true,
			anchor: { mode: 'viewport', x: MARGE, y: Math.max(MARGE, view.contentEl.clientHeight - 320) },
		});
		this.observe(view);
		void this.loop(doc);
	}

	private observe(view: ItemView): void {
		if (!this.observers.has(view)) {
			const ro = new ResizeObserver(() => this.repinSoon());
			ro.observe(view.contentEl);
			this.observers.set(view, ro);
		}
		this.repinSoon();
	}

	/** Recale chaque widget en bas à gauche de sa vue (la vue ou le widget ont changé de taille). */
	repinSoon(): void {
		window.clearTimeout(this.repinTimer);
		this.repinTimer = window.setTimeout(() => {
			for (const view of this.observers.keys()) this.repin(view);
		}, 80);
	}

	private repin(view: ItemView): void {
		const doc = view.getDocument();
		const id = doc && this.widgetOf(doc);
		if (!id) return;
		const el = Array.from(view.contentEl.querySelectorAll<HTMLElement>('.doc-widget')).find((w) => w.querySelector('.quick-anki-view'));
		if (!el || !el.offsetHeight) return;
		const y = Math.max(MARGE, view.contentEl.clientHeight - el.offsetHeight - MARGE);
		const a = this.app.artefacts.get(id)?.anchor as { mode?: string; x?: number; y?: number } | null | undefined;
		if (a?.mode === 'viewport' && a.x === MARGE && Math.abs((a.y ?? 0) - y) < 2) return;
		this.app.artefacts.set(id, { anchor: { mode: 'viewport', x: MARGE, y } }, 'follow');
	}

	/** Ctrl+Maj+K : le widget, et la carte suivante, recto armé. */
	async newCard(view: ItemView): Promise<void> {
		this.showWidget(view);
	}

	/**
	 * La BOUCLE par défaut : dès qu'un paquet est courant, une carte neuve est en cours
	 * et l'outil de sa prochaine face est armé (r, v, r, v…). Une composition en cours
	 * (brouillon, édition) est gardée.
	 */
	async loop(cible?: string | null): Promise<void> {
		const doc = cible ?? this.documentView()?.getDocument() ?? null;
		if (!this.currentDeck()) return;
		if (!this.composer.state) await this.composer.start(null);
		const s = this.composer.state;
		if (!doc || !s || s.cardId) return;
		const tool = !s.recto ? 'qa-recto' : !s.verso ? 'qa-verso' : null;
		if (tool) await this.arm(doc, tool);
	}

	/** Arme un outil Quick Anki sur la vue du document (l'instance est montée au besoin). */
	async arm(doc: string, tool: string | null): Promise<void> {
		const view = this.viewOf(doc);
		if (!view) return;
		if (tool && !view.isLayerActive('annotation', PRESET)) view.toggleLayer('annotation', PRESET);
		// La session de l'instance naît avec le calque : elle peut arriver une image plus tard.
		for (let i = 0; i < 30; i++) {
			const d = [...this.drafts.values()].find((x) => x.session.context.view === view);
			if (d) { d.session.setTool(tool); return; }
			await new Promise((r) => requestAnimationFrame(r));
		}
	}

	async openWindow(): Promise<void> {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.parent !== null) ?? this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.setActiveLeaf(leaf);
	}

	// ── Le stockage ────────────────────────────────────────────────────────

	async decks(): Promise<{ id: string; state: Deck }[]> {
		return (await this.read(DECK, readDeck)).sort((a, b) => b.state.createdAt - a.state.createdAt);
	}

	async cards(deck?: string): Promise<{ id: string; state: Card }[]> {
		return (await this.read(CARD, readCard)).filter((c) => !deck || c.state.deck === deck).sort((a, b) => a.state.createdAt - b.state.createdAt);
	}

	private async read<S>(type: string, parse: (raw: unknown) => S | null): Promise<{ id: string; state: S }[]> {
		await this.app.artefacts.ready;
		const recs = this.app.artefacts.list({ type, scope: { collection: SCOPE.collection } });
		const out = await Promise.all(recs.map(async (r) => ({ id: r.id, state: parse(await this.app.artefacts.state(r.id)) })));
		return out.filter((r): r is { id: string; state: S } => r.state !== null);
	}

	/** Le paquet courant (non supprimé), s'il existe. */
	currentDeck(): string | null {
		const id = this.data.deck;
		return id && this.app.artefacts.get(id) ? id : null;
	}

	async setCurrent(id: string | null): Promise<void> {
		this.data.deck = id ?? undefined;
		await this.saveData(this.data);
		this.changed();
	}

	/** Prévient les vues (widget, fenêtre) : quelque chose a changé. */
	changed(): void {
		this.app.workspace.trigger('quick-anki:changed');
	}

	async createDeck(name: string, parent: string): Promise<string> {
		const id = this.app.artefacts.set(null, { type: DECK, scope: SCOPE, state: { name, parent, createdAt: Date.now() } satisfies Deck }, 'user');
		await this.setCurrent(id);
		return id;
	}

	async updateDeck(id: string, patch: Partial<Deck>): Promise<void> {
		const deck = readDeck(await this.app.artefacts.state(id));
		if (deck) this.app.artefacts.set(id, { state: { ...deck, ...patch } }, 'user');
		this.changed();
	}

	/** Supprime une carte ; une Notice permet de la rendre. Envoyée : demande si elle part aussi d'Anki. */
	async deleteCard(id: string): Promise<void> {
		const card = readCard(await this.app.artefacts.state(id));
		if (!card) return;
		const aussiAnki = card.noteId && status(card) !== 'new' ? await demander(this, 'Cette carte est déjà dans Anki. La supprimer aussi d’Anki ?') : false;
		if (this.composer.state?.cardId === id) this.composer.cancel();
		this.app.artefacts.del(id, 'user');
		if (aussiAnki && card.noteId) {
			try { await deleteNotes([card.noteId]); } catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
		}
		this.changed();
		annulable('Carte supprimée', () => {
			const rendue: Card = aussiAnki ? { ...card, noteId: undefined, syncedAt: undefined } : card;
			this.app.artefacts.set(null, { type: CARD, scope: SCOPE, state: rendue }, 'user');
			this.changed();
		});
	}

	/** Supprime un paquet et ses cartes (dans le coffre) ; une Notice permet de tout rendre. */
	async deleteDeck(id: string): Promise<void> {
		const deck = readDeck(await this.app.artefacts.state(id));
		if (!deck) return;
		const cards = await this.cards(id);
		const etaitCourant = this.currentDeck() === id;
		if (this.composer.state && cards.some((c) => c.id === this.composer.state?.cardId)) this.composer.cancel();
		for (const c of cards) this.app.artefacts.del(c.id, 'user');
		this.app.artefacts.del(id, 'user');
		if (etaitCourant) await this.setCurrent(null);
		this.changed();
		annulable(`Paquet « ${deck.name} » supprimé`, () => {
			const nouveau = this.app.artefacts.set(null, { type: DECK, scope: SCOPE, state: deck }, 'user');
			for (const c of cards) this.app.artefacts.set(null, { type: CARD, scope: SCOPE, state: { ...c.state, deck: nouveau } }, 'user');
			if (etaitCourant) void this.setCurrent(nouveau);
			this.changed();
		});
	}
}

/** Une question oui / non (non par défaut). */
export function demander(plugin: Plugin, question: string): Promise<boolean> {
	return new Promise((ok) => {
		let reponse = false;
		const modal = new Modal(plugin.app).setTitle('Quick Anki').setContent(question);
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText('Non').setCta().onClick(() => modal.close()))
			.addButton((b) => b.setButtonText('Oui').setWarning().onClick(() => { reponse = true; modal.close(); }));
		const close = modal.onClose.bind(modal);
		modal.onClose = () => { close(); ok(reponse); };
		modal.open();
	});
}
