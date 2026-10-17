//! DuckDuckGo `d.js` extractor, pure-Rust JS subset interpreter (`jsa`), and
//! `Val` serde deserializer.

pub mod deserialize;
pub mod jsa;
pub mod model;

use std::{fmt, rc::Rc};

pub use deserialize::Error as DeserializeError;
pub use model::SearchPage;
use urlencoding::encode;

const MAX_RETRIES: u64 = 5;

#[derive(Debug, Clone)]
pub struct SearchParams {
	pub safesearch: SafeSearch,
	pub country:    String,
}

impl Default for SearchParams {
	fn default() -> Self {
		Self { safesearch: SafeSearch::Off, country: "wt-wt".into() }
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafeSearch {
	Strict,
	Moderate,
	Off,
}

#[derive(Debug)]
pub enum SearchError {
	NetworkError(String),
	ParseError(String),
	JSAError(String),
	DeserializeError(DeserializeError),
	RetryError,
}

impl fmt::Display for SearchError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NetworkError(e) => f.write_str(e),
			Self::ParseError(e) => f.write_str(e),
			Self::JSAError(e) => f.write_str(e),
			Self::DeserializeError(e) => e.fmt(f),
			Self::RetryError => f.write_str("retry exceeded"),
		}
	}
}

impl std::error::Error for SearchError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::DeserializeError(e) => std::error::Error::source(e),
			Self::NetworkError(_) | Self::ParseError(_) | Self::JSAError(_) | Self::RetryError => None,
		}
	}
}

impl From<DeserializeError> for SearchError {
	fn from(value: DeserializeError) -> Self {
		Self::DeserializeError(value)
	}
}

#[derive(Debug, Clone)]
pub enum DuckAction {
	Ok(model::SearchPage),
	Retry(String),
}

pub fn extract_duck_url(page: &str) -> Result<String, SearchError> {
	let anchor = page
		.find("\"https://links.duckduckgo.com/d.js")
		.ok_or_else(|| SearchError::ParseError("invalid initialize".into()))?;
	let finish = page[anchor + 1..]
		.find('"')
		.ok_or_else(|| SearchError::ParseError("corrupted page".into()))?;
	Ok(page[anchor + 1..anchor + 1 + finish].to_owned())
}

pub async fn search(query: &str, params: SearchParams) -> Result<SearchPage, SearchError> {
	let cookie = format!(
		"{safesearch}ah={country}; l={country}",
		safesearch = match params.safesearch {
			SafeSearch::Strict => "p=1; ",
			SafeSearch::Moderate => "",
			SafeSearch::Off => "p=-2; ",
		},
		country = params.country
	);
	let page =
		http_get(&format!("https://duckduckgo.com/?q={}", encode(query)), &[("Cookie", &cookie)])
			.await?;
	let duck = extract_duck_url(&page)?;
	follow(duck).await
}

/// Fetches the page behind a [`SearchPage::next_page`] cursor.
pub async fn search_next(cursor: &str) -> Result<SearchPage, SearchError> {
	follow(format!("https://links.duckduckgo.com{cursor}")).await
}

impl SearchPage {
	pub fn is_next(&self) -> bool {
		self.next_page().is_some()
	}

	pub async fn next(&self) -> Result<Option<Self>, SearchError> {
		match self.next_page() {
			Some(cursor) => search_next(cursor).await.map(Some),
			None => Ok(None),
		}
	}
}

/// Runs `d.js`, following deep redirects until it yields a page.
async fn follow(mut duck: String) -> Result<SearchPage, SearchError> {
	for _ in 0..MAX_RETRIES {
		match get_duck(&duck).await? {
			DuckAction::Ok(page) => return Ok(page),
			DuckAction::Retry(new_duck) => duck = new_duck,
		}
	}
	Err(SearchError::RetryError)
}

async fn get_duck(duck: &str) -> Result<DuckAction, SearchError> {
	let page = http_get(duck, &[
		("Referer", "https://duckduckgo.com/"),
		("Priority", "u=1, i"),
		("Sec-Fetch-Dest", "script"),
		("Sec-Fetch-Mode", "no-cors"),
		("Sec-Fetch-Site", "same-origin"),
	])
	.await?;
	eval_duck_script(&page)
}

