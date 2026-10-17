use std::{collections::HashMap, iter::Peekable, str::CharIndices};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::{
	Error, HOLE, NAN, NEG_INF, POS_INF, ParseOptions, Result, UNDEFINED, sentinel, special,
	unflatten_at,
};

const MAX_LEN: usize = 1 << 24;

#[derive(Debug, Clone)]
pub struct Arena {
	pub vals: Vec<Value>,
	pub root: i64,
}

impl Arena {
	pub fn get(&self, r: i64) -> Option<&Value> {
		usize::try_from(r).ok().and_then(|i| self.vals.get(i))
	}

	/// Ref stored under `key` in the object at `r`.
	pub fn field(&self, r: i64, key: &str) -> Option<i64> {
		self.get(r)?.as_object()?.get(key)?.as_i64()
	}

	/// Element refs of the plain (untagged) array at `r`.
	pub fn elems(&self, r: i64) -> Option<Vec<i64>> {
		let a = self.get(r)?.as_array()?;
		if a.first().is_some_and(Value::is_string) {
			return None;
		}
		a.iter().map(Value::as_i64).collect()
	}

	pub fn str(&self, r: i64) -> Option<&str> {
		self.get(r)?.as_str()
	}

	pub fn decode<T: DeserializeOwned>(self) -> Result<T> {
		let r = self.root;
		self.decode_at(r)
	}

	pub fn decode_at<T: DeserializeOwned>(self, r: i64) -> Result<T> {
		unflatten_at(self.vals, r, &ParseOptions::default())
	}
}

/// Parse the whole input as one expression.
pub fn parse<T: DeserializeOwned>(src: &str) -> Result<T> {
	let (arena, used) = read(src)?;
	if !src[used..].trim().is_empty() {
		return Err(Error(format!("uneval: trailing input at byte {used}")));
	}
	arena.decode()
}

/// Parse one expression from the start of `src`. Returns the arena and the
/// number of bytes consumed; anything after that is ignored.
pub fn read(src: &str) -> Result<(Arena, usize)> {
	let mut p =
		P { s: src, i: 0, f: Arena { vals: Vec::new(), root: UNDEFINED }, env: HashMap::new() };
	p.f.root = p.expr()?;
	Ok((p.f, p.i))
}

enum Mut {
	Prop(String, i64),
	Index(usize, i64),
	Add(i64),
	Put(i64, i64),
}

struct P<'a> {
	s:   &'a str,
	i:   usize,
	f:   Arena,
	env: HashMap<&'a str, i64>,
}

impl<'a> P<'a> {
	fn e(&self, m: &str) -> Error {
		Error(format!("uneval: {m} at byte {}", self.i))
	}

	fn peek(&self) -> Option<u8> {
		self.s.as_bytes().get(self.i).copied()
	}

