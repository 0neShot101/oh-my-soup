pub mod uneval;

use std::{
	borrow::Cow,
	cell::Cell,
	collections::{BTreeMap, HashMap},
	fmt::{self, Write as _},
	iter,
};

use serde::{
	Deserialize,
	de::{
		self, DeserializeOwned, DeserializeSeed, EnumAccess, IntoDeserializer, MapAccess, SeqAccess,
		VariantAccess, Visitor,
	},
	ser::{self, Serialize},
};
use serde_json::Value;

const UNDEFINED: i64 = -1;
const HOLE: i64 = -2;
const NAN: i64 = -3;
const POS_INF: i64 = -4;
const NEG_INF: i64 = -5;
const NEG_ZERO: i64 = -6;
const SPARSE: i64 = -7;
const MAX_SAFE: u128 = (1 << 53) - 1;
const MAX_ARRAY_LEN: u64 = (1 << 32) - 1;
const STASHED: i64 = i64::MIN;
const DATE_TOKEN: &str = "$devalue::Date";

const SPECIALS: [(i64, f64); 4] =
	[(NAN, f64::NAN), (POS_INF, f64::INFINITY), (NEG_INF, f64::NEG_INFINITY), (NEG_ZERO, -0.0)];

fn sentinel(x: f64) -> Option<i64> {
	SPECIALS
		.iter()
		.find(|(_, s)| s.to_bits() == x.to_bits() || (s.is_nan() && x.is_nan()))
		.map(|&(r, _)| r)
}

fn special(r: i64) -> Option<f64> {
	SPECIALS.iter().find(|&&(s, _)| s == r).map(|&(_, f)| f)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Error(String);
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		f.write_str(&self.0)
	}
}
impl std::error::Error for Error {}
impl ser::Error for Error {
	fn custom<T: fmt::Display>(m: T) -> Self {
		Error(m.to_string())
	}
}
impl de::Error for Error {
	fn custom<T: fmt::Display>(m: T) -> Self {
		Error(m.to_string())
	}
}

fn invalid() -> Error {
	Error("Invalid input".into())
}
fn fail<T>(m: &str) -> Result<T> {
	Err(Error(m.into()))
}
fn ensure(ok: bool) -> Result<()> {
	ok.then_some(()).or_invalid()
}

trait OrInvalid<T> {
	fn or_invalid(self) -> Result<T>;
}
impl<T> OrInvalid<T> for Option<T> {
	fn or_invalid(self) -> Result<T> {
		self.ok_or_else(invalid)
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Date(pub String);

impl Serialize for Date {
	fn serialize<S: ser::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
		s.serialize_newtype_struct(DATE_TOKEN, &self.0)
	}
}
impl<'de> Deserialize<'de> for Date {
	fn deserialize<D: de::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
		String::deserialize(d).map(Date)
	}
}

pub fn nullish<'de, D, T>(d: D) -> std::result::Result<T, D::Error>
where
	D: de::Deserializer<'de>,
	T: Deserialize<'de> + Default,
{
	Option::<T>::deserialize(d).map(Option::unwrap_or_default)
}

pub fn stringify<T: ?Sized + Serialize>(value: &T) -> Result<String> {
	let mut f = Flat::default();
	match value.serialize(&mut f)? {
		r if r < 0 => Ok(r.to_string()),
		_ => f
			.slots
			.into_iter()
			.collect::<Option<Vec<_>>>()
			.map(array)
			.ok_or_else(|| Error("internal: unfilled slot".into())),
	}
}

fn join<T: fmt::Display>(xs: impl IntoIterator<Item = T>) -> String {
	xs.into_iter()
		.map(|x| x.to_string())
		.collect::<Vec<_>>()
		.join(",")
}
fn array<T: fmt::Display>(xs: impl IntoIterator<Item = T>) -> String {
	format!("[{}]", join(xs))
}
fn object<'k>(kv: impl IntoIterator<Item = (&'k str, i64)>) -> String {
	format!("{{{}}}", join(kv.into_iter().map(|(k, v)| format!("{}:{v}", quote(k)))))
}
fn tagged(tag: &str, rest: impl IntoIterator<Item = String>) -> String {
	array(iter::once(quote(tag)).chain(rest))
}

fn escape(c: char) -> Option<&'static str> {
	Some(match c {
		'"' => "\\\"",
		'\\' => "\\\\",
		'<' => "\\u003C",
		'\n' => "\\n",
		'\r' => "\\r",
		'\t' => "\\t",
		'\u{8}' => "\\b",
		'\u{c}' => "\\f",
		'\u{2028}' => "\\u2028",
		'\u{2029}' => "\\u2029",
		_ => return None,
	})
}

fn quote(s: &str) -> String {
	s.chars().fold(String::from('"'), |mut o, c| {
		match escape(c) {
			Some(e) => o.push_str(e),
			None if (c as u32) < 0x20 => {
				let _ = write!(o, "\\u{:04x}", c as u32);
			},
			None => o.push(c),
		}
		o
	}) + "\""
}

fn fmt_num(x: f64) -> String {
	let a = x.abs();
	if a != 0.0 && (a >= 1e21 || a < 1e-6) {
		format!("{x:e}")
	} else {
		format!("{x}")
	}
}

#[derive(Hash, PartialEq, Eq)]
enum Prim {
	Null,
	Bool(bool),
	Num(u64),
	Str(String),
	Big(String),
}

enum MKey {
	S(String),
	I(i64),
}

