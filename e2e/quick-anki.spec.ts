// ═══════════════════════════════════════════════════════════════════════════
//  e2e de Quick Anki — se lance DEPUIS le dépôt Fragment (son harnais Electron) :
//    copier ce fichier dans <Fragment>/app/e2e/, puis, dans <Fragment>/app :
//      npx playwright test e2e/quick-anki.spec.ts --workers=1
//  Variables : QUICK_ANKI_DIR (ce dépôt, défaut ../../fragment-quick-anki depuis app/),
//  QA_SHOTS (dossier des captures, défaut <ce dépôt>/e2e/screens).
//  Le plugin testé est le main.js / styles.css / manifest.json de ce dépôt (npm run build).
//  AnkiConnect est DOUBLÉ par un petit serveur HTTP local (localStorage `quick-anki:url`).
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { ARTICLE, lancerLecteur, type Harnais } from './readerHarness';

const QA = process.env.QUICK_ANKI_DIR ?? path.resolve('..', '..', 'fragment-quick-anki');
const SHOTS = process.env.QA_SHOTS ?? path.join(QA, 'e2e', 'screens');
const NOTE = 'note.md';
const AUTRE = 'autre.md';
const DEFAUT = '.annotation-toolbar[data-instance="annotation"]';
const BARRE_QA = '.annotation-toolbar[data-instance="annotation:quick-anki"]';
const OUTILS = ['Recto (r)', 'Verso (v)', 'Cache (c)'];
const W = '.quick-anki-view[data-mode="widget"]';

/** Le faux AnkiConnect : chaque requête est gardée. */
const requetes: { action: string; params: any }[] = [];
let noteIds = 1000;
const serveur = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		const { action, params } = JSON.parse(body);
		requetes.push({ action, params });
		const result = action === 'deckNames' ? ['Default', 'MATHS Prepa'] : action === 'addNotes' ? params.notes.map(() => ++noteIds)
			: action === 'storeMediaFile' ? params.filename : action === 'createDeck' ? 1 : null;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ result, error: null }));
	});
});

/** La session d'annotation de la vue ACTIVE : celle du preset Quick Anki, ou celle par défaut (`null`). */
function session(page: Page, preset: string | null, code: string): Promise<any> {
	return page.evaluate(({ preset, code }) => {
		const app = (window as any).app;
		const view = app.workspace.activeLeaf.view;
		const s = [...app.plugins.plugins.get('annotation').views].find((x: any) => x.context.instance.preset === preset && x.context.view === view);
		return new Function('s', 'app', code)(s, app);
	}, { preset, code });
}
const outilQA = (page: Page) => session(page, 'quick-anki', 'return s?.activeTool ?? null');
const geometrie = (page: Page, outil: string) => session(page, 'quick-anki', `
	return s.strokes().filter((t) => t.tool === '${outil}').map((t) => s.geometry(t));`);
/** Les cartes du coffre (états lus). */
const cartes = (page: Page): Promise<{ id: string; state: any }[]> => page.evaluate(async () => {
	const app = (window as any).app;
	const recs = app.artefacts.list({ type: 'quick-anki:card' });
	return Promise.all(recs.map(async (r: any) => ({ id: r.id, state: await app.artefacts.state(r.id) })));
});
const composeur = (page: Page) => page.evaluate(() => (window as any).app.plugins.plugins.get('quick-anki').composer.state);

/** Le rectangle écran VISIBLE de la colonne de texte de la note. */
const colonne = (page: Page) => page.evaluate(() => {
	const r = document.querySelector('.doc-editor .cm-content:not(.doc-widget .cm-content)')!.getBoundingClientRect();
	const s = (window as any).app.workspace.activeLeaf.view.contentEl.getBoundingClientRect();
	const top = Math.max(r.top, s.top), bottom = Math.min(r.bottom, s.bottom);
	return { x: r.left, y: top, w: r.width, h: bottom - top };
});