	fn ws(&mut self) {
		while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
			self.i += 1;
		}
	}

	fn eat(&mut self, c: u8) -> bool {
		self.ws();
		let hit = self.peek() == Some(c);
		self.i += hit as usize;
		hit
	}

	fn expect(&mut self, c: u8) -> Result<()> {
		if self.eat(c) {
			Ok(())
		} else {
			Err(self.e(&format!("expected `{}`", c as char)))
		}
	}

	fn ident(&mut self) -> Option<&'a str> {
		self.ws();
		let s = self.s;
		let b = s.as_bytes();
		let (st, mut j) = (self.i, self.i);
		while b
			.get(j)
			.is_some_and(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$')
		{
			j += 1;
		}
		if j == st || b[st].is_ascii_digit() {
			return None;
		}
		self.i = j;
		Some(&s[st..j])
	}

	fn want_ident(&mut self) -> Result<&'a str> {
		self.ident().ok_or_else(|| self.e("expected identifier"))
	}

	fn keyword(&mut self, k: &str) -> bool {
		let save = self.i;
		let hit = self.ident() == Some(k);
		if !hit {
			self.i = save;
		}
		hit
	}

	fn digits(&mut self) -> &'a str {
		let s = self.s;
		let st = self.i;
		while self.peek().is_some_and(|c| c.is_ascii_digit()) {
			self.i += 1;
		}
		&s[st..self.i]
	}

	fn uint(&mut self) -> Result<usize> {
		self.ws();
		let d = self.digits();
		d.parse()
			.ok()
			.filter(|&n| n < MAX_LEN)
			.ok_or_else(|| self.e("expected index"))
	}

	fn push(&mut self, v: Value) -> i64 {
		self.f.vals.push(v);
		self.f.vals.len() as i64 - 1
	}

	fn reserve(&mut self) -> usize {
		self.f.vals.push(Value::Null);
		self.f.vals.len() - 1
	}

	fn tagged(&mut self, tag: &str, rest: Vec<Value>) -> i64 {
		let mut a = vec![Value::from(tag)];
		a.extend(rest);
		self.push(Value::Array(a))
	}

	fn num(&mut self, x: f64) -> i64 {
		match sentinel(x) {
			Some(r) => r,
			None => self.push(serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)),
		}
	}

	fn refs(&self, r: i64) -> Result<Vec<i64>> {
		self.f.elems(r).ok_or_else(|| self.e("expected array"))
	}

	fn lit_str(&self, r: Option<i64>) -> Result<String> {
		r.and_then(|r| self.f.str(r))
			.map(str::to_owned)
			.ok_or_else(|| self.e("expected string literal"))
	}

	fn lit_f64(&self, r: i64) -> Option<f64> {
		special(r).or_else(|| self.f.get(r)?.as_f64())
	}

	fn expr(&mut self) -> Result<i64> {
		self.ws();
		match self.peek() {
			None => Err(self.e("unexpected end of input")),
			Some(b'"' | b'\'') => {
				let s = self.string()?;
				Ok(self.push(s.into()))
			},
			Some(b'[') => self.array(),
			Some(b'{') => self.object(),
			Some(b'(') => self.paren(),
			Some(b'/') => self.regex(),
			Some(b'-' | b'.' | b'0'..=b'9') => self.number(),
			Some(b'!') => {
				self.i += 1;
				match self.digits() {
					"0" => Ok(self.push(true.into())),
					"1" => Ok(self.push(false.into())),
					_ => Err(self.e("expected !0 or !1")),
				}
			},
			Some(_) => self.word(),
		}
	}

	fn number(&mut self) -> Result<i64> {
		let neg = self.eat(b'-');
		if self.keyword("Infinity") {
			return Ok(if neg { NEG_INF } else { POS_INF });
		}
		self.ws();
		let st = self.i;
		self.digits();
		if self.peek() == Some(b'.') {
			self.i += 1;
			self.digits();
		}
		if matches!(self.peek(), Some(b'e' | b'E')) {
			self.i += 1;
			if matches!(self.peek(), Some(b'+' | b'-')) {
				self.i += 1;
			}
			self.digits();
		}
		let s = self.s;
		let lit = &s[st..self.i];
		if self.peek() == Some(b'n') {
			self.i += 1;
			let big = if neg {
				format!("-{lit}")
			} else {
				lit.to_owned()
			};
			return Ok(self.tagged("BigInt", vec![big.into()]));
		}
		if let Ok(n) = lit.parse::<i64>() {
			if !(neg && n == 0) {
				return Ok(self.push((if neg { -n } else { n }).into()));
			}
		}
		let x: f64 = lit.parse().map_err(|_| self.e("bad number"))?;
		Ok(self.num(if neg { -x } else { x }))
	}

	fn string(&mut self) -> Result<String> {
		let s = self.s;
		let q = s.as_bytes()[self.i] as char;
		self.i += 1;
		let mut out: Vec<u16> = Vec::new();
		let mut it = s[self.i..].char_indices().peekable();
		while let Some((k, c)) = it.next() {
			match c {
				c if c == q => {
					self.i += k + 1;
					return Ok(String::from_utf16_lossy(&out));
				},
				'\\' => escape(&mut it, &mut out).ok_or_else(|| self.e("bad escape"))?,
				c => out.extend_from_slice(c.encode_utf16(&mut [0; 2])),
			}
		}
		Err(self.e("unterminated string"))
	}

	fn array(&mut self) -> Result<i64> {
		self.i += 1;
		let idx = self.reserve();
		let mut items = Vec::new();
		loop {
			if self.eat(b']') {
				break;
			}
			if self.eat(b',') {
				items.push(Value::from(HOLE)); // [1,,2]
				continue;
			}
			items.push(self.expr()?.into());
			if !self.eat(b',') {
				self.expect(b']')?;
				break;
			}
		}
		self.f.vals[idx] = Value::Array(items);
		Ok(idx as i64)
	}

	fn object(&mut self) -> Result<i64> {
		self.i += 1;
		let idx = self.reserve();
		let mut m = Map::new();
		loop {
			if self.eat(b'}') {
				break;
			}
			let k = self.key()?;
			self.expect(b':')?;
			let v = self.expr()?;
			m.insert(k, v.into());
			if !self.eat(b',') {
				self.expect(b'}')?;
				break;
			}
		}
		self.f.vals[idx] = Value::Object(m);
		Ok(idx as i64)
	}

	fn key(&mut self) -> Result<String> {
		self.ws();
		match self.peek() {
			Some(b'"' | b'\'') => self.string(),
			Some(b'0'..=b'9') => Ok(self.digits().to_owned()),
			_ => Ok(self.want_ident()?.to_owned()),
		}
	}

	fn word(&mut self) -> Result<i64> {
		let w = self.want_ident()?;
		Ok(match w {
			"void" => {
				self.expr()?;
				UNDEFINED
			},
			"undefined" => UNDEFINED,
			"null" => self.push(Value::Null),
			"true" => self.push(true.into()),
			"false" => self.push(false.into()),
			"NaN" => NAN,
			"Infinity" => POS_INF,
			"new" => return self.construct(),
			"Object" => return self.object_call(),
			"Array" => {
				self.expect(b'(')?;
				let n = self.uint()?;
				self.expect(b')')?;
				self.push(Value::Array(vec![Value::from(HOLE); n]))
			},
			name => *self
				.env
				.get(name)
				.ok_or_else(|| self.e(&format!("unknown identifier `{name}`")))?,
		})
	}

	fn args(&mut self) -> Result<Vec<i64>> {
		self.expect(b'(')?;
		let mut v = Vec::new();
		while !self.eat(b')') {
			v.push(self.expr()?);
			if !self.eat(b',') {
				self.expect(b')')?;
				break;
			}
		}
		Ok(v)
	}

	fn construct(&mut self) -> Result<i64> {
		let ty = self.want_ident()?;
		self.ws();
		let args = if self.peek() == Some(b'(') {
			self.args()?
		} else {
			Vec::new()
		};
		let arg = |k: usize| args.get(k).copied();
		Ok(match ty {
			"Date" => {
				let iso = arg(0)
					.and_then(|r| self.lit_f64(r))
					.filter(|ms| ms.is_finite())
					.map(iso8601)
					.unwrap_or_default(); // "" → invalid date → None
				self.tagged("Date", vec![iso.into()])
			},
			"Set" => {
				let items = match arg(0) {
					Some(r) => self.refs(r)?,
					None => Vec::new(),
				};
				self.tagged("Set", items.into_iter().map(Value::from).collect())
			},
			"Map" => {
				let entries = match arg(0) {
					Some(r) => self.refs(r)?,
					None => Vec::new(),
				};
				let mut kv = Vec::new();
				for e in entries {
					match self.refs(e)?.as_slice() {
						&[k, v] => kv.extend([Value::from(k), Value::from(v)]),
						_ => return Err(self.e("Map entry must be [key, value]")),
					}
				}
				self.tagged("Map", kv)
			},
			"URL" | "URLSearchParams" => {
				let s = self.lit_str(arg(0))?;
				self.tagged(ty, vec![s.into()])
			},
			"RegExp" => {
				let src = self.lit_str(arg(0))?;
				let flags = match arg(1) {
					Some(r) => self.lit_str(Some(r))?,
					None => String::new(),
				};
				self.tagged("RegExp", vec![src.into(), flags.into()])
			},
			t if t.ends_with("Array") => match arg(0) {
				Some(r) => r, // typed array → plain number array
				None => self.push(Value::Array(Vec::new())),
			},
			t => return Err(self.e(&format!("unsupported `new {t}`"))),
		})
	}

	/// `Object("boxed")`, `Object.create(null)`,
	/// `Object.assign(Object.create(null), {..})`
	fn object_call(&mut self) -> Result<i64> {
		if self.eat(b'.') {
			let m = self.want_ident()?;
			let args = self.args()?;
			return match (m, args.as_slice()) {
				("create", _) => Ok(self.push(Value::Object(Map::new()))),
				("assign", &[_, src]) => Ok(src),
				_ => Err(self.e(&format!("unsupported `Object.{m}`"))),
			};
		}
		match self.args()?.as_slice() {
			&[inner] => Ok(inner),
			_ => Err(self.e("expected Object(x)")),
		}
	}

	fn regex(&mut self) -> Result<i64> {
		let s = self.s;
		let b = s.as_bytes();
		let st = self.i + 1;
		let (mut j, mut class) = (st, false);
		loop {
			match b.get(j) {
				None => return Err(self.e("unterminated regex")),
				Some(b'\\') => {
					j += 2;
					continue;
				},
				Some(b'[') => class = true,
				Some(b']') => class = false,
				Some(b'/') if !class => break,
				_ => {},
			}
			j += 1;
		}
		self.i = j + 1;
		while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
			self.i += 1;
		}
		let (src, flags) = (&s[st..j], &s[j + 1..self.i]);
		Ok(self.tagged("RegExp", vec![src.into(), flags.into()]))
	}

	fn paren(&mut self) -> Result<i64> {
		self.i += 1;
		if self.keyword("function") {
			return self.iife();
		}
		let r = self.expr()?;
		self.expect(b')')?;
		Ok(r)
	}

	/// `(function(a,b){a.x=..;b.add(..);return ..}(A,B))`
	fn iife(&mut self) -> Result<i64> {
		let outer = std::mem::take(&mut self.env);
		self.expect(b'(')?;
		let mut params = Vec::new();
		while !self.eat(b')') {
			let name = self.want_ident()?;
			let slot = self.reserve();
			self.env.insert(name, slot as i64);
			params.push(slot);
			if !self.eat(b',') {
				self.expect(b')')?;
				break;
			}
		}
		self.expect(b'{')?;
		let mut muts = Vec::new();
		let ret = loop {
			if self.keyword("return") {
				let r = self.expr()?;
				self.eat(b';');
				self.expect(b'}')?;
				break r;
			}
			self.statement(&mut muts)?;
			self.expect(b';')?;
		};
		self.env = outer;
		let late = self.eat(b')'); // `(function(){..})(args)` variant
		let args = self.args()?;
		if !late {
			self.expect(b')')?;
		}
		if args.len() != params.len() {
			return Err(self.e("IIFE arity mismatch"));
		}
		for (slot, a) in params.into_iter().zip(args) {
			let v = self
				.f
				.get(a)
				.cloned()
				.ok_or_else(|| self.e("hoisted value must be an object"))?;
			self.f.vals[slot] = v;
		}
		for (slot, m) in muts {
			self.apply(slot, m)?;
		}
		Ok(ret)
	}

	fn statement(&mut self, out: &mut Vec<(usize, Mut)>) -> Result<()> {
		let name = self.want_ident()?;
		let slot = *self
			.env
			.get(name)
			.ok_or_else(|| self.e(&format!("unknown name `{name}`")))? as usize;
		if self.eat(b'[') {
			self.ws();
			let m = if matches!(self.peek(), Some(b'"' | b'\'')) {
				let k = self.string()?;
				self.expect(b']')?;
				self.expect(b'=')?;
				Mut::Prop(k, self.expr()?)
			} else {
				let n = self.uint()?;
				self.expect(b']')?;
				self.expect(b'=')?;
				Mut::Index(n, self.expr()?)
			};
			out.push((slot, m));
			return Ok(());
		}
		self.expect(b'.')?;
		let mut prop = self.want_ident()?;
		self.ws();
		if self.peek() != Some(b'(') {
			self.expect(b'=')?;
			out.push((slot, Mut::Prop(prop.to_owned(), self.expr()?)));
			return Ok(());
		}
		loop {
			let m = match (prop, self.args()?.as_slice()) {
				("add", &[v]) => Mut::Add(v),
				("set", &[k, v]) => Mut::Put(k, v),
				_ => return Err(self.e(&format!("unsupported call `.{prop}(..)`"))),
			};
			out.push((slot, m));
			if !self.eat(b'.') {
				return Ok(());
			}
			prop = self.want_ident()?;
		}
	}

	fn apply(&mut self, slot: usize, m: Mut) -> Result<()> {
		let ok = match (&mut self.f.vals[slot], m) {
			(Value::Object(o), Mut::Prop(k, v)) => {
				o.insert(k, v.into());
				true
			},
			(Value::Object(o), Mut::Index(i, v)) => {
				o.insert(i.to_string(), v.into());
				true
			},
			(Value::Array(a), Mut::Index(i, v))
				if !a.first().is_some_and(Value::is_string) && i < MAX_LEN =>
			{
				if a.len() <= i {
					a.resize(i + 1, Value::from(HOLE));
				}
				a[i] = v.into();
				true
			},
			(Value::Array(a), Mut::Add(v)) if a.first().and_then(Value::as_str) == Some("Set") => {
				a.push(v.into());
				true
			},
			(Value::Array(a), Mut::Put(k, v)) if a.first().and_then(Value::as_str) == Some("Map") => {
				a.extend([Value::from(k), Value::from(v)]);
				true
			},
			_ => false,
		};
		if ok {
			Ok(())
		} else {
			Err(self.e("mutation doesn't fit its target"))
		}
	}
}

