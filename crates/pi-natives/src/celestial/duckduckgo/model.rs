use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPage {
	pub deep_payload:     DeepPayload,
	pub organics:         Vec<OrganicEntry>,
	pub images:           Option<ImagesModule>,
	pub news:             Option<NewsModule>,
	pub videos:           Option<VideosModule>,
	pub translations:     Option<TranslationsModule>,
	pub related_searches: Option<RelatedSearchesModule>,
	pub about:            Option<Box<FatheadModule>>,
	pub result_languages: Option<ResultLanguages>,
	pub ad_languages:     Option<AdLanguages>,
	pub layout:           Option<PageLayout>,
	#[serde(default)]
	pub deep_meta:        DeepMeta,
}

impl SearchPage {
	pub fn results(&self) -> impl Iterator<Item = &OrganicResult> {
		self.organics.iter().filter_map(|e| match e {
			OrganicEntry::Result(r) => Some(&**r),
			OrganicEntry::NextPage(_) => None,
			OrganicEntry::NoResult { .. } => None,
		})
	}

	pub fn next_page(&self) -> Option<&str> {
		self.organics.iter().find_map(|e| match e {
			OrganicEntry::NextPage(c) => Some(c.next_page_path.as_str()),
			OrganicEntry::Result(_) => None,
			OrganicEntry::NoResult { .. } => None,
		})
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepPayload {
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub instant_answers:  Vec<InstantAnswer>,
	pub recommended_tabs: RecommendedTabs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "RawInstantAnswer")]
pub struct InstantAnswer {
	pub data:      InstantAnswerPayload,
	#[serde(rename = "from")]
	pub provider:  String, // "wikinlp" | "news" | ...
	pub resources: Option<Value>, // (?) null
	pub signal:    SignalStrength,
}

/// `data`, typed by the answer's `from` provider.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum InstantAnswerPayload {
	/// `wikinlp`
	WikiNlp(Box<InstantAnswerData>),
	/// `news`
	News(NewsAnswerData),
	/// Providers not modeled yet, verbatim.
	Other(Value),
}

/// Wire shape; `data` is decoded once `from` is known.
#[derive(Deserialize)]
struct RawInstantAnswer {
	data:      Value,
	from:      String,
	resources: Option<Value>,
	signal:    SignalStrength,
}

impl TryFrom<RawInstantAnswer> for InstantAnswer {
	type Error = serde_json::Error;

	fn try_from(raw: RawInstantAnswer) -> Result<Self, Self::Error> {
		let data = match raw.from.as_str() {
			"wikinlp" => InstantAnswerPayload::WikiNlp(serde_json::from_value(raw.data)?),
			"news" => InstantAnswerPayload::News(serde_json::from_value(raw.data)?),
			_ => InstantAnswerPayload::Other(raw.data),
		};
		Ok(Self { data, provider: raw.from, resources: raw.resources, signal: raw.signal })
	}
}

/// Which backend DDG wants serving the news module for this query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsAnswerData {
	pub preferred_news_source:          Option<NewsSource>, // null unless a backend is preferred
	pub strongly_preferred_news_source: Option<NewsSource>,
}

// the frontend compares these against "you" and overwrites them with "bing"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewsSource {
	You,
	Bing,
	#[serde(other)]
	Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalStrength {
	Low,
	Medium,
	High,
	#[serde(other)]
	Unknown,
}

impl SignalStrength {
	pub fn from_initial(s: &str) -> Self {
		match s {
			"l" => Self::Low,
			"m" => Self::Medium,
			"h" => Self::High,
			_ => Self::Unknown,
		}
	}