impl MKey {
	fn as_str(&self) -> Option<&str> {
		match self {
			MKey::S(s) => Some(s),
			MKey::I(_) => None,
		}
	}
}

type Wrap = Option<(usize, &'static str)>;

#[derive(Default)]
struct Flat {
	slots: Vec<Option<String>>,
	prims: HashMap<Prim, i64>,
	stash: Option<String>,
}

impl Flat {
	fn reserve(&mut self) -> usize {
		self.slots.push(None);
		self.slots.len() - 1
	}

	fn fill(&mut self, i: usize, s: String) -> i64 {
		self.slots[i] = Some(s);
		i as i64
	}

	fn push(&mut self, s: String) -> i64 {
		let i = self.reserve();
		self.fill(i, s)
	}

	fn prim(&mut self, k: Prim, render: impl FnOnce() -> String) -> i64 {
		let slots = &mut self.slots;
		*self.prims.entry(k).or_insert_with(|| {
			slots.push(Some(render()));
			slots.len() as i64 - 1
		})
	}

	fn null(&mut self) -> i64 {
		self.prim(Prim::Null, || "null".into())
	}

	fn str(&mut self, s: &str) -> i64 {
		self.prim(Prim::Str(s.to_owned()), || quote(s))
	}

	fn num(&mut self, x: f64) -> i64 {
		sentinel(x).unwrap_or_else(|| self.prim(Prim::Num(x.to_bits()), || fmt_num(x)))
	}

	fn big(&mut self, s: String) -> i64 {
		let body = tagged("BigInt", [quote(&s)]);
		self.prim(Prim::Big(s), || body)
	}

	fn int(&mut self, n: i128) -> i64 {
		if n.unsigned_abs() <= MAX_SAFE {
			self.num(n as f64)
		} else {
			self.big(n.to_string())
		}
	}

	fn key_of<T: ?Sized + Serialize>(&mut self, v: &T) -> Result<MKey> {
		Ok(match v.serialize(KeySer(&mut *self))? {
			STASHED => MKey::S(self.stash.take().unwrap_or_default()),
			i => MKey::I(i),
		})
	}
}

fn close(f: &mut Flat, idx: usize, body: String, wrap: Wrap) -> i64 {
	let i = f.fill(idx, body);
	wrap.map_or(i, |(o, name)| f.fill(o, object([(name, i)])))
}

macro_rules! ser_ints {
    ($($m:ident: $t:ty),*) => { $( fn $m(self, v: $t) -> Result<i64> { Ok(self.int(v.into())) } )* };
}

impl<'a> ser::Serializer for &'a mut Flat {
	type Error = Error;
	type Ok = i64;
	type SerializeMap = Dict<'a>;
	type SerializeSeq = Arr<'a>;
	type SerializeStruct = Dict<'a>;
	type SerializeStructVariant = Dict<'a>;
	type SerializeTuple = Arr<'a>;
	type SerializeTupleStruct = Arr<'a>;
	type SerializeTupleVariant = Arr<'a>;

	ser_ints!(serialize_i8: i8, serialize_i16: i16, serialize_i32: i32, serialize_i64: i64,
              serialize_i128: i128, serialize_u8: u8, serialize_u16: u16, serialize_u32: u32,
              serialize_u64: u64);

	fn serialize_bool(self, v: bool) -> Result<i64> {
		Ok(self.prim(Prim::Bool(v), || v.to_string()))
	}

	fn serialize_u128(self, v: u128) -> Result<i64> {
		Ok(if v <= MAX_SAFE {
			self.num(v as f64)
		} else {
			self.big(v.to_string())
		})
	}

	fn serialize_f32(self, v: f32) -> Result<i64> {
		let w = if v.is_finite() {
			v.to_string().parse().unwrap_or(v.into())
		} else {
			v.into()
		};
		Ok(self.num(w))
	}

	fn serialize_f64(self, v: f64) -> Result<i64> {
		Ok(self.num(v))
	}

	fn serialize_char(self, v: char) -> Result<i64> {
		Ok(self.str(v.encode_utf8(&mut [0; 4])))
	}

	fn serialize_str(self, v: &str) -> Result<i64> {
		Ok(self.str(v))
	}

	fn serialize_bytes(self, v: &[u8]) -> Result<i64> {
		let i = self.reserve();
		let b = self.push(tagged("ArrayBuffer", [quote(&b64_encode(v))]));
		Ok(self.fill(i, tagged("Uint8Array", [b.to_string()])))
	}

	fn serialize_none(self) -> Result<i64> {
		Ok(self.null())
	}

	fn serialize_some<T: ?Sized + Serialize>(self, v: &T) -> Result<i64> {
		v.serialize(self)
	}

	fn serialize_unit(self) -> Result<i64> {
		Ok(self.null())
	}

	fn serialize_unit_struct(self, _: &'static str) -> Result<i64> {
		Ok(self.null())
	}

	fn serialize_unit_variant(self, _: &'static str, _: u32, var: &'static str) -> Result<i64> {
		Ok(self.str(var))
	}

	fn serialize_newtype_struct<T: ?Sized + Serialize>(
		self,
		name: &'static str,
		v: &T,
	) -> Result<i64> {
		if name != DATE_TOKEN {
			return v.serialize(self);
		}
		let idx = self.reserve();
		let MKey::S(iso) = self.key_of(v)? else {
			return fail("devalue::Date must wrap a string");
		};
		Ok(self.fill(idx, tagged("Date", [quote(&iso)])))
	}

	fn serialize_newtype_variant<T: ?Sized + Serialize>(
		self,
		_: &'static str,
		_: u32,
		var: &'static str,
		v: &T,
	) -> Result<i64> {
		let o = self.reserve();
		let i = v.serialize(&mut *self)?;
		Ok(self.fill(o, object([(var, i)])))
	}

	fn serialize_seq(self, _: Option<usize>) -> Result<Arr<'a>> {
		Ok(Arr::new(self, None))
	}

	fn serialize_tuple(self, _: usize) -> Result<Arr<'a>> {
		Ok(Arr::new(self, None))
	}

	fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Arr<'a>> {
		Ok(Arr::new(self, None))
	}

	fn serialize_tuple_variant(
		self,
		_: &'static str,
		_: u32,
		var: &'static str,
		_: usize,
	) -> Result<Arr<'a>> {
		let o = self.reserve();
		Ok(Arr::new(self, Some((o, var))))
	}

	fn serialize_map(self, _: Option<usize>) -> Result<Dict<'a>> {
		Ok(Dict::new(self, None))
	}

	fn serialize_struct(self, _: &'static str, _: usize) -> Result<Dict<'a>> {
		Ok(Dict::new(self, None))
	}

	fn serialize_struct_variant(
		self,
		_: &'static str,
		_: u32,
		var: &'static str,
		_: usize,
	) -> Result<Dict<'a>> {
		let o = self.reserve();
		Ok(Dict::new(self, Some((o, var))))
	}
}

