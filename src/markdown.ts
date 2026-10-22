import { Modal, Notice, defineRegistry, type App } from 'fragment';

// ═══════════════════════════════════════════════════════════════════════════
//  La fenêtre Markdown d'une face : la source à gauche, l'aperçu à droite, rendu
//  par le service `markdown:render@1` (le MÊME pipeline que les notes : maths,
//  listes, code…). Valider capture l'aperçu en PNG : c'est l'image envoyée.
// ═══════════════════════════════════════════════════════════════════════════

interface MarkdownMount { set(text: string): void; destroy(): void }
interface MarkdownRenderService { mount(el: HTMLElement, text: string, opts?: { sourcePath?: string }): MarkdownMount }
const markdownRender = defineRegistry<MarkdownRenderService>('markdown:render@1');

const deuxImages = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

class MarkdownFaceModal extends Modal {
	private mount: MarkdownMount | null = null;
	private textarea!: HTMLTextAreaElement;
	private page!: HTMLElement;
	private preview!: HTMLElement;
	result: { text: string; png: Uint8Array } | null = null;
	done: (r: { text: string; png: Uint8Array } | null) => void = () => {};

	constructor(app: App, title: string, private text: string, private sourcePath: string) {
		super(app);
		this.setTitle(title);
	}

	onOpen(): void {
		this.modalEl.classList.add('qa-md-modal');
		const grid = this.contentEl.appendChild(document.createElement('div'));
		grid.className = 'qa-md-grid';
		this.textarea = grid.appendChild(document.createElement('textarea'));
		this.textarea.className = 'qa-md-source';
		this.textarea.value = this.text;
		this.textarea.placeholder = 'Markdown : **gras**, $x^2$, listes, code…';
		this.preview = grid.appendChild(document.createElement('div'));
		this.preview.className = 'qa-md-preview';
		this.page = this.preview.appendChild(document.createElement('div'));
		this.page.className = 'qa-md-page';
		const service = this.app.registry.get(markdownRender).entries().at(-1)?.value;
		try {
			if (service) this.mount = service.mount(this.page, this.text, { sourcePath: this.sourcePath });
		} catch (e) {
			console.error('quick-anki : aperçu Markdown', e);
		}
		if (!this.mount) this.page.textContent = this.text;
		this.textarea.addEventListener('input', () => {
			if (this.mount) this.mount.set(this.textarea.value);
			else this.page.textContent = this.textarea.value;
		});
		this.textarea.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.valider(); }
		});
		const pied = this.contentEl.appendChild(document.createElement('div'));
		pied.className = 'modal-button-container qa-md-footer';
		const aide = pied.appendChild(document.createElement('span'));
		aide.className = 'qa-md-hint';
		aide.textContent = 'Ctrl+Entrée : valider · l’aperçu est l’image envoyée';
		const annuler = pied.appendChild(document.createElement('button'));
		annuler.textContent = 'Annuler';
		annuler.onclick = () => this.close();
		const ok = pied.appendChild(document.createElement('button'));
		ok.className = 'mod-cta qa-md-ok';
		ok.textContent = 'Valider';
		ok.onclick = () => void this.valider();
		window.setTimeout(() => this.textarea.focus(), 0);
	}

	/** L'aperçu devient une image : la partie visible de la page rendue. */
	private async valider(): Promise<void> {
		const text = this.textarea.value;
		if (!text.trim()) { new Notice('La face est vide.'); return; }
		this.preview.scrollTop = 0;
		if (this.page.offsetHeight > this.preview.clientHeight + 1) new Notice('Le rendu dépasse la hauteur visible : seule la partie visible est capturée.');
		this.modalEl.classList.add('qa-md-capturing');
		await deuxImages();
		const p = this.page.getBoundingClientRect(), v = this.preview.getBoundingClientRect();
		const rect = { x: p.left, y: p.top, width: p.width, height: Math.min(p.bottom, v.bottom) - p.top };
		try {
			const png = await this.app.windowHost.capture(rect);
			this.result = { text, png };
			this.close();
		} catch (e) {
			this.modalEl.classList.remove('qa-md-capturing');
			new Notice(`Capture impossible : ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose(): void {
		this.mount?.destroy();
		this.mount = null;
		this.done(this.result);
	}
}

/** Ouvre la fenêtre ; rend le texte et son image, ou `null` (annulé). */
export function editMarkdown(app: App, title: string, text: string, sourcePath = ''): Promise<{ text: string; png: Uint8Array } | null> {
	return new Promise((ok) => {
		const modal = new MarkdownFaceModal(app, title, text, sourcePath);
		modal.done = ok;
		modal.open();
	});
}
