use super::{
	Answer, Article, Author, Capabilities, Discussion, Engine, Fact, FaqEntry, Link, Market,
	Metadata, MetadataKinds, Page, Panel, PanelKind, PanelKinds, Query, SafeSearch, Verticals,
	VideoDetails, VideoHit, WebHit, non_empty, plain,
};
use crate::celestial::brave::model::{InfoboxResult, VideoResult, WebResult};

/// search.brave.com/settings, 2026-10
const MARKETS: &[Market] = &[
	("es", "AR", "ar"),
	("en", "AU", "au"),
	("de", "AT", "at"),
	("nl", "BE", "be"),
	("pt", "BR", "br"),
	("en", "CA", "ca"),
	("es", "CL", "cl"),
	("zh", "CN", "cn"),
	("da", "DK", "dk"),
	("fi", "FI", "fi"),
	("fr", "FR", "fr"),
	("de", "DE", "de"),
	("el", "GR", "gr"),
	("zh", "HK", "hk"),
	("en", "IN", "in"),
	("id", "ID", "id"),
	("it", "IT", "it"),
	("ja", "JP", "jp"),
	("ko", "KR", "kr"),
	("ms", "MY", "my"),
	("es", "MX", "mx"),
	("nl", "NL", "nl"),
	("en", "NZ", "nz"),
	("nb", "NO", "no"),
	("en", "PH", "ph"),
	("pl", "PL", "pl"),
	("pt", "PT", "pt"),
	("ru", "RU", "ru"),
	("ar", "SA", "sa"),
	("en", "SG", "sg"),
	("en", "ZA", "za"),
	("es", "ES", "es"),
	("sv", "SE", "se"),
	("de", "CH", "ch"),
	("zh", "TW", "tw"),
	("tr", "TR", "tr"),
	("en", "GB", "gb"),
	("en", "US", "us"),
];

/// [Brave Search](https://search.brave.com).
#[derive(Debug, Clone)]
pub struct Brave {
	pub spellcheck: bool,
}

impl Default for Brave {
	fn default() -> Self {
		Self { spellcheck: crate::celestial::brave::SearchParams::default().spellcheck }
	}
}

impl Engine for Brave {
	/// Index of the next page.
	type Cursor = u32;
	type Error = crate::celestial::brave::SearchError;

	const NAME: &'static str = "brave";

	fn capabilities(&self) -> Capabilities {
		Capabilities {
			verticals: Verticals::WEB | Verticals::VIDEOS,
			metadata:  MetadataKinds::DISCUSSION
				| MetadataKinds::FAQ
				| MetadataKinds::ARTICLE
				| MetadataKinds::VIDEO,
			// corrections need `spellcheck`
			panels:    PanelKinds::ENTITY | PanelKinds::CORRECTION,
			markets:   MARKETS,
		}
	}

	async fn search(
		&self,
		query: &Query,
		cursor: Option<&u32>,
	) -> Result<(Page, Option<u32>), Self::Error> {
		let index = cursor.copied().unwrap_or(0);
		let params = crate::celestial::brave::SearchParams {
			page:       index,
			spellcheck: self.spellcheck,
			safesearch: match query.safesearch {
				SafeSearch::Strict => crate::celestial::brave::SafeSearch::Strict,
				SafeSearch::Moderate => crate::celestial::brave::SafeSearch::Moderate,
				SafeSearch::Off => crate::celestial::brave::SafeSearch::Off,
			},
			country:    match query.region.and_then(|region| region.market(MARKETS)) {
				Some(code) => code.to_owned(),
				None => crate::celestial::brave::SearchParams::default().country,
			},
		};
		let page = crate::celestial::brave::search(&query.text, params).await?;
		let next = page
			.body
			.response
			.query
			.more_results_available
			.then_some(index + 1);
		Ok((convert(page, query), next))
	}
}

pub fn convert(page: crate::celestial::brave::SearchPage, query: &Query) -> Page {
	let response = page.body.response;
	let mut out = Page { related: response.query.related_flat(), ..Page::default() };
	if let Some(web) = response.web
		&& query.verticals.contains(Verticals::WEB)
	{
		out.web = web
			.results
			.into_iter()
			.map(|result| web_hit(result, query.metadata))
			.collect();
	}
	if let Some(videos) = response.videos
		&& query.verticals.contains(Verticals::VIDEOS)
	{
		out.videos = videos.results.into_iter().map(video_hit).collect();
	}
	if let Some(altered) = response.query.altered.and_then(non_empty)
		&& query.panels.contains(PanelKinds::CORRECTION)
	{
		out.panels
			.push(Panel::new(PanelKind::Correction, plain(&altered)));
	}
	if let Some(infobox) = response.infobox
		&& query.panels.contains(PanelKinds::ENTITY)
	{
		out.panels
			.extend(infobox.results.into_iter().filter_map(entity));
	}
	out
}

