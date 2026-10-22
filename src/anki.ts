import { Notice, requestUrl } from 'fragment';
import { cardImages, fullName, readDeck, status, type Card } from './model';
import type QuickAnki from './main';

// AnkiConnect (add-on 2055492159), Anki ouvert. requestUrl passe par le main : pas de CORS.
// L'adresse peut être changée (tests) par `localStorage['quick-anki:url']`.
const url = (): string => { try { return localStorage.getItem('quick-anki:url') ?? 'http://127.0.0.1:8765'; } catch { return 'http://127.0.0.1:8765'; } };
const INJOIGNABLE = 'Anki injoignable : ouvre Anki avec l’add-on AnkiConnect (2055492159). Les cartes restent dans le coffre.';

async function anki<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
	let res;
	try {
		res = await requestUrl({ url: url(), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, version: 6, params }) });
	} catch {
		throw new Error(INJOIGNABLE);
	}
	const { result, error } = res.json as { result: T; error: string | null };
	if (error) throw new Error(`Anki : ${error}`);
	return result;
}

/** Les paquets d'Anki (pour l'emplacement) ; `null` si Anki est injoignable. */
export async function deckNames(): Promise<string[] | null> {
	try { return await anki<string[]>('deckNames'); } catch { return null; }
}

export const deleteNotes = (notes: number[]): Promise<null> => anki('deleteNotes', { notes });

/**
 * Envoie les cartes nouvelles (addNotes) et modifiées (updateNoteFields) du paquet.
 * Idempotent : `noteId` / `syncedAt` sont écrits carte par carte, une panne au milieu se reprend.
 * Les images ont un nom VERSIONNÉ (`qa-<id>-<n>-recto.png`) : Anki ne garde pas l'ancienne.
 */
export async function sendDeck(plugin: QuickAnki, deckId: string): Promise<void> {
	const { artefacts } = plugin.app;
	const deck = readDeck(await artefacts.state(deckId));
	if (!deck) return;
	const name = fullName(deck);
	const todo = (await plugin.cards(deckId)).filter((c) => status(c.state) !== 'sent');
	let envoyees = 0;
	try {
		await anki('createDeck', { deck: name });
		for (const { id, state } of todo) {
			const n = state.updatedAt;
			const img = await cardImages(state);
			const fichiers = { recto: `qa-${id}-${n}-recto.png`, verso: `qa-${id}-${n}-verso.png` };
			await anki('storeMediaFile', { filename: fichiers.recto, data: img.recto });
			await anki('storeMediaFile', { filename: fichiers.verso, data: img.verso });
			const fields = { Front: `<img src="${fichiers.recto}">`, Back: `<img src="${fichiers.verso}">` };
			let noteId = state.noteId;
			if (noteId) await anki('updateNoteFields', { note: { id: noteId, fields } });
			else {
				const [nid] = await anki<(number | null)[]>('addNotes', { notes: [{
					deckName: name, modelName: 'Basic', fields, options: { allowDuplicate: true }, tags: ['fragment', 'quick-anki'],
				}] });
				if (!nid) throw new Error('Anki a refusé une carte.');
				noteId = nid;
			}
			const next: Card = { ...state, noteId, syncedAt: Date.now() };
			if (next.syncedAt! < next.updatedAt) next.syncedAt = next.updatedAt;
			artefacts.set(id, { state: next }, 'user');
			envoyees++;
		}
		artefacts.set(deckId, { state: { ...deck, sentAt: Date.now() } }, 'user');
		new Notice(`${envoyees} carte(s) envoyée(s) dans « ${name} ».`);
	} catch (e) {
		new Notice(`${envoyees ? `${envoyees} carte(s) envoyée(s). ` : ''}${e instanceof Error ? e.message : String(e)}`);
	}
	plugin.changed();
}
