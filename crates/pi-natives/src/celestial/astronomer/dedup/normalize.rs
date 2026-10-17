//! ```no_run
//! use astronomer::dedup::normalize::{BareHost, Https, Normalize, Normalized};
//!
//! let dedup = Normalized(Https.then(BareHost));
//! assert_eq!(dedup.key("http://www.example.com/"), dedup.key("https://example.com/"));
//! assert_ne!(dedup.key("https://example.com/#a"), dedup.key("https://example.com/#b"));
//! ```

use std::{collections::HashMap, fmt::Write};

use url::{Url, form_urlencoded};

use super::{super::atlas::Hit, Dedup};

/// Hits are duplicates when their URLs are equal after `N`. URLs that do not
/// parse compare verbatim.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Normalized<N = Canonical>(pub N);

impl<N: Normalize> Normalized<N> {
	/// The string `url` is identified by.
	pub fn key(&self, url: &str) -> String {
		match Url::parse(url) {
			Ok(mut parsed) => {
				self.0.normalize(&mut parsed);
				parsed.into()
			},
			Err(_) => url.to_owned(),
		}
	}
}

impl<N: Normalize> Dedup for Normalized<N> {
	fn group<H: Hit>(&self, hits: &[&H]) -> Vec<usize> {
		let mut groups = HashMap::with_capacity(hits.len());
		hits
			.iter()
			.map(|hit| {
				let next = groups.len();
				*groups.entry(self.key(hit.url())).or_insert(next)
			})
			.collect()
	}
}

/// One URL rewrite. Chain steps with [`Normalize::then`].
pub trait Normalize {
	fn normalize(&self, url: &mut Url);

	/// `self`, then `next`.
	fn then<N: Normalize>(self, next: N) -> Then<Self, N>
	where
		Self: Sized,
	{
		Then(self, next)
	}
}

/// No rewrite: keys are the WHATWG serialization alone ("punycode, then
/// compare").
impl Normalize for () {
	fn normalize(&self, _: &mut Url) {}
}

/// Two steps in sequence; see [`Normalize::then`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Then<A, B>(A, B);

impl<A: Normalize, B: Normalize> Normalize for Then<A, B> {
	fn normalize(&self, url: &mut Url) {
		self.0.normalize(url);
		self.1.normalize(url);
	}
}

/// Every step in this module, chained: the default of [`Normalized`].
///
/// Merges URLs differing in scheme (`http`/`https`), `www.`, fragment, trailing
/// slashes, tracking parameters, query order and percent-encoding. Keeps path
/// case, real query values, non-default ports and non-HTTP schemes apart.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Canonical;

impl Normalize for Canonical {
	fn normalize(&self, url: &mut Url) {
		Https
			.then(BareHost)
			.then(DropFragment)
			.then(TrimSlash)
			.then(DropTracking)
			.then(SortQuery)
			.then(DecodeUnreserved)
			.normalize(url);
	}
}

/// `http:` becomes `https:`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Https;

impl Normalize for Https {
	fn normalize(&self, url: &mut Url) {
		if url.scheme() == "http" {
			let _ = url.set_scheme("https");
		}
	}
}

/// `www.example.com.` becomes `example.com`: no `www.` label, no trailing root
/// dot.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BareHost;

impl Normalize for BareHost {
	fn normalize(&self, url: &mut Url) {
		let Some(host) = url.host_str() else {
			return;
		};
		let bare = host.strip_suffix('.').unwrap_or(host);
		let bare = bare.strip_prefix("www.").unwrap_or(bare);
		if bare.len() != host.len() {
			let bare = bare.to_owned();
			let _ = url.set_host(Some(&bare));
		}
	}
}

/// Drops the `#fragment`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DropFragment;

impl Normalize for DropFragment {
	fn normalize(&self, url: &mut Url) {
		url.set_fragment(None);
	}
}

/// `/docs/` becomes `/docs`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrimSlash;

impl Normalize for TrimSlash {
	fn normalize(&self, url: &mut Url) {
		let path = url.path();
		let trimmed = path.trim_end_matches('/');
		if trimmed.len() != path.len() {
			let trimmed = trimmed.to_owned();
			url.set_path(&trimmed);
		}
	}
}

/// Query parameters that only track the visitor; `utm_*` is matched as a
/// prefix.
const TRACKING: &[&str] = &[
	"_ga", "_gl", "_hsenc", "_hsmi", "dclid", "fbclid", "gbraid", "gclid", "gclsrc", "igshid",
	"mc_cid", "mc_eid", "mkt_tok", "msclkid", "ref_src", "srsltid", "twclid", "wbraid", "yclid",
];

/// Drops tracking query parameters (`utm_*`, `gclid`, `fbclid`, `srsltid`,
/// ...).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DropTracking;

impl Normalize for DropTracking {
	fn normalize(&self, url: &mut Url) {
		let mut params = query_params(url);
		let before = params.len();
		params.retain(|(name, _)| !is_tracking(name));
		if params.len() != before {
			set_query_params(url, &params);
		}
	}
}

fn is_tracking(name: &str) -> bool {
	name
		.get(..4)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("utm_"))
		|| TRACKING
			.iter()
			.any(|param| param.eq_ignore_ascii_case(name))
}

/// Sorts query parameters and re-encodes them as
/// `application/x-www-form-urlencoded` (`q=a%20b` becomes `q=a+b`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SortQuery;

impl Normalize for SortQuery {
	fn normalize(&self, url: &mut Url) {
		if url.query().is_some() {
			let mut params = query_params(url);
			params.sort_unstable();
			set_query_params(url, &params);
		}
	}
}

fn query_params(url: &Url) -> Vec<(String, String)> {
	url.query_pairs().into_owned().collect()
}

fn set_query_params(url: &mut Url, params: &[(String, String)]) {
	if params.is_empty() {
		url.set_query(None);
	} else {
		let query = form_urlencoded::Serializer::new(String::new())
			.extend_pairs(params)
			.finish();
		url.set_query(Some(&query));
	}
}

/// Normalizes percent-encoding in path and query: escaped unreserved characters
/// (`%7E`) are decoded, other escapes get uppercase hex (`%e2` becomes `%E2`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DecodeUnreserved;

impl Normalize for DecodeUnreserved {
	fn normalize(&self, url: &mut Url) {
		if let Some(path) = normalize_escapes(url.path()) {
			url.set_path(&path);
		}
		if let Some(query) = url.query().and_then(normalize_escapes) {
			url.set_query(Some(&query));
		}
	}
}

/// `s` (serialized, hence ASCII) with normalized escapes; `None` when already
/// normal.
fn normalize_escapes(s: &str) -> Option<String> {
	if !s.contains('%') {
		return None;
	}
	let bytes = s.as_bytes();
	let mut out = String::with_capacity(s.len());
	let mut i = 0;
	while i < bytes.len() {
		let escaped = match bytes[i..] {
			[b'%', high, low, ..] => hex(high).zip(hex(low)).map(|(h, l)| h << 4 | l),
			_ => None,
		};
		match escaped {
			Some(byte) if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) => {
				out.push(char::from(byte));
				i += 3;
			},
			Some(byte) => {
				let _ = write!(out, "%{byte:02X}");
				i += 3;
			},
			None => {
				out.push(char::from(bytes[i]));
				i += 1;
			},
		}
	}
	(out != s).then_some(out)
}

fn hex(digit: u8) -> Option<u8> {
	char::from(digit).to_digit(16).map(|value| value as u8)
}
