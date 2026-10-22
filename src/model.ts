// ═══════════════════════════════════════════════════════════════════════════
//  Le modèle : paquets, cartes, faces. Tout est artefact du coffre (collection
//  `quick-anki`) ; les images sont en base64 (PNG) dans l'état.
// ═══════════════════════════════════════════════════════════════════════════

export const SCOPE = { kind: 'plugin', collection: 'quick-anki' } as const;
export const DECK = 'quick-anki:deck';
export const CARD = 'quick-anki:card';
export const DRAFT = 'quick-anki:draft';

export interface Box { x: number; y: number; w: number; h: number }

/** Une face : une ZONE d'un document, du MARKDOWN rendu, ou une image figée (cartes v1). */
export type Face =
	| { kind: 'zone'; doc: string; stroke: string; box: Box; png: string; masks: Box[]; maskStrokes: string[] }
	| { kind: 'markdown'; text: string; png: string }
	| { kind: 'image'; png: string };

export interface Deck { name: string; parent: string; createdAt: number; sentAt?: number }

export interface Card {
	deck: string;
	recto: Face;
	/** `null` : le verso est le recto sans ses caches (occlusion). */
	verso: Face | null;
	createdAt: number;
	updatedAt: number;
	noteId?: number;
	syncedAt?: number;
}

/** Le nom complet dans Anki : `parent::name`. */
export const fullName = (d: Deck): string => (d.parent ? `${d.parent}::${d.name}` : d.name);

export type Status = 'new' | 'sent' | 'modified';
export function status(c: Card): Status {
	if (!c.noteId) return 'new';
	return c.updatedAt > (c.syncedAt ?? 0) ? 'modified' : 'sent';
}

/** Une carte lue du journal : v2 telle quelle, v1 (`{front, back}`) en deux faces image figées. */
export function readCard(raw: unknown): Card | null {
	const r = raw as Partial<Card> & { front?: string; back?: string };
	if (!r || typeof r.deck !== 'string') return null;
	if (r.recto) return r as Card;
	if (typeof r.front !== 'string') return null;
	const at = r.createdAt ?? 0;
	return {
		deck: r.deck, recto: { kind: 'image', png: r.front }, verso: typeof r.back === 'string' ? { kind: 'image', png: r.back } : null,
		createdAt: at, updatedAt: at, noteId: r.noteId, syncedAt: r.noteId ? at : undefined,
	};
}

/** Un paquet lu du journal (v1 : sans `parent`). */
export function readDeck(raw: unknown): Deck | null {
	const r = raw as Partial<Deck>;
	return r && typeof r.name === 'string' ? { parent: '', createdAt: 0, ...r } as Deck : null;
}

export const masksOf = (f: Face | null): Box[] => (f?.kind === 'zone' ? f.masks : []);

export function toBase64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/** Le recto envoyé : l'image avec ses caches peints en aplats, à leur place proportionnelle. */
export async function paintMasks(png: string, masks: Box[], color = '#e0ac00'): Promise<string> {
	if (!masks.length) return png;
	const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
	const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
	const canvas = document.createElement('canvas');
	canvas.width = img.width;
	canvas.height = img.height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(img, 0, 0);
	ctx.fillStyle = color;
	for (const m of masks) ctx.fillRect(m.x * img.width, m.y * img.height, m.w * img.width, m.h * img.height);
	return canvas.toDataURL('image/png').split(',')[1];
}

/** Les deux images d'une carte telles qu'Anki les reçoit. */
export async function cardImages(c: Card): Promise<{ recto: string; verso: string }> {
	return { recto: await paintMasks(c.recto.png, masksOf(c.recto)), verso: (c.verso ?? c.recto).png };
}
