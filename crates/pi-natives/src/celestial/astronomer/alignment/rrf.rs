use super::{Alignment, Vote};

/// Weighted Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, 2009):
/// `Σ weight / (k + rank)`. Larger `k` flattens the advantage of top positions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rrf {
	pub k: f64,
}

impl Default for Rrf {
	/// `k = 60`, the value from the paper.
	fn default() -> Self {
		Self { k: 60.0 }
	}
}

impl Alignment for Rrf {
	fn score(&self, votes: &[Vote]) -> f64 {
		votes
			.iter()
			.map(|vote| vote.weight / (self.k + f64::from(vote.rank)))
			.sum()
	}
}
