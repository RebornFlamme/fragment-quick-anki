# Quick Anki for Fragment

Frame a zone of a note or a PDF — recto, verso, masks — and it becomes an Anki card.
Decks are stored in the vault (artefacts) and sent to Anki when you finish.

## Usage

| Key | Action |
| --- | --- |
| `Ctrl+Shift+K` | Start: shows the "Annotations — Quick Anki" layer, arms the recto tool, opens the deck widget |
| `r` / `v` / `c` | Recto / verso / mask (cache) rectangle |
| `Enter` | Save the card (front = recto with masks, back = verso, or the recto without masks) |
| `Backspace` | Discard the current draft |
| `Escape` | Disarm the tool |

After a recto is drawn, the verso tool is armed automatically. The first card creates a
deck named after the document. **Terminer → Anki** (widget) or **Envoyer** (the "Quick Anki"
tab: command *Quick Anki: Ouvrir les paquets* or the ribbon icon) sends the cards not yet sent.

**Prerequisite:** Anki open with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
add-on (code `2055492159`). If Anki is unreachable, the cards stay in the vault.

## Utilisation (FR)

`Ctrl+Maj+K` dans une note ou un PDF : le calque « Annotations — Quick Anki » s'affiche et le
recto est armé. `r` recto, `v` verso, `c` cache, `Entrée` valide la carte, `Retour arrière`
abandonne le brouillon. Le premier recto arme le verso. La première carte crée un paquet au nom
du document. « Terminer → Anki » envoie les cartes ; il faut Anki ouvert avec l'add-on
AnkiConnect (2055492159) — sinon les cartes restent dans le coffre.

## Build

```bash
npm install
npm run build   # tsc + esbuild → main.js
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.fragment/plugins/quick-anki/`.
