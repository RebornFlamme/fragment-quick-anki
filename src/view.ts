import { ItemView, Modal, Setting, setIcon, type WorkspaceLeaf } from 'fragment';
import { sendDeck } from './anki';
import { CARD, DECK, SCOPE, type Card, type Deck } from './main';
import type QuickAnki from './main';

export const VIEW_TYPE = 'quick-anki';

/** Une vue, deux présentations : les stats du paquet courant (widget du document), les paquets (onglet). */
export class QuickAnkiView extends ItemView {
	private doc: string | null = null;
	private selected: string | null = null;
	private icons = ['layers', '0'];
	private rendu = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: QuickAnki) {
		super(leaf);
		this.icon = 'layers';
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return 'Quick Anki'; }
	getIcons(): string[] { return this.isWidget() ? this.icons : ['layers']; }
	docWidgetActions(): string[] { return ['tab', 'collapse']; }

	/** Hébergée dans un widget (feuille détachée), elle montre les stats ; en onglet, les paquets. */
	private isWidget(): boolean { return this.doc !== null || this.leaf.parent === null; }

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const placement = (state as { docWidget?: { file: string } } | null)?.docWidget;
		if (placement) { this.doc = placement.file; void this.render(); }
	}

	protected async onOpen(): Promise<void> {
		this.contentEl.classList.add('quick-anki-view');
		this.register(this.app.artefacts.subscribe({ scope: { collection: SCOPE.collection } }, () => void this.render()));
		this.registerEvent(this.app.workspace.on('quick-anki:draft', () => void this.render()));
		await this.render();
	}

	private async render(): Promise<void> {
		const n = ++this.rendu;
		const [decks, cards] = await Promise.all([this.plugin.list<Deck>(DECK), this.plugin.list<Card>(CARD)]);
		if (n !== this.rendu) return;
		const el = this.contentEl;
		el.replaceChildren();
		el.dataset.mode = this.isWidget() ? 'widget' : 'window';
		if (this.isWidget()) this.renderWidget(el, decks, cards);
		else this.renderWindow(el, decks, cards);
	}

	private renderWidget(el: HTMLElement, decks: { id: string; state: Deck }[], cards: { id: string; state: Card }[]): void {
		const current = this.plugin.currentDeck();
		const deck = decks.find((d) => d.id === current);
		const mine = cards.filter((c) => c.state.deck === current);
		const pending = mine.filter((c) => !c.state.noteId).length;
		line(el, 'qa-title', deck?.state.name ?? 'Nouveau paquet');
		line(el, 'qa-stat', `${mine.length} carte(s) · ${pending} à envoyer · ${mine.length - pending} envoyée(s)`);
		line(el, 'qa-stat', `${mine.filter((c) => c.state.doc === this.doc).length} de ce document`);
		const d = [...this.plugin.drafts.values()].find((x) => x.session.doc === this.doc)?.draft;
		line(el, 'qa-stat qa-draft', `Brouillon : recto ${d?.recto ? '✓' : '—'} · verso ${d?.verso ? '✓' : '—'} · ${d?.caches.length ?? 0} cache(s)`);
		const send = el.appendChild(document.createElement('button'));
		send.className = 'setting-button mod-cta qa-send';
		send.textContent = 'Terminer → Anki';
		send.disabled = !pending || !current;
		send.onclick = () => current && void sendDeck(this.plugin, current);
		const icons = ['layers', String(mine.length)];
		if (icons.join() !== this.icons.join()) {
			this.icons = icons;
			this.leaf.updateHeader();
		}
	}

	private renderWindow(el: HTMLElement, decks: { id: string; state: Deck }[], cards: { id: string; state: Card }[]): void {
		const current = this.plugin.currentDeck();
		decks.sort((a, b) => b.state.createdAt - a.state.createdAt);
		if (!decks.some((d) => d.id === this.selected)) this.selected = current ?? decks[0]?.id ?? null;
		line(el, 'qa-heading', 'Paquets');
		if (!decks.length) line(el, 'qa-empty', 'Aucun paquet. Ctrl+Maj+K dans une note ou un PDF pour cadrer une carte.');
		for (const { id, state } of decks) {
			const row = el.appendChild(document.createElement('div'));
			row.className = 'qa-deck' + (id === this.selected ? ' is-selected' : '');
			row.onclick = () => { this.selected = id; void this.render(); };
			const name = row.appendChild(document.createElement('input'));
			name.className = 'qa-deck-name';
			name.value = state.name;
			name.onclick = (e) => e.stopPropagation();
			name.onchange = () => name.value.trim() && this.app.artefacts.set(id, { state: { ...state, name: name.value.trim() } }, 'user');
			const nb = cards.filter((c) => c.state.deck === id);
			const meta = id === current ? 'courant' : state.sentAt ? `envoyé le ${new Date(state.sentAt).toLocaleDateString()}` : '';
			line(row, 'qa-deck-meta', `${nb.length} carte(s)${meta ? ' · ' + meta : ''}`);
			if (id !== current && !state.sentAt) button(row, 'Rendre courant', () => void this.plugin.setCurrent(id));
			button(row, state.sentAt ? 'Renvoyer' : 'Envoyer', () => void sendDeck(this.plugin, id)).disabled = !nb.some((c) => !c.state.noteId);
			icon(row, 'trash-2', 'Supprimer le paquet', () => confirmer(this, `Supprimer « ${state.name} » et ses ${nb.length} carte(s) ?`, () => {
				for (const c of nb) this.app.artefacts.del(c.id, 'user');
				this.app.artefacts.del(id, 'user');
				if (id === current) void this.plugin.setCurrent(null);
			}));
		}
		const deck = decks.find((d) => d.id === this.selected);
		if (!deck) return;
		line(el, 'qa-heading', deck.state.name);
		const grid = el.appendChild(document.createElement('div'));
		grid.className = 'qa-cards';
		for (const { id, state } of cards.filter((c) => c.state.deck === deck.id)) {
			const card = grid.appendChild(document.createElement('div'));
			card.className = 'qa-card' + (state.noteId ? ' is-sent' : '');
			for (const png of [state.front, state.back]) card.appendChild(document.createElement('img')).src = `data:image/png;base64,${png}`;
			icon(card, 'trash-2', 'Supprimer la carte', () => this.app.artefacts.del(id, 'user'));
		}
	}
}

function line(parent: HTMLElement, cls: string, text: string): HTMLElement {
	const el = parent.appendChild(document.createElement('div'));
	el.className = cls;
	el.textContent = text;
	return el;
}

function button(parent: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
	const b = parent.appendChild(document.createElement('button'));
	b.className = 'setting-button';
	b.textContent = text;
	b.onclick = (e) => { e.stopPropagation(); onClick(); };
	return b;
}

function icon(parent: HTMLElement, name: string, label: string, onClick: () => void): void {
	const b = parent.appendChild(document.createElement('div'));
	b.className = 'clickable-icon qa-icon';
	b.setAttribute('aria-label', label);
	setIcon(b, name);
	b.onclick = (e) => { e.stopPropagation(); onClick(); };
}

function confirmer(view: ItemView, message: string, ok: () => void): void {
	const modal = new Modal(view.app).setTitle('Quick Anki').setContent(message);
	new Setting(modal.contentEl)
		.addButton((b) => b.setButtonText('Annuler').onClick(() => modal.close()))
		.addButton((b) => b.setButtonText('Supprimer').setWarning().onClick(() => { ok(); modal.close(); }));
	modal.open();
}
