// ═══════════════════════════════════════════════════════════════════════════
//  e2e de Quick Anki — se lance DEPUIS le dépôt Fragment (son harnais Electron) :
//    copier ce fichier dans <Fragment>/app/e2e/, puis, dans <Fragment>/app :
//      npx playwright test e2e/quick-anki.spec.ts --workers=1
//  Variables : QUICK_ANKI_DIR (ce dépôt, défaut ../../fragment-quick-anki depuis app/),
//  QA_SHOTS (dossier des captures, défaut <ce dépôt>/e2e/screens).
//  Le plugin testé est le main.js / styles.css / manifest.json de ce dépôt (npm run build).
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { ARTICLE, lancerLecteur, type Harnais } from './readerHarness';

// ═══════════════════════════════════════════════════════════════════════════
//  Quick Anki (plugin COMMUNAUTAIRE, dépôt fragment-quick-anki) de bout en bout
//  dans le vrai Fragment : instance d'annotation par défaut ouverte D'ABORD, puis
//  Ctrl+Maj+K. Barres propres, cadres pleins qui restent, poignées de
//  redimensionnement (annulables), carte enregistrée, outils inertes ailleurs.
// ═══════════════════════════════════════════════════════════════════════════

const QA = process.env.QUICK_ANKI_DIR ?? path.resolve('..', '..', 'fragment-quick-anki');
const SHOTS = process.env.QA_SHOTS ?? path.join(QA, 'e2e', 'screens');
const NOTE = 'note.md';
const DEFAUT = '.annotation-toolbar[data-instance="annotation"]';
const BARRE_QA = '.annotation-toolbar[data-instance="annotation:quick-anki"]';
const OUTILS = ['Recto (r)', 'Verso (v)', 'Cache (c)'];

/** La session d'annotation de la note : celle du preset Quick Anki, ou celle par défaut (`null`). */
function session(page: Page, preset: string | null, code: string): Promise<any> {
    return page.evaluate(({ preset, code }) => {
        const app = (window as any).app;
        const s = [...app.plugins.plugins.get('annotation').views].find((x: any) => x.context.instance.preset === preset);
        return new Function('s', 'app', code)(s, app);
    }, { preset, code });
}
const outilQA = (page: Page) => session(page, 'quick-anki', 'return s.activeTool');
const geometrie = (page: Page, outil: string) => session(page, 'quick-anki', `
    return s.strokes().filter((t) => t.tool === '${outil}').map((t) => s.geometry(t));`);
const brouillon = (page: Page) => page.locator('.quick-anki-view .qa-draft').innerText();

/** Le rectangle écran de la colonne de texte de la note. */
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