pub struct Arr<'a> {
	f:     &'a mut Flat,
	idx:   usize,
	wrap:  Wrap,
	items: Vec<i64>,
}

impl<'a> Arr<'a> {
	fn new(f: &'a mut Flat, wrap: Wrap) -> Self {
		let idx = f.reserve();
		Arr { f, idx, wrap, items: vec![] }
	}

	fn push<T: ?Sized + Serialize>(&mut self, v: &T) -> Result<()> {
		self.items.push(v.serialize(&mut *self.f)?);
		Ok(())
	}

	fn done(self) -> Result<i64> {
		Ok(close(self.f, self.idx, array(self.items), self.wrap))
	}
}

macro_rules! arr_like {
    ($($tr:ident :: $m:ident),*) => { $(
        impl ser::$tr for Arr<'_> {
            type Ok = i64;
            type Error = Error;
            fn $m<T: ?Sized + Serialize>(&mut self, v: &T) -> Result<()> { self.push(v) }
            fn end(self) -> Result<i64> { self.done() }
        }
    )* };
}
arr_like!(
	SerializeSeq::serialize_element,
	SerializeTuple::serialize_element,
	SerializeTupleStruct::serialize_field,
	SerializeTupleVariant::serialize_field
);

pub struct Dict<'a> {
	f:    &'a mut Flat,
	idx:  usize,
	wrap: Wrap,
	keys: Vec<MKey>,
	vals: Vec<i64>,
}

impl<'a> Dict<'a> {
	fn new(f: &'a mut Flat, wrap: Wrap) -> Self {
		let idx = f.reserve();
		Dict { f, idx, wrap, keys: vec![], vals: vec![] }
	}

	fn val<T: ?Sized + Serialize>(&mut self, v: &T) -> Result<()> {
		self.vals.push(v.serialize(&mut *self.f)?);
		Ok(())
	}

	fn done(self) -> Result<i64> {
		let Dict { f, idx, wrap, keys, vals } = self;
		let body = match keys.iter().map(MKey::as_str).collect::<Option<Vec<_>>>() {
			Some(ks) if ks.contains(&"__proto__") => {
				return fail("Cannot stringify objects with __proto__ keys");
			},
			Some(ks) => object(ks.into_iter().zip(vals)),
			None => {
				let ks: Vec<i64> = keys
					.iter()
					.map(|k| match k {
						MKey::S(s) => f.str(s),
						MKey::I(i) => *i,
					})
					.collect();
				tagged(
					"Map",
					ks.into_iter()
						.zip(vals)
						.flat_map(|(k, v)| [k.to_string(), v.to_string()]),
				)
			},
		};
		Ok(close(f, idx, body, wrap))
	}
}

impl ser::SerializeMap for Dict<'_> {
	type Error = Error;
	type Ok = i64;

	fn serialize_key<T: ?Sized + Serialize>(&mut self, k: &T) -> Result<()> {
		let k = self.f.key_of(k)?;
		self.keys.push(k);
		Ok(())
	}

	fn serialize_value<T: ?Sized + Serialize>(&mut self, v: &T) -> Result<()> {
		self.val(v)
	}

	fn end(self) -> Result<i64> {
		self.done()
	}
}

macro_rules! dict_like {
    ($($tr:ident),*) => { $(
        impl ser::$tr for Dict<'_> {
            type Ok = i64;
            type Error = Error;
            fn serialize_field<T: ?Sized + Serialize>(&mut self, k: &'static str, v: &T) -> Result<()> {
                self.keys.push(MKey::S(k.into()));
                self.val(v)
            }
            fn end(self) -> Result<i64> { self.done() }
        }
    )* };
}
dict_like!(SerializeStruct, SerializeStructVariant);

struct KeySer<'a>(&'a mut Flat);

impl KeySer<'_> {
	fn stash(self, s: &str) -> Result<i64> {
		self.0.stash = Some(s.to_owned());
		Ok(STASHED)
	}
}