/// Infobox entries without any description are forum-thread teasers, not
/// entities.
fn entity(result: InfoboxResult) -> Option<Panel> {
	let description = result
		.description
		.map(|text| plain(&text))
		.and_then(non_empty);
	let long = result
		.long_desc
		.map(|text| plain(&text))
		.and_then(non_empty);
	if description.is_none() && long.is_none() && result.attributes.is_empty() {
		return None;
	}

	let mut panel = Panel::new(PanelKind::Entity, plain(&result.title));
	panel.subtitle = description.clone().or(result.label);
	panel.text = long.or(description).unwrap_or_default();
	panel.url = result.url;
	panel.image = result.images.into_iter().next().map(|image| image.src);
	panel.source = result
		.providers
		.into_iter()
		.next()
		.map(|provider| provider.name);
	panel.facts = result
		.attributes
		.into_iter()
		.filter_map(|(label, value)| {
			Some(Fact { label: non_empty(plain(&label?))?, values: vec![non_empty(plain(&value?))?] })
		})
		.collect();
	panel.links = result
		.website_url
		.map(|url| Link { title: "Official site".into(), url })
		.into_iter()
		.chain(
			result
				.profiles
				.into_iter()
				.filter_map(|profile| Some(Link { title: profile.name, url: profile.url? })),
		)
		.collect();
	Some(panel)
}

fn web_hit(result: WebResult, kinds: MetadataKinds) -> WebHit {
	let title = plain(result.display_title());
	let mut metadata = Metadata {
		discussion: result.qa.map(|qa| Discussion {
			question: qa.question.as_deref().map(plain).and_then(non_empty),
			answers:  qa
				.answer
				.into_iter()
				.chain(qa.suggested_answers)
				.map(|answer| Answer { text: plain(&answer.text), votes: answer.upvote_count })
				.collect(),
		}),
		faq:        result
			.faq
			.map(|faq| faq.items)
			.unwrap_or_default()
			.into_iter()
			.map(|item| FaqEntry {
				question: plain(&item.question),
				answer:   plain(&item.answer),
				url:      item.url,
			})
			.collect(),
		article:    result.article.map(|article| Article {
			authors:   article
				.author
				.into_iter()
				.map(|author| Author { name: plain(&author.name), url: author.url })
				.collect(),
			publisher: article.publisher.map(|publisher| plain(&publisher.name)),
			date:      article.date.and_then(non_empty),
		}),
		video:      result
			.video
			.map(|video| VideoDetails {
				duration:  video.duration.and_then(non_empty),
				views:     None,
				creator:   video.creator.and_then(non_empty),
				publisher: video.publisher.and_then(non_empty),
			})
			.filter(|video| !video.is_empty()),
		facts:      Vec::new(),
	};
	metadata.retain(kinds);

	WebHit {
		title,
		snippet: plain(&result.description),
		site: result.profile.map(|profile| profile.name),
		favicon: result.meta_url.and_then(|meta| meta.favicon),
		published: result.page_age,
		thumbnail: result.thumbnail.map(|thumbnail| thumbnail.src),
		sitelinks: result
			.deep_results
			.map(|deep| deep.buttons)
			.unwrap_or_default()
			.into_iter()
			.map(|button| Link { title: plain(&button.title), url: button.url })
			.collect(),
		url: result.url,
		metadata,
	}
}

fn video_hit(result: VideoResult) -> VideoHit {
	let (duration, publisher, creator) = result
		.video
		.map(|video| (video.duration, video.publisher, video.creator))
		.unwrap_or_default();
	VideoHit {
		title:     plain(&result.title),
		snippet:   result.description.as_deref().map(plain).unwrap_or_default(),
		duration:  duration.and_then(non_empty),
		publisher: publisher.and_then(non_empty),
		creator:   creator.and_then(non_empty),
		views:     None,
		published: result.page_age,
		thumbnail: result.thumbnail.map(|thumbnail| thumbnail.src),
		url:       result.url,
	}
}
