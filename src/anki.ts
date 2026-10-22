import { Notice, requestUrl } from 'fragment';
import { CARD, type Card, type Deck } from './main';
import type QuickAnki from './main';

// AnkiConnect (add-on 2055492159), Anki ouvert. requestUrl passe par le main : pas de CORS.
const URL = 'http://127.0.0.1:8765';
const INJOIGNABLE = 'Anki injoignable : ouvre Anki avec l’add-on AnkiConnect (2055492159). Les cartes restent dans le coffre.';

async function anki<T>(action: string, params: Record<string, unknown>): Promise<T> {
	let res;
	try {
		res = await requestUrl({ url: URL, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, version: 6, params }) });
	} catch {
		throw new Error(INJOIGNABLE);
	}
	const { result, error } = res.json as { result: T; error: string | null };
	if (error) throw new Error(`Anki : ${error}`);
	return result;
}

/** Envoie les cartes pas encore envoyées du paquet ; jamais une carte qui a un noteId. */
export async function sendDeck(plugin: QuickAnki, deckId: string): Promise<void> {
	const { artefacts } = plugin.app;
	const deck = await artefacts.state<Deck>(deckId);
	if (!deck) return;
	const cards = (await plugin.list<Card>(CARD)).filter((c) => c.state.deck === deckId && !c.state.noteId);
	try {
		await anki('createDeck', { deck: deck.name });
		for (const { id, state } of cards) {
			await anki('storeMediaFile', { filename: `qa-${id}-front.png`, data: state.front });
			await anki('storeMediaFile', { filename: `qa-${id}-back.png`, data: state.back });
		}
		const ids = await anki<(number | null)[]>('addNotes', { notes: cards.map(({ id }) => ({
			deckName: deck.name, modelName: 'Basic',
			fields: { Front: `<img src="qa-${id}-front.png">`, Back: `<img src="qa-${id}-back.png">` },
			options: { allowDuplicate: false }, tags: ['fragment', 'quick-anki'],
		})) });
		cards.forEach((c, i) => { if (ids[i]) artefacts.set(c.id, { state: { ...c.state, noteId: ids[i] } }, 'user'); });
		artefacts.set(deckId, { state: { ...deck, sentAt: Date.now() } }, 'user');
		if (plugin.currentDeck() === deckId) await plugin.setCurrent(null);
		new Notice(`${ids.filter(Boolean).length} carte(s) envoyée(s) dans « ${deck.name} ».`);
	} catch (e) {
		new Notice(e instanceof Error ? e.message : String(e));
	}
}