macro_rules! fwd {
    ($($m:ident($($a:ident: $t:ty),*) -> $r:ty;)*) => {
        $( fn $m(self, $($a: $t),*) -> Result<$r> { self.0.$m($($a),*) } )*
    };
}

impl<'a> ser::Serializer for KeySer<'a> {
	type Error = Error;
	type Ok = i64;
	type SerializeMap = Dict<'a>;
	type SerializeSeq = Arr<'a>;
	type SerializeStruct = Dict<'a>;
	type SerializeStructVariant = Dict<'a>;
	type SerializeTuple = Arr<'a>;
	type SerializeTupleStruct = Arr<'a>;
	type SerializeTupleVariant = Arr<'a>;

	fwd! {
		 serialize_bool(v: bool) -> i64;
		 serialize_i8(v: i8) -> i64; serialize_i16(v: i16) -> i64;
		 serialize_i32(v: i32) -> i64; serialize_i64(v: i64) -> i64; serialize_i128(v: i128) -> i64;
		 serialize_u8(v: u8) -> i64; serialize_u16(v: u16) -> i64;
		 serialize_u32(v: u32) -> i64; serialize_u64(v: u64) -> i64; serialize_u128(v: u128) -> i64;
		 serialize_f32(v: f32) -> i64; serialize_f64(v: f64) -> i64;
		 serialize_bytes(v: &[u8]) -> i64;
		 serialize_none() -> i64;
		 serialize_unit() -> i64;
		 serialize_unit_struct(n: &'static str) -> i64;
		 serialize_seq(n: Option<usize>) -> Arr<'a>;
		 serialize_tuple(n: usize) -> Arr<'a>;
		 serialize_tuple_struct(a: &'static str, n: usize) -> Arr<'a>;
		 serialize_tuple_variant(a: &'static str, b: u32, c: &'static str, n: usize) -> Arr<'a>;
		 serialize_map(n: Option<usize>) -> Dict<'a>;
		 serialize_struct(a: &'static str, n: usize) -> Dict<'a>;
		 serialize_struct_variant(a: &'static str, b: u32, c: &'static str, n: usize) -> Dict<'a>;
	}

	fn serialize_str(self, v: &str) -> Result<i64> {
		self.stash(v)
	}

	fn serialize_char(self, v: char) -> Result<i64> {
		self.stash(v.encode_utf8(&mut [0; 4]))
	}

	fn serialize_unit_variant(self, _: &'static str, _: u32, var: &'static str) -> Result<i64> {
		self.stash(var)
	}

	fn serialize_some<T: ?Sized + Serialize>(self, v: &T) -> Result<i64> {
		v.serialize(self)
	}

	fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _: &'static str, v: &T) -> Result<i64> {
		v.serialize(self)
	}

	fn serialize_newtype_variant<T: ?Sized + Serialize>(
		self,
		n: &'static str,
		i: u32,
		var: &'static str,
		v: &T,
	) -> Result<i64> {
		self.0.serialize_newtype_variant(n, i, var, v)
	}
}

#[derive(Clone, Debug)]
pub struct ParseOptions {
	pub max_depth: usize,
	pub max_nodes: Option<usize>,
}

impl Default for ParseOptions {
	fn default() -> Self {
		ParseOptions { max_depth: 128, max_nodes: None }
	}
}

pub fn parse<T: DeserializeOwned>(s: &str) -> Result<T> {
	parse_with(s, &ParseOptions::default())
}

pub fn parse_with<T: DeserializeOwned>(s: &str, o: &ParseOptions) -> Result<T> {
	let v: Value = serde_json::from_str(s).map_err(|e| Error(format!("invalid JSON: {e}")))?;
	unflatten(v, o)
}

pub fn unflatten<T: DeserializeOwned>(v: Value, o: &ParseOptions) -> Result<T> {
	match v {
		Value::Array(a) if !a.is_empty() => unflatten_at(a, 0, o),
		Value::Number(n) => {
			let r = n
				.as_i64()
				.filter(|&r| r == UNDEFINED || special(r).is_some())
				.or_invalid()?;
			unflatten_at(Vec::new(), r, o)
		},
		_ => Err(invalid()),
	}
}

pub fn unflatten_at<T: DeserializeOwned>(
	vals: Vec<Value>,
	root: i64,
	o: &ParseOptions,
) -> Result<T> {
	let n = vals.len();
	let g = Graph {
		visiting: vec![Cell::new(false); n],
		depth: Cell::new(0),
		budget: Cell::new(
			o.max_nodes
				.unwrap_or_else(|| n.saturating_mul(16).max(1 << 20)),
		),
		max_depth: o.max_depth,
		vals,
	};
	T::deserialize(Node { g: &g, r: root })
}

struct Graph {
	vals:      Vec<Value>,
	visiting:  Vec<Cell<bool>>,
	depth:     Cell<usize>,
	budget:    Cell<usize>,
	max_depth: usize,
}

impl Graph {
	fn charge(&self) -> Result<()> {
		self
			.budget
			.get()
			.checked_sub(1)
			.map(|b| self.budget.set(b))
			.ok_or_else(|| Error("devalue: node budget exhausted".into()))
	}

	fn enter(&self, i: usize) -> Result<Guard<'_>> {
		if self.visiting[i].replace(true) {
			return fail("devalue: cyclic reference");
		}
		self.depth.set(self.depth.get() + 1);
		let guard = Guard { g: self, i };
		if self.depth.get() > self.max_depth {
			return fail("devalue: max depth exceeded");
		}
		Ok(guard)
	}
}

struct Guard<'g> {
	g: &'g Graph,
	i: usize,
}

