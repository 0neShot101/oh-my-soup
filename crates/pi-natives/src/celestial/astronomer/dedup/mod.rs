pub mod normalize;

use std::collections::HashSet;

use super::{
	alignment::{Fused, Vote},
	atlas::Hit,
};

/// Decides which hits are the same resource.
pub trait Dedup {
	fn group<H: Hit>(&self, hits: &[&H]) -> Vec<usize>;
}

/// One engine's hits for a vertical, best first.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranking<H> {
	pub engine: &'static str,
	pub weight: f64,
	pub hits:   Vec<H>,
}

pub fn merge<H, D>(dedup: &D, rankings: Vec<Ranking<H>>) -> Vec<Fused<H>>
where
	H: Hit,
	D: Dedup,
{
	let depth = rankings.iter().map(|r| r.hits.len()).max().unwrap_or(0);
	let order: Vec<(usize, usize)> = (0..depth)
		.flat_map(|rank| {
			rankings
				.iter()
				.enumerate()
				.filter(move |(_, ranking)| rank < ranking.hits.len())
				.map(move |(list, _)| (list, rank))
		})
		.collect();
	let groups = {
		let hits: Vec<&H> = order
			.iter()
			.map(|&(list, rank)| &rankings[list].hits[rank])
			.collect();
		dedup.group(&hits)
	};
	assert_eq!(groups.len(), order.len(), "Dedup::group returns one id per hit");

	let mut ids = vec![usize::MAX; order.len()];
	let mut count = 0;
	let mut voted = HashSet::<(usize, usize)>::new();
	let mut slots: Vec<Vec<(usize, bool)>> = rankings
		.iter()
		.map(|ranking| Vec::with_capacity(ranking.hits.len()))
		.collect();
	for (&(list, _), group) in order.iter().zip(groups) {
		let id = &mut ids[group];
		if *id == usize::MAX {
			*id = count;
			count += 1;
		}
		slots[list].push((*id, voted.insert((*id, list))));
	}

	let mut candidates: Vec<Option<Fused<H>>> =
		std::iter::repeat_with(|| None).take(count).collect();
	let mut lists: Vec<_> = rankings
		.into_iter()
		.zip(slots)
		.map(|(ranking, slots)| {
			let total = ranking.hits.len() as u32;
			let hits = ranking.hits.into_iter().zip(slots);
			(ranking.engine, ranking.weight, total, hits)
		})
		.collect();
	for rank in 1..=depth as u32 {
		for &mut (engine, weight, total, ref mut hits) in &mut lists {
			let Some((hit, (id, votes))) = hits.next() else {
				continue;
			};
			let vote = votes.then_some(Vote { engine, rank, total, weight });
			if let Some(candidate) = &mut candidates[id] {
				candidate.hit.absorb(hit);
				candidate.votes.extend(vote);
			} else {
				candidates[id] = Some(Fused { hit, score: 0.0, votes: Vec::from_iter(vote) });
			}
		}
	}

	candidates
		.into_iter()
		.map(|candidate| candidate.expect("every candidate id has a hit"))
		.collect()
}
