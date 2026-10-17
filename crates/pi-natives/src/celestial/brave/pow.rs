//! Celestial's proof-of-work and Privacy Pass client, using the original
//! Argon2 and Ristretto implementations rather than substitute cryptography.

use std::{collections::HashMap, fmt};

pub use argon2::{Algorithm, Argon2, Params, Version};
pub use challenge_bypass_ristretto::voprf::{PublicKey, UnblindedToken};
use challenge_bypass_ristretto::{
	errors::TokenError,
	voprf::{BatchDLEQProof, BlindedToken, SignedToken, Token},
};
use hmac::Hmac;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::Sha512;

type HmacSha512 = Hmac<Sha512>;
pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
	Argon2(argon2::Error),
	Token(TokenError),
	DifficultyTooHigh { difficulty: usize, max: usize },
	CountMismatch { expected: usize, actual: usize },
	NoSolution { token: String },
	NetworkError(String),
	ServerError(String),
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Argon2(e) => write!(f, "argon2: {e}"),
			Self::Token(e) => write!(f, "token: {e}"),
			Self::DifficultyTooHigh { difficulty, max } => {
				write!(f, "difficulty {difficulty} exceeds hash length {max}")
			},
			Self::CountMismatch { expected, actual } => {
				write!(f, "expected {expected} signed tokens, got {actual}")
			},
			Self::NoSolution { token } => {
				write!(f, "no solution for token '{token}' within attempt limit")
			},
			Self::NetworkError(e) | Self::ServerError(e) => f.write_str(e),
		}
	}
}

impl std::error::Error for Error {}

impl From<argon2::Error> for Error {
	fn from(e: argon2::Error) -> Self {
		Self::Argon2(e)
	}
}

impl From<TokenError> for Error {
	fn from(e: TokenError) -> Self {
		Self::Token(e)
	}
}

#[derive(Debug, Deserialize)]
pub struct BraveKey {
	pub key_id:     String,
	pub public_key: String,
}

#[derive(Debug, Deserialize)]
pub struct BraveKeysResponse {
	pub keys:                 Vec<BraveKey>,
	pub tokens_per_challenge: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct BravePoWSignRequest {
	pub blinded_messages: Vec<String>,
	pub key_id:           String,
	pub set_token:        String,
	pub solutions:        HashMap<String, String>,
	pub taken_time:       u32,
}

#[derive(Debug, Deserialize)]
pub struct BravePoWSignResponse {
	pub batch_proof:   String,
	pub signed_tokens: Vec<String>,
}

#[derive(Clone)]
pub struct ProofOfWork {
	argon2:     Argon2<'static>,
	output_len: usize,
}

impl ProofOfWork {
	pub const ITERATIONS: u32 = 2;
	pub const MEMORY_KIB: u32 = 512;
	const NONCE_LEN: usize = 16;
	pub const OUTPUT_LEN: usize = 32;
	pub const PARALLELISM: u32 = 1;

	pub fn new(params: Params) -> Self {
		let output_len = params.output_len().unwrap_or(Params::DEFAULT_OUTPUT_LEN);
		Self { argon2: Argon2::new(Algorithm::Argon2id, Version::V0x13, params), output_len }
	}

	/// Difficulty counts leading hexadecimal characters, not zero bytes.
	pub fn solve(&self, challenge: &str, difficulty: usize, limit: usize) -> Result<String> {
		if difficulty > self.output_len * 2 {
			return Err(Error::DifficultyTooHigh { difficulty, max: self.output_len * 2 });
		}
		let mut nonce = [0u8; Self::NONCE_LEN];
		let mut nonce_hex = [0u8; Self::NONCE_LEN * 2];
		let mut digest = vec![0u8; self.output_len];
		for _ in 0..limit {
			OsRng.fill_bytes(&mut nonce);
			hex::encode_to_slice(nonce, &mut nonce_hex)
				.expect("hex buffer is exactly twice the nonce length");
			self
				.argon2
				.hash_password_into(challenge.as_bytes(), &nonce_hex, &mut digest)?;
			if has_leading_zeros(&digest, difficulty) {
				return Ok(std::str::from_utf8(&nonce_hex)
					.expect("hex buffer is valid ASCII")
					.to_owned());
			}
		}
		Err(Error::NoSolution { token: challenge.to_owned() })
	}
}

impl Default for ProofOfWork {
	fn default() -> Self {
		let params =
			Params::new(Self::MEMORY_KIB, Self::ITERATIONS, Self::PARALLELISM, Some(Self::OUTPUT_LEN))
				.expect("built-in Argon2 parameters are valid");
		Self::new(params)
	}
}

pub fn has_leading_zeros(digest: &[u8], count: usize) -> bool {
	let mut zeros = 0;
	for &byte in digest {
		if byte == 0 {
			zeros += 2;
		} else {
			if byte < 0x10 {
				zeros += 1;
			}
			break;
		}
	}
	zeros >= count
}

#[derive(Clone)]
pub struct TokenRequest {
	pub tokens: Vec<Token>,
	blinded:    Vec<BlindedToken>,
}

impl TokenRequest {
	pub fn new(count: usize) -> Self {
		let mut rng = OsRng;
		let (tokens, blinded) = (0..count)
			.map(|_| {
				let token = Token::random::<Sha512, OsRng>(&mut rng);
				let blinded = token.blind();
				(token, blinded)
			})
			.unzip();
		Self { tokens, blinded }
	}