impl Drop for Guard<'_> {
	fn drop(&mut self) {
		self.g.visiting[self.i].set(false);
		self.g.depth.set(self.g.depth.get() - 1);
	}
}

#[derive(Clone, Copy)]
enum Num {
	I(i64),
	U(u64),
	F(f64),
	I128(i128),
	U128(u128),
}

fn num_of(n: &serde_json::Number) -> Num {
	n.as_u64()
		.map(Num::U)
		.or_else(|| n.as_i64().map(Num::I))
		.unwrap_or_else(|| Num::F(n.as_f64().unwrap_or(f64::NAN)))
}

fn parse_int(s: &str) -> Option<Num> {
	s.parse()
		.map(Num::I)
		.or_else(|_| s.parse().map(Num::U))
		.or_else(|_| s.parse().map(Num::I128))
		.or_else(|_| s.parse().map(Num::U128))
		.ok()
}

fn whole(f: f64) -> Option<Num> {
	(f.fract() == 0.0 && (-9.2e18..1.8e19).contains(&f)).then(|| {
		if f < 0.0 {
			Num::I(f as i64)
		} else {
			Num::U(f as u64)
		}
	})
}

fn visit_num<'de, V: Visitor<'de>>(v: V, n: Num) -> Result<V::Value> {
	match n {
		Num::I(x) => v.visit_i64(x),
		Num::U(x) => v.visit_u64(x),
		Num::F(x) => v.visit_f64(x),
		Num::I128(x) => v.visit_i128(x),
		Num::U128(x) => v.visit_u128(x),
	}
}

enum View<'g> {
	Nil,
	Bool(bool),
	Num(Num),
	Str(Cow<'g, str>),
	Big(&'g str),
	Arr(&'g [Value]),
	Sparse(usize, BTreeMap<usize, i64>),
	Obj(&'g serde_json::Map<String, Value>),
	Map(&'g [Value]),
	NullProto(&'g [Value]),
	Typed(&'g str, Vec<u8>),
	Custom(&'g str, i64),
}

struct Resolved<'g> {
	view:   View<'g>,
	_guard: Option<Guard<'g>>,
}

fn plain(view: View<'_>) -> Resolved<'_> {
	Resolved { view, _guard: None }
}

#[derive(Clone, Copy)]
struct Node<'g> {
	g: &'g Graph,
	r: i64,
}

fn node<'g>(g: &'g Graph, v: &Value) -> Result<Node<'g>> {
	v.as_i64().map(|r| Node { g, r }).or_invalid()
}

impl<'g> Node<'g> {
	fn raw(&self) -> Option<&'g Value> {
		usize::try_from(self.r)
			.ok()
			.and_then(|i| self.g.vals.get(i))
	}

	fn resolve(self) -> Result<Resolved<'g>> {
		let g = self.g;
		g.charge()?;
		if let Some(f) = special(self.r) {
			return Ok(plain(View::Num(Num::F(f))));
		}
		if matches!(self.r, UNDEFINED | HOLE) {
			return Ok(plain(View::Nil));
		}
		let i = usize::try_from(self.r)
			.ok()
			.filter(|&i| i < g.vals.len())
			.or_invalid()?;
		Ok(match &g.vals[i] {
			Value::Null => plain(View::Nil),
			Value::Bool(b) => plain(View::Bool(*b)),
			Value::Number(n) => plain(View::Num(num_of(n))),
			Value::String(s) => plain(View::Str(s.as_str().into())),
			v => {
				let guard = g.enter(i)?;
				Resolved { view: read_compound(g, v)?, _guard: Some(guard) }
			},
		})
	}

	fn int<'de, V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		let r = self.resolve()?;
		match r.view {
			View::Num(Num::F(f)) => visit_num(v, whole(f).unwrap_or(Num::F(f))),
			View::Big(s) => {
				visit_num(v, parse_int(s).ok_or_else(|| Error("devalue: BigInt out of range".into()))?)
			},
			view => visit_any(self.g, view, v),
		}
	}
}

fn read_compound<'g>(g: &'g Graph, v: &'g Value) -> Result<View<'g>> {
	match v {
		Value::Object(m) => Ok(View::Obj(m)),
		Value::Array(a) => match a.first() {
			Some(Value::String(tag)) => read_tagged(g, tag, &a[1..]),
			Some(n) if n.as_i64() == Some(SPARSE) => read_sparse(a),
			_ => Ok(View::Arr(a)),
		},
		_ => Err(invalid()),
	}
}

fn read_tagged<'g>(g: &'g Graph, tag: &'g str, rest: &'g [Value]) -> Result<View<'g>> {
	let lit = |k: usize| rest.get(k).and_then(Value::as_str).or_invalid();
	let pairs = || ensure(rest.len() % 2 == 0).map(|_| rest);
	Ok(match tag {
		"Date" => match lit(0)? {
			"" => View::Nil,
			s => View::Str(s.into()),
		},
		"Set" => View::Arr(rest),
		"Map" => View::Map(pairs()?),
		"null" => View::NullProto(pairs()?),
		"RegExp" => View::Str(format!("/{}/{}", lit(0)?, lit(1).unwrap_or("")).into()),
		"BigInt" => View::Big(lit(0)?),
		"Object" => read_boxed(g, rest)?,
		"ArrayBuffer" => View::Typed(tag, b64_decode(lit(0)?)?),
		"URL" | "URLSearchParams" => View::Str(lit(0)?.into()),
		t if t.starts_with("Temporal.") => View::Str(lit(0)?.into()),
		t if width(t).is_some() => read_typed(g, t, rest)?,
		t => match rest {
			[r] => View::Custom(t, r.as_i64().or_invalid()?),
			_ => return Err(invalid()),
		},
	})
}

