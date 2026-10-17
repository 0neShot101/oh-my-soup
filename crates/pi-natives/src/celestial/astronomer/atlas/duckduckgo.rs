use super::{
	Article, Author, Capabilities, Discussion, Engine, Fact, ImageHit, Link, Market, Metadata,
	MetadataKinds, NewsHit, Page, Panel, PanelKind, PanelKinds, Query, SafeSearch, Verticals,
	VideoDetails, VideoHit, WebHit, non_empty, plain,
};
use crate::celestial::duckduckgo::model::{
	FatheadModule, ImageResult, InfoboxDataType, InfoboxValue, InstantAnswerPayload, NewsResult,
	OrganicEntry, OrganicResult, TranslationsModule, VideoResult,
};

/// DuckDuckGo's `kl` regions
const MARKETS: &[Market] = &[
	("es", "AR", "ar-es"),
	("en", "AU", "au-en"),
	("de", "AT", "at-de"),
	("nl", "BE", "be-nl"),
	("fr", "BE", "be-fr"),
	("pt", "BR", "br-pt"),
	("bg", "BG", "bg-bg"),
	("en", "CA", "ca-en"),
	("fr", "CA", "ca-fr"),
	("es", "CL", "cl-es"),
	("zh", "CN", "cn-zh"),
	("es", "CO", "co-es"),
	("hr", "HR", "hr-hr"),
	("cs", "CZ", "cz-cs"),
	("da", "DK", "dk-da"),
	("et", "EE", "ee-et"),
	("fi", "FI", "fi-fi"),
	("fr", "FR", "fr-fr"),
	("de", "DE", "de-de"),
	("el", "GR", "gr-el"),
	("zh", "HK", "hk-tzh"),
	("hu", "HU", "hu-hu"),
	("is", "IS", "is-is"),
	("en", "IN", "in-en"),
	("en", "ID", "id-en"),
	("en", "IE", "ie-en"),
	("en", "IL", "il-en"),
	("it", "IT", "it-it"),
	("ja", "JP", "jp-jp"),
	("ko", "KR", "kr-kr"),
	("lv", "LV", "lv-lv"),
	("lt", "LT", "lt-lt"),
	("en", "MY", "my-en"),
	("es", "MX", "mx-es"),
	("nl", "NL", "nl-nl"),
	("en", "NZ", "nz-en"),
	("nb", "NO", "no-no"),
	("en", "PK", "pk-en"),
	("es", "PE", "pe-es"),
	("en", "PH", "ph-en"),
	("pl", "PL", "pl-pl"),
	("pt", "PT", "pt-pt"),
	("ro", "RO", "ro-ro"),
	("ru", "RU", "ru-ru"),
	("ar", "SA", "xa-ar"),
	("en", "SG", "sg-en"),
	("sk", "SK", "sk-sk"),
	("sl", "SI", "sl-sl"),
	("en", "ZA", "za-en"),
	("es", "ES", "es-es"),
	("ca", "ES", "es-ca"),
	("sv", "SE", "se-sv"),
	("de", "CH", "ch-de"),
	("fr", "CH", "ch-fr"),
	("zh", "TW", "tw-tzh"),
	("en", "TH", "th-en"),
	("tr", "TR", "tr-tr"),
	("en", "US", "us-en"),
	("es", "US", "us-es"),
	("uk", "UA", "ua-uk"),
	("en", "GB", "uk-en"),
	("en", "VN", "vn-en"),
];

/// [DuckDuckGo](https://duckduckgo.com).
#[derive(Debug, Clone, Copy, Default)]
pub struct DuckDuckGo;

impl Engine for DuckDuckGo {
	/// DuckDuckGo's next-page path; it carries the region and safesearch of the
	/// first page.
	type Cursor = String;
	type Error = crate::celestial::duckduckgo::SearchError;

	const NAME: &'static str = "duckduckgo";

	fn capabilities(&self) -> Capabilities {
		Capabilities {
			verticals: Verticals::ALL,
			metadata:  MetadataKinds::DISCUSSION
				| MetadataKinds::ARTICLE
				| MetadataKinds::VIDEO
				| MetadataKinds::FACTS,
			panels:    PanelKinds::ENTITY | PanelKinds::ANSWER | PanelKinds::TRANSLATION,
			markets:   MARKETS,
		}
	}

