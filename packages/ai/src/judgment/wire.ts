/**
 * Wire dialects of the native judgment APIs: how {@link NativeJudge} addresses,
 * encodes, and decodes one request for each API it serves. Internal to the
 * judgment module; `native.ts` maps every judgment API to its dialect.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { toDataUrl } from "../images/shared";
import type { ImageContent, Usage } from "../types";
import type { JudgmentRequest } from "./types";

/** Where one attempt posts and which bearer token it sends. */
export interface JudgmentTarget {
	url: string;
	token: string;
}

/** One decoded response. */
export interface DecodedJudgment {
	/** Model that answered, when the response names one. */
	model: string | undefined;
	/** Wire answers keyed by question id; {@link NativeJudge} checks each against its question's type. */
	answers: Readonly<Record<string, unknown>>;
	/** Question ids the model declined to answer. */
	refused: readonly string[];
	usage: Usage;
}

/** How one judgment API addresses, encodes, and decodes a request. */
export interface JudgmentWire {
	/**
	 * Target of one attempt made with credential `key` against `model`.
	 * Throws when the credential cannot address the endpoint (e.g. no account id).
	 */
	target(baseUrl: string, model: string, key: string): JudgmentTarget;
	/** Request body for `model`. */
	encode(request: JudgmentRequest, model: string): unknown;
	/** Image requests are supported only when the API dialect explicitly declares them. */
	supportsImages?: boolean;
	/** The response's answers and usage; `undefined` when the payload is not this API's response shape. */
	decode(payload: unknown): DecodedJudgment | undefined;
}

/** Whether a value is an embedded base64 image accepted by judgment wires. */
export function isEmbeddedImageContent(image: unknown): image is ImageContent {
	return (
		isRecord(image) &&
		image.type === "image" &&
		typeof image.data === "string" &&
		/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) &&
		image.data.length % 4 !== 1 &&
		typeof image.mimeType === "string" &&
		/^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/i.test(image.mimeType)
	);
}

/** Convert one embedded judgment image to a validated inline data URL. */
export function judgmentImageDataUrl(image: unknown): string {
	if (!isEmbeddedImageContent(image)) {
		throw new AIError.ValidationError("Judgment images must contain non-empty base64 data and an image MIME type");
	}
	return toDataUrl({ data: image.data, mimeType: image.mimeType.toLowerCase() });
}

/** `value` when it is a finite number. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