fn read_boxed<'g>(g: &'g Graph, rest: &'g [Value]) -> Result<View<'g>> {
	let inner = node(g, rest.first().or_invalid()?)?.resolve()?;
	match inner.view {
		v @ (View::Bool(_) | View::Num(_) | View::Str(_) | View::Big(_)) => Ok(v),
		_ => Err(invalid()),
	}
}

fn read_sparse(a: &[Value]) -> Result<View<'static>> {
	let len = a
		.get(1)
		.and_then(Value::as_u64)
		.filter(|&l| l <= MAX_ARRAY_LEN)
		.or_invalid()? as usize;
	let rest = &a[2..];
	ensure(rest.len() % 2 == 0)?;
	let set = rest
		.chunks_exact(2)
		.map(|c| -> Result<_> {
			let i = c[0]
				.as_u64()
				.map(|i| i as usize)
				.filter(|&i| i < len)
				.or_invalid()?;
			Ok((i, c[1].as_i64().or_invalid()?))
		})
		.collect::<Result<BTreeMap<_, _>>>()?;
	Ok(View::Sparse(len, set))
}

fn width(t: &str) -> Option<usize> {
	Some(match t {
		"Int8Array" | "Uint8Array" | "Uint8ClampedArray" | "DataView" | "ArrayBuffer" => 1,
		"Int16Array" | "Uint16Array" | "Float16Array" => 2,
		"Int32Array" | "Uint32Array" | "Float32Array" => 4,
		"Float64Array" | "BigInt64Array" | "BigUint64Array" => 8,
		_ => return None,
	})
}

fn read_typed<'g>(g: &'g Graph, t: &'g str, rest: &'g [Value]) -> Result<View<'g>> {
	let w = width(t).or_invalid()?;
	let usize_at = |k: usize| {
		rest
			.get(k)
			.and_then(Value::as_u64)
			.map(|n| n as usize)
			.or_invalid()
	};
	let bytes = match g.vals.get(usize_at(0)?) {
		Some(Value::Array(b)) if b.len() == 2 && b[0] == "ArrayBuffer" => {
			b64_decode(b[1].as_str().or_invalid()?)?
		},
		_ => return Err(invalid()),
	};
	let range = match rest.len() {
		1 => Some(0..bytes.len()).filter(|_| bytes.len() % w == 0),
		3 => {
			let (off, len) = (usize_at(1)?, usize_at(2)?);
			(if t == "DataView" {
				Some(len)
			} else {
				len.checked_mul(w)
			})
			.and_then(|n| off.checked_add(n))
			.filter(|&end| end <= bytes.len() && off % w == 0)
			.map(|end| off..end)
		},
		_ => None,
	}
	.or_invalid()?;
	Ok(View::Typed(t, bytes[range].to_vec()))
}

fn scalar(tag: &str, c: &[u8]) -> Num {
	macro_rules! le {
		($t:ty) => {
			<$t>::from_le_bytes(c.try_into().unwrap())
		};
	}
	match tag {
		"Int8Array" => Num::I(c[0] as i8 as i64),
		"Int16Array" => Num::I(le!(i16) as i64),
		"Uint16Array" => Num::U(le!(u16) as u64),
		"Float16Array" => Num::F(f16(le!(u16))),
		"Int32Array" => Num::I(le!(i32) as i64),
		"Uint32Array" => Num::U(le!(u32) as u64),
		"Float32Array" => Num::F(le!(f32) as f64),
		"Float64Array" => Num::F(le!(f64)),
		"BigInt64Array" => Num::I(le!(i64)),
		"BigUint64Array" => Num::U(le!(u64)),
		_ => Num::U(c[0] as u64),
	}
}

fn f16(h: u16) -> f64 {
	let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
	let (e, m) = ((h >> 10) & 0x1f, (h & 0x3ff) as f64);
	sign
		* match e {
			0 => m * 2f64.powi(-24),
			31 => {
				if m == 0.0 {
					f64::INFINITY
				} else {
					f64::NAN
				}
			},
			_ => (1.0 + m / 1024.0) * 2f64.powi(e as i32 - 15),
		}
}

fn own_key(k: &str) -> Result<&str> {
	if k == "__proto__" {
		fail("Cannot parse an object with a `__proto__` property")
	} else {
		Ok(k)
	}
}

