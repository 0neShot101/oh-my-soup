//! ```ignore
//! use astronomer::Astronomer;
//! use astronomer::atlas::{Brave, DuckDuckGo, Query};
//!
//! # async fn run() {
//! let astronomer = Astronomer::new()
//!     .engine(Brave::default())
//!     .engine(DuckDuckGo)
//!     .weighted(Startpage, 1.5);
//! let query = Query {
//!     region: "en-US".parse().ok(),
//!     ..Query::new("rust async runtime")
//! };
//! let mut pager = astronomer.search(query);
//! while let Some(results) = pager.next().await {
//!     for fused in &results.web {
//!         println!("{:.4} {}", fused.score, fused.hit.url);
//!     }
//! }
//! # }
//! ```
//!
//! [`Pager::next`] waits for every engine. To show results as engines answer,
//! `observe` the page instead.
//!
//! ```ignore
//! # use astronomer::Astronomer;
//! # use astronomer::atlas::{DuckDuckGo, Query};
//! # async fn run() {
//! # let astronomer = Astronomer::new().engine(DuckDuckGo);
//! let mut pager = astronomer.search(Query::new("rust async runtime"));
//! while let Some(mut observation) = pager.observe() {
//!     while let Some(update) = observation.next().await {
//!         println!("{} answered, waiting on {:?}", update.engine, update.pending);
//!         println!("{} web results so far", update.results.web.len());
//!     }
//! }
//! # }
//! ```

pub mod alignment;
pub mod atlas;
pub mod dedup;

use std::{collections::HashSet, fmt, mem, sync::Arc};

use alignment::{Alignment, Fused, Rrf};
use atlas::{
	Cursor, Dispatch, Engine, EngineError, Fetched, Hit, ImageHit, NewsHit, Page, Panel, PanelKind,
	Query, Region, VideoHit, WebHit,
};
use dedup::{Dedup, Ranking, normalize::Normalized};
use tokio::task::{Id, JoinSet};

pub struct Astronomer<D = Normalized, A = Rrf> {
	engines:   Vec<Slot>,
	dedup:     D,
	alignment: A,
}

struct Slot {
	engine: Arc<dyn Dispatch>,
	weight: f64,
}

/// Fused results of one round.
#[derive(Debug, Clone, Default)]
pub struct Results {
	pub web:      Vec<Fused<WebHit>>,
	pub news:     Vec<Fused<NewsHit>>,
	pub images:   Vec<Fused<ImageHit>>,
	pub videos:   Vec<Fused<VideoHit>>,
	pub related:  Vec<String>,
	pub panels:   Vec<Fused<Panel>>,
	/// in engine order.
	pub failures: Vec<EngineError>,
}

impl Astronomer {
	/// No engines, [`Normalized`] dedup with the canonical chain, [`Rrf`]
	/// alignment.
	pub fn new() -> Self {
		Self { engines: Vec::new(), dedup: Normalized::default(), alignment: Rrf::default() }
	}
}

impl Default for Astronomer {
	fn default() -> Self {
		Self::new()
	}
}

impl<D: Dedup, A: Alignment> Astronomer<D, A> {
	pub fn engine<E>(self, engine: E) -> Self
	where
		E: Engine<search(..): Send> + 'static,
	{
		self.weighted(engine, 1.0)
	}

	pub fn weighted<E>(mut self, engine: E, weight: f64) -> Self
	where
		E: Engine<search(..): Send> + 'static,
	{
		self.engines.push(Slot { engine: Arc::new(engine), weight });
		self
	}

	pub fn dedup<T: Dedup>(self, dedup: T) -> Astronomer<T, A> {
		Astronomer { engines: self.engines, dedup, alignment: self.alignment }
	}

	pub fn alignment<T: Alignment>(self, alignment: T) -> Astronomer<D, T> {
		Astronomer { engines: self.engines, dedup: self.dedup, alignment }
	}

	/// Regions some engine has a market for, sorted by tag; any of them makes a
	/// useful [`Query::region`].
	pub fn regions(&self) -> Vec<Region> {
		let mut regions: Vec<Region> = self
			.engines
			.iter()
			.flat_map(|slot| slot.engine.capabilities().markets)
			.map(|(language, country, _)| {
				format!("{language}-{country}")
					.parse()
					.expect("market tables hold valid subtags")
			})
			.collect();
		regions.sort_unstable();
		regions.dedup();
		regions
	}

