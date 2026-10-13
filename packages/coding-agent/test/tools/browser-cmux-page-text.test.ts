import { expect, it, spyOn } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";

it("cmux text and html read the page body when given no selector", async () => {
	const scripts: string[] = [];
	const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (_method: string, params?: Record<string, unknown>) => {
			scripts.push(String(params?.script));
			return { value: "page" };
		},
	);
	try {
		const tab = new CmuxTab({
			client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-page-text.sock" }),
			surfaceId: "page-text",
		});
		expect(await tab.text()).toBe("page");
		expect(await tab.html()).toBe("page");
		expect(scripts).toHaveLength(2);
		for (const script of scripts) expect(script).toContain('"body"');
	} finally {
		request.mockRestore();
	}
});