fn visit_any<'de, 'g, V: Visitor<'de>>(g: &'g Graph, view: View<'g>, v: V) -> Result<V::Value> {
	match view {
		View::Nil => v.visit_unit(),
		View::Bool(b) => v.visit_bool(b),
		View::Num(n) => visit_num(v, n),
		View::Str(Cow::Borrowed(s)) => v.visit_str(s),
		View::Str(Cow::Owned(s)) => v.visit_string(s),
		View::Big(s) => match parse_int(s) {
			Some(n @ (Num::I(_) | Num::U(_))) => visit_num(v, n),
			_ => v.visit_str(s),
		},
		View::Arr(xs) => v.visit_seq(Elems(xs.iter().map(move |x| node(g, x)))),
		View::Sparse(len, set) => {
			let mut set = set.into_iter().peekable();
			v.visit_seq(Elems((0..len).map(move |pos| match set.next_if(|&(i, _)| i == pos) {
				Some((_, r)) => Ok(Node { g, r }),
				None => g.charge().map(|_| Node { g, r: UNDEFINED }),
			})))
		},
		View::Typed(tag, bytes) => {
			let w = width(tag).unwrap_or(1);
			v.visit_seq(Elems(
				(0..bytes.len() / w)
					.map(move |i| Ok::<_, Error>(NumDe(scalar(tag, &bytes[i * w..][..w])))),
			))
		},
		View::Obj(m) => v.visit_map(Entries::new(
			m.iter()
				.map(move |(k, x)| -> Result<_> { Ok((Key::Lit(own_key(k)?), node(g, x)?)) }),
		)),
		View::Map(xs) => v.visit_map(Entries::new(
			xs.chunks_exact(2)
				.map(move |c| -> Result<_> { Ok((Key::Ref(node(g, &c[0])?), node(g, &c[1])?)) }),
		)),
		View::NullProto(xs) => {
			v.visit_map(Entries::new(xs.chunks_exact(2).map(move |c| -> Result<_> {
				Ok((Key::Lit(own_key(c[0].as_str().or_invalid()?)?), node(g, &c[1])?))
			})))
		},
		View::Custom(tag, r) => {
			v.visit_map(Entries::new(iter::once(Ok::<_, Error>((Key::Lit(tag), Node { g, r })))))
		},
	}
}

macro_rules! node_ints {
    ($($m:ident)*) => { $( fn $m<V: Visitor<'de>>(self, v: V) -> Result<V::Value> { self.int(v) } )* };
}

impl<'de, 'g> de::Deserializer<'de> for Node<'g> {
	type Error = Error;

	node_ints! { deserialize_i8 deserialize_i16 deserialize_i32 deserialize_i64 deserialize_i128
	deserialize_u8 deserialize_u16 deserialize_u32 deserialize_u64 deserialize_u128 }

	serde::forward_to_deserialize_any! { bool f32 f64 unit unit_struct seq tuple tuple_struct map struct }

	fn deserialize_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		let r = self.resolve()?;
		visit_any(self.g, r.view, v)
	}

	fn deserialize_str<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		let r = self.resolve()?;
		match r.view {
			View::Big(s) => v.visit_str(s),
			view => visit_any(self.g, view, v),
		}
	}

	fn deserialize_string<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		de::Deserializer::deserialize_str(self, v)
	}

	fn deserialize_char<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		de::Deserializer::deserialize_str(self, v)
	}

	fn deserialize_identifier<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		de::Deserializer::deserialize_str(self, v)
	}

	fn deserialize_bytes<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		let r = self.resolve()?;
		match r.view {
			View::Typed(_, b) => v.visit_byte_buf(b),
			view => visit_any(self.g, view, v),
		}
	}

	fn deserialize_byte_buf<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		de::Deserializer::deserialize_bytes(self, v)
	}

	fn deserialize_option<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		let nil = match self.raw() {
			None => matches!(self.r, UNDEFINED | HOLE),
			Some(Value::Null) => true,
			Some(Value::Array(a)) => a.len() == 2 && a[0] == "Date" && a[1] == "",
			_ => false,
		};
		if nil {
			v.visit_none()
		} else {
			v.visit_some(self)
		}
	}

	fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, v: V) -> Result<V::Value> {
		v.visit_newtype_struct(self)
	}

	fn deserialize_enum<V: Visitor<'de>>(
		self,
		_: &'static str,
		_: &'static [&'static str],
		v: V,
	) -> Result<V::Value> {
		let r = self.resolve()?;
		let (name, val) = match r.view {
			View::Str(s) => (s, None),
			View::Obj(m) if m.len() == 1 => {
				let (k, x) = m.iter().next().or_invalid()?;
				(Cow::Borrowed(k.as_str()), Some(node(self.g, x)?))
			},
			View::Custom(tag, rr) => (Cow::Borrowed(tag), Some(Node { g: self.g, r: rr })),
			_ => return fail("devalue: expected enum (\"V\", {\"V\": ..} or [\"V\", ref])"),
		};
		v.visit_enum(Enum { name, val })
	}

	fn deserialize_ignored_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		v.visit_unit()
	}
}

struct NumDe(Num);

impl<'de> de::Deserializer<'de> for NumDe {
	type Error = Error;

	serde::forward_to_deserialize_any! {
		 bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
		 option unit unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
	}

	fn deserialize_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		visit_num(v, self.0)
	}
}

struct Elems<I>(I);

impl<'de, I, D> SeqAccess<'de> for Elems<I>
where
	I: Iterator<Item = Result<D>>,
	D: de::Deserializer<'de, Error = Error>,
{
	type Error = Error;

	fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>> {
		self.0.next().map(|d| seed.deserialize(d?)).transpose()
	}

	fn size_hint(&self) -> Option<usize> {
		Some(self.0.size_hint().0)
	}
}

enum Key<'g> {
	Lit(&'g str),
	Ref(Node<'g>),
}

struct Entries<'g, I> {
	it:  I,
	val: Option<Node<'g>>,
}

impl<'g, I> Entries<'g, I> {
	fn new(it: I) -> Self {
		Entries { it, val: None }
	}
}