	pub fn search(&self, query: Query) -> Pager<'_, D, A> {
		let progress = self
			.engines
			.iter()
			.map(|slot| {
				let verticals = slot.engine.capabilities().verticals;
				match verticals.intersects(query.verticals) {
					true => Progress::Start,
					false => Progress::Done,
				}
			})
			.collect();
		Pager { astronomer: self, query: Arc::new(query), progress, delivered: Delivered::default() }
	}

	/// Fuses `pages`, given in engine order, leaving out hits `delivered` holds.
	pub fn fuse_pages<I>(&self, pages: I, failures: Vec<EngineError>) -> Results
	where
		I: IntoIterator<Item = (usize, Page)>,
		I::IntoIter: ExactSizeIterator,
	{
		self.fuse(pages, failures, &Delivered::default())
	}

	/// Fuses `pages`, given in engine order, leaving out hits `delivered` holds.
	fn fuse<I>(&self, pages: I, failures: Vec<EngineError>, delivered: &Delivered) -> Results
	where
		I: IntoIterator<Item = (usize, Page)>,
		I::IntoIter: ExactSizeIterator,
	{
		let pages = pages.into_iter();
		let mut web = Vec::with_capacity(pages.len());
		let mut news = Vec::with_capacity(pages.len());
		let mut images = Vec::with_capacity(pages.len());
		let mut videos = Vec::with_capacity(pages.len());
		let mut related = Vec::with_capacity(pages.len());
		let mut panels: [Vec<Ranking<Panel>>; PanelKind::ALL.len()] = Default::default();
		for (index, page) in pages {
			let slot = &self.engines[index];
			let (engine, weight) = (slot.engine.name(), slot.weight);
			web.push(Ranking { engine, weight, hits: page.web });
			news.push(Ranking { engine, weight, hits: page.news });
			images.push(Ranking { engine, weight, hits: page.images });
			videos.push(Ranking { engine, weight, hits: page.videos });
			related.push(page.related);

			// Panels only merge within their kind: an answer citing a Wikipedia
			// article is not that article's entity panel.
			let mut by_kind: [Vec<Panel>; PanelKind::ALL.len()] = Default::default();
			for panel in page.panels {
				by_kind[panel.kind as usize].push(panel);
			}
			for (rankings, hits) in panels.iter_mut().zip(by_kind) {
				rankings.push(Ranking { engine, weight, hits });
			}
		}

		Results {
			web: self.rank(web, &delivered.web),
			news: self.rank(news, &delivered.news),
			images: self.rank(images, &delivered.images),
			videos: self.rank(videos, &delivered.videos),
			related: interleave_unique(related),
			panels: alignment::align(
				&self.alignment,
				panels
					.into_iter()
					.flat_map(|rankings| dedup::merge(&self.dedup, rankings))
					.collect(),
			),
			failures,
		}
	}

	/// Merges and aligns `rankings`, without the hits `dedup` finds among
	/// `delivered`.
	fn rank<H: Hit>(&self, rankings: Vec<Ranking<H>>, delivered: &[H]) -> Vec<Fused<H>> {
		let mut fused = dedup::merge(&self.dedup, rankings);
		if !delivered.is_empty() {
			let hits: Vec<&H> = delivered
				.iter()
				.chain(fused.iter().map(|f| &f.hit))
				.collect();
			let groups = self.dedup.group(&hits);
			let (earlier, current) = groups.split_at(delivered.len());
			let earlier: HashSet<usize> = earlier.iter().copied().collect();
			let mut current = current.iter();
			fused.retain(|_| !earlier.contains(current.next().expect("one group per hit")));
		}
		alignment::align(&self.alignment, fused)
	}
}

impl<D: fmt::Debug, A: fmt::Debug> fmt::Debug for Astronomer<D, A> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let engines: Vec<_> = self
			.engines
			.iter()
			.map(|slot| (slot.engine.name(), slot.weight))
			.collect();
		f.debug_struct("Astronomer")
			.field("engines", &engines)
			.field("dedup", &self.dedup)
			.field("alignment", &self.alignment)
			.finish()
	}
}

/// Walks the result pages of one query.
///
/// Each page asks every engine with pages left for its next one, all at once,
/// and fuses the answers. A page leaves out what earlier pages delivered, so a
/// hit one engine ranked on its first page and another on its second shows
/// once. [`Pager::next`] waits for every engine; [`Pager::observe`] shows the
/// fusion after each.
pub struct Pager<'a, D = Normalized, A = Rrf> {
	astronomer: &'a Astronomer<D, A>,
	query:      Arc<Query>,
	/// in engine order.
	progress:   Vec<Progress>,
	delivered:  Delivered,
}