test.describe.serial('Quick Anki', () => {
    test.setTimeout(120_000);
    let h: Harnais;
    let zone: { x: number; y: number; w: number; h: number };
    let rectoW = 0;

    test.beforeAll(async () => {
        test.setTimeout(120_000);
        h = await lancerLecteur({
            [NOTE]: ARTICLE,
            '.fragment/plugins/quick-anki/manifest.json': readFileSync(path.join(QA, 'manifest.json')),
            '.fragment/plugins/quick-anki/main.js': readFileSync(path.join(QA, 'main.js')),
            '.fragment/plugins/quick-anki/styles.css': readFileSync(path.join(QA, 'styles.css')),
            '.fragment/community-plugins.json': JSON.stringify(['quick-anki']),
        }, NOTE);
        await expect.poll(() => h.page.evaluate(() => (window as any).app.plugins.plugins.has('quick-anki')), { timeout: 20_000 }).toBe(true);
        await h.page.evaluate(() => {
            const v = (window as any).app.workspace.activeLeaf.view;
            if (v.isLayerActive('agent')) v.toggleLayer('agent');
            v.toggleLayer('annotation'); // l'instance PAR DÉFAUT d'abord
        });
        await expect(h.page.locator(DEFAUT)).toBeVisible();
        zone = await colonne(h.page);
        await h.page.mouse.click(zone.x + 20, zone.y + 10); // la note est la feuille active, focus dedans
        await h.page.keyboard.press('Control+Shift+K');
        await expect(h.page.locator(BARRE_QA)).toBeVisible();
        await expect(h.page.locator('.quick-anki-view')).toBeVisible();
    });
    test.afterAll(async () => { await h?.electronApp.close(); });

    test('1. deux barres ; la défaut sans outils Quick Anki ; la Quick Anki : 3 outils + Annuler/Rétablir', async () => {
        for (const l of OUTILS) await expect(h.page.locator(`${DEFAUT} .toolbar-item[aria-label="${l}"]`)).toBeHidden();
        const visibles = await h.page.locator(`${BARRE_QA} .toolbar-item`).evaluateAll((els) =>
            els.filter((e) => (e as HTMLElement).offsetParent !== null && getComputedStyle(e).display !== 'none')
                .map((e) => e.getAttribute('aria-label') ?? e.className));
        expect(visibles).toEqual([...OUTILS, 'Annuler', 'Rétablir']);
        // Un seul séparateur : outils | annuler / rétablir (ceux des sections cachées le sont aussi).
        expect(await h.page.locator(`${BARRE_QA} .toolbar-separator`).evaluateAll((els) =>
            els.filter((e) => getComputedStyle(e).display !== 'none').length)).toBe(1);
        expect(await outilQA(h.page)).toBe('qa-recto');
    });

    test('2. recto tracé : il RESTE, outil → verso, widget « recto ✓ »', async () => {
        await tirer(h.page, zone.x + 40, zone.y + zone.h * 0.35, 200, 80);
        const recto = h.page.locator('.annotation-stroke.mod-qa-recto');
        await expect(recto).toHaveCount(1);
        await h.page.waitForTimeout(1000);
        await expect(recto).toBeVisible();
        expect(await outilQA(h.page)).toBe('qa-verso');
        await expect.poll(() => brouillon(h.page)).toContain('recto ✓');
    });

    test('3. cache dans le recto (c), verso ailleurs (v) ; cadres PLEINS', async () => {
        await h.page.keyboard.press('c');
        expect(await outilQA(h.page)).toBe('qa-cache');
        await tirer(h.page, zone.x + 80, zone.y + zone.h * 0.35 + 20, 60, 30);
        await expect(h.page.locator('.annotation-stroke.mod-qa-cache')).toHaveCount(1);
        await h.page.keyboard.press('v');
        expect(await outilQA(h.page)).toBe('qa-verso');
        await tirer(h.page, zone.x + 40, zone.y + zone.h * 0.6, 220, 70);
        await expect(h.page.locator('.annotation-stroke.mod-qa-verso')).toHaveCount(1);
        await expect.poll(() => brouillon(h.page)).toMatch(/recto ✓ · verso ✓ · 1 cache/);
        const dash = await h.page.locator('.annotation-stroke.mod-qa-recto path').first()
            .evaluate((p) => getComputedStyle(p).strokeDasharray);
        expect(dash).toBe('none');
        await h.page.screenshot({ path: path.join(SHOTS, 'qa2-step3.png') });
    });

    test('4. poignées : 3 cadres ; tirer le coin se du recto l’agrandit ; Ctrl+Z le rend', async () => {
        await expect(h.page.locator('.qa-handles')).toHaveCount(3);
        const avant = (await geometrie(h.page, 'qa-recto'))[0];
        const poignee = h.page.locator('.qa-handles').filter({ has: h.page.locator('.qa-handle') })
            .and(h.page.locator('[style*="--qa-color: #086ddd"]')).locator('.qa-handle[data-h="se"]');
        await expect(poignee).toHaveCount(1);
        const b = (await poignee.boundingBox())!;
        await h.page.screenshot({ path: path.join(SHOTS, 'qa2-step4-before.png') });
        await tirer(h.page, b.x + b.width / 2, b.y + b.height / 2, 60, 30);
        await expect.poll(async () => (await geometrie(h.page, 'qa-recto'))[0].w).toBeGreaterThan(avant.w + 55);
        const apres = (await geometrie(h.page, 'qa-recto'))[0];
        expect(apres.x).toBeCloseTo(avant.x, 0);
        expect(apres.y).toBeCloseTo(avant.y, 0);
        expect(Math.abs(apres.w - avant.w - 60)).toBeLessThan(4);
        expect(Math.abs(apres.h - avant.h - 30)).toBeLessThan(4);
        // L'image du recto est reprise (la capture cache barres, poignées et widget) : après elle.
        await expect.poll(() => h.page.evaluate(() => document.body.classList.contains('qa-capturing'))).toBe(false);
        await h.page.waitForTimeout(300);
        await h.page.screenshot({ path: path.join(SHOTS, 'qa2-step4-after.png') });
        // Les poignées suivent le cadre agrandi.
        const pb = (await poignee.boundingBox())!;
        expect(Math.abs(pb.x - b.x - 60)).toBeLessThan(4);
        await h.page.keyboard.press('Control+z');
        await expect.poll(async () => Math.round((await geometrie(h.page, 'qa-recto'))[0].w)).toBe(Math.round(avant.w));
        await h.page.keyboard.press('Control+y');
        await expect.poll(async () => Math.round((await geometrie(h.page, 'qa-recto'))[0].w)).toBe(Math.round(apres.w));
        await h.page.keyboard.press('Control+z');
        await expect.poll(async () => Math.round((await geometrie(h.page, 'qa-recto'))[0].w)).toBe(Math.round(avant.w));
        rectoW = avant.w;
    });

    test('5. Entrée : une carte (PNG recto/verso), brouillon vidé, outil → recto', async () => {
        await h.page.keyboard.press('Enter');
        await expect.poll(() => h.page.evaluate(() => (window as any).app.artefacts.list({ type: 'quick-anki:card' }).length)).toBe(1);
        const carte = await h.page.evaluate(async () => {
            const app = (window as any).app;
            const st = await app.artefacts.state(app.artefacts.list({ type: 'quick-anki:card' })[0].id);
            const largeur = (b64: string) => new DataView(Uint8Array.from(atob(b64.slice(0, 64)), (c) => c.charCodeAt(0)).buffer).getUint32(16);
            return { front: st.front.slice(0, 8), back: st.back.slice(0, 8), n: st.strokes.length, doc: st.doc,
                frontW: largeur(st.front) / devicePixelRatio };
        });
        expect(carte).toMatchObject({ front: 'iVBORw0K', back: 'iVBORw0K', n: 3, doc: NOTE });
        // L'image du recto est celle de la taille ANNULÉE (pas l'agrandie : +60 px).
        expect(carte.frontW).toBeLessThan(rectoW);
        expect(carte.frontW).toBeGreaterThan(rectoW - 20);
        await expect.poll(() => brouillon(h.page)).toContain('recto — · verso — · 0 cache');
        expect(await outilQA(h.page)).toBe('qa-recto');
        expect(await h.page.evaluate(() => (window as any).app.workspace.activeLeaf.view.editor.getValue())).toBe(ARTICLE);
        await h.page.screenshot({ path: path.join(SHOTS, 'qa2-step5.png') });
    });

    test('6. un outil Quick Anki armé dans l’instance PAR DÉFAUT ne trace rien', async () => {
        const avant = await session(h.page, 'quick-anki', 'return s.strokes().length');
        const avantDefaut = await session(h.page, null, 'return s.strokes().length');
        expect(await session(h.page, null, `s.setTool('qa-recto'); return s.activeTool`)).toBe('qa-recto');
        await tirer(h.page, zone.x + 300, zone.y + zone.h * 0.8, 150, 60);
        await h.page.waitForTimeout(300);
        expect(await session(h.page, 'quick-anki', 'return s.strokes().length')).toBe(avant);
        expect(await session(h.page, null, 'return s.strokes().length')).toBe(avantDefaut);
        await expect(h.page.locator('.annotation-stroke.mod-qa-recto')).toHaveCount(1); // le recto de la carte, seul
        await session(h.page, null, 's.setTool(null)');
    });

    test('7. Retour arrière jette un brouillon neuf', async () => {
        await session(h.page, 'quick-anki', `s.setTool('qa-recto')`);
        const n = await h.page.locator('.annotation-stroke.mod-qa-recto').count();
        await tirer(h.page, zone.x + 300, zone.y + zone.h * 0.8, 180, 60);
        await expect(h.page.locator('.annotation-stroke.mod-qa-recto')).toHaveCount(n + 1);
        await expect.poll(() => brouillon(h.page)).toContain('recto ✓');
        await h.page.keyboard.press('Backspace');
        await expect(h.page.locator('.annotation-stroke.mod-qa-recto')).toHaveCount(n);
        await expect.poll(() => brouillon(h.page)).toContain('recto —');
        expect(await outilQA(h.page)).toBe('qa-recto');
        expect(await h.page.evaluate(() => (window as any).app.workspace.activeLeaf.view.editor.getValue())).toBe(ARTICLE);
        expect(await h.page.evaluate(() => (window as any).app.artefacts.list({ type: 'quick-anki:card' }).length)).toBe(1);
    });
});