	pub fn encode_blinded(&self) -> Vec<String> {
		self
			.blinded
			.iter()
			.map(BlindedToken::encode_base64)
			.collect()
	}

	/// Verify the issuer's proof before accepting or unblinding any signed
	/// token.
	pub fn finalize(
		self,
		response: &IssuanceResponse,
		public_key: &PublicKey,
	) -> Result<Vec<UnblindedToken>> {
		if response.signed_tokens.len() != self.tokens.len() {
			return Err(Error::CountMismatch {
				expected: self.tokens.len(),
				actual:   response.signed_tokens.len(),
			});
		}
		Ok(response.proof.verify_and_unblind::<Sha512, _>(
			&self.tokens,
			&self.blinded,
			&response.signed_tokens,
			public_key,
		)?)
	}
}

pub struct IssuanceResponse {
	signed_tokens: Vec<SignedToken>,
	proof:         BatchDLEQProof,
}

impl IssuanceResponse {
	pub const fn new(signed_tokens: Vec<SignedToken>, proof: BatchDLEQProof) -> Self {
		Self { signed_tokens, proof }
	}

	pub fn from_base64<S: AsRef<str>>(signed_tokens: &[S], proof: &str) -> Result<Self> {
		let signed_tokens = signed_tokens
			.iter()
			.map(|s| SignedToken::decode_base64(s.as_ref()))
			.collect::<std::result::Result<Vec<_>, _>>()?;
		Ok(Self::new(signed_tokens, BatchDLEQProof::decode_base64(proof)?))
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redemption {
	pub preimage:  String,
	pub signature: String,
}

impl Redemption {
	pub fn new(token: &UnblindedToken, message: &[u8]) -> Self {
		let signature = token
			.derive_verification_key::<Sha512>()
			.sign::<HmacSha512>(message);
		Self { preimage: token.t.encode_base64(), signature: signature.encode_base64() }
	}
}

#[cfg(test)]
mod tests {
	use challenge_bypass_ristretto::voprf::{SigningKey, TokenPreimage, VerificationSignature};
	use rand::{SeedableRng, rngs::StdRng};

	use super::*;

	#[test]
	fn issuance_rejects_the_wrong_issuer_and_valid_tokens_redeem() {
		let mut rng = StdRng::seed_from_u64(42);
		let issuer = SigningKey::random(&mut rng);
		let other_issuer = SigningKey::random(&mut rng);
		let request = TokenRequest::new(2);
		let signed: Vec<_> = request
			.blinded
			.iter()
			.map(|token| issuer.sign(token).unwrap())
			.collect();
		let proof =
			BatchDLEQProof::new::<Sha512, StdRng>(&mut rng, &request.blinded, &signed, &issuer)
				.unwrap();
		let response = IssuanceResponse::new(signed, proof);
		assert!(
			request
				.clone()
				.finalize(&response, &other_issuer.public_key)
				.is_err()
		);
		let tokens = request.finalize(&response, &issuer.public_key).unwrap();
		let redemption = Redemption::new(&tokens[0], b"test message");
		let preimage = TokenPreimage::decode_base64(&redemption.preimage).unwrap();
		let expected = issuer
			.rederive_unblinded_token(&preimage)
			.derive_verification_key::<Sha512>()
			.sign::<HmacSha512>(b"test message");
		assert!(VerificationSignature::decode_base64(&redemption.signature).unwrap() == expected);
	}
}
