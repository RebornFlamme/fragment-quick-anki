import { ItemView, Menu, Modal, Notice, setIcon, type WorkspaceLeaf } from 'fragment';
import { deckNames, sendDeck } from './anki';
import { editMarkdown } from './markdown';
import { fullName, masksOf, status, toBase64, type Card, type Deck, type Face, type Status } from './model';
import type { Side } from './tools';
import type QuickAnki from './main';

export const VIEW_TYPE = 'quick-anki';

const ETATS: Record<Status, [string, string]> = { new: ['●', 'À envoyer'], sent: ['✓', 'Envoyée'], modified: ['✎', 'Modifiée depuis l’envoi'] };
const NOMS: Record<Side, string> = { recto: 'Recto', verso: 'Verso' };

/**
 * Une vue, deux présentations. Dans un widget (en bas à gauche d'un document) :
 * A. pas de paquet → le créer ; B. le paquet courant et ses cartes ; C. la carte
 * en cours. En onglet : tous les paquets et leurs cartes.
 */
export class QuickAnkiView extends ItemView {
	private doc: string | null = null;
	private selected: string | null = null;
	private icons = ['layers', '0'];
	private rendu = 0;
	/** Les saisies de l'état A, gardées d'un rendu à l'autre. */
	private form: { name: string; parent: string } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: QuickAnki) {
		super(leaf);
		this.icon = 'layers';
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return 'Quick Anki'; }
	getIcons(): string[] { return this.isWidget() ? this.icons : ['layers']; }
	docWidgetActions(): string[] { return ['tab', 'collapse']; }

	/** Hébergée dans un widget (feuille détachée), elle montre le paquet courant ; en onglet, les paquets. */
	private isWidget(): boolean { return this.doc !== null || this.leaf.parent === null; }

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const placement = (state as { docWidget?: { file: string } } | null)?.docWidget;
		if (placement) { this.doc = placement.file; void this.render(); }
	}

	protected async onOpen(): Promise<void> {
		this.contentEl.classList.add('quick-anki-view');
		this.registerEvent(this.app.workspace.on('quick-anki:changed', () => void this.render()));
		// Sa hauteur change d'un état à l'autre : le widget se recale en bas.
		const ro = new ResizeObserver(() => this.plugin.repinSoon());
		ro.observe(this.contentEl);
		this.register(() => ro.disconnect());
		await this.render();
	}

	private async render(): Promise<void> {
		const n = ++this.rendu;
		const [decks, cards] = await Promise.all([this.plugin.decks(), this.plugin.cards()]);
		if (n !== this.rendu) return;
		const el = this.contentEl;
		el.replaceChildren();
		if (this.isWidget()) {
			const current = decks.find((d) => d.id === this.plugin.currentDeck());
			const mine = current ? cards.filter((c) => c.state.deck === current.id) : [];
			const s = this.plugin.composer.state;
			el.dataset.mode = 'widget';
			if (!current && !s?.cardId) this.renderNewDeck(el, decks);
			else if (s) this.renderComposer(el, mine, cards);
			else this.renderDeck(el, current!, mine);
			this.setIcons(['layers', String(mine.length)]);
		} else {
			el.dataset.mode = 'window';
			this.renderWindow(el, decks, cards);
		}
	}

	private setIcons(icons: string[]): void {
		if (icons.join() === this.icons.join()) return;
		this.icons = icons;
		this.leaf.updateHeader();
	}

	// ── A. Pas de paquet ───────────────────────────────────────────────────

	private renderNewDeck(el: HTMLElement, decks: { id: string; state: Deck }[]): void {
		el.dataset.state = 'new-deck';
		const docName = (this.doc?.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
		// Le nom du document tant que l'utilisateur n'a rien saisi (le document arrive après le 1er rendu).
		const form = this.form ?? { name: docName, parent: '' };
		line(el, 'qa-title', 'Nouveau paquet');
		const nom = field(el, 'Nom', form.name, 'Nom du paquet');
		nom.classList.add('qa-deck-name-input');
		nom.oninput = () => { form.name = nom.value; this.form = form; };
		const dans = field(el, 'Dans', form.parent, 'Paquet parent (vide : à la racine)');
		dans.classList.add('qa-deck-parent-input');
		dans.oninput = () => { form.parent = dans.value; this.form = form; };
		const liste = el.appendChild(document.createElement('datalist'));
		liste.id = `qa-decks-${this.leaf.id}`;
		dans.setAttribute('list', liste.id);
		const note = line(el, 'qa-hint', 'Les paquets d’Anki…');
		void deckNames().then((noms) => {
			if (noms) for (const n of noms) liste.appendChild(document.createElement('option')).value = n;
			note.textContent = noms ? `${noms.length} paquet(s) dans Anki : choisis l’emplacement ou écris-le.` : 'Anki fermé : écris l’emplacement (ex. MATHS Prepa::Analyse).';
		});
		const creer = button(el, 'Créer le paquet', async () => {
			const name = form.name.trim();
			if (!name) { new Notice('Donne un nom au paquet.'); return; }
			this.form = null;
			await this.plugin.createDeck(name, form.parent.trim().replace(/::$/, ''));
		}, 'mod-cta qa-create-deck');
		for (const input of [nom, dans]) input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); creer.click(); } };
		const autres = decks.filter((d) => !d.state.sentAt);
		if (autres.length) {
			line(el, 'qa-hint', 'ou reprendre :');
			for (const d of autres.slice(0, 5)) {
				const b = button(el, fullName(d.state), () => void this.plugin.setCurrent(d.id), 'qa-link qa-resume');
				b.title = 'Reprendre ce paquet';
			}
		}
	}

	// ── B. Le paquet courant ───────────────────────────────────────────────

	private renderDeck(el: HTMLElement, deck: { id: string; state: Deck }, cards: { id: string; state: Card }[]): void {
		el.dataset.state = 'deck';
		const head = el.appendChild(document.createElement('div'));
		head.className = 'qa-head';
		line(head, 'qa-title', deck.state.name);
		icon(head, 'chevron-down', 'Paquet…', (evt) => this.deckMenu(evt, deck));
		line(el, 'qa-path', fullName(deck.state));
		const aEnvoyer = cards.filter((c) => status(c.state) !== 'sent').length;
		line(el, 'qa-stat', `${cards.length} carte(s) · ${aEnvoyer} à envoyer`);
		const list = el.appendChild(document.createElement('div'));
		list.className = 'qa-rows';
		cards.forEach((c, i) => {
			const row = list.appendChild(document.createElement('div'));
			row.className = 'qa-row';
			row.dataset.card = c.id;
			row.onclick = () => void this.plugin.composer.start(c.id);
			line(row, 'qa-row-n', String(i + 1));
			row.appendChild(thumb(c.state.recto));
			row.appendChild(thumb(c.state.verso));
			const [glyph, label] = ETATS[status(c.state)];
			const st = line(row, `qa-row-status is-${status(c.state)}`, glyph);
			st.title = label;
		});
		const actions = el.appendChild(document.createElement('div'));
		actions.className = 'qa-actions';
		button(actions, '+ Nouvelle carte', async () => {
			await this.plugin.composer.start(null);
			if (this.doc) this.plugin.arm(this.doc, 'qa-recto');
		}, 'qa-new-card');
		button(actions, `Envoyer à Anki (${aEnvoyer})`, () => void sendDeck(this.plugin, deck.id), 'mod-cta qa-send').disabled = !aEnvoyer;
	}

	private deckMenu(evt: MouseEvent, deck: { id: string; state: Deck }): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Renommer').setIcon('pencil').onClick(async () => {
			const name = await demanderTexte(this.app, 'Renommer le paquet', deck.state.name);
			if (name?.trim()) await this.plugin.updateDeck(deck.id, { name: name.trim() });
		}));
		menu.addItem((i) => i.setTitle('Changer l’emplacement').setIcon('folder-tree').onClick(async () => {
			const parent = await demanderTexte(this.app, 'Paquet parent dans Anki', deck.state.parent, (await deckNames()) ?? []);
			if (parent !== null) await this.plugin.updateDeck(deck.id, { parent: parent.trim().replace(/::$/, '') });
		}));
		menu.addSeparator();
		void this.plugin.decks().then((decks) => {
			for (const d of decks.filter((x) => x.id !== deck.id)) {
				menu.addItem((i) => i.setTitle(`Passer à « ${d.state.name} »`).setIcon('arrow-right-left').onClick(() => void this.plugin.setCurrent(d.id)));
			}
			menu.addItem((i) => i.setTitle('Nouveau paquet').setIcon('plus').onClick(() => void this.plugin.setCurrent(null)));
			menu.addItem((i) => i.setTitle('Ouvrir la fenêtre des paquets').setIcon('layers').onClick(() => void this.plugin.openWindow()));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle('Supprimer le paquet').setIcon('trash-2').setWarning(true).onClick(() => void this.plugin.deleteDeck(deck.id)));
			menu.showAtMouseEvent(evt);
		});
	}

	// ── C. La carte en cours ───────────────────────────────────────────────

	private renderComposer(el: HTMLElement, mine: { id: string; state: Card }[], all: { id: string; state: Card }[]): void {
		const s = this.plugin.composer.state!;
		el.dataset.state = 'composer';
		const index = s.cardId ? mine.findIndex((c) => c.id === s.cardId) : -1;
		const numero = index >= 0 ? index + 1 : s.cardId ? '' : mine.length + 1;
		line(el, 'qa-title', `Carte ${numero}${s.cardId ? ' · modification' : ''}`);
		for (const side of ['recto', 'verso'] as const) this.renderFace(el, side, s[side], numero);
		const actions = el.appendChild(document.createElement('div'));
		actions.className = 'qa-actions';
		button(actions, 'Valider ⏎', () => void this.plugin.composer.validate(), 'mod-cta qa-validate').disabled = !s.recto;
		button(actions, 'Annuler (Échap)', () => this.plugin.composer.cancel(), 'qa-cancel');
		if (!s.cardId) return;
		const card = all.find((c) => c.id === s.cardId);
		const plus = el.appendChild(document.createElement('div'));
		plus.className = 'qa-more';
		button(plus, 'Refaire toute la carte', () => this.plugin.composer.clearAll(), 'qa-link qa-redo-all');
		const zone = [card?.state.recto, card?.state.verso].find((f): f is Extract<Face, { kind: 'zone' }> => f?.kind === 'zone');
		if (zone) button(plus, 'Voir dans le document', () => void this.reveal(zone.doc, zone.stroke), 'qa-link qa-reveal');
		button(plus, 'Supprimer', () => void this.plugin.deleteCard(s.cardId!), 'qa-link mod-warning qa-delete');
	}

	private renderFace(el: HTMLElement, side: Side, face: Face | null, numero: number | string): void {
		const composer = this.plugin.composer;
		const box = el.appendChild(document.createElement('div'));
		box.className = `qa-face is-${side}`;
		box.dataset.side = side;
		const head = box.appendChild(document.createElement('div'));
		head.className = 'qa-face-head';
		line(head, 'qa-face-label', NOMS[side].toUpperCase());
		const zone = () => { if (this.doc) this.plugin.arm(this.doc, side === 'recto' ? 'qa-recto' : 'qa-verso'); };
		const texte = async (initial: string) => {
			const doc = face?.kind === 'zone' ? face.doc : this.doc ?? '';
			const r = await editMarkdown(this.app, `Carte ${numero} — ${NOMS[side]}`, initial, doc);
			if (r && composer.state) composer.setFace(side, { kind: 'markdown', text: r.text, png: toBase64(r.png) });
		};
		if (!face) {
			button(head, `Zone (${side[0]})`, zone, 'qa-zone');
			button(head, 'Texte', () => void texte(this.selection()), 'qa-text');
			if (side === 'verso') line(box, 'qa-hint', 'vide = le recto sans ses caches');
			return;
		}
		const redo = () => {
			composer.setFace(side, null);
			if (face.kind === 'markdown') void texte(face.text);
			else zone();
		};
		if (face.kind === 'markdown') icon(head, 'pencil', 'Modifier le texte', () => void texte(face.text)).classList.add('qa-edit');
		icon(head, 'rotate-ccw', `Refaire le ${side}`, redo).classList.add('qa-redo');
		icon(head, 'x', `Retirer le ${side}`, () => composer.setFace(side, null)).classList.add('qa-remove');
		box.appendChild(thumb(face, side === 'recto' ? this.cacheBoxes(face) : undefined));
		if (side === 'recto' && face.kind === 'zone') {
			const n = composer.state?.caches.length ?? 0;
			const row = box.appendChild(document.createElement('div'));
			row.className = 'qa-face-foot';
			button(row, '+ Cache (c)', () => { if (this.doc) this.plugin.arm(this.doc, 'qa-cache'); }, 'qa-link qa-add-cache');
			line(row, 'qa-hint qa-cache-count', `${n} cache(s)`);
		}
	}

	/** Les caches en cours, en fractions de la zone du recto (pour la miniature). */
	private cacheBoxes(face: Face): { x: number; y: number; w: number; h: number }[] {
		const s = this.plugin.composer.state;
		if (face.kind !== 'zone' || !s) return [];
		const r = face.box;
		return s.caches.map(({ box: c }) => ({ x: (c.x - r.x) / r.w, y: (c.y - r.y) / r.h, w: c.w / r.w, h: c.h / r.h }));
	}

	/** Le texte sélectionné dans la note hôte (préremplit une face Markdown). */
	private selection(): string {
		const view = this.doc ? this.plugin.viewOf(this.doc) : null;
		const editor = (view as unknown as { editor?: { getSelection?(): string } } | null)?.editor;
		// L'éditeur de Fragment rend une PLAGE ({from, to}) ; repli : la sélection du DOM.
		const sel = editor?.getSelection?.() as unknown as { from: number; to: number } | string | undefined;
		const value = (editor as { getValue?(): string } | undefined)?.getValue?.();
		if (sel && typeof sel === 'object' && typeof value === 'string' && sel.to > sel.from) return value.slice(sel.from, sel.to);
		return window.getSelection()?.toString() ?? '';
	}

	/** Ouvre le document à la zone (le cadre est montré par l'instance Quick Anki). */
	private async reveal(doc: string, strokeId: string): Promise<void> {
		const leaf = await this.app.workspace.openDocument(doc, false);
		const view = leaf.view;
		if (!(view instanceof ItemView)) return;
		if (!view.isLayerActive('annotation', 'quick-anki')) view.toggleLayer('annotation', 'quick-anki');
		for (let i = 0; i < 20; i++) {
			const d = [...this.plugin.drafts.values()].find((x) => x.session.context.view === view);
			const stroke = d?.session.strokes().find((t) => t.id === strokeId);
			if (stroke) { view.setEphemeralState({ passage: { from: stroke.pos, to: stroke.pos } }); return; }
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	// ── La fenêtre : tous les paquets ──────────────────────────────────────

	private renderWindow(el: HTMLElement, decks: { id: string; state: Deck }[], cards: { id: string; state: Card }[]): void {
		const current = this.plugin.currentDeck();
		if (!decks.some((d) => d.id === this.selected)) this.selected = current ?? decks[0]?.id ?? null;
		line(el, 'qa-heading', 'Paquets');
		if (!decks.length) line(el, 'qa-empty', 'Aucun paquet. Le bouton Quick Anki d’une note ou d’un PDF en crée un.');
		for (const { id, state } of decks) {
			const row = el.appendChild(document.createElement('div'));
			row.className = 'qa-deck' + (id === this.selected ? ' is-selected' : '');
			row.onclick = () => { this.selected = id; void this.render(); };
			const name = row.appendChild(document.createElement('input'));
			name.className = 'qa-deck-name';
			name.value = state.name;
			name.onclick = (e) => e.stopPropagation();
			name.onchange = () => name.value.trim() && void this.plugin.updateDeck(id, { name: name.value.trim() });
			const nb = cards.filter((c) => c.state.deck === id);
			const todo = nb.filter((c) => status(c.state) !== 'sent').length;
			line(row, 'qa-deck-meta', `${state.parent ? state.parent + ' · ' : ''}${nb.length} carte(s)${todo ? ` · ${todo} à envoyer` : ''}${id === current ? ' · courant' : ''}`);
			if (id !== current) button(row, 'Rendre courant', () => void this.plugin.setCurrent(id));
			button(row, 'Envoyer', () => void sendDeck(this.plugin, id)).disabled = !todo;
			icon(row, 'trash-2', 'Supprimer le paquet', () => void this.plugin.deleteDeck(id));
		}
		const deck = decks.find((d) => d.id === this.selected);
		if (!deck) return;
		line(el, 'qa-heading', fullName(deck.state));
		const grid = el.appendChild(document.createElement('div'));
		grid.className = 'qa-cards';
		for (const { id, state } of cards.filter((c) => c.state.deck === deck.id)) {
			const card = grid.appendChild(document.createElement('div'));
			card.className = `qa-card is-${status(state)}`;
			card.appendChild(thumb(state.recto));
			card.appendChild(thumb(state.verso));
			icon(card, 'trash-2', 'Supprimer la carte', () => void this.plugin.deleteCard(id));
		}
	}
}

// ── Petits gabarits DOM ────────────────────────────────────────────────────

function line(parent: HTMLElement, cls: string, text: string): HTMLElement {
	const el = parent.appendChild(document.createElement('div'));
	el.className = cls;
	el.textContent = text;
	return el;
}

function button(parent: HTMLElement, text: string, onClick: () => unknown, cls = ''): HTMLButtonElement {
	const b = parent.appendChild(document.createElement('button'));
	b.className = `qa-button ${cls}`.trim();
	b.textContent = text;
	b.onclick = (e) => { e.stopPropagation(); void onClick(); };
	return b;
}

function icon(parent: HTMLElement, name: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
	const b = parent.appendChild(document.createElement('div'));
	b.className = 'clickable-icon qa-icon';
	b.setAttribute('aria-label', label);
	setIcon(b, name);
	b.onclick = (e) => { e.stopPropagation(); onClick(e); };
	return b;
}

function field(parent: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
	const row = parent.appendChild(document.createElement('label'));
	row.className = 'qa-field';
	line(row, 'qa-field-label', label);
	const input = row.appendChild(document.createElement('input'));
	input.type = 'text';
	input.value = value;
	input.placeholder = placeholder;
	return input;
}

/** La miniature d'une face : son image, et ses caches par-dessus (aplats). */
function thumb(face: Face | null, caches?: { x: number; y: number; w: number; h: number }[]): HTMLElement {
	const el = document.createElement('div');
	el.className = `qa-thumb${face ? ` is-${face.kind}` : ' is-empty'}`;
	if (!face) { el.textContent = '—'; el.title = 'Verso : le recto sans ses caches'; return el; }
	if (face.png) el.appendChild(document.createElement('img')).src = `data:image/png;base64,${face.png}`;
	for (const m of caches ?? masksOf(face)) {
		const c = el.appendChild(document.createElement('div'));
		c.className = 'qa-thumb-mask';
		Object.assign(c.style, { left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` });
	}
	return el;
}

/** Une saisie d'une ligne dans une modale ; `null` si annulée. */
function demanderTexte(app: QuickAnkiView['app'], title: string, value: string, suggestions: string[] = []): Promise<string | null> {
	return new Promise((ok) => {
		let result: string | null = null;
		const modal = new Modal(app).setTitle(title);
		const input = modal.contentEl.appendChild(document.createElement('input'));
		input.type = 'text';
		input.className = 'qa-prompt';
		input.value = value;
		if (suggestions.length) {
			const list = modal.contentEl.appendChild(document.createElement('datalist'));
			list.id = 'qa-prompt-list';
			for (const s of suggestions) list.appendChild(document.createElement('option')).value = s;
			input.setAttribute('list', list.id);
		}
		const footer = modal.contentEl.appendChild(document.createElement('div'));
		footer.className = 'modal-button-container qa-prompt-footer';
		const valider = () => { result = input.value; modal.close(); };
		footer.appendChild(document.createElement('button')).textContent = 'Annuler';
		(footer.lastElementChild as HTMLButtonElement).onclick = () => modal.close();
		const okb = footer.appendChild(document.createElement('button'));
		okb.className = 'mod-cta';
		okb.textContent = 'Valider';
		okb.onclick = valider;
		input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); valider(); } };
		const close = modal.onClose.bind(modal);
		modal.onClose = () => { close(); ok(result); };
		modal.open();
		window.setTimeout(() => input.select(), 0);
	});
}
