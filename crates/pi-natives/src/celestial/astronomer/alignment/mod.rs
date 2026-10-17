mod combmnz;
mod rrf;

pub use combmnz::CombMnz;
pub use rrf::Rrf;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vote {
	pub engine: &'static str,
	/// 1-based position in the engine's ranking.
	pub rank:   u32,
	/// Length of that ranking; never below `rank`.
	pub total:  u32,
	/// Engine weight configured on the [`Astronomer`](crate::Astronomer).
	pub weight: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Fused<H> {
	pub hit:   H,
	/// Fused relevance; higher is better.
	pub score: f64,
	/// At most one vote per engine ranking, in rank order.
	pub votes: Vec<Vote>,
}

pub trait Alignment {
	/// Higher scores rank first.
	fn score(&self, votes: &[Vote]) -> f64;
}

pub fn align<H, A>(alignment: &A, mut candidates: Vec<Fused<H>>) -> Vec<Fused<H>>
where
	A: Alignment + ?Sized,
{
	for candidate in &mut candidates {
		candidate.score = alignment.score(&candidate.votes);
	}
	candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
	candidates
}
