//! Shared bounded HTTP transport for the Rust engine APIs.

use std::{sync::LazyLock, time::Duration};

use reqwest::{Client, RequestBuilder};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
static CLIENT: LazyLock<Result<Client, reqwest::Error>> = LazyLock::new(|| {
	Client::builder()
		.timeout(Duration::from_secs(20))
		.user_agent("Oh-My-Soup Celestial")
		.build()
});

fn client() -> Result<&'static Client, String> {
	CLIENT.as_ref().map_err(ToString::to_string)
}

pub async fn get(url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
	let mut request = client()?.get(url);
	for &(name, value) in headers {
		request = request.header(name, value);
	}
	read_text(request).await
}

pub async fn post_json(url: &str, referer: &str, body: &str) -> Result<String, String> {
	read_text(
		client()?
			.post(url)
			.header("Referer", referer)
			.header("Content-Type", "application/json")
			.body(body.to_owned()),
	)
	.await
}

async fn read_text(request: RequestBuilder) -> Result<String, String> {
	let mut response = request
		.send()
		.await
		.and_then(reqwest::Response::error_for_status)
		.map_err(|error| error.to_string())?;
	if response
		.content_length()
		.is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
	{
		return Err("Search response exceeds 8 MiB".to_owned());
	}
	let mut body = Vec::new();
	while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
		if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
			return Err("Search response exceeds 8 MiB".to_owned());
		}
		body.extend_from_slice(&chunk);
	}
	String::from_utf8(body).map_err(|error| error.to_string())
}