	async fn search(
		&self,
		query: &Query,
		cursor: Option<&String>,
	) -> Result<(Page, Option<String>), Self::Error> {
		let page = match cursor {
			Some(cursor) => crate::celestial::duckduckgo::search_next(cursor).await?,
			None => {
				let params = crate::celestial::duckduckgo::SearchParams {
					safesearch: match query.safesearch {
						SafeSearch::Strict => crate::celestial::duckduckgo::SafeSearch::Strict,
						SafeSearch::Moderate => crate::celestial::duckduckgo::SafeSearch::Moderate,
						SafeSearch::Off => crate::celestial::duckduckgo::SafeSearch::Off,
					},
					country:    match query.region.and_then(|region| region.market(MARKETS)) {
						Some(code) => code.to_owned(),
						None => crate::celestial::duckduckgo::SearchParams::default().country,
					},
				};
				crate::celestial::duckduckgo::search(&query.text, params).await?
			},
		};
		let next = page.next_page().map(str::to_owned);
		Ok((convert(page, query), next))
	}
}

pub fn convert(page: crate::celestial::duckduckgo::SearchPage, query: &Query) -> Page {
	let verticals = query.verticals;
	let mut out = Page::default();
	if verticals.contains(Verticals::WEB) {
		out.web = page
			.organics
			.into_iter()
			.filter_map(|entry| match entry {
				OrganicEntry::Result(result) => Some(web_hit(*result, query.metadata)),
				OrganicEntry::NextPage(_) => None,
				OrganicEntry::NoResult { .. } => None,
			})
			.collect();
	}
	if let Some(news) = page.news
		&& verticals.contains(Verticals::NEWS)
	{
		out.news = news.results.into_iter().map(news_hit).collect();
	}
	if let Some(images) = page.images
		&& verticals.contains(Verticals::IMAGES)
	{
		out.images = images.results.into_iter().map(image_hit).collect();
	}
	if let Some(videos) = page.videos
		&& verticals.contains(Verticals::VIDEOS)
	{
		out.videos = videos.results.into_iter().map(video_hit).collect();
	}
	if let Some(related) = page.related_searches {
		out.related = related.results.into_iter().map(|r| r.text).collect();
	}

	let panels = query.panels;
	if panels.contains(PanelKinds::ANSWER) {
		for answer in page.deep_payload.instant_answers {
			if let InstantAnswerPayload::WikiNlp(data) = answer.data
				&& let Some(text) = data.answer.and_then(non_empty)
			{
				// DuckAssist answers are markdown; only bold markers occur in the
				// short form
				let mut panel = Panel::new(PanelKind::Answer, query.text.clone());
				panel.text = plain(&text.replace("**", ""));
				panel.source = Some("DuckAssist".into());
				panel.links = data
					.sources
					.into_iter()
					.map(|source| Link {
						title: plain(&source.article.site),
						url:   source.article.link,
					})
					.collect();
				panel.related = data
					.more_questions
					.map(|more| more.more_questions)
					.unwrap_or_default();
				out.panels.push(panel);
			}
		}
	}
	if let Some(about) = page.about
		&& panels.contains(PanelKinds::ENTITY)
	{
		out.panels.extend(entity(*about));
	}
	if let Some(translations) = page.translations
		&& panels.contains(PanelKinds::TRANSLATION)
	{
		out.panels.push(translation(translations));
	}
	out
}

/// The Wikipedia "About" box; disambiguation pages carry no abstract and are
/// skipped.
fn entity(about: FatheadModule) -> Option<Panel> {
	let data = about.data;
	let text = non_empty(plain(&data.abstract_text))?;
	let mut panel = Panel::new(PanelKind::Entity, plain(&data.heading));
	panel.text = text;
	panel.url = non_empty(data.abstract_url);
	// relative to duckduckgo.com: "/i/832f249b21809a13.png"
	panel.image = non_empty(data.image).map(|path| format!("https://duckduckgo.com{path}"));
	panel.source = non_empty(data.abstract_source);
	panel.facts = data
		.infobox
		.map(|infobox| infobox.content)
		.unwrap_or_default()
		.into_iter()
		// the rest are wikidata internals and social profile ids
		.filter(|entry| {
			matches!(
				entry.data_type,
				InfoboxDataType::Text | InfoboxDataType::DateOfBirth | InfoboxDataType::Other
			)
		})
		.filter_map(|entry| {
			let values = match entry.value {
				InfoboxValue::Text(text) => vec![text],
				InfoboxValue::List(items) => items,
				_ => return None,
			};
			let values: Vec<String> = values
				.iter()
				.map(|value| plain(value))
				.filter(|value| !value.is_empty())
				.collect();
			(!values.is_empty()).then(|| Fact { label: plain(&entry.label), values })
		})
		.collect();
	panel.links = data
		.official_website
		.and_then(non_empty)
		.map(|url| Link { title: "Official site".into(), url })
		.into_iter()
		.collect();
	Some(panel)
}