impl<'de, 'g, I> MapAccess<'de> for Entries<'g, I>
where
	I: Iterator<Item = Result<(Key<'g>, Node<'g>)>>,
{
	type Error = Error;

	fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>> {
		let Some((k, v)) = self.it.next().transpose()? else {
			return Ok(None);
		};
		self.val = Some(v);
		let key = match k {
			Key::Lit(s) => seed.deserialize(KeyDe(s)),
			Key::Ref(n) => seed.deserialize(n),
		}?;
		Ok(Some(key))
	}

	fn next_value_seed<S: DeserializeSeed<'de>>(&mut self, seed: S) -> Result<S::Value> {
		seed.deserialize(self.val.take().or_invalid()?)
	}

	fn size_hint(&self) -> Option<usize> {
		Some(self.it.size_hint().0)
	}
}

struct KeyDe<'a>(&'a str);

macro_rules! key_parse {
    ($($m:ident $t:ty => $vis:ident),* $(,)?) => { $(
        fn $m<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
            match self.0.parse::<$t>() { Ok(n) => v.$vis(n), Err(_) => v.visit_str(self.0) }
        }
    )* };
}

impl<'de, 'a> de::Deserializer<'de> for KeyDe<'a> {
	type Error = Error;

	key_parse! {
		 deserialize_bool bool => visit_bool,
		 deserialize_i8 i8 => visit_i8, deserialize_i16 i16 => visit_i16,
		 deserialize_i32 i32 => visit_i32, deserialize_i64 i64 => visit_i64,
		 deserialize_i128 i128 => visit_i128,
		 deserialize_u8 u8 => visit_u8, deserialize_u16 u16 => visit_u16,
		 deserialize_u32 u32 => visit_u32, deserialize_u64 u64 => visit_u64,
		 deserialize_u128 u128 => visit_u128,
		 deserialize_f32 f32 => visit_f32, deserialize_f64 f64 => visit_f64,
	}

	serde::forward_to_deserialize_any! {
		 char str string bytes byte_buf unit unit_struct seq tuple tuple_struct map struct identifier ignored_any
	}

	fn deserialize_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		v.visit_str(self.0)
	}

	fn deserialize_option<V: Visitor<'de>>(self, v: V) -> Result<V::Value> {
		v.visit_some(self)
	}

	fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, v: V) -> Result<V::Value> {
		v.visit_newtype_struct(self)
	}

	fn deserialize_enum<V: Visitor<'de>>(
		self,
		_: &'static str,
		_: &'static [&'static str],
		v: V,
	) -> Result<V::Value> {
		v.visit_enum(<&str as IntoDeserializer<'de, Error>>::into_deserializer(self.0))
	}
}

struct Enum<'g> {
	name: Cow<'g, str>,
	val:  Option<Node<'g>>,
}

impl<'de, 'g> EnumAccess<'de> for Enum<'g> {
	type Error = Error;
	type Variant = Var<'g>;

	fn variant_seed<S: DeserializeSeed<'de>>(self, seed: S) -> Result<(S::Value, Var<'g>)> {
		let k = seed.deserialize(KeyDe(&self.name))?;
		Ok((k, Var(self.val)))
	}
}

struct Var<'g>(Option<Node<'g>>);

impl<'g> Var<'g> {
	fn payload(self) -> Result<Node<'g>> {
		self
			.0
			.ok_or_else(|| Error("devalue: variant has no payload".into()))
	}
}

impl<'de, 'g> VariantAccess<'de> for Var<'g> {
	type Error = Error;

	fn unit_variant(self) -> Result<()> {
		self.0.map_or(Ok(()), <() as Deserialize<'de>>::deserialize)
	}

	fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value> {
		seed.deserialize(self.payload()?)
	}

	fn tuple_variant<V: Visitor<'de>>(self, _: usize, v: V) -> Result<V::Value> {
		de::Deserializer::deserialize_seq(self.payload()?, v)
	}

	fn struct_variant<V: Visitor<'de>>(self, _: &'static [&'static str], v: V) -> Result<V::Value> {
		de::Deserializer::deserialize_map(self.payload()?, v)
	}
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(b: &[u8]) -> String {
	b.chunks(3)
		.flat_map(|c| {
			let n = c
				.iter()
				.enumerate()
				.fold(0u32, |n, (i, &x)| n | (x as u32) << (16 - 8 * i));
			(0..4).map(move |k| {
				if k <= c.len() {
					B64[(n >> (18 - 6 * k)) as usize & 63] as char
				} else {
					'='
				}
			})
		})
		.collect()
}

fn sextet(c: u8) -> Option<u8> {
	Some(match c {
		b'A'..=b'Z' => c - b'A',
		b'a'..=b'z' => c - b'a' + 26,
		b'0'..=b'9' => c - b'0' + 52,
		b'+' => 62,
		b'/' => 63,
		_ => return None,
	})
}

fn b64_decode(s: &str) -> Result<Vec<u8>> {
	let bad = || Error("Invalid ArrayBuffer encoding".into());
	let raw: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
	let body = raw
		.strip_suffix(b"==")
		.or_else(|| raw.strip_suffix(b"="))
		.unwrap_or(&raw[..]);
	let digits = body
		.iter()
		.map(|&c| sextet(c))
		.collect::<Option<Vec<_>>>()
		.ok_or_else(bad)?;
	if digits.len() % 4 == 1 {
		return Err(bad());
	}
	Ok(digits
		.chunks(4)
		.flat_map(|c| {
			let n = c
				.iter()
				.enumerate()
				.fold(0u32, |n, (i, &x)| n | (x as u32) << (18 - 6 * i));
			(0..c.len() - 1).map(move |k| (n >> (16 - 8 * k)) as u8)
		})
		.collect())
}
