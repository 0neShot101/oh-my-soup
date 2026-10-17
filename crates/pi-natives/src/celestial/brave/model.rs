use std::fmt;

use serde::Deserialize;

use crate::celestial::devalue;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct SearchPage {
	pub body:       Body,
	pub status:     Option<u16>,
	pub title:      Option<String>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub no_results: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptchaPage {
	pub challenge_set: Option<ChallengeSet>,
}

#[derive(Debug)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub enum ParseError {
	/// `None` = detected, but the challenge payload didn't match the struct.
	Captcha(Option<ChallengeSet>),
	Parse(devalue::Error),
}

impl fmt::Display for ParseError {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		match self {
			ParseError::Captcha(_) => f.write_str("captcha challenge served"),
			ParseError::Parse(e) => e.fmt(f),
		}
	}
}

impl std::error::Error for ParseError {}

impl From<devalue::Error> for ParseError {
	fn from(e: devalue::Error) -> Self {
		ParseError::Parse(e)
	}
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Body {
	pub mixer_time: Option<f64>,
	pub response:   Response,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Response {
	pub query:   Query,
	pub mixed:   Option<Mixed>,
	pub web:     Option<Web>,
	pub videos:  Option<Videos>,
	pub infobox: Option<Infobox>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Query {
	pub original:               String,
	pub altered:                Option<String>,
	pub country:                Option<String>,
	pub city:                   Option<String>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub more_results_available: bool,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub bad_results:            bool,
	/// each related query = list of (is_highlighted, word)
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub related_queries:        Vec<Vec<(bool, String)>>,
}

impl Query {
	pub fn related_flat(&self) -> Vec<String> {
		self
			.related_queries
			.iter()
			.map(|q| {
				q.iter()
					.map(|(_, w)| w.as_str())
					.collect::<Vec<_>>()
					.join(" ")
			})
			.collect()
	}
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Mixed {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub top:  Vec<MixedRef>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub main: Vec<MixedRef>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub side: Vec<MixedRef>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct MixedRef {
	#[serde(rename = "type")]
	pub kind:  String, // "web" | "videos" | "infobox" | "chatllm" | ...
	pub index: Option<u32>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub all:   bool,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Web {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub results: Vec<WebResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct WebResult {
	pub title:        String,
	pub full_title:   Option<String>,
	pub url:          String,
	/// HTML-ish: contains <strong> + entities like &quot;
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub description:  String,
	pub page_age:     Option<String>, // "2026-09-22T10:50:38", no tz
	pub age:          Option<String>, // "1 week ago"
	pub language:     Option<String>,
	pub subtype:      Option<String>, // "generic" | "video" | "faq" ...
	pub profile:      Option<Profile>,
	pub meta_url:     Option<MetaUrl>,
	pub thumbnail:    Option<Thumbnail>,
	pub deep_results: Option<DeepResults>,
	pub video:        Option<VideoMeta>,
	pub qa:           Option<Qa>,
	pub article:      Option<Article>,
	pub faq:          Option<Faq>,
}

impl WebResult {
	#[allow(dead_code, reason = "deserialized Brave SERP schema")]
	pub fn display_title(&self) -> &str {
		self.full_title.as_deref().unwrap_or(&self.title)
	}
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Profile {
	pub name:      String,
	pub url:       Option<String>,
	pub long_name: Option<String>,
	pub img:       Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct MetaUrl {
	pub hostname: String,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub path:     String,
	pub favicon:  Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Thumbnail {
	pub src:      String,
	pub original: Option<String>,
	pub logo:     Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct DeepResults {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub buttons: Vec<DeepLink>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct DeepLink {
	pub title: String,
	pub url:   String,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct VideoMeta {
	pub duration:  Option<String>, // "06:07"
	// pub views: Option<String>,    // "53M"
	pub creator:   Option<String>,
	pub publisher: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Qa {
	/// HTML: <p>…</p>, &#39; etc.
	pub question:          Option<String>,
	pub answer:            Option<Answer>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub suggested_answers: Vec<Answer>,
}

impl Qa {
	#[allow(dead_code, reason = "deserialized Brave SERP schema")]
	pub fn answers(&self) -> impl Iterator<Item = &Answer> {
		self.answer.iter().chain(&self.suggested_answers)
	}
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Answer {
	pub text:         String,
	pub upvote_count: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Article {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub author:    Vec<Entity>,
	pub date:      Option<String>, // "Feb 22, 2026", human format
	pub publisher: Option<Entity>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Entity {
	pub name: String,
	pub url:  Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Faq {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub items: Vec<FaqItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct FaqItem {
	pub question: String,
	pub answer:   String,
	pub url:      Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Videos {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub results: Vec<VideoResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct VideoResult {
	pub title:       String,
	pub url:         String,
	pub description: Option<String>,
	pub age:         Option<String>,
	pub page_age:    Option<String>,
	pub meta_url:    Option<MetaUrl>,
	pub thumbnail:   Option<Thumbnail>,
	pub video:       Option<VideoMeta>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Infobox {
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub results: Vec<InfoboxResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct InfoboxResult {
	pub title:       String,
	pub label:       Option<String>,
	pub description: Option<String>,
	pub long_desc:   Option<String>,
	pub url:         Option<String>,
	pub category:    Option<String>,
	pub website_url: Option<String>,
	/// [key, value]; either side may be null. values may contain <a href>.
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub attributes:  Vec<(Option<String>, Option<String>)>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub images:      Vec<InfoboxImage>,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub profiles:    Vec<Profile>,
	/// attribution source (e.g. Wikipedia, CC BY-SA)
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub providers:   Vec<Provider>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct InfoboxImage {
	pub src:      String,
	pub original: Option<String>,
	pub alt:      Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct Provider {
	pub name: String,
	pub url:  String,
}

// challenge

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct ChallengeSet {
	pub set_token:            String,
	#[serde(default, deserialize_with = "crate::celestial::devalue::nullish")]
	pub tokens:               Vec<String>,
	pub zero_count:           u32,
	pub hash_function_params: HashParams,
	pub solution_limit:       u32,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code, reason = "deserialized Brave SERP schema")]
pub struct HashParams {
	pub iterations:  u32,
	pub memory_size: u32,
	pub hash_length: Option<usize>,
	pub parallelism: u32,
}