async function tirer(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx, y + dy, { steps: 8 });
	await page.mouse.up();
}
/** Écart (px) entre le bas du widget et le bas de la vue active : recalé, il vaut ~16. */
const basDuWidget = (page: Page) => page.evaluate(() => {
	const view = (window as any).app.workspace.activeLeaf.view;
	const w = [...view.contentEl.querySelectorAll('.doc-widget')].find((x: any) => x.querySelector('.quick-anki-view')) as HTMLElement;
	return Math.round(view.contentEl.getBoundingClientRect().bottom - w.getBoundingClientRect().bottom);
});
/** « Cartes (n) ▸ » : la liste par-dessus la carte en cours. */
async function liste(page: Page): Promise<void> {
	await page.locator(`${W} .qa-list-link`).click();
	await expect(page.locator(`${W}[data-state="deck"]`)).toBeVisible();
}
const enBoucle = (page: Page, n: number) => expect(page.locator(`${W}[data-state="composer"] .qa-title`)).toHaveText(`Carte ${n}`);
const capture = (page: Page, nom: string) => page.screenshot({ path: path.join(SHOTS, `${nom}.png`) });
const pasDeCapture = (page: Page) => expect.poll(() => page.evaluate(() => document.body.classList.contains('qa-capturing'))).toBe(false);