	pub fn initial(self) -> &'static str {
		match self {
			Self::Low => "l",
			Self::Medium => "m",
			Self::High => "h",
			Self::Unknown => "?",
		}
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstantAnswerData {
	// always
	pub assist_operator:          u32,
	#[serde(rename = "belowAds")]
	pub is_below_ads:             bool,
	#[serde(with = "int_bool")]
	pub can_auto_answer:          bool,
	pub endpoint:                 String, // relative
	pub intent:                   u32,
	#[serde(rename = "isSignalUpgradable", with = "int_bool")]
	pub is_signal_upgradable:     bool,
	#[serde(with = "int_bool")]
	pub is_recent_topic:          bool,
	#[serde(rename = "postData")]
	pub post_data:                PostData,
	#[serde(rename = "precheck_counts")]
	pub precheck_count:           u32,
	pub query:                    String, // percent-encoded
	pub run_id:                   String, // TODO: swap for uuid::Uuid maybe
	#[serde(with = "int_bool")]
	pub should_use_cached_answer: bool,

	// cached
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub action: Option<String>, // "answer"
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub all_source_urls: Vec<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub answer: Option<String>, // markdown, **bold** and all
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub answer_language: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub answer_run_id: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub assistexp: Option<String>, // "" so far (?)
	#[serde(default, with = "int_bool::opt", skip_serializing_if = "Option::is_none")]
	pub attempted_fallback: Option<bool>,
	#[serde(default, with = "loose_u32::opt", skip_serializing_if = "Option::is_none")]
	pub can_show_internationally: Option<u32>,
	#[serde(rename = "dw", default, skip_serializing_if = "Option::is_none")]
	pub deep_wiki_mode: Option<u32>, // mirrors postData.dw
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expanded_answer: Option<String>, // long markdown
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub fallback_sources_only: Option<bool>, // inconsistent much
	#[serde(default, with = "int_bool::opt", skip_serializing_if = "Option::is_none")]
	pub is_backup: Option<bool>,
	#[serde(default, with = "int_bool::opt", skip_serializing_if = "Option::is_none")]
	pub is_fallback_error: Option<bool>,
	#[serde(
		rename = "is_signal_upgradable",
		default,
		with = "int_bool::opt",
		skip_serializing_if = "Option::is_none"
	)]
	pub is_signal_upgradable_snake: Option<bool>,
	#[serde(rename = "m", default, skip_serializing_if = "Option::is_none")]
	pub model_tag: Option<String>, // "nl54" (?)
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub max_age_override: Option<u32>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub more_questions: Option<MoreQuestions>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub organics_source: Option<String>, // "xa" | "sd" (?)
	#[serde(rename = "p", default, skip_serializing_if = "Option::is_none")]
	pub pipeline_hash: Option<String>,
	#[serde(default, with = "loose_f64::opt", skip_serializing_if = "Option::is_none")]
	pub score: Option<f64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub search_country: Option<String>, // "ca", "us"
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub shortlisted_sources: Vec<IaSource>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub sorry_reason: Option<String>, // (?) null so far;
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub sources: Vec<IaSource>,
	#[serde(default, with = "loose_u32::opt", skip_serializing_if = "Option::is_none")]
	pub sources_count: Option<u32>, // "2", a string
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub timestamp: Option<i64>, // unix seconds
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub trigger_signal: Option<SignalStrength>,
	#[serde(default, with = "int_bool::opt", skip_serializing_if = "Option::is_none")]
	pub youcom_news_data: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoreQuestions {
	pub more_questions: Vec<String>, // yes
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IaSource {
	pub article: IaArticle,
	pub section: serde_json::Map<String, Value>, // (?) always {} so far
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IaArticle {
	pub link: String,
	pub site: String, // "Wikipedia" | "natakallam.com" -- display name OR bare host
	pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostData {
	pub abstracts: Vec<Value>, // (?) []
	pub auto_sorry_reason: Option<String>,
	pub bing_market: String, // "" | "en-US"
	pub country_code: String,
	pub deep_wiki_title: Option<String>,
	pub domains: Vec<String>,
	pub dominant_result_language: String,
	#[serde(rename = "dw")]
	pub deep_wiki_mode: u32, // (?)
	pub entities: Vec<String>,
	#[serde(with = "int_bool")]
	pub fresh_news_required: bool,
	#[serde(rename = "genericized_query_l0")]
	pub genericized_query_level0: Option<String>, // "<Q134556> <Q5>" or null
	#[serde(rename = "genericized_query_l1")]
	pub genericized_query_level1: Option<String>, // "<ENTITY>"
	#[serde(rename = "genericized_query_l2")]
	pub genericized_query_level2: Option<String>,
	#[serde(with = "int_bool")]
	pub has_ads: bool,
	pub index_wiki_title: String,
	#[serde(with = "int_bool")]
	pub is_news_heavy: bool,
	pub news_heavy_trigger_reasons: Vec<String>,
	pub news_slot_rank: u32,
	pub num_top_ten_urls_within_thirty_days: u32,
	pub num_top_ten_urls_within_two_days: u32,
	#[serde(rename = "q")]
	pub query: String,
	pub query_language: String,
	pub ranks: Vec<Value>, // (?) [] prob
	#[serde(rename = "serp_timestamp")]
	pub serp_unix_timestamp: i64,
	pub spelling_suggestion: Option<String>,
	#[serde(default)]
	pub supported_wikidata_prop_matches: Option<Vec<Value>>,
	pub titles: Vec<String>,
	pub trigger_version: u32,
	pub urls: Vec<String>,
	pub wiki_entities_from_organics: Vec<WikiEntityFromOrganics>,
	pub wikidata_ids: Vec<String>,
	pub wikidata_instance_of_ids: Vec<String>,
	pub wikidata_property_aliases_in_query: Vec<Value>, // (?) []
	pub word_shingles_from_organics: Vec<WordShingle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiEntityFromOrganics {
	pub count:             u32,
	pub exact_match_count: u32,
	pub min_index:         u32,
	pub wiki_entity_name:  String, // "Say Hello"
	pub word_shingles:     Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordShingle {
	pub count:        u32,
	pub min_index:    u32,
	pub rank:         u32,
	pub word_shingle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedTabs {
	pub max_visible_tabs: u32,
	pub tab_order:        Vec<SearchTab>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchTab {
	Images,
	Videos,
	News,
	MapsExpanded,
	Products,
	#[serde(other)]
	Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OrganicEntry {
	Result(Box<OrganicResult>),
	NextPage(NextPageCursor),
	NoResult {
		#[serde(rename = "t")]
		reason: NoResultReason,
	},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoResultReason {
	#[serde(rename = "DEEP_SIMPLE_NO_RESULTS")]
	DeepSimpleNoResults,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextPageCursor {
	#[serde(rename = "n")]
	pub next_page_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganicResult {
	#[serde(rename = "a")]
	pub abstract_html:         String, // contains <b> tags + &#x27; entities
	#[serde(rename = "ae")]
	pub abstract_extended:     Option<Value>, // (?)
	#[serde(rename = "b", default, skip_serializing_if = "Option::is_none")]
	pub source_badge:          Option<SourceBadge>,
	#[serde(rename = "c")]
	pub click_url:             String,
	#[serde(rename = "d")]
	pub display_url:           String, // percent-DEcoded
	#[serde(rename = "da")]
	pub deep_answer_verticals: CommaList, /* "videos,wheretowatch", "translations",
	                                       * "apps_domains,..." */
	#[serde(rename = "e", default, skip_serializing_if = "Option::is_none")]
	pub last_modified:         Option<String>, /* "2026-01-17T00:00:00.0000000",
	                                            * chrono::NaiveDateTime parses it */
	#[serde(rename = "h")]
	pub highlight_flag:        u8, // (?)
	#[serde(rename = "i")]
	pub hostname:              String,
	#[serde(rename = "k")]
	pub knowledge_panel:       Option<Value>, // (?)
	#[serde(rename = "l", default, skip_serializing_if = "Option::is_none")]
	pub sitelinks:             Option<Vec<Sitelink>>,
	#[serde(rename = "m")]
	pub module_flag:           u8, // (?)
	#[serde(rename = "o")]
	pub override_flag:         u8, // (?)
	#[serde(rename = "p")]
	pub is_paid:               u8, // (?)
	#[serde(rename = "rf", default, skip_serializing_if = "Option::is_none")]
	pub rich_fields:           Option<Vec<RichField>>, // can be [] too
	#[serde(rename = "s")]
	pub upstream_source:       String, // "bingv7aa", same as setUpstream(...)
	#[serde(rename = "sn", default, skip_serializing_if = "Option::is_none")]
	pub site_name:             Option<String>, // may hold entities or trailing spaces
	#[serde(rename = "t")]
	pub title:                 String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub thumbnail_url:         Option<String>, // full words for once! bing th?id=... url
	#[serde(rename = "u")]
	pub url:                   String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub video:                 Option<VideoInfo>,
}

impl OrganicResult {
	pub fn sitelinks(&self) -> impl Iterator<Item = &Sitelink> {
		self.sitelinks.iter().flatten()
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sitelink {
	pub snippet:    String,
	#[serde(rename = "targetUrl")]
	pub target_url: String, // camelCase, inside a single-letter-key object. why not
	pub text:       String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RichField {
	pub hint:  TextNode, // "MEDIA:DURATION", "BASE:AUTHOR", "BASE:VIEWSCOUNT"
	pub items: Vec<TextNode>,
	pub label: TextNode, // localized
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextNode {
	pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
	pub duration:               String, // "27:53"
	#[serde(rename = "height")]
	pub thumbnail_height:       u32,
	#[serde(default, with = "int_bool::opt", skip_serializing_if = "Option::is_none")]
	pub is_navigational_video:  Option<bool>,
	pub statistics:             VideoStatistics,
	pub thumbnail_url_template: String,
	#[serde(rename = "width")]
	pub thumbnail_width:        u32,
}

impl VideoInfo {
	/// fills the {width}/{height} holes in the template
	pub fn thumbnail_url(&self, width: u32, height: u32) -> String {
		self
			.thumbnail_url_template
			.replace("{width}", &width.to_string())
			.replace("{height}", &height.to_string())
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoStatistics {
	#[serde(default, with = "loose_u64::opt")]
	pub view_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourceBadge {
	pub badge_id:     String,
	pub display_name: String,
	pub domain:       String,
}

impl TryFrom<String> for SourceBadge {
	type Error = String;

	fn try_from(raw: String) -> Result<Self, Self::Error> {
		let mut parts = raw.splitn(3, '\t');
		match (parts.next(), parts.next(), parts.next()) {
			(Some(id), Some(name), Some(domain)) => Ok(Self {
				badge_id:     id.to_owned(),
				display_name: name.to_owned(),
				domain:       domain.to_owned(),
			}),
			_ => Err(format!("expected 3 tab-separated parts, got {raw:?}")),
		}
	}
}

impl From<SourceBadge> for String {
	fn from(b: SourceBadge) -> Self {
		format!("{}\t{}\t{}", b.badge_id, b.display_name, b.domain)
	}
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub struct CommaList(pub Vec<String>);

impl From<String> for CommaList {
	fn from(raw: String) -> Self {
		Self(
			raw.split(',')
				.filter(|s| !s.is_empty())
				.map(str::to_owned)
				.collect(),
		)
	}
}

impl From<CommaList> for String {
	fn from(list: CommaList) -> Self {
		list.0.join(",")
	}
}

//  duckbar modules sharing the {ads, query, results, vqd}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuckbarModule<R> {
	// pub ads: Vec<Value>, // idk we probably dont need it
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub count_top_us_news_domains: Option<u32>, // news-only extra
	pub query:                     String,
	#[serde(rename = "queryEncoded")]
	pub query_encoded:             String,
	pub response_type:             String, // "places" on literally every module wtf
	pub results:                   Vec<R>,
	#[serde(rename = "vqd")]
	pub query_verification_tokens: HashMap<String, String>, // encoded query -> token
}

pub type ImagesModule = DuckbarModule<ImageResult>;
pub type NewsModule = DuckbarModule<NewsResult>;
pub type VideosModule = DuckbarModule<VideoResult>;
pub type RelatedSearchesModule = DuckbarModule<RelatedSearch>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageResult {
	pub discovery_date:  Option<String>, // (?)
	pub encoding_format: ImageFormat,
	pub height:          u32,
	#[serde(rename = "image")]
	pub image_url:       String,
	pub image_token:     String,
	#[serde(rename = "source")]
	pub provider:        String, // "Bing" lol
	#[serde(rename = "thumbnail")]
	pub thumbnail_url:   String,
	pub thumbnail_token: String,
	pub title:           String,
	#[serde(rename = "url")]
	pub source_page_url: String,
	pub width:           u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
	Jpeg,
	Png,
	Gif,
	Webp,
	#[serde(other)]
	Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsResult {
	#[serde(rename = "date")]
	pub unix_date:     i64,
	pub excerpt:       String, // html w/ <b>, often cut mid-word
	// 1 = go fetch an image yourself prob.
	#[serde(default, with = "int_bool::opt", skip_serializing_if = "Option::is_none")]
	pub fetch_image:   Option<bool>,
	#[serde(rename = "image", default, skip_serializing_if = "Option::is_none")]
	pub image_url:     Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub image_token:   Option<String>,
	pub relative_time: String, // english only
	pub source:        String,
	pub syndicate:     String, // "bing"
	pub title:         String,
	pub url:           String,
	#[serde(with = "int_bool")]
	pub use_relevancy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoResult {
	#[serde(rename = "content")]
	pub video_url:        String,
	pub description:      String,
	pub duration:         String, // "4:18"
	pub embed_html:       String, // "" for tiktok
	pub embed_url:        String, // "" for tiktok
	pub image_token:      String,
	pub images:           VideoThumbnails,
	pub provider:         String, // "Bing"
	pub published:        String, // chrono
	pub publisher:        String, // "YouTube" | "TikTok"
	pub statistics:       VideoResultStatistics,
	pub thumbnail_height: u32,
	pub thumbnail_width:  u32,
	pub title:            String,
	pub uploader:         String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoThumbnails {
	pub large:  String,
	pub medium: String,
	pub motion: String, // "" unless there's an animated preview
	pub small:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoResultStatistics {
	#[serde(rename = "viewCount")]
	pub view_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelatedSearch {
	pub display_text:   String, // html; inverse highlight
	pub text:           String,
	pub web_search_url: String, // "?q=...&origin=related"
}

/// DDG.duckbar.loadModule('translations', { results: {...} })
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationsModule {
	pub results: Translation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Translation {
	#[serde(rename = "original_language_name")]
	pub original_language:   String, // "en"
	pub original_text:       String,
	#[serde(rename = "translated_language_name")]
	pub translated_language: String, // "es"
	pub translated_text:     String,
}

// the wikipedia About panel
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FatheadModule {
	pub data:          FatheadData,
	pub duckbar_topic: String, // "About"
	#[serde(rename = "from")]
	pub provider:      String, // "deep_answer"
	pub meta:          IaMeta, // identical copy of data.meta
	pub model:         String, // "FatheadArticle"
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub official_site: Option<String>,
	pub pixel_id:      String, // "wikipedia_fathead_deep"
	pub signal:        SignalStrength,
	pub templates:     HashMap<String, String>, // {"detail": "info_detail"}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct FatheadData {
	#[serde(rename = "Abstract")]
	pub abstract_html:     String,
	pub abstract_source:   String,
	pub abstract_text:     String,
	#[serde(rename = "AbstractURL")]
	pub abstract_url:      String,
	pub answer:            String,
	pub answer_type:       String,
	pub definition:        String,
	pub definition_source: String,
	#[serde(rename = "DefinitionURL")]
	pub definition_url:    String,
	pub entity:            String, // "musician", "music", "infobox" etc
	pub heading:           String,
	pub image:             String, // "" or relative "/i/39959457e1388218.png"
	pub image_height:      u32,
	#[serde(with = "int_bool")]
	pub image_is_logo:     bool,
	pub image_width:       u32,
	#[serde(with = "empty_none")]
	pub infobox:           Option<Infobox>, // "" when the article has none
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub official_domain:   Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub official_website:  Option<String>,
	pub redirect:          String,
	pub related_topics:    Vec<RelatedTopic>,
	pub results:           Vec<RelatedTopic>,
	#[serde(rename = "Type")]
	pub kind:              FatheadType,
	#[serde(rename = "meta")]
	pub meta:              IaMeta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FatheadType {
	#[serde(rename = "A")]
	Article,
	#[serde(rename = "D")]
	Disambiguation,
	#[serde(rename = "C")]
	Category,
	#[serde(rename = "N")]
	Name,
	#[serde(rename = "E")]
	Exclusive,
	#[serde(rename = "")]
	Nothing,
	#[serde(other)]
	Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct RelatedTopic {
	#[serde(rename = "FirstURL")]
	pub first_url:   String,
	pub icon:        Icon,
	#[serde(rename = "Result")]
	pub result_html: String, // "<a href=...>Text</a>"
	pub text:        String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Icon {
	#[serde(with = "loose_u32::opt")]
	pub height: Option<u32>,
	#[serde(rename = "URL")]
	pub url:    String, // "" or relative "/i/d-ue.jp.ico"
	#[serde(with = "loose_u32::opt")]
	pub width:  Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Infobox {
	pub content: Vec<InfoboxEntry>,
	#[serde(default)]
	pub meta:    Vec<InfoboxMeta>, // absent on some wikidata-only boxes ("calendar")
}

impl Infobox {
	pub fn get(&self, label: &str) -> Option<&InfoboxValue> {
		self
			.content
			.iter()
			.find(|e| e.label == label)
			.map(|e| &e.value)
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfoboxEntry {
	pub data_type:  InfoboxDataType,
	pub label:      String,
	#[serde(default, with = "loose_u32::opt", skip_serializing_if = "Option::is_none")]
	pub sort_order: Option<u32>,
	pub value:      InfoboxValue,
	#[serde(with = "loose_u32")]
	pub wiki_order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfoboxMeta {
	pub data_type: InfoboxDataType,
	pub label:     String, // "article_title", "template_name", "above", "caption"
	pub value:     String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InfoboxDataType {
	#[serde(rename = "string")]
	Text,
	YoutubeChannel,
	TwitterProfile,
	InstagramProfile,
	FacebookProfile,
	ImdbId,
	RottenTomatoes,
	SpotifyArtistId,
	SoundcloudId,
	GooglePlayArtistId, // RIP google play music
	ItunesArtistId,
	Instance,
	OfficialWebsite,
	DateOfBirth,
	WdDescription,
	WikidataId,
	WikidataLabel,
	WikidataAliases,
	#[serde(other)]
	Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InfoboxValue {
	Text(String),
	List(Vec<String>),
	Entity(WikidataEntityRef),
	Time(WikidataTime),
	Other(Value),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikidataEntityRef {
	#[serde(rename = "entity-type")]
	pub entity_type: String, // "item"
	pub id:          String, // "Q5"
	#[serde(rename = "numeric-id")]
	pub numeric_id:  u64, // 5
}

/// raw wikidata time datavalue
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikidataTime {
	pub after:         i64,
	pub before:        i64,
	pub calendarmodel: String,
	pub precision:     u8,
	pub time:          String,
	pub timezone:      i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IaMeta {
	pub attribution:      Option<Value>,  // (?) null
	pub blockgroup:       Option<Value>,  // (?) null
	pub created_date:     Option<String>, // (?) null; name says date
	pub description:      String,
	pub designer:         Option<Value>,  // (?) null
	pub dev_date:         Option<String>, // (?) null
	pub dev_milestone:    String,         // "live"
	pub developer:        Vec<IaDeveloper>,
	pub example_query:    String,
	pub id:               String,
	pub is_stackexchange: Option<Value>, // (?) null; prob 0/1 when set
	pub js_callback_name: String,
	pub live_date:        Option<String>, // (?) null
	pub maintainer:       IaMaintainer,
	pub name:             String,
	pub perl_module:      String,        // "DDG::Fathead::Wikipedia"
	pub producer:         Option<Value>, // (?) null
	pub production_state: String,
	pub repo:             String,
	pub signal_from:      String,
	pub src_domain:       String,
	pub src_id:           u32,
	pub src_name:         String,
	pub src_options:      SrcOptions,
	pub src_url:          Option<String>, // (?) null
	pub status:           String,
	pub tab:              String, // "About"
	pub topic:            Vec<String>,
	#[serde(rename = "unsafe", with = "int_bool")]
	pub is_unsafe:        bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IaDeveloper {
	pub name: String,
	#[serde(rename = "type")]
	pub kind: String, // "ddg"
	pub url:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IaMaintainer {
	pub github: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SrcOptions {
	pub directory:           String,
	#[serde(with = "int_bool")]
	pub is_fanon:            bool,
	#[serde(with = "int_bool")]
	pub is_mediawiki:        bool,
	#[serde(with = "int_bool")]
	pub is_wikipedia:        bool,
	pub language:            String,
	#[serde(with = "loose_u32")]
	pub min_abstract_length: u32, // arrives as "20"
	#[serde(with = "int_bool")]
	pub skip_abstract:       bool,
	#[serde(with = "int_bool")]
	pub skip_abstract_paren: bool,
	pub skip_end:            String,
	#[serde(with = "int_bool")]
	pub skip_icon:           bool,
	#[serde(with = "int_bool")]
	pub skip_image_name:     bool,
	pub skip_qr:             String,
	pub source_skip:         String,
	pub src_info:            String,
}

/// language code -> urls in that language
pub type ResultLanguages = HashMap<String, Vec<String>>;
pub type AdLanguages = ResultLanguages;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageLayout {
	pub mainline: LayoutColumn,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub sidebar:  Option<LayoutColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutColumn {
	#[serde(rename = "items")]
	pub slots: Vec<Vec<String>>, /* [["organic"], ["news"], ["videos"], ["translations"],
	                              * ["wikipedia_fathead"], ...] */
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeepMeta {
	pub upstream:              Option<String>, // setUpstream("bingv7aa")
	pub ad_unit_index:         Option<String>,
	pub alt_is_navigational:   Option<bool>, // DDG.search.altIsNavigational = 1
	pub wikipedia_exact_match: Option<bool>, // wikipediaExactMatch = 1
	pub signal_summary:        Option<SignalSummary>, // "about:m,lyrics:h,wikinlp:l" | ""
	pub page_layout_summary:   Option<LayoutSummary>,
	pub bn:                    Option<DeepBn>, // {'ivc': 1} idk
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub future_signal_tabs:    Vec<FutureSignalTab>, // fires 0..n times
	//#[serde(default, skip_serializing_if = "Vec::is_empty")]
	// pub deferred_loads: Vec<DeferredLoad>, // nrj
	pub layout_start:          Option<u32>, // initialize(..., {start: 0})
	#[serde(default)]
	pub related_qna_loaded:    bool, // loadModule('related_qna') with zero payload
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepBn {
	pub ivc: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FutureSignalTab {
	pub signal:   SignalStrength,
	#[serde(rename = "from")]
	pub provider: String, // "deep_answer" | "lyrics"
}

// #[derive(Debug, Clone, Serialize, Deserialize)]
// pub struct DeferredLoad {
//     pub path: String,
//     pub middle_args: Vec<Value>,
//     pub module: String,
// }

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub struct SignalSummary(pub Vec<SignalSummaryEntry>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalSummaryEntry {
	pub source: String,
	pub signal: SignalStrength,
}

impl From<String> for SignalSummary {
	fn from(raw: String) -> Self {
		Self(
			raw.split(',')
				.filter(|s| !s.is_empty())
				.map(|pair| match pair.split_once(':') {
					Some((src, sig)) => SignalSummaryEntry {
						source: src.to_owned(),
						signal: SignalStrength::from_initial(sig),
					},
					None => {
						SignalSummaryEntry { source: pair.to_owned(), signal: SignalStrength::Unknown }
					},
				})
				.collect(),
		)
	}
}

impl From<SignalSummary> for String {
	fn from(s: SignalSummary) -> Self {
		s.0.iter()
			.map(|e| format!("{}:{}", e.source, e.signal.initial()))
			.collect::<Vec<_>>()
			.join(",")
	}
}

/// "t1w1rqa1w9r1,e1" = translations, 1 organic, related_qna, 9 organics,
/// related_searches | fathead codes prob: w=organic, n=news, i=images,
/// v=videos, t=translations,             r=related_searches, rqa=related_qna,
/// e=wikipedia_fathead
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub struct LayoutSummary(pub Vec<Vec<LayoutRun>>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutRun {
	pub code:  String,
	pub count: u32,
}

impl LayoutSummary {
	pub fn mainline(&self) -> &[LayoutRun] {
		self.0.first().map(Vec::as_slice).unwrap_or(&[])
	}

	pub fn sidebar(&self) -> &[LayoutRun] {
		self.0.get(1).map(Vec::as_slice).unwrap_or(&[])
	}
}

fn parse_layout_runs(col: &str) -> Vec<LayoutRun> {
	let mut runs = Vec::new();
	let mut code = String::new();
	let mut digits = String::new();
	for ch in col.chars() {
		if ch.is_ascii_digit() {
			digits.push(ch);
		} else {
			if !digits.is_empty() {
				runs.push(LayoutRun {
					code:  std::mem::take(&mut code),
					count: digits.parse().unwrap_or(0),
				});
				digits.clear();
			}
			code.push(ch);
		}
	}
	if !code.is_empty() || !digits.is_empty() {
		runs.push(LayoutRun { code, count: digits.parse().unwrap_or(0) });
	}
	runs
}

impl From<String> for LayoutSummary {
	fn from(raw: String) -> Self {
		Self(
			raw.split(',')
				.filter(|c| !c.is_empty())
				.map(parse_layout_runs)
				.collect(),
		)
	}
}

impl From<LayoutSummary> for String {
	fn from(s: LayoutSummary) -> Self {
		s.0.iter()
			.map(|col| {
				col.iter()
					.map(|r| format!("{}{}", r.code, r.count))
					.collect::<String>()
			})
			.collect::<Vec<_>>()
			.join(",")
	}
}

#[derive(serde::Deserialize)]
pub struct LayoutOpts {
	pub start: u32,
}

/// upstream sends "" where an object is absent
mod empty_none {
	use serde::{
		Deserialize, Deserializer, Serialize, Serializer,
		de::{DeserializeOwned, Error},
	};
	use serde_json::Value;

	pub fn serialize<T: Serialize, S: Serializer>(
		value: &Option<T>,
		s: S,
	) -> Result<S::Ok, S::Error> {
		match value {
			Some(value) => value.serialize(s),
			None => s.serialize_str(""), // keep upstream's format
		}
	}

	// buffered through Value (not an untagged enum) so a bad object keeps its
	// real error
	pub fn deserialize<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
	where
		T: DeserializeOwned,
		D: Deserializer<'de>,
	{
		match Value::deserialize(d)? {
			Value::String(s) if s.is_empty() => Ok(None),
			value => T::deserialize(value).map(Some).map_err(D::Error::custom),
		}
	}
}

mod int_bool {
	use serde::{Deserialize, Deserializer, Serializer, de::Error};

	pub fn serialize<S: Serializer>(value: &bool, s: S) -> Result<S::Ok, S::Error> {
		s.serialize_u8(*value as u8)
	}

	pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
		match u8::deserialize(d)? {
			0 => Ok(false),
			1 => Ok(true),
			n => Err(D::Error::custom(format!("expected 0 or 1, got {n}"))),
		}
	}

	/// same, for fields that only show up sometimes (pair with `default`)
	pub mod opt {
		use serde::{Deserialize, Deserializer, Serializer, de::Error};

		pub fn serialize<S: Serializer>(value: &Option<bool>, s: S) -> Result<S::Ok, S::Error> {
			match value {
				Some(b) => s.serialize_u8(*b as u8),
				None => s.serialize_none(),
			}
		}

		pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
			match Option::<u8>::deserialize(d)? {
				None => Ok(None),
				Some(0) => Ok(Some(false)),
				Some(1) => Ok(Some(true)),
				Some(n) => Err(D::Error::custom(format!("expected 0 or 1, got {n}"))),
			}
		}
	}
}

mod loose_u64 {
	pub mod opt {
		use serde::{Deserialize, Deserializer, Serializer, de::Error};

		#[derive(Deserialize)]
		#[serde(untagged)]
		enum Raw {
			Num(u64),
			Str(String),
		}

		pub fn serialize<S: Serializer>(n: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
			match n {
				Some(n) => s.collect_str(n), // keep upstream's stringly format
				None => s.serialize_none(),
			}
		}

		pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
			match Option::<Raw>::deserialize(d)? {
				None => Ok(None),
				Some(Raw::Num(n)) => Ok(Some(n)),
				Some(Raw::Str(s)) if s.is_empty() => Ok(None),
				Some(Raw::Str(s)) => s.parse().map(Some).map_err(D::Error::custom),
			}
		}
	}
}

mod loose_u32 {
	use serde::{Deserialize, Deserializer, Serializer, de::Error};

	#[derive(Deserialize)]
	#[serde(untagged)]
	enum Raw {
		Num(u64),
		Str(String),
	}

	fn parse(raw: Raw) -> Result<Option<u32>, String> {
		match raw {
			Raw::Num(n) => u32::try_from(n).map(Some).map_err(|e| e.to_string()),
			Raw::Str(s) if s.is_empty() => Ok(None),
			Raw::Str(s) => s.parse::<u32>().map(Some).map_err(|e| e.to_string()),
		}
	}

	pub fn serialize<S: Serializer>(n: &u32, s: S) -> Result<S::Ok, S::Error> {
		s.serialize_u32(*n)
	}

	pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
		parse(Raw::deserialize(d)?)
			.map_err(D::Error::custom)?
			.ok_or_else(|| D::Error::custom("expected a number, got \"\""))
	}

	pub mod opt {
		use serde::{Deserialize, Deserializer, Serializer, de::Error};

		pub fn serialize<S: Serializer>(n: &Option<u32>, s: S) -> Result<S::Ok, S::Error> {
			match n {
				Some(n) => s.serialize_u32(*n),
				None => s.serialize_str(""),
			}
		}

		pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
			Option::<super::Raw>::deserialize(d)?
				.map(super::parse)
				.transpose()
				.map_err(D::Error::custom)
				.map(Option::flatten)
		}
	}
}

mod loose_f64 {
	pub mod opt {
		use serde::{Deserialize, Deserializer, Serializer, de::Error};

		#[derive(Deserialize)]
		#[serde(untagged)]
		enum Raw {
			Num(f64),
			Str(String),
		}

		pub fn serialize<S: Serializer>(n: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
			match n {
				Some(n) => s.serialize_f64(*n),
				None => s.serialize_none(),
			}
		}

		pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
			match Option::<Raw>::deserialize(d)? {
				None => Ok(None),
				Some(Raw::Num(n)) => Ok(Some(n)),
				Some(Raw::Str(s)) if s.is_empty() => Ok(None),
				Some(Raw::Str(s)) => s.parse().map(Some).map_err(D::Error::custom),
			}
		}
	}
}