/// Evaluates a DuckDuckGo `d.js` script payload inside the pure-Rust `jsa`
/// interpreter and deserializes the resulting [`model::SearchPage`] or deep
/// retry URL.
pub fn eval_duck_script(page: &str) -> Result<DuckAction, SearchError> {
	let host = Rc::new(jsa::Host::default());
	let global = jsa::Scope::global(host.clone(), [("document".into(), jsa::Val::Doc)]);

	jsa::run(page, &global)
		.map_err(|x| SearchError::JSAError(format!("invalid d.js: {}", x.to_string())))?;

	let exec_deep = host.writes.borrow().get("window.execDeep").cloned();

	if let Some(exec) = exec_deep {
		jsa::call(&exec, &[]).map_err(|x| {
			SearchError::JSAError(format!("error while running window.execDeep: {}", x.to_string()))
		})?;
	}

	let call_tail = |path: &str, tag: Option<&str>| -> Option<Vec<jsa::Val>> {
		host.calls.borrow().iter().find_map(|(p, args)| {
			if p != path {
				return None;
			}
			match (tag, args.as_slice()) {
				(Some(t), [jsa::Val::Str(s), rest @ ..]) if &**s == t => Some(rest.to_vec()),
				(None, rest) => Some(rest.to_vec()),
				_ => None,
			}
		})
	};

	let call_arg = |path: &str, tag: Option<&str>| -> Option<jsa::Val> {
		call_tail(path, tag).and_then(|rest| rest.into_iter().next())
	};

	let all_calls = |path: &str| -> Vec<Vec<jsa::Val>> {
		host
			.calls
			.borrow()
			.iter()
			.filter(|(p, _)| p == path)
			.map(|(_, args)| args.clone())
			.collect()
	};

	let write = |key: &str| -> Option<jsa::Val> { host.writes.borrow().get(key).cloned() };

	if let Some(redirect) = call_arg("DDG.deep.initialize", None) {
		return match redirect {
			jsa::Val::Str(x) => Ok(DuckAction::Retry(format!("https://links.duckduckgo.com{x}"))),
			_ => Err(SearchError::JSAError("deep redirect is not string!".into())),
		};
	}

	let layout_tail = call_tail("DDG.pageLayout.initialize", None).unwrap_or_default();

	let deep_meta = model::DeepMeta {
		upstream:              call_arg("DDG.deep.setUpstream", None)
			.map(deserialize::from_val::<Option<String>>)
			.transpose()?
			.flatten(),
		ad_unit_index:         write("DDG.deep.adUnitIndex")
			.map(deserialize::from_val)
			.transpose()?,
		alt_is_navigational:   write("DDG.search.altIsNavigational")
			.map(deserialize::from_val::<u8>)
			.transpose()?
			.map(|n| n != 0),
		wikipedia_exact_match: write("DDG.deep.wikipediaExactMatch")
			.map(deserialize::from_val::<u8>)
			.transpose()?
			.map(|n| n != 0),
		signal_summary:        write("DDG.deep.signalSummary")
			.map(deserialize::from_val)
			.transpose()?,
		page_layout_summary:   write("DDG.deep.pageLayoutSummary")
			.map(deserialize::from_val)
			.transpose()?,
		bn:                    write("DDG.deep.bn")
			.map(deserialize::from_val)
			.transpose()?,
		future_signal_tabs:    all_calls("DDG.duckbar.future_signal_tab")
			.into_iter()
			.filter_map(|args| args.into_iter().next())
			.map(deserialize::from_val)
			.collect::<Result<_, _>>()?,
		layout_start:          layout_tail
			.get(1)
			.cloned()
			.map(deserialize::from_val::<model::LayoutOpts>)
			.transpose()?
			.map(|o| o.start),
		related_qna_loaded:    call_tail("DDG.duckbar.loadModule", Some("related_qna")).is_some(),
	};
	let deep_val = write("DDG.deep.deepPayload")
		.ok_or_else(|| SearchError::JSAError("DDG.deep.deepPayload gone".into()))?;

	Ok(DuckAction::Ok(model::SearchPage {
		deep_payload: deserialize::from_val(deep_val)?,
		organics: match call_arg("DDG.pageLayout.load", Some("d")) {
			Some(v) => deserialize::from_val(v)?,
			None => vec![],
		},
		images: call_arg("DDG.duckbar.load", Some("images"))
			.map(deserialize::from_val)
			.transpose()?,
		news: call_arg("DDG.duckbar.load", Some("news"))
			.map(deserialize::from_val)
			.transpose()?,
		videos: call_arg("DDG.duckbar.load", Some("videos"))
			.map(deserialize::from_val)
			.transpose()?,
		translations: call_arg("DDG.duckbar.loadModule", Some("translations"))
			.map(deserialize::from_val)
			.transpose()?,
		related_searches: call_arg("DDG.duckbar.loadModule", Some("related_searches"))
			.map(deserialize::from_val)
			.transpose()?,
		about: call_arg("DDG.duckbar.add", None)
			.map(deserialize::from_val)
			.transpose()?,
		result_languages: call_arg("DDG.inject", Some("DDG.Data.languages.resultLanguages"))
			.map(deserialize::from_val)
			.transpose()?,
		ad_languages: call_arg("DDG.inject", Some("DDG.Data.languages.adLanguages"))
			.map(deserialize::from_val)
			.transpose()?,
		layout: layout_tail
			.first()
			.cloned()
			.map(deserialize::from_val)
			.transpose()?,
		deep_meta,
	}))
}

async fn http_get(url: &str, headers: &[(&str, &str)]) -> Result<String, SearchError> {
	crate::celestial::http::get(url, headers)
		.await
		.map_err(SearchError::NetworkError)
}
