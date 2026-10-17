pub mod brave;
pub mod duckduckgo;

use std::{any::Any, error::Error, fmt, ops::BitOr, str::FromStr, sync::Arc};

pub use brave::Brave;
pub use duckduckgo::DuckDuckGo;
use tokio::task::{AbortHandle, JoinSet};

#[allow(async_fn_in_trait)]
pub trait Engine: Send + Sync {
	/// Identifier reported in votes and failures.
	const NAME: &'static str;

	type Error: Error + Send + Sync + 'static;

	/// Engine-specific position of a following page.
	type Cursor: Send + Sync + 'static;

	fn capabilities(&self) -> Capabilities;

	async fn search(
		&self,
		query: &Query,
		cursor: Option<&Self::Cursor>,
	) -> Result<(Page, Option<Self::Cursor>), Self::Error>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
	pub verticals: Verticals,
	/// [`Metadata`] the engine can attach to web hits.
	pub metadata:  MetadataKinds,
	/// [`Panel`]s the engine can show beside its results.
	pub panels:    PanelKinds,
	/// Regions the engine searches in. A [`Query::region`] outside them falls
	/// back to a market in the same country, then to the engine's default.
	pub markets:   &'static [Market],
}

/// Defines a set of named flags with set operations.
macro_rules! flags {
    ($(#[$doc:meta])* $name:ident { $($flag:ident = $bit:literal,)* }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
        pub struct $name(u8);

        impl $name {
            pub const NONE: Self = Self(0);
            $(pub const $flag: Self = Self(1 << $bit);)*
            pub const ALL: Self = Self(0 $(| 1 << $bit)*);

            pub const fn contains(self, other: Self) -> bool {
                self.0 & other.0 == other.0
            }

            pub const fn intersects(self, other: Self) -> bool {
                self.0 & other.0 != 0
            }
        }

        impl BitOr for $name {
            type Output = Self;

            fn bitor(self, rhs: Self) -> Self {
                Self(self.0 | rhs.0)
            }
        }
    };
}

flags! {
	 /// Set of result verticals.
	 Verticals { WEB = 0, NEWS = 1, IMAGES = 2, VIDEOS = 3, }
}

flags! {
	 /// Set of [`Metadata`] kinds, one per field.
	 MetadataKinds { DISCUSSION = 0, FAQ = 1, ARTICLE = 2, VIDEO = 3, FACTS = 4, }
}

flags! {
	 /// Set of [`PanelKind`]s.
	 PanelKinds { ENTITY = 0, ANSWER = 1, TRANSLATION = 2, CORRECTION = 3, }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
	pub text:       String,
	pub safesearch: SafeSearch,
	/// `None` searches worldwide.
	pub region:     Option<Region>,
	/// Verticals to collect; engines covering none of them are not queried.
	pub verticals:  Verticals,
	/// [`Metadata`] to keep on web hits; the rest is dropped.
	pub metadata:   MetadataKinds,
	/// [`Panel`]s to keep; the rest is dropped.
	pub panels:     PanelKinds,
}

impl Query {
	pub fn new(text: impl Into<String>) -> Self {
		Self {
			text:       text.into(),
			safesearch: SafeSearch::default(),
			region:     None,
			verticals:  Verticals::ALL,
			metadata:   MetadataKinds::ALL,
			panels:     PanelKinds::ALL,
		}
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum SafeSearch {
	Strict,
	Moderate,
	#[default]
	Off,
}

/// ISO 639 language plus ISO 3166-1 alpha-2 country
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Region {
	/// Lowercase, space-padded to three letters.
	language: [u8; 3],
	/// Uppercase.
	country:  [u8; 2],
}

pub type Market = (&'static str, &'static str, &'static str);

impl Region {
	pub fn language(&self) -> &str {
		ascii(&self.language).trim_end()
	}

	pub fn country(&self) -> &str {
		ascii(&self.country)
	}

	/// Engine code of the closest market in `markets`.
	fn market(self, markets: &[Market]) -> Option<&'static str> {
		let (language, country) = (self.language(), self.country());
		markets
			.iter()
			.find(|&&(l, c, _)| l == language && c == country)
			.or_else(|| markets.iter().find(|&&(_, c, _)| c == country))
			.map(|&(_, _, code)| code)
	}
}

fn ascii(bytes: &[u8]) -> &str {
	std::str::from_utf8(bytes).expect("region subtags are ASCII letters")
}

impl FromStr for Region {
	type Err = ParseRegionError;

	fn from_str(tag: &str) -> Result<Self, Self::Err> {
		let alpha = |s: &str, lengths: &[usize]| {
			lengths.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic())
		};
		let mut subtags = tag.split(['-', '_']);
		let subtags = [(); 4].map(|()| subtags.next());
		let (language, country) = match subtags {
			[Some(language), Some(country), None, _] => (language, country),
			[Some(language), Some(script), Some(country), None] if alpha(script, &[4]) => {
				(language, country)
			},
			_ => return Err(ParseRegionError),
		};
		if !alpha(language, &[2, 3]) || !alpha(country, &[2]) {
			return Err(ParseRegionError);
		}

		let mut region = Region { language: *b"   ", country: [0; 2] };
		for (slot, b) in region.language.iter_mut().zip(language.bytes()) {
			*slot = b.to_ascii_lowercase();
		}
		for (slot, b) in region.country.iter_mut().zip(country.bytes()) {
			*slot = b.to_ascii_uppercase();
		}
		Ok(region)
	}
}

impl fmt::Display for Region {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}-{}", self.language(), self.country())
	}
}