/// The hits of every page delivered so far, by vertical.
#[derive(Default)]
struct Delivered {
	web:    Vec<WebHit>,
	news:   Vec<NewsHit>,
	images: Vec<ImageHit>,
	videos: Vec<VideoHit>,
}

impl Delivered {
	fn record(&mut self, results: &Results) {
		self
			.web
			.extend(results.web.iter().map(|fused| fused.hit.clone()));
		self
			.news
			.extend(results.news.iter().map(|fused| fused.hit.clone()));
		self
			.images
			.extend(results.images.iter().map(|fused| fused.hit.clone()));
		self
			.videos
			.extend(results.videos.iter().map(|fused| fused.hit.clone()));
	}
}

enum Progress {
	/// First page not fetched yet.
	Start,
	/// The next page starts at this cursor.
	At(Cursor),
	/// Out of pages, failed, or covering none of the query's verticals.
	Done,
}

impl<D: Dedup, A: Alignment> Pager<'_, D, A> {
	/// Whether there is an engine left to ask for another page.
	pub fn has_more(&self) -> bool {
		self
			.progress
			.iter()
			.any(|progress| !matches!(progress, Progress::Done))
	}

	/// The next page, once every engine responses have arrived.
	pub async fn next(&mut self) -> Option<Results> {
		let mut fetches = self.fetch()?;
		let mut settled = Vec::with_capacity(fetches.ids.len());
		while let Some(fetched) = fetches.next().await {
			settled.push(fetched);
		}

		settled.sort_unstable_by_key(|&(index, _)| index);
		let mut pages = Vec::with_capacity(settled.len());
		let mut failures = Vec::new();
		for (index, fetched) in settled {
			match fetched {
				Ok((page, next)) => {
					self.progress[index] = next.map_or(Progress::Done, Progress::At);
					pages.push((index, page));
				},
				Err(error) => {
					self.progress[index] = Progress::Done;
					failures.push(error);
				},
			}
		}
		let results = self.astronomer.fuse(pages, failures, &self.delivered);
		self.delivered.record(&results);
		Some(results)
	}

	/// Starts fetching the next page and returns an [`Observation`] of it, fused
	/// anew as each engine answers. `None` once every engine is out of pages or
	/// has failed.
	pub fn observe(&mut self) -> Option<Observation<'_, D, A>> {
		let fetches = self.fetch()?;
		Some(Observation {
			astronomer: self.astronomer,
			progress: &mut self.progress,
			delivered: &mut self.delivered,
			recorded: false,
			pages: Vec::with_capacity(fetches.ids.len()),
			fetches,
			failed: Vec::new(),
			results: Results::default(),
		})
	}

	/// Queries every engine with pages left for its next page
	fn fetch(&self) -> Option<Fetches> {
		let engines = &self.astronomer.engines;
		let mut fetches = Fetches {
			tasks:   JoinSet::new(),
			ids:     Vec::with_capacity(engines.len()),
			engines: Vec::with_capacity(engines.len()),
		};
		for (index, (slot, progress)) in engines.iter().zip(&self.progress).enumerate() {
			let cursor = match progress {
				Progress::Start => None,
				Progress::At(cursor) => Some(Arc::clone(cursor)),
				Progress::Done => continue,
			};
			let task =
				Arc::clone(&slot.engine).spawn(Arc::clone(&self.query), cursor, &mut fetches.tasks);
			fetches.ids.push((task.id(), index));
			fetches.engines.push(slot.engine.name());
		}
		(!fetches.ids.is_empty()).then_some(fetches)
	}
}

impl<D, A> fmt::Debug for Pager<'_, D, A> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let engines: Vec<_> = self
			.astronomer
			.engines
			.iter()
			.zip(&self.progress)
			.map(|(slot, progress)| {
				let state = match progress {
					Progress::Start => "start",
					Progress::At(_) => "more",
					Progress::Done => "done",
				};
				(slot.engine.name(), state)
			})
			.collect();
		f.debug_struct("Pager")
			.field("query", &self.query)
			.field("engines", &engines)
			.finish()
	}
}

