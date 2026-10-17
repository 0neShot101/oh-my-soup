//! Celestial metasearch & SERP extraction engine (`astronomer`, `brave`,
//! `devalue`, `duckduckgo`) without Startpage.
//!
//! Exposes both the Rust APIs (`astronomer`, `brave`, `devalue`, `duckduckgo`)
//! and N-API bindings for the Oh My Soup TypeScript runtime.

pub mod astronomer;
pub mod brave;
pub mod devalue;
pub mod duckduckgo;
mod http;

use napi::{Error, Result};
use napi_derive::napi;

use self::{
	astronomer::{
		alignment::{self, CombMnz, Fused, Rrf},
		atlas::{
			Article, Author, Discussion, Fact, ImageHit, Link, Metadata, NewsHit, Page, Panel,
			PanelKind, Query, VideoDetails, VideoHit, WebHit,
		},
		dedup::{
			self, Ranking,
			normalize::{Canonical, Normalized},
		},
	},
	brave::pow,
};

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialLinkDto {
	pub title: String,
	pub url:   String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFactDto {
	pub label:  String,
	pub values: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialAnswerDto {
	pub text:  String,
	pub votes: Option<i64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialDiscussionDto {
	pub question: Option<String>,
	pub answers:  Vec<CelestialAnswerDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFaqEntryDto {
	pub question: String,
	pub answer:   String,
	pub url:      Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialAuthorDto {
	pub name: String,
	pub url:  Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialArticleDto {
	pub authors:   Vec<CelestialAuthorDto>,
	pub publisher: Option<String>,
	pub date:      Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialVideoDetailsDto {
	pub duration:  Option<String>,
	pub views:     Option<f64>,
	pub creator:   Option<String>,
	pub publisher: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialMetadataDto {
	pub discussion: Option<CelestialDiscussionDto>,
	pub faq:        Vec<CelestialFaqEntryDto>,
	pub article:    Option<CelestialArticleDto>,
	pub video:      Option<CelestialVideoDetailsDto>,
	pub facts:      Vec<CelestialFactDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialWebHitDto {
	pub url:       String,
	pub title:     String,
	pub snippet:   String,
	pub site:      Option<String>,
	pub favicon:   Option<String>,
	pub published: Option<String>,
	pub thumbnail: Option<String>,
	pub sitelinks: Vec<CelestialLinkDto>,
	pub metadata:  Option<CelestialMetadataDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialNewsHitDto {
	pub url:       String,
	pub title:     String,
	pub snippet:   String,
	pub source:    Option<String>,
	pub published: Option<String>,
	pub thumbnail: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialImageHitDto {
	pub url:       String,
	pub page:      String,
	pub title:     String,
	pub thumbnail: String,
	pub width:     u32,
	pub height:    u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialVideoHitDto {
	pub url:       String,
	pub title:     String,
	pub snippet:   String,
	pub duration:  Option<String>,
	pub publisher: Option<String>,
	pub creator:   Option<String>,
	pub views:     Option<f64>,
	pub published: Option<String>,
	pub thumbnail: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialPanelDto {
	pub kind:     String,
	pub title:    String,
	pub subtitle: Option<String>,
	pub text:     String,
	pub url:      Option<String>,
	pub image:    Option<String>,
	pub source:   Option<String>,
	pub facts:    Vec<CelestialFactDto>,
	pub links:    Vec<CelestialLinkDto>,
	pub related:  Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialPageDto {
	pub web:     Vec<CelestialWebHitDto>,
	pub news:    Vec<CelestialNewsHitDto>,
	pub images:  Vec<CelestialImageHitDto>,
	pub videos:  Vec<CelestialVideoHitDto>,
	pub related: Vec<String>,
	pub panels:  Vec<CelestialPanelDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialChallengeSetDto {
	pub set_token:      String,
	pub tokens:         Vec<String>,
	pub zero_count:     u32,
	pub solution_limit: u32,
	pub iterations:     u32,
	pub memory_size:    u32,
	pub hash_length:    Option<u32>,
	pub parallelism:    u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialBraveParseOutput {
	pub status:        String,
	pub page:          Option<CelestialPageDto>,
	pub challenge_set: Option<CelestialChallengeSetDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialDuckEvalOutput {
	pub status:    String,
	pub retry_url: Option<String>,
	pub page:      Option<CelestialPageDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialVoteDto {
	pub engine: String,
	pub rank:   u32,
	pub total:  u32,
	pub weight: f64,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFusedWebHitDto {
	pub hit:   CelestialWebHitDto,
	pub score: f64,
	pub votes: Vec<CelestialVoteDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFusedNewsHitDto {
	pub hit:   CelestialNewsHitDto,
	pub score: f64,
	pub votes: Vec<CelestialVoteDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFusedImageHitDto {
	pub hit:   CelestialImageHitDto,
	pub score: f64,
	pub votes: Vec<CelestialVoteDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFusedVideoHitDto {
	pub hit:   CelestialVideoHitDto,
	pub score: f64,
	pub votes: Vec<CelestialVoteDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFusedPanelDto {
	pub hit:   CelestialPanelDto,
	pub score: f64,
	pub votes: Vec<CelestialVoteDto>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialFusedResultsDto {
	pub web:     Vec<CelestialFusedWebHitDto>,
	pub news:    Vec<CelestialFusedNewsHitDto>,
	pub images:  Vec<CelestialFusedImageHitDto>,
	pub videos:  Vec<CelestialFusedVideoHitDto>,
	pub panels:  Vec<CelestialFusedPanelDto>,
	pub related: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CelestialEnginePageInput {
	pub engine: String,
	pub weight: Option<f64>,
	pub page:   CelestialPageDto,
}

fn static_engine_name(name: &str) -> &'static str {
	if name.eq_ignore_ascii_case("brave") {
		"brave"
	} else if name.eq_ignore_ascii_case("duckduckgo") || name.eq_ignore_ascii_case("ddg") {
		"duckduckgo"
	} else if name.eq_ignore_ascii_case("google") {
		"google"
	} else if name.eq_ignore_ascii_case("ecosia") {
		"ecosia"
	} else if name.eq_ignore_ascii_case("mojeek") {
		"mojeek"
	} else if name.eq_ignore_ascii_case("searxng") {
		"searxng"
	} else if name.eq_ignore_ascii_case("yandex") {
		"yandex"
	} else if name.eq_ignore_ascii_case("kagi") {
		"kagi"
	} else if name.eq_ignore_ascii_case("tavily") {
		"tavily"
	} else if name.eq_ignore_ascii_case("exa") {
		"exa"
	} else if name.eq_ignore_ascii_case("perplexity") {
		"perplexity"
	} else {
		"custom"
	}
}

/// Normalize a URL using Astronomer's [`Canonical`] pipeline (`Https` +
/// `BareHost` + `DropFragment` + `TrimSlash` + `DropTracking` + `SortQuery` +
/// `DecodeUnreserved`).
#[napi(js_name = "celestialNormalizeUrl")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn celestial_normalize_url(url: String) -> String {
	Normalized::<Canonical>::default().key(&url)
}

/// Parse a Brave Search SSR HTML document (`__DATA__` SvelteKit `devalue`
/// payload) and convert it into an Astronomer [`CelestialPageDto`] or
/// [`CelestialChallengeSetDto`].
#[napi(js_name = "celestialParseBraveHtml")]
pub fn celestial_parse_brave_html(
	html: String,
	query: Option<String>,
) -> Result<CelestialBraveParseOutput> {
	let q = Query::new(query.unwrap_or_default());
	match brave::parse_search(&html) {
		Ok(search_page) => {
			let page = astronomer::atlas::brave::convert(search_page, &q);
			Ok(CelestialBraveParseOutput {
				status:        "ok".to_owned(),
				page:          Some(page_to_dto(page)),
				challenge_set: None,
			})
		},
		Err(brave::model::ParseError::Captcha(Some(set))) => Ok(CelestialBraveParseOutput {
			status:        "pow".to_owned(),
			page:          None,
			challenge_set: Some(CelestialChallengeSetDto {
				set_token:      set.set_token,
				tokens:         set.tokens,
				zero_count:     set.zero_count,
				solution_limit: set.solution_limit,
				iterations:     set.hash_function_params.iterations,
				memory_size:    set.hash_function_params.memory_size,
				hash_length:    set.hash_function_params.hash_length.map(|n| n as u32),
				parallelism:    set.hash_function_params.parallelism,
			}),
		}),
		Err(brave::model::ParseError::Captcha(None)) => Ok(CelestialBraveParseOutput {
			status:        "captcha".to_owned(),
			page:          None,
			challenge_set: None,
		}),
		Err(brave::model::ParseError::Parse(e)) => Err(Error::from_reason(e.to_string())),
	}
}

/// Solve a Brave Argon2id Proof-of-Work challenge in native Rust.
#[napi(js_name = "celestialSolveBravePow")]
pub fn celestial_solve_brave_pow(
	challenge: String,
	difficulty: u32,
	limit: u32,
	memory_kib: Option<u32>,
	iterations: Option<u32>,
	parallelism: Option<u32>,
	hash_length: Option<u32>,
) -> Result<String> {
	let params = pow::Params::new(
		memory_kib.unwrap_or(pow::ProofOfWork::MEMORY_KIB),
		iterations.unwrap_or(pow::ProofOfWork::ITERATIONS),
		parallelism.unwrap_or(pow::ProofOfWork::PARALLELISM),
		Some(hash_length.map_or(pow::ProofOfWork::OUTPUT_LEN, |n| n as usize)),
	)
	.map_err(|e| Error::from_reason(e.to_string()))?;
	let solver = pow::ProofOfWork::new(params);
	solver
		.solve(&challenge, difficulty as usize, limit as usize)
		.map_err(|e| Error::from_reason(e.to_string()))
}

/// Extract the `https://links.duckduckgo.com/d.js...` script URL from
/// DuckDuckGo's search page HTML.
#[napi(js_name = "celestialExtractDuckDuckGoUrl")]
pub fn celestial_extract_duckduckgo_url(html: String) -> Result<String> {
	duckduckgo::extract_duck_url(&html).map_err(|e| Error::from_reason(e.to_string()))
}

/// Evaluate a DuckDuckGo `d.js` script payload inside the pure-Rust `jsa`
/// interpreter and convert it into an Astronomer [`CelestialPageDto`] or retry
/// URL.
#[napi(js_name = "celestialEvalDuckDuckGoScript")]
pub fn celestial_eval_duckduckgo_script(
	script: String,
	query: Option<String>,
) -> Result<CelestialDuckEvalOutput> {
	let q = Query::new(query.unwrap_or_default());
	match duckduckgo::eval_duck_script(&script).map_err(|e| Error::from_reason(e.to_string()))? {
		duckduckgo::DuckAction::Ok(search_page) => {
			let page = astronomer::atlas::duckduckgo::convert(search_page, &q);
			Ok(CelestialDuckEvalOutput {
				status:    "ok".to_owned(),
				retry_url: None,
				page:      Some(page_to_dto(page)),
			})
		},
		duckduckgo::DuckAction::Retry(retry_url) => Ok(CelestialDuckEvalOutput {
			status:    "retry".to_owned(),
			retry_url: Some(retry_url),
			page:      None,
		}),
	}
}

/// Fuse and align multiple engine result pages using Astronomer's deduplication
/// (`Normalized<Canonical>`) and rank-fusion (`Rrf` or `CombMnz`) pipeline.
#[napi(js_name = "celestialFusePages")]
pub fn celestial_fuse_pages(
	inputs: Vec<CelestialEnginePageInput>,
	alignment_mode: Option<String>,
	rrf_k: Option<f64>,
) -> Result<CelestialFusedResultsDto> {
	let dedup = Normalized::<Canonical>::default();
	let use_combmnz = alignment_mode
		.as_deref()
		.is_some_and(|m| m.eq_ignore_ascii_case("combmnz"));
	let rrf = Rrf { k: rrf_k.unwrap_or(60.0) };

	let mut web_rankings = Vec::with_capacity(inputs.len());
	let mut news_rankings = Vec::with_capacity(inputs.len());
	let mut image_rankings = Vec::with_capacity(inputs.len());
	let mut video_rankings = Vec::with_capacity(inputs.len());
	let mut related_lists = Vec::with_capacity(inputs.len());
	let mut panel_rankings: [Vec<Ranking<Panel>>; PanelKind::ALL.len()] = Default::default();

	for input in inputs {
		let engine = static_engine_name(&input.engine);
		let weight = input.weight.unwrap_or(1.0);
		let page = page_from_dto(input.page);
		web_rankings.push(Ranking { engine, weight, hits: page.web });
		news_rankings.push(Ranking { engine, weight, hits: page.news });
		image_rankings.push(Ranking { engine, weight, hits: page.images });
		video_rankings.push(Ranking { engine, weight, hits: page.videos });
		related_lists.push(page.related);

		let mut by_kind: [Vec<Panel>; PanelKind::ALL.len()] = Default::default();
		for panel in page.panels {
			by_kind[panel.kind as usize].push(panel);
		}
		for (rankings, hits) in panel_rankings.iter_mut().zip(by_kind) {
			rankings.push(Ranking { engine, weight, hits });
		}
	}

	let align_web = |fused: Vec<Fused<WebHit>>| {
		if use_combmnz {
			alignment::align(&CombMnz, fused)
		} else {
			alignment::align(&rrf, fused)
		}
	};
	let align_news = |fused: Vec<Fused<NewsHit>>| {
		if use_combmnz {
			alignment::align(&CombMnz, fused)
		} else {
			alignment::align(&rrf, fused)
		}
	};
	let align_images = |fused: Vec<Fused<ImageHit>>| {
		if use_combmnz {
			alignment::align(&CombMnz, fused)
		} else {
			alignment::align(&rrf, fused)
		}
	};
	let align_videos = |fused: Vec<Fused<VideoHit>>| {
		if use_combmnz {
			alignment::align(&CombMnz, fused)
		} else {
			alignment::align(&rrf, fused)
		}
	};
	let align_panels = |fused: Vec<Fused<Panel>>| {
		if use_combmnz {
			alignment::align(&CombMnz, fused)
		} else {
			alignment::align(&rrf, fused)
		}
	};

	let web = align_web(dedup::merge(&dedup, web_rankings));
	let news = align_news(dedup::merge(&dedup, news_rankings));
	let images = align_images(dedup::merge(&dedup, image_rankings));
	let videos = align_videos(dedup::merge(&dedup, video_rankings));
	let panels = align_panels(
		panel_rankings
			.into_iter()
			.flat_map(|r| dedup::merge(&dedup, r))
			.collect(),
	);
	let related = interleave_unique_strings(related_lists);

	Ok(CelestialFusedResultsDto {
		web: web
			.into_iter()
			.map(|f| CelestialFusedWebHitDto {
				hit:   web_hit_to_dto(f.hit),
				score: f.score,
				votes: votes_to_dto(f.votes),
			})
			.collect(),
		news: news
			.into_iter()
			.map(|f| CelestialFusedNewsHitDto {
				hit:   news_hit_to_dto(f.hit),
				score: f.score,
				votes: votes_to_dto(f.votes),
			})
			.collect(),
		images: images
			.into_iter()
			.map(|f| CelestialFusedImageHitDto {
				hit:   image_hit_to_dto(f.hit),
				score: f.score,
				votes: votes_to_dto(f.votes),
			})
			.collect(),
		videos: videos
			.into_iter()
			.map(|f| CelestialFusedVideoHitDto {
				hit:   video_hit_to_dto(f.hit),
				score: f.score,
				votes: votes_to_dto(f.votes),
			})
			.collect(),
		panels: panels
			.into_iter()
			.map(|f| CelestialFusedPanelDto {
				hit:   panel_to_dto(f.hit),
				score: f.score,
				votes: votes_to_dto(f.votes),
			})
			.collect(),
		related,
	})
}

fn interleave_unique_strings(lists: Vec<Vec<String>>) -> Vec<String> {
	let mut seen = std::collections::HashSet::new();
	let mut merged = Vec::new();
	let mut lists: Vec<_> = lists.into_iter().map(Vec::into_iter).collect();
	loop {
		let mut drained = true;
		for list in &mut lists {
			if let Some(item) = list.next() {
				drained = false;
				if seen.insert(item.to_lowercase()) {
					merged.push(item);
				}
			}
		}
		if drained {
			return merged;
		}
	}
}

fn votes_to_dto(votes: Vec<alignment::Vote>) -> Vec<CelestialVoteDto> {
	votes
		.into_iter()
		.map(|v| CelestialVoteDto {
			engine: v.engine.to_owned(),
			rank:   v.rank,
			total:  v.total,
			weight: v.weight,
		})
		.collect()
}

fn page_to_dto(page: Page) -> CelestialPageDto {
	CelestialPageDto {
		web:     page.web.into_iter().map(web_hit_to_dto).collect(),
		news:    page.news.into_iter().map(news_hit_to_dto).collect(),
		images:  page.images.into_iter().map(image_hit_to_dto).collect(),
		videos:  page.videos.into_iter().map(video_hit_to_dto).collect(),
		related: page.related,
		panels:  page.panels.into_iter().map(panel_to_dto).collect(),
	}
}

fn web_hit_to_dto(hit: WebHit) -> CelestialWebHitDto {
	let metadata = if hit.metadata.is_empty() {
		None
	} else {
		Some(CelestialMetadataDto {
			discussion: hit.metadata.discussion.map(|d| CelestialDiscussionDto {
				question: d.question,
				answers:  d
					.answers
					.into_iter()
					.map(|a| CelestialAnswerDto { text: a.text, votes: a.votes })
					.collect(),
			}),
			faq:        hit
				.metadata
				.faq
				.into_iter()
				.map(|f| CelestialFaqEntryDto {
					question: f.question,
					answer:   f.answer,
					url:      f.url,
				})
				.collect(),
			article:    hit.metadata.article.map(|a| CelestialArticleDto {
				authors:   a
					.authors
					.into_iter()
					.map(|au| CelestialAuthorDto { name: au.name, url: au.url })
					.collect(),
				publisher: a.publisher,
				date:      a.date,
			}),
			video:      hit.metadata.video.map(|v| CelestialVideoDetailsDto {
				duration:  v.duration,
				views:     v.views.map(|n| n as f64),
				creator:   v.creator,
				publisher: v.publisher,
			}),
			facts:      hit
				.metadata
				.facts
				.into_iter()
				.map(|f| CelestialFactDto { label: f.label, values: f.values })
				.collect(),
		})
	};
	CelestialWebHitDto {
		url: hit.url,
		title: hit.title,
		snippet: hit.snippet,
		site: hit.site,
		favicon: hit.favicon,
		published: hit.published,
		thumbnail: hit.thumbnail,
		sitelinks: hit
			.sitelinks
			.into_iter()
			.map(|l| CelestialLinkDto { title: l.title, url: l.url })
			.collect(),
		metadata,
	}
}

fn news_hit_to_dto(hit: NewsHit) -> CelestialNewsHitDto {
	CelestialNewsHitDto {
		url:       hit.url,
		title:     hit.title,
		snippet:   hit.snippet,
		source:    hit.source,
		published: hit.published,
		thumbnail: hit.thumbnail,
	}
}

fn image_hit_to_dto(hit: ImageHit) -> CelestialImageHitDto {
	CelestialImageHitDto {
		url:       hit.url,
		page:      hit.page,
		title:     hit.title,
		thumbnail: hit.thumbnail,
		width:     hit.width,
		height:    hit.height,
	}
}

fn video_hit_to_dto(hit: VideoHit) -> CelestialVideoHitDto {
	CelestialVideoHitDto {
		url:       hit.url,
		title:     hit.title,
		snippet:   hit.snippet,
		duration:  hit.duration,
		publisher: hit.publisher,
		creator:   hit.creator,
		views:     hit.views.map(|v| v as f64),
		published: hit.published,
		thumbnail: hit.thumbnail,
	}
}

fn panel_to_dto(panel: Panel) -> CelestialPanelDto {
	let kind = match panel.kind {
		PanelKind::Entity => "entity",
		PanelKind::Answer => "answer",
		PanelKind::Translation => "translation",
		PanelKind::Correction => "correction",
	}
	.to_owned();
	CelestialPanelDto {
		kind,
		title: panel.title,
		subtitle: panel.subtitle,
		text: panel.text,
		url: panel.url,
		image: panel.image,
		source: panel.source,
		facts: panel
			.facts
			.into_iter()
			.map(|f| CelestialFactDto { label: f.label, values: f.values })
			.collect(),
		links: panel
			.links
			.into_iter()
			.map(|l| CelestialLinkDto { title: l.title, url: l.url })
			.collect(),
		related: panel.related,
	}
}

fn page_from_dto(dto: CelestialPageDto) -> Page {
	Page {
		web:     dto.web.into_iter().map(web_hit_from_dto).collect(),
		news:    dto.news.into_iter().map(news_hit_from_dto).collect(),
		images:  dto.images.into_iter().map(image_hit_from_dto).collect(),
		videos:  dto.videos.into_iter().map(video_hit_from_dto).collect(),
		related: dto.related,
		panels:  dto.panels.into_iter().map(panel_from_dto).collect(),
	}
}

fn web_hit_from_dto(dto: CelestialWebHitDto) -> WebHit {
	let metadata = dto.metadata.map_or_else(Metadata::default, |m| Metadata {
		discussion: m.discussion.map(|d| Discussion {
			question: d.question,
			answers:  d
				.answers
				.into_iter()
				.map(|a| astronomer::atlas::Answer { text: a.text, votes: a.votes })
				.collect(),
		}),
		faq:        m
			.faq
			.into_iter()
			.map(|f| astronomer::atlas::FaqEntry {
				question: f.question,
				answer:   f.answer,
				url:      f.url,
			})
			.collect(),
		article:    m.article.map(|a| Article {
			authors:   a
				.authors
				.into_iter()
				.map(|au| Author { name: au.name, url: au.url })
				.collect(),
			publisher: a.publisher,
			date:      a.date,
		}),
		video:      m.video.map(|v| VideoDetails {
			duration:  v.duration,
			views:     v.views.map(|n| n as u64),
			creator:   v.creator,
			publisher: v.publisher,
		}),
		facts:      m
			.facts
			.into_iter()
			.map(|f| Fact { label: f.label, values: f.values })
			.collect(),
	});
	WebHit {
		url: dto.url,
		title: dto.title,
		snippet: dto.snippet,
		site: dto.site,
		favicon: dto.favicon,
		published: dto.published,
		thumbnail: dto.thumbnail,
		sitelinks: dto
			.sitelinks
			.into_iter()
			.map(|l| Link { title: l.title, url: l.url })
			.collect(),
		metadata,
	}
}

fn news_hit_from_dto(dto: CelestialNewsHitDto) -> NewsHit {
	NewsHit {
		url:       dto.url,
		title:     dto.title,
		snippet:   dto.snippet,
		source:    dto.source,
		published: dto.published,
		thumbnail: dto.thumbnail,
	}
}

fn image_hit_from_dto(dto: CelestialImageHitDto) -> ImageHit {
	ImageHit {
		url:       dto.url,
		page:      dto.page,
		title:     dto.title,
		thumbnail: dto.thumbnail,
		width:     dto.width,
		height:    dto.height,
	}
}

fn video_hit_from_dto(dto: CelestialVideoHitDto) -> VideoHit {
	VideoHit {
		url:       dto.url,
		title:     dto.title,
		snippet:   dto.snippet,
		duration:  dto.duration,
		publisher: dto.publisher,
		creator:   dto.creator,
		views:     dto.views.map(|v| v as u64),
		published: dto.published,
		thumbnail: dto.thumbnail,
	}
}

fn panel_from_dto(dto: CelestialPanelDto) -> Panel {
	let kind = match dto.kind.as_str() {
		"answer" => PanelKind::Answer,
		"translation" => PanelKind::Translation,
		"correction" => PanelKind::Correction,
		_ => PanelKind::Entity,
	};
	Panel {
		kind,
		title: dto.title,
		subtitle: dto.subtitle,
		text: dto.text,
		url: dto.url,
		image: dto.image,
		source: dto.source,
		facts: dto
			.facts
			.into_iter()
			.map(|f| Fact { label: f.label, values: f.values })
			.collect(),
		links: dto
			.links
			.into_iter()
			.map(|l| Link { title: l.title, url: l.url })
			.collect(),
		related: dto.related,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn canonical_url_normalization_matches_astronomer_rules() {
		assert_eq!(
			celestial_normalize_url(
				"http://www.Example.com:80/docs/?utm_source=x&b=2&a=1#frag".to_owned()
			),
			"https://example.com/docs?a=1&b=2"
		);
		assert_eq!(
			celestial_normalize_url("https://example.com/".to_owned()),
			"https://example.com/"
		);
		assert_eq!(
			celestial_normalize_url("https://example.com/%7Euser/%e2%9c%93".to_owned()),
			"https://example.com/~user/%E2%9C%93"
		);
	}

	#[test]
	fn pow_solver_solves_argon2id_challenge() {
		let solution = celestial_solve_brave_pow(
			"brave-challenge-token".to_owned(),
			1,
			1000,
			Some(64),
			Some(1),
			Some(1),
			Some(32),
		)
		.expect("should find 1-zero-nibble nonce quickly");
		assert_eq!(solution.len(), 32);

		let params = pow::Params::new(64, 1, 1, Some(32)).unwrap();
		let argon = pow::Argon2::new(pow::Algorithm::Argon2id, pow::Version::V0x13, params);
		let mut digest = [0u8; 32];
		argon
			.hash_password_into(b"brave-challenge-token", solution.as_bytes(), &mut digest)
			.unwrap();
		assert!(pow::has_leading_zeros(&digest, 1));
	}

	#[test]
	fn duckduckgo_jsa_evaluates_d_js_payload() {
		let script = r#"
if (true) {
	DDG.deep.setUpstream("bing");
	DDG.deep.deepPayload = { "instantAnswers": [], "recommendedTabs": { "maxVisibleTabs": 1, "tabOrder": [] } };
	DDG.pageLayout.load("d", [
		{
			"a": "<b>Rust</b> is a systems programming language.",
			"c": "https://www.rust-lang.org/",
			"d": "rust-lang.org",
			"da": "",
			"h": 0,
			"i": "rust-lang.org",
			"k": null,
			"m": 0,
			"o": 0,
			"p": 0,
			"s": "Rust Programming Language",
			"t": "Rust Programming Language",
			"u": "https://www.rust-lang.org/"
		},
		{ "n": "/d.js?q=rust&s=10" }
	]);
	DDG.duckbar.loadModule("related_searches", {
		"query": "rust",
		"queryEncoded": "rust",
		"response_type": "places",
		"vqd": {},
		"results": [
			{ "text": "rust book", "display_text": "rust book", "web_search_url": "/?q=rust+book" }
		]
	});
}
"#;
		let out =
			celestial_eval_duckduckgo_script(script.to_owned(), Some("rust".to_owned())).unwrap();
		assert_eq!(out.status, "ok");
		let page = out.page.expect("page should be present");
		assert_eq!(page.web.len(), 1);
		assert_eq!(page.web[0].url, "https://www.rust-lang.org/");
		assert_eq!(page.web[0].title, "Rust Programming Language");
		assert_eq!(page.web[0].snippet, "Rust is a systems programming language.");
		assert_eq!(page.related, vec!["rust book"]);
	}

	#[test]
	fn fuse_pages_merges_and_ranks_consensus_hits() {
		let empty_page = CelestialPageDto {
			web:     vec![],
			news:    vec![],
			images:  vec![],
			videos:  vec![],
			related: vec![],
			panels:  vec![],
		};
		let brave_page = CelestialPageDto {
			web: vec![
				CelestialWebHitDto {
					url:       "https://www.rust-lang.org/".to_owned(),
					title:     "Rust".to_owned(),
					snippet:   "".to_owned(),
					site:      Some("Rust".to_owned()),
					favicon:   None,
					published: None,
					thumbnail: None,
					sitelinks: vec![],
					metadata:  None,
				},
				CelestialWebHitDto {
					url:       "https://docs.rs/".to_owned(),
					title:     "Docs.rs".to_owned(),
					snippet:   "Rust package docs".to_owned(),
					site:      None,
					favicon:   None,
					published: None,
					thumbnail: None,
					sitelinks: vec![],
					metadata:  None,
				},
			],
			related: vec!["cargo".to_owned()],
			..empty_page.clone()
		};
		let ddg_page = CelestialPageDto {
			web: vec![CelestialWebHitDto {
				url:       "http://rust-lang.org?utm_source=ddg#top".to_owned(),
				title:     "Rust Lang".to_owned(),
				snippet:   "A language empowering everyone.".to_owned(),
				site:      None,
				favicon:   Some(
					"https://external-content.duckduckgo.com/ip3/rust-lang.org.ico".to_owned(),
				),
				published: None,
				thumbnail: None,
				sitelinks: vec![],
				metadata:  None,
			}],
			related: vec!["rustup".to_owned(), "Cargo".to_owned()],
			..empty_page
		};

		let fused = celestial_fuse_pages(
			vec![
				CelestialEnginePageInput {
					engine: "brave".to_owned(),
					weight: Some(1.0),
					page:   brave_page,
				},
				CelestialEnginePageInput {
					engine: "duckduckgo".to_owned(),
					weight: Some(1.0),
					page:   ddg_page,
				},
			],
			Some("rrf".to_owned()),
			Some(60.0),
		)
		.unwrap();

		assert_eq!(fused.web.len(), 2);
		assert_eq!(fused.web[0].hit.url, "https://www.rust-lang.org/");
		assert_eq!(
			fused.web[0].hit.snippet, "A language empowering everyone.",
			"empty snippet absorbed from second engine"
		);
		assert_eq!(fused.web[0].votes.len(), 2);
		assert_eq!(fused.related, vec!["cargo", "rustup"]);
	}
}