test.describe.serial('Quick Anki', () => {
	test.setTimeout(120_000);
	let h: Harnais;
	let zone: { x: number; y: number; w: number; h: number };
	/** Où tracer : à droite du widget (en bas à gauche de la vue). */
	const X = () => zone.x + 160;

	test.beforeAll(async () => {
		test.setTimeout(120_000);
		await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok));
		h = await lancerLecteur({
			[NOTE]: ARTICLE,
			[AUTRE]: ARTICLE.split('\n\n').reverse().join('\n\n'),
			'.fragment/plugins/quick-anki/manifest.json': readFileSync(path.join(QA, 'manifest.json')),
			'.fragment/plugins/quick-anki/main.js': readFileSync(path.join(QA, 'main.js')),
			'.fragment/plugins/quick-anki/styles.css': readFileSync(path.join(QA, 'styles.css')),
			'.fragment/community-plugins.json': JSON.stringify(['quick-anki']),
		}, NOTE);
		await expect.poll(() => h.page.evaluate(() => (window as any).app.plugins.plugins.has('quick-anki')), { timeout: 20_000 }).toBe(true);
		const port = (serveur.address() as AddressInfo).port;
		await h.page.evaluate((port) => {
			localStorage.setItem('quick-anki:url', `http://127.0.0.1:${port}`);
			const v = (window as any).app.workspace.activeLeaf.view;
			if (v.isLayerActive('agent')) v.toggleLayer('agent');
			v.toggleLayer('annotation'); // l'instance PAR DÉFAUT d'abord
		}, port);
		await expect(h.page.locator(DEFAUT)).toBeVisible();
		zone = await colonne(h.page);
	});
	test.afterAll(async () => { await h?.electronApp.close(); serveur.close(); });

	test('1. bouton d’en-tête → état A (nom du document, paquets d’Anki) → paquet créé avec son parent', async () => {
		const bouton = h.page.locator('.workspace-leaf.mod-active .view-header .qa-header-action');
		await expect(bouton).toBeVisible();
		await bouton.click();
		await expect(h.page.locator(`${W}[data-state="new-deck"]`)).toBeVisible();
		await expect(h.page.locator('.qa-deck-name-input')).toHaveValue('note');
		await expect(h.page.locator(`${W} datalist option`)).toHaveCount(2);
		await h.page.locator('.qa-deck-parent-input').fill('MATHS Prepa');
		await capture(h.page, 'qa3-A');
		await h.page.locator('.qa-create-deck').click();
		// La BOUCLE par défaut : une carte neuve, recto armé.
		await enBoucle(h.page, 1);
		await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		await expect.poll(() => basDuWidget(h.page)).toBeGreaterThanOrEqual(10);
		await capture(h.page, 'qa4-default');
		await liste(h.page);
		await expect(h.page.locator(`${W} .qa-path`)).toHaveText('MATHS Prepa::note');
		await h.page.locator(`${W} .qa-back-card`).click();
		await enBoucle(h.page, 1);
	});

	test('2. carte : recto ZONE + 2 caches, verso MARKDOWN (aperçu capturé) ; barres propres', async () => {
		await expect(h.page.locator(`${W}[data-state="composer"]`)).toBeVisible();
		await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		// La barre par défaut sans outils Quick Anki ; la sienne : 3 outils + annuler / rétablir.
		for (const l of OUTILS) await expect(h.page.locator(`${DEFAUT} .toolbar-item[aria-label="${l}"]`)).toBeHidden();
		const visibles = await h.page.locator(`${BARRE_QA} .toolbar-item`).evaluateAll((els) =>
			els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('aria-label')));
		expect(visibles).toEqual([...OUTILS, 'Annuler', 'Rétablir']);

		const y0 = zone.y + zone.h * 0.3;
		await tirer(h.page, X(), y0, 240, 100);
		await expect(h.page.locator(`${W} .qa-face.is-recto .qa-thumb img`)).toBeVisible();
		await expect.poll(() => outilQA(h.page)).toBe('qa-verso');
		await h.page.keyboard.press('c');
		await tirer(h.page, X() + 20, y0 + 15, 60, 25);
		await tirer(h.page, X() + 120, y0 + 50, 60, 25);
		await expect(h.page.locator(`${W} .qa-cache-count`)).toHaveText('2 cache(s)');
		await expect(h.page.locator(`${W} .qa-face.is-recto .qa-thumb-mask`)).toHaveCount(2);
		expect(await h.page.locator('.annotation-stroke.mod-qa-recto path').first().evaluate((p) => getComputedStyle(p).strokeDasharray)).toBe('none');
		await expect(h.page.locator('.qa-handles')).toHaveCount(3);

		await h.page.locator(`${W} .qa-face.is-verso .qa-text`).click();
		const modal = h.page.locator('.qa-md-modal');
		await expect(modal).toBeVisible();
		await expect(modal.locator('.modal-title')).toHaveText('Carte 1 — Verso');
		await modal.locator('.qa-md-source').fill('**Théorème** : pour tout réel $x$, $x^2 \\ge 0$.\n\n- une liste\n- de points');
		await expect(modal.locator('.qa-md-page')).toContainText('Théorème');
		await expect(modal.locator('.qa-md-page mjx-container, .qa-md-page .math').first()).toBeVisible();
		await capture(h.page, 'qa3-markdown');
		await modal.locator('.qa-md-ok').click();
		await expect(modal).toHaveCount(0);
		// Verso posé sur une carte neuve : elle s'enregistre SEULE, la suivante commence.
		await expect(h.page.locator('.notice', { hasText: 'Carte 1 enregistrée' })).toBeVisible();
		await enBoucle(h.page, 2);
		await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		const [c] = await cartes(h.page);
		expect(c.state.recto.kind).toBe('zone');
		expect(c.state.recto.masks).toHaveLength(2);
		expect(c.state.verso).toMatchObject({ kind: 'markdown', text: expect.stringContaining('Théorème') });
		expect(c.state.verso.png.slice(0, 8)).toBe('iVBORw0K');
		expect(await composeur(h.page)).toMatchObject({ cardId: null, recto: null, verso: null });
		await liste(h.page);
		await expect(h.page.locator(`${W} .qa-row`)).toHaveCount(1);
		await capture(h.page, 'qa3-B');
	});

	test('3. refaire JUSTE le recto : le verso reste, l’ancien cadre et ses caches partent', async () => {
		const [avant] = await cartes(h.page);
		await h.page.locator(`${W} .qa-row`).first().click();
		await expect(h.page.locator(`${W}[data-state="composer"]`)).toBeVisible();
		await expect(h.page.locator(`${W} .qa-title`)).toHaveText('Carte 1 · modification');
		await h.page.locator(`${W} .qa-face.is-recto .qa-redo`).click();
		await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		await tirer(h.page, X() + 40, zone.y + zone.h * 0.6, 200, 70);
		await expect(h.page.locator(`${W} .qa-face.is-recto .qa-thumb img`)).toBeVisible();
		await pasDeCapture(h.page);
		await h.page.locator(`${W} .qa-validate`).click();
		await enBoucle(h.page, 2);
		const [apres] = await cartes(h.page);
		expect(apres.id).toBe(avant.id);
		expect(apres.state.recto.stroke).not.toBe(avant.state.recto.stroke);
		expect(apres.state.recto.masks).toHaveLength(0);
		expect(apres.state.verso).toEqual(avant.state.verso);
		await expect(h.page.locator('.annotation-stroke.mod-qa-recto')).toHaveCount(1);
		await expect(h.page.locator('.annotation-stroke.mod-qa-cache')).toHaveCount(0);
	});

	test('4. Annuler (bouton, puis Échap) rend la carte d’origine intacte', async () => {
		const [avant] = await cartes(h.page);
		await liste(h.page);
		await h.page.locator(`${W} .qa-row`).first().click();
		await h.page.locator(`${W} .qa-face.is-recto .qa-remove`).click();
		await h.page.locator(`${W} .qa-face.is-verso .qa-remove`).click();
		await expect(h.page.locator(`${W} .qa-face.is-recto .qa-zone`)).toBeVisible();
		await h.page.locator(`${W} .qa-cancel`).click();
		await expect(h.page.locator(`${W}[data-state="deck"]`)).toBeVisible();
		expect((await cartes(h.page))[0]).toEqual(avant);
		// Échap, outil armé, après un nouveau cadre : le cadre part, la carte reste.
		await h.page.locator(`${W} .qa-row`).first().click();
		await h.page.locator(`${W} .qa-face.is-recto .qa-redo`).click();
		await tirer(h.page, X() + 40, zone.y + zone.h * 0.75, 160, 50);
		await expect(h.page.locator('.annotation-stroke.mod-qa-recto')).toHaveCount(2);
		await pasDeCapture(h.page);
		await h.page.keyboard.press('Escape');
		await expect(h.page.locator(`${W}[data-state="deck"]`)).toBeVisible();
		await expect(h.page.locator('.annotation-stroke.mod-qa-recto')).toHaveCount(1);
		expect((await cartes(h.page))[0]).toEqual(avant);
	});

	test('5. Supprimer puis « Annuler » dans la Notice : la carte revient', async () => {
		const [avant] = await cartes(h.page);
		await h.page.locator(`${W} .qa-row`).first().click();
		await h.page.locator(`${W} .qa-delete`).click();
		await expect(h.page.locator(`${W} .qa-row`)).toHaveCount(0);
		expect(await cartes(h.page)).toHaveLength(0);
		await h.page.locator('.notice', { hasText: 'Carte supprimée' }).locator('.qa-undo').click();
		await expect(h.page.locator(`${W} .qa-row`)).toHaveCount(1);
		const [rendue] = await cartes(h.page);
		expect(rendue.state).toEqual(avant.state);
	});

	test('6. même widget sur un 2e document ; recalé en bas à gauche quand la fenêtre change de taille', async () => {
		await h.page.evaluate(async (p) => {
			const app = (window as any).app;
			await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p), { active: true });
		}, AUTRE);
		await h.page.locator('.workspace-leaf.mod-active .view-header .qa-header-action').click();
		await enBoucle(h.page, 2);
		await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		await expect(h.page.locator(`${W} .qa-list-link`)).toHaveText('Cartes (1) ▸');
		await liste(h.page);
		await expect(h.page.locator(`${W} .qa-path`)).toHaveText('MATHS Prepa::note');
		await expect(h.page.locator(`${W} .qa-row`)).toHaveCount(1);
		const ecart = () => h.page.evaluate(() => {
			const view = (window as any).app.workspace.activeLeaf.view;
			const w = [...view.contentEl.querySelectorAll('.doc-widget')].find((x: any) => x.querySelector('.quick-anki-view')) as HTMLElement;
			const a = w.getBoundingClientRect(), b = view.contentEl.getBoundingClientRect();
			return { bas: Math.round(b.bottom - a.bottom), gauche: Math.round(a.left - b.left) };
		});
		await expect.poll(async () => (await ecart()).bas).toBeLessThan(24);
		await h.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1400, 700)));
		await expect.poll(async () => { const e = await ecart(); return e.bas >= 10 && e.bas <= 24 && e.gauche < 30; }, { timeout: 5000 }).toBe(true);
		await h.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1400, 900)));
		await expect.poll(async () => { const e = await ecart(); return e.bas >= 10 && e.bas <= 24; }, { timeout: 5000 }).toBe(true);
		zone = await colonne(h.page);
	});

	test('7. faux AnkiConnect : createDeck avec parent, addNotes ; carte refaite → ✎ → updateNoteFields', async () => {
		requetes.length = 0;
		await h.page.locator(`${W} .qa-send`).click();
		await expect(h.page.locator(`${W} .qa-row-status.is-sent`)).toHaveCount(1);
		expect(requetes.find((r) => r.action === 'createDeck')?.params.deck).toBe('MATHS Prepa::note');
		const add = requetes.find((r) => r.action === 'addNotes')!;
		expect(add.params.notes[0]).toMatchObject({ deckName: 'MATHS Prepa::note', modelName: 'Basic' });
		expect(requetes.filter((r) => r.action === 'storeMediaFile')).toHaveLength(2);
		const [envoyee] = await cartes(h.page);
		expect(envoyee.state.noteId).toBe(noteIds);
		const premier = requetes.find((r) => r.action === 'storeMediaFile')!.params.filename;

		// Refaire le verso : il redevient « le recto sans caches » → la carte est ✎.
		await h.page.locator(`${W} .qa-row`).first().click();
		await h.page.locator(`${W} .qa-face.is-verso .qa-remove`).click();
		await h.page.locator(`${W} .qa-validate`).click();
		await enBoucle(h.page, 2);
		await liste(h.page);
		await expect(h.page.locator(`${W} .qa-row-status.is-modified`)).toHaveCount(1);
		requetes.length = 0;
		await h.page.locator(`${W} .qa-send`).click();
		await expect(h.page.locator(`${W} .qa-row-status.is-sent`)).toHaveCount(1);
		const upd = requetes.find((r) => r.action === 'updateNoteFields')!;
		expect(upd.params.note.id).toBe(envoyee.state.noteId);
		expect(requetes.some((r) => r.action === 'addNotes')).toBe(false);
		const second = requetes.find((r) => r.action === 'storeMediaFile')!.params.filename;
		expect(second).toMatch(/^qa-.+-\d+-recto\.png$/);
		expect(second).not.toBe(premier);
	});

	test('8. le brouillon survit au rechargement du plugin', async () => {
		await h.page.locator(`${W} .qa-back-card`).click();
		await h.page.locator(`${W} .qa-face.is-recto .qa-text`).click();
		const modal = h.page.locator('.qa-md-modal');
		await modal.locator('.qa-md-source').fill('Brouillon **persistant**');
		await modal.locator('.qa-md-ok').click();
		await expect(h.page.locator(`${W} .qa-face.is-recto .qa-thumb img`)).toBeVisible();
		await h.page.evaluate(() => (window as any).app.plugins.reloadPlugin('quick-anki'));
		await expect(h.page.locator(`${W}[data-state="composer"] .qa-face.is-recto .qa-thumb img`)).toBeVisible({ timeout: 15_000 });
		expect((await composeur(h.page))?.recto).toMatchObject({ kind: 'markdown', text: 'Brouillon **persistant**' });
		await h.page.locator(`${W} .qa-cancel`).click();
		await expect(h.page.locator(`${W}[data-state="deck"]`)).toBeVisible();
		expect(await h.page.evaluate(() => (window as any).app.artefacts.list({ type: 'quick-anki:draft' }).length)).toBe(0);
		expect(await cartes(h.page)).toHaveLength(1);
	});

	test('9. un outil Quick Anki armé dans l’instance PAR DÉFAUT ne trace rien', async () => {
		const avant = await session(h.page, null, 'return s ? s.strokes().length : -1');
		if (avant < 0) await h.page.evaluate(() => (window as any).app.workspace.activeLeaf.view.toggleLayer('annotation'));
		const n = await session(h.page, null, 'return s.strokes().length');
		expect(await session(h.page, null, `s.setTool('qa-recto'); return s.activeTool`)).toBe('qa-recto');
		await tirer(h.page, X() + 100, zone.y + zone.h * 0.5, 150, 60);
		await h.page.waitForTimeout(300);
		expect(await session(h.page, null, 'return s.strokes().length')).toBe(n);
		await session(h.page, null, 's.setTool(null)');
	});

	test('10. la BOUCLE : recto, verso ×3 à la souris seule → 3 cartes dans l’ordre, recto armé après chacune', async () => {
		await h.page.locator(`${W} .qa-new-card`).click();
		await enBoucle(h.page, 2);
		await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		const avant = (await cartes(h.page)).length;
		for (let i = 0; i < 3; i++) {
			const y = zone.y + zone.h * (0.15 + i * 0.25);
			await tirer(h.page, X(), y, 180, 50);
			await expect.poll(() => outilQA(h.page)).toBe('qa-verso');
			await tirer(h.page, X() + 220, y, 160, 50);
			await expect.poll(async () => (await cartes(h.page)).length).toBe(avant + i + 1);
			await enBoucle(h.page, avant + i + 2);
			await expect.poll(() => outilQA(h.page)).toBe('qa-recto');
		}
		await pasDeCapture(h.page);
		await expect.poll(() => basDuWidget(h.page)).toBeGreaterThanOrEqual(10);
		await capture(h.page, 'qa4-loop');
		const toutes = (await cartes(h.page)).sort((a, b) => a.state.createdAt - b.state.createdAt).slice(avant);
		expect(toutes.map((c) => [c.state.recto.kind, c.state.verso.kind])).toEqual([['zone', 'zone'], ['zone', 'zone'], ['zone', 'zone']]);
		const ys = toutes.map((c) => c.state.recto.box.y);
		expect([...ys].sort((a, b) => a - b)).toEqual(ys);
	});

	test('11. « Annuler » de la Notice : la carte enregistrée seule redevient le brouillon, cadres compris', async () => {
		const avant = (await cartes(h.page)).sort((a, b) => a.state.createdAt - b.state.createdAt);
		const derniere = avant.at(-1)!;
		await h.page.locator('.notice', { hasText: `Carte ${avant.length} enregistrée` }).locator('.qa-undo').click();
		await expect.poll(async () => (await cartes(h.page)).length).toBe(avant.length - 1);
		await expect(h.page.locator(`${W}[data-state="composer"] .qa-title`)).toHaveText(`Carte ${avant.length}`);
		expect(await composeur(h.page)).toMatchObject({ cardId: null, recto: { stroke: derniere.state.recto.stroke }, verso: { stroke: derniere.state.verso.stroke } });
		const traits = await h.page.locator('.annotation-stroke.mod-qa-verso').count();
		// Refaire juste le verso puis le retracer : la carte se réenregistre.
		await h.page.locator(`${W} .qa-face.is-verso .qa-redo`).click();
		await expect.poll(() => outilQA(h.page)).toBe('qa-verso');
		await expect(h.page.locator('.annotation-stroke.mod-qa-verso')).toHaveCount(traits - 1);
		await tirer(h.page, X() + 220, zone.y + zone.h * 0.62, 120, 40);
		await expect.poll(async () => (await cartes(h.page)).length).toBe(avant.length);
		await enBoucle(h.page, avant.length + 1);
	});
});