fn escape(it: &mut Peekable<CharIndices<'_>>, out: &mut Vec<u16>) -> Option<()> {
	let (_, e) = it.next()?;
	let unit = |out: &mut Vec<u16>, c: char| out.extend_from_slice(c.encode_utf16(&mut [0; 2]));
	match e {
		'n' => out.push(0x0a),
		'r' => out.push(0x0d),
		't' => out.push(0x09),
		'b' => out.push(0x08),
		'f' => out.push(0x0c),
		'v' => out.push(0x0b),
		'0' => out.push(0),
		'x' => out.push(hex(it, 2)? as u16),
		'u' if it.peek().map(|p| p.1) == Some('{') => {
			it.next();
			let mut cp = 0u32;
			loop {
				let (_, d) = it.next()?;
				if d == '}' {
					break;
				}
				cp = cp.checked_mul(16)?.checked_add(d.to_digit(16)?)?;
			}
			unit(out, char::from_u32(cp)?);
		},
		'u' => out.push(hex(it, 4)? as u16), // surrogate halves pair up via utf16
		'\r' => {
			if it.peek().map(|p| p.1) == Some('\n') {
				it.next();
			}
		},
		'\n' | '\u{2028}' | '\u{2029}' => {}, // line continuation
		c => unit(out, c),
	}
	Some(())
}

fn hex(it: &mut impl Iterator<Item = (usize, char)>, n: usize) -> Option<u32> {
	(0..n).try_fold(0, |acc, _| Some(acc * 16 + it.next()?.1.to_digit(16)?))
}

/// epoch ms → `YYYY-MM-DDTHH:MM:SS.mmmZ`
fn iso8601(ms: f64) -> String {
	let ms = ms as i64;
	let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = yoe + era * 400 + (m <= 2) as i64;
	format!(
		"{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
		rem / 3_600_000,
		rem / 60_000 % 60,
		rem / 1000 % 60,
		rem % 1000
	)
}