struct Fetches {
	tasks:   JoinSet<Fetched>,
	/// Unsettled fetches in engine order: task and engine index.
	ids:     Vec<(Id, usize)>,
	/// Engine names of `ids`, in the same order.
	engines: Vec<&'static str>,
}

impl Fetches {
	async fn next(&mut self) -> Option<(usize, Fetched)> {
		let joined = self.tasks.join_next_with_id().await?;
		let id = match &joined {
			Ok((id, _)) => *id,
			Err(error) => error.id(),
		};
		let position = self
			.ids
			.iter()
			.position(|&(task, _)| task == id)
			.expect("every task is recorded when spawned");
		let (_, index) = self.ids.remove(position);
		let engine = self.engines.remove(position);
		let fetched = joined
			.map(|(_, fetched)| fetched)
			.unwrap_or_else(|panic| Err(EngineError { engine, error: Arc::new(panic) }));
		Some((index, fetched))
	}
}

#[must_use = "dropping an observation cancels its fetches"]
pub struct Observation<'p, D = Normalized, A = Rrf> {
	astronomer: &'p Astronomer<D, A>,
	/// The pager's, advanced as each engine answers.
	progress:   &'p mut [Progress],
	/// The pager's; takes this page's hits once the page is complete or taken.
	delivered:  &'p mut Delivered,
	recorded:   bool,
	fetches:    Fetches,
	/// Received pages in engine order, by engine index.
	pages:      Vec<(usize, Page)>,
	/// Engine index of each of `results.failures`.
	failed:     Vec<usize>,
	results:    Results,
}

/// An [`Observation`] right after one of its engines answered.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct Update<'o> {
	/// The engine that answered, with a page or a failure.
	pub engine:  &'static str,
	/// Why `engine` has no page; also in `results.failures`.
	pub error:   Option<&'o EngineError>,
	/// The fusion of every page received so far. Pages fuse in engine order,
	/// whatever order they arrive in: these are the results [`Pager::next`]
	/// would give if only the engines answered so far were asked.
	pub results: &'o Results,
	/// Engines still fetching, in engine order; empty on the last update.
	pub pending: &'o [&'static str],
}

impl<D: Dedup, A: Alignment> Observation<'_, D, A> {
	pub async fn next(&mut self) -> Option<Update<'_>> {
		let (index, fetched) = self.fetches.next().await?;
		let engine = self.astronomer.engines[index].engine.name();
		let failure = match fetched {
			Ok((page, next)) => {
				self.progress[index] = next.map_or(Progress::Done, Progress::At);
				let at = self.pages.partition_point(|&(other, _)| other < index);
				self.pages.insert(at, (index, page));
				let failures = mem::take(&mut self.results.failures);
				self.results = match self.fetches.ids.is_empty() {
					// No later update needs the pages: fuse them, not copies.
					true => self
						.astronomer
						.fuse(mem::take(&mut self.pages), failures, self.delivered),
					false => self
						.astronomer
						.fuse(self.pages.iter().cloned(), failures, self.delivered),
				};
				None
			},
			Err(error) => {
				self.progress[index] = Progress::Done;
				let at = self.failed.partition_point(|&other| other < index);
				self.failed.insert(at, index);
				self.results.failures.insert(at, error);
				Some(at)
			},
		};
		if self.fetches.ids.is_empty() {
			self.record();
		}

		Some(Update {
			engine,
			error: failure.map(|at| &self.results.failures[at]),
			results: &self.results,
			pending: &self.fetches.engines,
		})
	}

	/// The fusion of every page received so far; empty before the first update.
	pub fn results(&self) -> &Results {
		&self.results
	}

	/// Engines still fetching, in engine order.
	pub fn pending(&self) -> &[&'static str] {
		&self.fetches.engines
	}

	/// Stops observing with the pages received so far, cancelling the engines
	/// still fetching; the pager queries them for the same page again next
	/// time, leaving out what this page delivered. Dropping an observation
	/// instead delivers nothing.
	pub fn into_results(mut self) -> Results {
		self.record();
		mem::take(&mut self.results)
	}

	fn record(&mut self) {
		if !mem::replace(&mut self.recorded, true) {
			self.delivered.record(&self.results);
		}
	}
}

impl<D, A> fmt::Debug for Observation<'_, D, A> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Observation")
			.field("pending", &self.fetches.engines)
			.field("results", &self.results)
			.finish()
	}
}

/// round-robin
fn interleave_unique(lists: Vec<Vec<String>>) -> Vec<String> {
	let mut seen = HashSet::new();
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
