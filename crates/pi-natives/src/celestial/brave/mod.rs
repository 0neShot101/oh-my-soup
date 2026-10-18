//! Brave Search SSR `devalue` parser, Argon2id PoW solver, and VOPRF Privacy
//! Pass client.

pub mod model;
pub mod pow;

use std::{collections::VecDeque, fmt, sync::LazyLock, time::Instant};

pub use model::SearchPage;
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::de::Error as _;
use urlencoding::encode;
use wreq_util::Emulation;

use crate::celestial::{
	brave::pow::{IssuanceResponse, PublicKey, Redemption},
	devalue::{self, Error},
};

static CLIENT: LazyLock<wreq::Client> = LazyLock::new(|| {
	wreq::Client::builder()
		.emulation(Emulation::Chrome149)
		.build()
		.unwrap()
});
static JAR: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

#[derive(Debug, Clone)]
pub struct SearchParams {
	/// Zero-based result page.
	pub page:       u32,
	pub spellcheck: bool,
	pub safesearch: SafeSearch,
	pub country:    String,
}

impl Default for SearchParams {
	fn default() -> Self {
		Self {
			page:       0,
			spellcheck: false,
			safesearch: SafeSearch::Off,
			country:    "all".into(),
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafeSearch {
	Strict,
	Moderate,
	Off,
}

impl fmt::Display for SafeSearch {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let s = match self {
			Self::Strict => "strict",
			Self::Moderate => "moderate",
			Self::Off => "off",
		};
		f.pad(s)
	}
}

#[derive(Debug)]
pub enum SearchError {
	NetworkError(wreq::Error),
	PowError(pow::Error),
	ParseError(String),
}

impl fmt::Display for SearchError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NetworkError(e) => e.fmt(f),
			Self::PowError(e) => e.fmt(f),
			Self::ParseError(e) => f.write_str(e),
		}
	}
}

impl std::error::Error for SearchError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::NetworkError(e) => std::error::Error::source(e),
			Self::PowError(e) => std::error::Error::source(e),
			Self::ParseError(_) => None,
		}
	}
}

impl From<wreq::Error> for SearchError {
	fn from(value: wreq::Error) -> Self {
		Self::NetworkError(value)
	}
}

impl From<pow::Error> for SearchError {
	fn from(value: pow::Error) -> Self {
		Self::PowError(value)
	}
}

pub async fn search(query: &str, params: SearchParams) -> Result<SearchPage, SearchError> {
	let url = format!(
		"https://search.brave.com/search?q={}&offset={}&spellcheck={}",
		encode(query),
		params.page,
		if params.spellcheck { "1" } else { "0" }
	);

	let extra = JAR
		.lock()
		.pop_front()
		.map(|item| format!("; {item}"))
		.unwrap_or_default();

	let resp = CLIENT
		.get(&url)
		.header(
			"Cookie",
			format!(
				"safesearch={}; country={}; useLocation=0{}",
				&params.safesearch.to_string(),
				&params.country,
				&extra
			),
		)
		.send()
		.await?;

	match parse_search(&resp.text().await?) {
		Ok(parsed) => Ok(parsed),
		Err(model::ParseError::Captcha(Some(challenge))) => {
			solve_pow(challenge, url).await?;
			Box::pin(search(query, params)).await
		},
		Err(model::ParseError::Captcha(None)) => {
			Err(SearchError::ParseError("unsupported type captcha".into()))
		},
		Err(model::ParseError::Parse(text)) => Err(SearchError::ParseError(text.to_string())),
	}
}

pub fn parse_search(html: &str) -> Result<model::SearchPage, model::ParseError> {
	let missing = || Error::custom("hydration blob not found");
	let anchor = html.find("node_ids:").ok_or_else(missing)?;
	let start = html[..anchor].rfind('{').ok_or_else(missing)?;
	let (arena, _) = devalue::uneval::read(&html[start..])?;

	let datas: Vec<i64> = arena
		.field(arena.root, "data")
		.and_then(|d| arena.elems(d))
		.unwrap_or_default()
		.into_iter()
		.filter(|&n| arena.field(n, "type").and_then(|t| arena.str(t)) == Some("data"))
		.filter_map(|n| arena.field(n, "data"))
		.collect();

	let route = datas
		.first()
		.and_then(|&l| arena.field(l, "page"))
		.and_then(|p| arena.str(p));

	let page = *datas
		.last()
		.ok_or_else(|| Error::custom("no page data node"))?;

	if route == Some("/captcha") || arena.field(page, "challengeSet").is_some() {
		let challenge = arena
			.decode_at::<model::CaptchaPage>(page)
			.ok()
			.and_then(|p| p.challenge_set);
		return Err(model::ParseError::Captcha(challenge));
	}

	Ok(arena.decode_at(page)?)
}

pub async fn solve_pow(challenge: model::ChallengeSet, referer: String) -> Result<(), pow::Error> {
	let solver = pow::ProofOfWork::new(pow::Params::new(
		challenge.hash_function_params.memory_size,
		challenge.hash_function_params.iterations,
		challenge.hash_function_params.parallelism,
		challenge.hash_function_params.hash_length,
	)?);
	let started = Instant::now();
	let answers = challenge
		.tokens
		.par_iter()
		.map(|token| {
			solver.solve(token, challenge.zero_count as usize, challenge.solution_limit as usize)
		})
		.collect::<Result<Vec<_>, _>>()?;
	let taken_time = started.elapsed().as_millis() as u32;

	let keys: pow::BraveKeysResponse = CLIENT
		.get("https://search.brave.com/api/tokens/keys")
		.header("Referer", &referer)
		.send()
		.await?
		.error_for_status()
		.map_err(|_| pow::Error::ServerError("token response invalid".into()))?
		.json()
		.await?;

	let key = keys
		.keys
		.last()
		.ok_or_else(|| pow::Error::ServerError("no valid public key".into()))?;
	let key_id = key.key_id.clone();
	let public_key = PublicKey::decode_base64(&key.public_key)?;

	let request = pow::TokenRequest::new(keys.tokens_per_challenge.unwrap_or(30) as usize);

	let signed: pow::BravePoWSignResponse = CLIENT
		.post("https://search.brave.com/api/captcha/pow?brave=0")
		.header("Referer", &referer)
		.json(&pow::BravePoWSignRequest {
			blinded_messages: request.encode_blinded(),
			key_id: key_id.clone(),
			set_token: challenge.set_token.clone(),
			solutions: challenge.tokens.clone().into_iter().zip(answers).collect(),
			taken_time,
		})
		.send()
		.await?
		.error_for_status()
		.map_err(|_| pow::Error::ServerError("pow verification failed".into()))?
		.json()
		.await?;

	let unblinded = request.finalize(
		&IssuanceResponse::from_base64(&signed.signed_tokens, &signed.batch_proof)?,
		&public_key,
	)?;

	JAR.lock().extend(unblinded.iter().map(|token| {
		let redemption = Redemption::new(token, b"brave-search-captcha");
		format!(
			"__Secure-token#brave-search-captcha={},{},{}",
			key_id, redemption.preimage, redemption.signature
		)
	}));

	Ok(())
}
