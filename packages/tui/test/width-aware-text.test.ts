import { describe, expect, it } from "bun:test";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { WidthAwareText } from "@oh-my-pi/pi-tui/render/width-aware-text";

function makeCx(cols: number): DescribeContext {
	return {
		cols,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => false,
	};
}

/** The text a native surface would show for the component's inner `Text`. */
function describedText(component: WidthAwareText, cx: DescribeContext): string {
	const described = component.describe(cx);
	const child = described.c?.[0];
	const inner = child && "k" in child ? child : child?.describe?.(cx);
	const spans = inner?.k === "text" ? inner.p?.spans : undefined;
	return spans ? spans.map(span => span.t).join("") : "";
}

describe("WidthAwareText describe width budget", () => {
	it("passes full cx.cols to the formatter, not cols minus padding", () => {
		// Regression: native Text.describe() emits no padding, so the formatter
		// must receive the full column budget. Subtracting padding here would
		// truncate native-rendered content by 2 columns on every surface.
		const widths: number[] = [];
		const component = new WidthAwareText(
			width => {
				widths.push(width);
				return "content";
			},
			1,
			1,
		);

		component.describe(makeCx(100));

		expect(widths).toEqual([100]);
	});

	it("render() still subtracts padding from the width budget", () => {
		// The render path goes through Text.render() which adds left/right
		// margins, so the formatter must receive width - paddingX * 2 there.
		const widths: number[] = [];
		const component = new WidthAwareText(
			width => {
				widths.push(width);
				return "content";
			},
			1,
			1,
		);

		component.render(100);

		expect(widths).toEqual([98]);
	});

	it("describe and render budgets differ by exactly paddingX * 2", () => {
		// The two paths must stay in sync: describe uses full cols, render
		// subtracts padding. A formatter that asserts a fixed width will catch
		// any future drift between the two budgets.
		const widths: number[] = [];
		const component = new WidthAwareText(
			width => {
				widths.push(width);
				return "x";
			},
			2,
			1,
		);

		component.describe(makeCx(80));
		component.render(80);

		expect(widths).toEqual([80, 76]);
	});

	it("re-describes at cx.cols after a render instead of reusing the render-time text", () => {
		// Regression: describe cached on `cx.cols` while render cached on
		// `width - paddingX * 2`, so a render between two describes left the
		// second describe serving the narrower render-time text. A native
		// surface that re-describes after a width-keyed render would then show
		// content truncated two columns early.
		const component = new WidthAwareText(width => `w${width}`, 1, 1);

		expect(describedText(component, makeCx(80))).toBe("w80");
		component.render(80);
		expect(describedText(component, makeCx(80))).toBe("w80");
	});
});
