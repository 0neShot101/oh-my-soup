import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, setKeybindings, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	widget: InlineWidget;
	/** Turn-scoped chrome between transcript and editor (loader, todo/subagent HUDs). */
	hud: InlineWidget;
	editor: Container;
}

function makeHarness(columns = COLUMNS, rows = ROWS, transcriptRows = TRANSCRIPT_ROWS): Harness {
	const terminal = new VirtualTerminal(columns, rows);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < transcriptRows; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	const hud = new InlineWidget();
	const editor = new Container();
	const widget = new InlineWidget();
	editor.addChild(widget);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, hud, editor]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, widget, hud, editor };
}

/** Settle, grow the inline chrome, settle, shrink it back, settle. */
async function cycleWidget(h: Harness): Promise<void> {
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 24;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 0;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

/**
 * Longest run of blank rows above the row containing `bottom`. Transcript
 * blocks are separated by one blank row, so a longer run is a band of rows no
 * frame can fill.
 */
function blankBand(terminal: VirtualTerminal, bottom = "EDITOR"): number {
	const view = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	let run = 0;
	let longest = 0;
	for (const row of view.slice(
		0,
		view.findIndex(line => line.includes(bottom)),
	)) {
		run = row === "" ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("answers an ask at the reported 54x112 geometry without losing, duplicating or stranding rows", async () => {
		const h = makeHarness(112, 54);
		await h.scheduler.settle(h.terminal);
		let submitted = false;
		const dialog = new AskDialogComponent(
			[
				{
					id: "approve",
					question: "Approve this section and the complete design for writing the spec?",
					options: [{ label: "Approve" }, { label: "Revise" }],
				},
			],
			{
				onSubmit: () => {
					submitted = true;
					h.editor.clear();
					h.editor.addChild(new Text("EDITOR", 0, 0));
					h.composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const visibleRows = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		dialog.handleInput("\r");
		await h.scheduler.settle(h.terminal);
		expect(submitted).toBe(true);
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(53);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		dialog.dispose();
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored after an inline panel closes", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("refills the screen after an ask closes below a response taller than the screen", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		// The response straddles the top edge: only its rows above the screen
		// may reach scrollback, or the panel would push on-screen history out
		// of reach and leave a band behind when it closes.
		transcript.addChild({ render: () => Array.from({ length: 80 }, (_, i) => `${TRANSCRIPT_PREFIX}${i}`) });
		transcript.addChild({ render: () => Array.from({ length: 11 }, (_, i) => `Tool row ${i}`) });
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const dialog = new AskDialogComponent(
			[{ id: "q", question: "Is it good?", options: [{ label: "Yes" }, { label: "No" }] }],
			{
				onSubmit: () => {
					editor.clear();
					editor.addChild(new Text("EDITOR", 0, 0));
					composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		editor.clear();
		editor.addChild(dialog);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		dialog.handleInput("\r");
		await scheduler.settle(terminal);
		expect(terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(blankBand(terminal)).toBeLessThanOrEqual(1);
		const indices = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: 80 }, (_, i) => i));
		dialog.dispose();
		composer.stop();
	});

	it("brings rows an ask panel covered back on screen when the ask is hidden", async () => {
		// The default app bindings (Alt+H hides a pending ask), as other suites leave them.
		setKeybindings(KeybindingsManager.inMemory());
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const dialog = new AskDialogComponent(
			[
				{
					id: "q",
					question: "Is it good?",
					options: ["A", "B", "C", "D"].map(label => ({ label, description: `${label} described` })),
				},
			],
			{ onSubmit: () => {}, onCancel: () => {}, onPrompt: () => Promise.resolve(undefined) },
			{ tui: h.composer.ui },
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const reachable = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		// Alt+H collapses the pending ask to one line: the rows it covered are
		// still live, so they refill the screen instead of leaving a band.
		dialog.handleInput("\x1bh");
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view[ROWS - 1]).toContain("Ask hidden");
		expect(blankBand(h.terminal, "Ask hidden")).toBeLessThanOrEqual(1);
		expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		// Showing it again covers them without writing anything twice.
		dialog.handleInput("\x1bh");
		await h.scheduler.settle(h.terminal);
		const shown = reachable();
		expect(new Set(shown).size).toBe(shown.length);
		dialog.dispose();
		h.composer.stop();
	});

	it("keeps the editor pinned to the bottom after transient below-transcript chrome shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(before.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await cycleWidget(h);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		// Regression: the editor used to strand ~24 blank rows below it after the
		// shrink because retired transcript rows never returned to the live tail.
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("retires transcript rows contiguously with no duplication or gaps across the grow/shrink cycle", async () => {
		const h = makeHarness();
		await cycleWidget(h);

		// Every transcript row appears exactly once (native scrollback + live grid),
		// in order — the shrink must not drop rows into a gap or duplicate them.
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));

		h.composer.stop();
	});

	it("keeps the below-chrome baseline across a height resize while inline chrome is expanded", async () => {
		const shorter = ROWS - 10;
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Expand, resize the terminal height *while still expanded*, then keep
		// rendering before shrinking. The retirement baseline must not adopt the
		// expanded peak at the resize, or the frames before the shrink retire
		// rows the shrink cannot reclaim and the editor is stranded again.
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(COLUMNS, shorter);
		await h.scheduler.advance(h.terminal, 300);
		for (let frame = 0; frame < 5; frame++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(shorter - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(shorter - 1);

		h.composer.stop();
	});

	it("clips the live tail from the top instead of compacting it when the chrome grows a few rows", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A persistent few-row growth (multi-line prompt, todo HUD, subagent badge)
		// lifts the chrome above the retirement baseline. The tail must scroll
		// off the top like native history would — not collapse into the
		// one-row-per-block emergency layout that drops every inter-block blank
		// and strands the freed rows below the editor.
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBe(ROWS - 1);
		const transcriptRows = view.slice(0, editorRow - 3);
		const separators = transcriptRows.filter(
			(row, i) => row === "" && transcriptRows[i - 1]?.startsWith(TRANSCRIPT_PREFIX),
		);
		expect(separators.length).toBeGreaterThan(0);
		expect(transcriptRows.at(-1)).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);

		h.composer.stop();
	});

	it("refills the screen with live rows when turn-scoped chrome goes away", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		h.hud.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// The turn ends: the todo/loader HUD closes. The rows it pushed aside
		// stayed live, so they return instead of leaving a band.
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.composer.stop();
	});

	it("keeps the editor on the bottom row when a live block collapses under retired history", async () => {
		const h = makeHarness();
		const transcript = new TranscriptContainer();
		for (let i = 0; i < TRANSCRIPT_ROWS; i++) transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${i}`] });
		// A streaming tool preview that collapses to its short result.
		let toolRows = 12;
		transcript.addChild({ render: () => Array.from({ length: toolRows }, (_, i) => `Tool row ${i}`) });
		h.composer.setRuntimeChildren([transcript, h.hud, h.editor]);
		await h.scheduler.settle(h.terminal);
		toolRows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(view.filter(row => row.startsWith("Tool row "))).toHaveLength(4);
		h.composer.stop();
	});
});
