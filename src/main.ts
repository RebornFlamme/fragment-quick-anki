import {
	App,
	Editor,
	ItemView,
	Modal,
	Notice,
	Plugin,
	WorkspaceLeaf,
	setIcon,
} from "fragment";

/**
 * The shape of the data this plugin persists via `loadData()` / `saveData()`.
 *
 * Fragment 0.1.0 does not yet ship a `Setting` / `PluginSettingTab` UI (the type
 * contract marks it as "future"), so this sample demonstrates persistence only.
 * The values below are edited programmatically; a settings tab can be added once
 * the host exposes one.
 */
interface FragmentSampleSettings {
	greeting: string;
	clickCount: number;
}

const DEFAULT_SETTINGS: FragmentSampleSettings = {
	greeting: "Hello, Fragment!",
	clickCount: 0,
};

/** The view type id used to register and to look the sample view up again. */
const VIEW_TYPE_SAMPLE = "fragment-sample-view";

/**
 * A sample Fragment plugin.
 *
 * Every `registerX()` / `addX()` call below schedules its own teardown, so
 * `onunload()` stays empty: disabling the plugin replays the teardown stack in
 * reverse. That is the whole point of the `Component` base class — the author
 * never has to remember to clean up.
 */
export default class FragmentSamplePlugin extends Plugin {
	settings: FragmentSampleSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// 1) A ribbon icon. `addRibbonIcon` returns the live button element, so we
		//    can style it. The icon name is a Lucide id (see `setIcon`).
		// Icon names are Lucide ids. Note: it is "dices" (plural) in Lucide — a
		// bare "dice" does not exist and renders as an almost invisible dot.
		const ribbonEl = this.addRibbonIcon(
			"dices",
			"Fragment sample: say hello",
			async () => {
				this.settings.clickCount += 1;
				await this.saveSettings();
				new Notice(
					`${this.settings.greeting} (clicked ${this.settings.clickCount}×)`,
				);
			},
		);
		ribbonEl.classList.add("fragment-sample-ribbon");

		// 2) A simple command, available everywhere, that opens a modal.
		this.addCommand({
			id: "open-sample-modal",
			name: "Open sample modal",
			icon: "info",
			callback: () => new SampleModal(this.app, this.settings.greeting).open(),
		});

		// 3) An editor command. It is only offered when a text editor has focus,
		//    and receives that editor. Offsets are absolute document positions.
		this.addCommand({
			id: "wrap-selection-bold",
			name: "Wrap selection in **bold**",
			editorCallback: (editor: Editor) => {
				const { from, to } = editor.getSelection();
				const selected = editor.getRange(from, to) || "bold text";
				editor.replaceRange(from, to, `**${selected}**`);
			},
		});

		// 4) A conditional command using `checkCallback`: it hides itself from the
		//    palette when the view is already open. `checking === true` must be a
		//    cheap, side-effect-free availability test.
		this.addCommand({
			id: "open-sample-view",
			name: "Open sample view",
			checkCallback: (checking: boolean): boolean => {
				const alreadyOpen =
					this.app.workspace.getLeavesOfType(VIEW_TYPE_SAMPLE).length > 0;
				if (!alreadyOpen && !checking) {
					void this.activateView();
				}
				return !alreadyOpen;
			},
		});

		// 5) A custom view, registered by type. The factory runs lazily, the first
		//    time a leaf of this type is materialised (§8.4 deferred views).
		this.registerView(
			VIEW_TYPE_SAMPLE,
			(leaf) => new SampleView(leaf, this),
		);

		// 6) A global DOM event. Unregistered automatically on unload.
		this.registerDomEvent(document, "click", () => {
			console.debug("[fragment-sample] document click");
		});

		// 7) A repeating interval. Cleared automatically on unload.
		this.registerInterval(
			window.setInterval(
				() => console.debug("[fragment-sample] tick"),
				5 * 60 * 1000,
			),
		);
	}

	onunload(): void {
		// Intentionally empty — see the class comment. Fragment tears down every
		// registration for us. Detaching leaves here is optional and left out so
		// the teardown discipline stays visible.
	}

	/** Open the sample view, reusing an existing leaf of that type if present. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SAMPLE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_SAMPLE, active: true });
		}
		workspace.setActiveLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as
			| Partial<FragmentSampleSettings>
			| null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** A minimal modal that greets the user with the configured message. */
class SampleModal extends Modal {
	private readonly greeting: string;

	constructor(app: App, greeting: string) {
		super(app);
		this.greeting = greeting;
	}

	onOpen(): void {
		this.setTitle("Fragment sample");
		this.setContent(this.greeting);
	}

	onClose(): void {
		this.contentEl.replaceChildren();
	}
}

/**
 * A custom side view. `ItemView` gives us a `contentEl` to draw into; the base
 * class handles the header, the `⋯` menu and view lifecycle.
 */
class SampleView extends ItemView {
	private readonly plugin: FragmentSamplePlugin;

	constructor(leaf: WorkspaceLeaf, plugin: FragmentSamplePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.icon = "dices";
	}

	getViewType(): string {
		return VIEW_TYPE_SAMPLE;
	}

	getDisplayText(): string {
		return "Fragment sample";
	}

	protected async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.replaceChildren();
		root.classList.add("fragment-sample-view");

		const header = document.createElement("div");
		header.classList.add("fragment-sample-view__header");

		const iconEl = document.createElement("span");
		setIcon(iconEl, "sparkles");
		header.append(iconEl);

		const heading = document.createElement("h2");
		heading.textContent = "Fragment sample view";
		header.append(heading);

		const greeting = document.createElement("p");
		greeting.textContent = `Greeting: ${this.plugin.settings.greeting}`;

		const clicks = document.createElement("p");
		clicks.textContent = `Ribbon clicks so far: ${this.plugin.settings.clickCount}`;

		root.append(header, greeting, clicks);
	}

	protected async onClose(): Promise<void> {
		this.contentEl.replaceChildren();
	}
}