impl fmt::Debug for Region {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "Region({self})")
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseRegionError;

impl fmt::Display for ParseRegionError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("expected a `language-COUNTRY` tag")
	}
}

impl Error for ParseRegionError {}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Page {
	pub web:     Vec<WebHit>,
	pub news:    Vec<NewsHit>,
	pub images:  Vec<ImageHit>,
	pub videos:  Vec<VideoHit>,
	/// Related query suggestions.
	pub related: Vec<String>,
	/// Page-level boxes, in engine order.
	pub panels:  Vec<Panel>,
}

pub trait Hit {
	/// Identity of the result: its URL for hits, see [`Panel`] for panels.
	fn url(&self) -> &str;

	/// Fills fields this hit lacks from `other`, a duplicate of the same
	/// resource.
	fn absorb(&mut self, other: Self);
}

/// | kind          | `title`          | `subtitle`        | `text`         | `url`              |
/// |---------------|------------------|-------------------|----------------|--------------------|
/// | `Entity`      | name             | short description | abstract       | source article     |
/// | `Answer`      | question (query) | –                 | answer         | –                  |
/// | `Translation` | translated text  | `en → es`         | original text  | –                  |
/// | `Correction`  | corrected query  | –                 | –              | –                  |
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Panel {
	pub kind:     PanelKind,
	pub title:    String,
	pub subtitle: Option<String>,
	pub text:     String,
	pub url:      Option<String>,
	pub image:    Option<String>,
	/// Attribution, e.g. `"Wikipedia"`.
	pub source:   Option<String>,
	/// Labelled values, e.g. infobox rows.
	pub facts:    Vec<Fact>,
	/// Official site, profiles, cited sources.
	pub links:    Vec<Link>,
	/// Follow-up queries the panel suggests.
	pub related:  Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelKind {
	/// Knowledge panel about a person, place, thing, ...
	Entity,
	/// Direct answer to the query.
	Answer,
	Translation,
	/// The query the engine believes was meant ("did you mean").
	Correction,
}

impl PanelKind {
	pub const ALL: [Self; 4] = [Self::Entity, Self::Answer, Self::Translation, Self::Correction];

	pub const fn flag(self) -> PanelKinds {
		match self {
			Self::Entity => PanelKinds::ENTITY,
			Self::Answer => PanelKinds::ANSWER,
			Self::Translation => PanelKinds::TRANSLATION,
			Self::Correction => PanelKinds::CORRECTION,
		}
	}
}

impl Panel {
	/// An empty card of `kind` titled `title`.
	pub fn new(kind: PanelKind, title: String) -> Self {
		Self {
			kind,
			title,
			subtitle: None,
			text: String::new(),
			url: None,
			image: None,
			source: None,
			facts: Vec::new(),
			links: Vec::new(),
			related: Vec::new(),
		}
	}
}

impl Hit for Panel {
	fn url(&self) -> &str {
		match self.kind {
			PanelKind::Entity => self.url.as_deref().unwrap_or(&self.title),
			PanelKind::Answer => &self.text,
			PanelKind::Translation | PanelKind::Correction => &self.title,
		}
	}

	fn absorb(&mut self, other: Self) {
		self.subtitle = self.subtitle.take().or(other.subtitle);
		fill(&mut self.text, other.text);
		self.url = self.url.take().or(other.url);
		self.image = self.image.take().or(other.image);
		self.source = self.source.take().or(other.source);
		union_by(&mut self.facts, other.facts, |fact| fact.label.as_str());
		union_by(&mut self.links, other.links, |link| link.url.as_str());
		union_by(&mut self.related, other.related, String::as_str);
	}
}

/// `published` is an ISO-8601 timestamp as reported by the engine; the offset
/// may be missing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebHit {
	pub url:       String,
	pub title:     String,
	pub snippet:   String,
	pub site:      Option<String>,
	pub favicon:   Option<String>,
	pub published: Option<String>,
	pub thumbnail: Option<String>,
	pub sitelinks: Vec<Link>,
	pub metadata:  Metadata,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Link {
	pub title: String,
	pub url:   String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
	/// The page is a forum thread (Reddit, Stack Exchange, ...).
	pub discussion: Option<Discussion>,
	/// Question and answer pairs the page publishes.
	pub faq:        Vec<FaqEntry>,
	pub article:    Option<Article>,
	/// The page plays a video.
	pub video:      Option<VideoDetails>,
	/// Engine-labelled facts without a dedicated field, e.g. a rating.
	pub facts:      Vec<Fact>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Discussion {
	pub question: Option<String>,
	pub answers:  Vec<Answer>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Answer {
	pub text:  String,
	pub votes: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FaqEntry {
	pub question: String,
	pub answer:   String,
	pub url:      Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Article {
	pub authors:   Vec<Author>,
	pub publisher: Option<String>,
	pub date:      Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Author {
	pub name: String,
	pub url:  Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VideoDetails {
	pub duration:  Option<String>,
	pub views:     Option<u64>,
	pub creator:   Option<String>,
	pub publisher: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fact {
	pub label:  String,
	pub values: Vec<String>,
}

impl Metadata {
	pub fn is_empty(&self) -> bool {
		self.discussion.is_none()
			&& self.faq.is_empty()
			&& self.article.is_none()
			&& self.video.is_none()
			&& self.facts.is_empty()
	}

	fn retain(&mut self, kinds: MetadataKinds) {
		if !kinds.contains(MetadataKinds::DISCUSSION) {
			self.discussion = None;
		}
		if !kinds.contains(MetadataKinds::FAQ) {
			self.faq.clear();
		}
		if !kinds.contains(MetadataKinds::ARTICLE) {
			self.article = None;
		}
		if !kinds.contains(MetadataKinds::VIDEO) {
			self.video = None;
		}
		if !kinds.contains(MetadataKinds::FACTS) {
			self.facts.clear();
		}
	}

	fn absorb(&mut self, other: Self) {
		merge_with(&mut self.discussion, other.discussion, |mine, theirs| {
			mine.question = mine.question.take().or(theirs.question);
			union_by(&mut mine.answers, theirs.answers, |answer| answer.text.as_str());
		});
		union_by(&mut self.faq, other.faq, |entry| entry.question.as_str());
		merge_with(&mut self.article, other.article, |mine, theirs| {
			union_by(&mut mine.authors, theirs.authors, |author| author.name.as_str());
			mine.publisher = mine.publisher.take().or(theirs.publisher);
			mine.date = mine.date.take().or(theirs.date);
		});
		merge_with(&mut self.video, other.video, |mine, theirs| {
			mine.duration = mine.duration.take().or(theirs.duration);
			mine.views = mine.views.or(theirs.views);
			mine.creator = mine.creator.take().or(theirs.creator);
			mine.publisher = mine.publisher.take().or(theirs.publisher);
		});
		union_by(&mut self.facts, other.facts, |fact| fact.label.as_str());
	}
}

impl VideoDetails {
	fn is_empty(&self) -> bool {
		self.duration.is_none()
			&& self.views.is_none()
			&& self.creator.is_none()
			&& self.publisher.is_none()
	}
}

/// `theirs` when `mine` is empty, else `merge(mine, theirs)`.
fn merge_with<T>(mine: &mut Option<T>, theirs: Option<T>, merge: impl FnOnce(&mut T, T)) {
	match (mine.as_mut(), theirs) {
		(Some(mine), Some(theirs)) => merge(mine, theirs),
		(None, theirs) => *mine = theirs,
		(Some(_), None) => {},
	}
}

/// Appends the items of `theirs` whose key `mine` lacks.
fn union_by<T>(mine: &mut Vec<T>, theirs: Vec<T>, key: impl Fn(&T) -> &str) {
	for item in theirs {
		if !mine.iter().any(|kept| key(kept) == key(&item)) {
			mine.push(item);
		}
	}
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewsHit {
	pub url:       String,
	pub title:     String,
	pub snippet:   String,
	/// Publisher name.
	pub source:    Option<String>,
	pub published: Option<String>,
	pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageHit {
	/// Original image URL.
	pub url:       String,
	/// Page embedding the image.
	pub page:      String,
	pub title:     String,
	pub thumbnail: String,
	pub width:     u32,
	pub height:    u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VideoHit {
	pub url:       String,
	pub title:     String,
	pub snippet:   String,
	/// Display duration such as `"4:18"`.
	pub duration:  Option<String>,
	/// Hosting platform, e.g. `"YouTube"`.
	pub publisher: Option<String>,
	/// Channel or uploader.
	pub creator:   Option<String>,
	pub views:     Option<u64>,
	pub published: Option<String>,
	pub thumbnail: Option<String>,
}

impl Hit for WebHit {
	fn url(&self) -> &str {
		&self.url
	}

	fn absorb(&mut self, other: Self) {
		fill(&mut self.title, other.title);
		fill(&mut self.snippet, other.snippet);
		self.site = self.site.take().or(other.site);
		self.favicon = self.favicon.take().or(other.favicon);
		self.published = self.published.take().or(other.published);
		self.thumbnail = self.thumbnail.take().or(other.thumbnail);
		if self.sitelinks.is_empty() {
			self.sitelinks = other.sitelinks;
		}
		self.metadata.absorb(other.metadata);
	}
}

impl Hit for NewsHit {
	fn url(&self) -> &str {
		&self.url
	}

	fn absorb(&mut self, other: Self) {
		fill(&mut self.title, other.title);
		fill(&mut self.snippet, other.snippet);
		self.source = self.source.take().or(other.source);
		self.published = self.published.take().or(other.published);
		self.thumbnail = self.thumbnail.take().or(other.thumbnail);
	}
}

impl Hit for ImageHit {
	fn url(&self) -> &str {
		&self.url
	}

	fn absorb(&mut self, other: Self) {
		fill(&mut self.page, other.page);
		fill(&mut self.title, other.title);
		fill(&mut self.thumbnail, other.thumbnail);
	}
}

impl Hit for VideoHit {
	fn url(&self) -> &str {
		&self.url
	}

	fn absorb(&mut self, other: Self) {
		fill(&mut self.title, other.title);
		fill(&mut self.snippet, other.snippet);
		self.duration = self.duration.take().or(other.duration);
		self.publisher = self.publisher.take().or(other.publisher);
		self.creator = self.creator.take().or(other.creator);
		self.views = self.views.or(other.views);
		self.published = self.published.take().or(other.published);
		self.thumbnail = self.thumbnail.take().or(other.thumbnail);
	}
}

fn fill(slot: &mut String, other: String) {
	if slot.is_empty() {
		*slot = other;
	}
}

fn non_empty(s: String) -> Option<String> {
	(!s.trim().is_empty()).then_some(s)
}

const HIGHLIGHT: [char; 2] = ['\u{e000}', '\u{e001}'];

fn plain(markup: &str) -> String {
	let mut out = String::with_capacity(markup.len());
	let mut space = false;
	let mut rest = markup;

	while let Some(c) = rest.chars().next() {
		let (decoded, len) = match c {
			'<' => match tag_len(rest) {
				// block tags separate words: `<p>a</p><p>b</p>` is "a b"
				Some(len) if is_block(&rest[1..len]) => (Some(' '), len),
				Some(len) => (None, len),
				None => (Some(c), 1),
			},
			'&' => match reference(rest) {
				Some((decoded, len)) => (Some(decoded), len),
				None => (Some(c), 1),
			},
			c if HIGHLIGHT.contains(&c) => (None, c.len_utf8()),
			c => (Some(c), c.len_utf8()),
		};
		rest = &rest[len..];

		match decoded {
			Some(c) if c.is_whitespace() => space = !out.is_empty(),
			Some(c) => {
				if space {
					out.push(' ');
					space = false;
				}
				out.push(c);
			},
			None => {},
		}
	}

	out
}

fn tag_len(s: &str) -> Option<usize> {
	let next = s[1..].chars().next()?;
	if !(next.is_ascii_alphabetic() || next == '/' || next == '!') {
		return None;
	}
	s.find('>').map(|end| end + 1)
}

fn is_block(tag: &str) -> bool {
	const BLOCKS: &[&str] = &[
		"blockquote",
		"br",
		"div",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"hr",
		"li",
		"ol",
		"p",
		"pre",
		"table",
		"td",
		"th",
		"tr",
		"ul",
	];
	let tag = tag.trim_start_matches('/');
	let name = &tag[..tag
		.find(|c: char| !c.is_ascii_alphanumeric())
		.unwrap_or(tag.len())];
	BLOCKS.iter().any(|block| block.eq_ignore_ascii_case(name))
}

fn reference(s: &str) -> Option<(char, usize)> {
	let end = s.bytes().take(12).position(|b| b == b';')?;
	let decoded = match &s[1..end] {
		"amp" => '&',
		"lt" => '<',
		"gt" => '>',
		"quot" => '"',
		"apos" => '\'',
		"nbsp" => '\u{a0}',
		name => {
			let code = name.strip_prefix('#')?;
			let code = match code.strip_prefix(['x', 'X']) {
				Some(hex) => u32::from_str_radix(hex, 16).ok()?,
				None => code.parse().ok()?,
			};
			char::from_u32(code)?
		},
	};
	Some((decoded, end + 1))
}

#[derive(Debug, Clone)]
pub struct EngineError {
	pub engine: &'static str,
	pub error:  Arc<dyn Error + Send + Sync>,
}

impl fmt::Display for EngineError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}: {}", self.engine, self.error)
	}
}

impl Error for EngineError {
	fn source(&self) -> Option<&(dyn Error + 'static)> {
		self.error.source()
	}
}

pub(crate) type Cursor = Arc<dyn Any + Send + Sync>;

pub(crate) type Fetched = Result<(Page, Option<Cursor>), EngineError>;

pub(crate) trait Dispatch: Send + Sync + 'static {
	fn name(&self) -> &'static str;

	fn capabilities(&self) -> Capabilities;

	fn spawn(
		self: Arc<Self>,
		query: Arc<Query>,
		cursor: Option<Cursor>,
		tasks: &mut JoinSet<Fetched>,
	) -> AbortHandle;
}

impl<E> Dispatch for E
where
	E: Engine<search(..): Send> + 'static,
{
	fn name(&self) -> &'static str {
		E::NAME
	}

	fn capabilities(&self) -> Capabilities {
		Engine::capabilities(self)
	}

	fn spawn(
		self: Arc<Self>,
		query: Arc<Query>,
		cursor: Option<Cursor>,
		tasks: &mut JoinSet<Fetched>,
	) -> AbortHandle {
		let cursor = cursor.map(|cursor| {
			cursor
				.downcast::<E::Cursor>()
				.expect("cursors only return to the engine that issued them")
		});
		tasks.spawn(async move {
			match self.search(&query, cursor.as_deref()).await {
				Ok((page, next)) => Ok((page, next.map(|next| Arc::new(next) as Cursor))),
				Err(error) => Err(EngineError { engine: E::NAME, error: Arc::new(error) }),
			}
		})
	}
}