fn translation(module: TranslationsModule) -> Panel {
	let translation = module.results;
	let mut panel = Panel::new(PanelKind::Translation, translation.translated_text);
	panel.subtitle =
		Some(format!("{} → {}", translation.original_language, translation.translated_language));
	panel.text = translation.original_text;
	panel
}

fn web_hit(result: OrganicResult, kinds: MetadataKinds) -> WebHit {
	let mut video = result.video.map(|video| VideoDetails {
		duration:  non_empty(video.duration),
		views:     video.statistics.view_count,
		creator:   None,
		// the badge names the platform ("YouTube") on video results
		publisher: result
			.source_badge
			.map(|badge| plain(&badge.display_name))
			.and_then(non_empty),
	});
	let mut authors = Vec::new();
	let mut facts = Vec::new();
	for field in result.rich_fields.unwrap_or_default() {
		let values: Vec<String> = field
			.items
			.iter()
			.map(|item| plain(&item.text))
			.filter(|value| !value.is_empty())
			.collect();
		match (field.hint.text.as_str(), video.as_mut()) {
			// the player's exact duration beats the rounded "63 min"
			("MEDIA:DURATION", Some(video)) => {
				video.duration = video.duration.take().or(values.into_iter().next());
			},
			("BASE:VIEWSCOUNT", Some(video)) => {
				video.views = video.views.or_else(|| values.first()?.parse().ok());
			},
			("BASE:AUTHOR", Some(video)) => {
				video.creator = video.creator.take().or(values.into_iter().next());
			},
			("BASE:AUTHOR", None) => {
				authors.extend(values.into_iter().map(|name| Author { name, url: None }));
			},
			_ => facts.push(Fact { label: plain(&field.label.text), values }),
		}
	}
	let mut metadata = Metadata {
		discussion: result
			.deep_answer_verticals
			.0
			.iter()
			.any(|vertical| vertical == "discussions")
			.then(Discussion::default),
		faq: Vec::new(),
		article: (!authors.is_empty()).then(|| Article { authors, ..Article::default() }),
		video,
		facts,
	};
	metadata.retain(kinds);

	WebHit {
		url: result.url,
		title: plain(&result.title),
		snippet: plain(&result.abstract_html),
		site: result
			.site_name
			.map(|site| plain(&site))
			.and_then(non_empty),
		// what DDG's own frontend shows: its icon proxy, keyed by hostname
		favicon: Some(format!("https://external-content.duckduckgo.com/ip3/{}.ico", result.hostname)),
		published: result.last_modified,
		thumbnail: result.thumbnail_url,
		sitelinks: result
			.sitelinks
			.unwrap_or_default()
			.into_iter()
			.map(|link| Link { title: plain(&link.text), url: link.target_url })
			.collect(),
		metadata,
	}
}

fn news_hit(result: NewsResult) -> NewsHit {
	NewsHit {
		url:       result.url,
		title:     plain(&result.title),
		snippet:   plain(&result.excerpt),
		source:    non_empty(result.source),
		published: Some(iso8601(result.unix_date)),
		thumbnail: result.image_url,
	}
}

fn image_hit(result: ImageResult) -> ImageHit {
	ImageHit {
		url:       result.image_url,
		page:      result.source_page_url,
		title:     plain(&result.title),
		thumbnail: result.thumbnail_url,
		width:     result.width,
		height:    result.height,
	}
}

fn video_hit(result: VideoResult) -> VideoHit {
	VideoHit {
		url:       result.video_url,
		title:     plain(&result.title),
		snippet:   plain(&result.description),
		duration:  non_empty(result.duration),
		publisher: non_empty(result.publisher),
		creator:   non_empty(result.uploader),
		views:     result.statistics.view_count,
		published: non_empty(result.published),
		thumbnail: non_empty(result.images.medium),
	}
}

/// Formats Unix seconds as UTC `YYYY-MM-DDTHH:MM:SSZ` (proleptic Gregorian
/// calendar).
fn iso8601(unix: i64) -> String {
	let (days, secs) = (unix.div_euclid(86_400), unix.rem_euclid(86_400));
	// Howard Hinnant's `civil_from_days`, with eras starting on 0000-03-01.
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = doy - (153 * mp + 2) / 5 + 1;
	let month = if mp < 10 { mp + 3 } else { mp - 9 };
	let year = yoe + era * 400 + i64::from(month <= 2);
	format!(
		"{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
		secs / 3_600,
		secs % 3_600 / 60,
		secs % 60
	)
}
