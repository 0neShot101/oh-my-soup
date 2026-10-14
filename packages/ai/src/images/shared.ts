import type { FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { isRecord, parseImageMetadata, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { ApiKey } from "../auth-retry";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { GeneratedImage, ImageInput } from "./types";

export class ImageApiError extends AIError.ProviderHttpError {
	override readonly name = "ImageApiError";
}

export function emptyUsage(input = 0, output = 0, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

export function usageFromWire(value: unknown): Usage {
	if (value === null || typeof value !== "object") return emptyUsage();
	const usage = value as Record<string, unknown>;
	const number = (key: string): number => (typeof usage[key] === "number" ? usage[key] : 0);
	return emptyUsage(
		number("input_tokens") || number("prompt_tokens"),
		number("output_tokens") || number("completion_tokens"),
		number("cost"),
	);
}

export function imageBaseUrl(model: Model): string {
	if (!model.baseUrl) throw new AIError.ValidationError(`Image model ${model.provider}/${model.id} has no base URL`);
	return model.baseUrl.replace(/\/+$/, "");
}

export async function modelHeaders(model: Model, signal?: AbortSignal): Promise<Record<string, string>> {
	return { ...model.headers, ...(await model.resolveHeaders?.(signal)) };
}

export function errorMessage(rawText: string): string {
	try {
		const parsed = JSON.parse(rawText) as { detail?: string; error?: { message?: string } };
		return parsed.detail ?? parsed.error?.message ?? rawText;
	} catch {
		return rawText;
	}
}

async function parseImageApiResponse(model: Model, response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) {
		throw new ImageApiError(
			`${model.provider}/${model.id} image request failed (${response.status}): ${errorMessage(text)}`,
			response.status,
			{ headers: response.headers },
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw new AIError.ProviderResponseError("Image API returned malformed JSON", {
			provider: model.provider,
			kind: "envelope",
			cause,
		});
	}
}

/** Request URL, or a builder for routes that depend on the bearer (xAI's `XAI_BASE_URL` rule). */
type ImageRequestUrl = string | ((bearer: string) => string);

export async function postJson(options: {
	model: Model;
	url: ImageRequestUrl;
	body: unknown;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const url = typeof options.url === "string" ? options.url : options.url(key);
			const response = await options.fetch(url, {
				method: "POST",
				headers: {
					...(await modelHeaders(options.model, options.signal)),
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(options.body),
				signal: options.signal,
			});
			return parseImageApiResponse(options.model, response);
		},
		{ signal: options.signal },
	);
}

export async function postMultipart(options: {
	model: Model;
	url: ImageRequestUrl;
	body: FormData;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const url = typeof options.url === "string" ? options.url : options.url(key);
			const response = await options.fetch(url, {
				method: "POST",
				headers: {
					...(await modelHeaders(options.model, options.signal)),
					Authorization: `Bearer ${key}`,
					"User-Agent": USER_AGENT,
				},
				body: options.body,
				signal: options.signal,
			});
			return parseImageApiResponse(options.model, response);
		},
		{ signal: options.signal },
	);
}

async function imageFromUrl(url: string, fetch: FetchImpl, signal?: AbortSignal): Promise<GeneratedImage> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		const text = await response.text();
		throw new ImageApiError(`Image download failed (${response.status}): ${text}`, response.status, {
			headers: response.headers,
		});
	}
	const mimeType = response.headers.get("content-type")?.split(";")[0];
	if (!mimeType?.startsWith("image/")) {
		throw new AIError.ProviderResponseError(`Image URL returned unsupported content type: ${mimeType ?? "missing"}`, {
			kind: "envelope",
		});
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return { data: bytes.toBase64(), mimeType };
}

export async function decodeImageResponse(
	value: unknown,
	fetch: FetchImpl,
	signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; usage: Usage }> {
	if (value === null || typeof value !== "object") {
		throw new AIError.ProviderResponseError("Image API returned a malformed response", { kind: "envelope" });
	}
	const root = value as { data?: unknown; usage?: unknown };
	if (!Array.isArray(root.data)) {
		throw new AIError.ProviderResponseError("Image API response is missing data", { kind: "envelope" });
	}
	const images: GeneratedImage[] = [];
	for (const item of root.data) {
		if (item === null || typeof item !== "object") continue;
		const image = item as { b64_json?: unknown; url?: unknown; media_type?: unknown };
		if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
			const mimeType =
				typeof image.media_type === "string"
					? image.media_type
					: (sniffBase64ImageMimeType(image.b64_json) ?? "image/png");
			images.push({ data: image.b64_json, mimeType });
		} else if (typeof image.url === "string" && image.url.length > 0) {
			images.push(await imageFromUrl(image.url, fetch, signal));
		}
	}
	return { images, usage: usageFromWire(root.usage) };
}

/**
 * Mime type of a base64 image, read from its header only. 64 base64 chars
 * decode to 48 bytes, past every magic number `parseImageMetadata` checks, so
 * multi-MB payloads are never fully decoded just to be labelled.
 */
export function sniffBase64ImageMimeType(base64: string): string | undefined {
	return parseImageMetadata(Buffer.from(base64.slice(0, 64), "base64"))?.mimeType;
}

export function validateImageInput(image: ImageInput): void {
	if (!isRecord(image) || typeof image.data !== "string") {
		throw new AIError.ValidationError("invalid base64 image data");
	}
	const reason = base64ImageDataFailureReason(image.data);
	if (reason) throw new AIError.ValidationError(reason);
	if (!isImageMimeType(image.mimeType)) throw new AIError.ValidationError("invalid image MIME type");
}

export function toDataUrl(image: ImageInput): string {
	validateImageInput(image);
	return `data:${image.mimeType};base64,${image.data}`;
}

export type Base64ImageDecodeResult =
	| { bytes: Buffer; reason?: never }
	| { bytes?: never; reason: "invalid base64 image data" | "empty image data" };

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ImageDataFailureReason(data: string): "invalid base64 image data" | "empty image data" | undefined {
	if (data.length === 0) return "empty image data";

	const match = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(data);
	if (!match) return "invalid base64 image data";
	const encoded = match[1];
	const paddingLength = match[2].length;
	const remainder = encoded.length % 4;
	if (
		(remainder === 1 && paddingLength === 0) ||
		(paddingLength === 1 && remainder !== 3) ||
		(paddingLength === 2 && remainder !== 2)
	) {
		return "invalid base64 image data";
	}

	const lastSextet = BASE64_ALPHABET.indexOf(encoded[encoded.length - 1]);
	if ((remainder === 2 && (lastSextet & 0b1111) !== 0) || (remainder === 3 && (lastSextet & 0b11) !== 0)) {
		return "invalid base64 image data";
	}
	return undefined;
}

/** Decode standard base64 image data, accepting omitted padding but only canonical trailing bits. */
export function decodeBase64ImageData(data: string): Base64ImageDecodeResult {
	const reason = base64ImageDataFailureReason(data);
	if (reason) return { reason };

	const bytes = Buffer.from(data, "base64");
	return bytes.length > 0 ? { bytes } : { reason: "empty image data" };
}

const IMAGE_MIME_TYPE = /^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/i;

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && IMAGE_MIME_TYPE.test(value);
}

export function resolveOpenAIImageSize(aspectRatio?: string, imageSize?: string): string | undefined {
	if (imageSize) return imageSize;
	switch (aspectRatio) {
		case "1:1":
			return "1024x1024";
		case "3:4":
		case "9:16":
			return "1024x1536";
		case "4:3":
		case "16:9":
			return "1536x1024";
		default:
			return undefined;
	}
}
