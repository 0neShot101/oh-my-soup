use super::{Alignment, Vote};

/// Weighted CombMNZ (Fox & Shaw, 1994) over rank-derived scores.
/// `(total - rank + 1) / total`: 1 for first place,
/// falling linearly to `1 / total` for last. The weighted sum is multiplied by
/// the number of votes, strongly rewarding agreement between engines.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CombMnz;

impl Alignment for CombMnz {
	fn score(&self, votes: &[Vote]) -> f64 {
		let sum: f64 = votes
			.iter()
			.map(|vote| {
				let total = f64::from(vote.total);
				vote.weight * (total - f64::from(vote.rank) + 1.0) / total
			})
			.sum();
		sum * votes.len() as f64
	}
}
