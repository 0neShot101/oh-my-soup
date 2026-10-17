use std::fmt;

use serde::de::{
	self, DeserializeOwned, DeserializeSeed, Deserializer, IntoDeserializer, Visitor,
	value::{MapDeserializer, SeqDeserializer, StringDeserializer},
};

use super::jsa::Val;

#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.0)
	}
}
impl std::error::Error for Error {}
impl de::Error for Error {
	fn custom<T: fmt::Display>(msg: T) -> Self {
		Error(msg.to_string())
	}
}

pub fn from_val<T: DeserializeOwned>(v: Val) -> Result<T, Error> {
	T::deserialize(v)
}

fn visit_num<'de, V: Visitor<'de>>(n: f64, v: V) -> Result<V::Value, Error> {
	if n.fract() == 0.0 {
		if (0.0..u64::MAX as f64).contains(&n) {
			return v.visit_u64(n as u64);
		}
		if (i64::MIN as f64..0.0).contains(&n) {
			return v.visit_i64(n as i64);
		}
	}
	v.visit_f64(n)
}

impl<'de> IntoDeserializer<'de, Error> for Val {
	type Deserializer = Val;

	fn into_deserializer(self) -> Val {
		self
	}
}

impl<'de> Deserializer<'de> for Val {
	type Error = Error;

	serde::forward_to_deserialize_any! {
		 bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
		 bytes byte_buf unit unit_struct seq tuple tuple_struct map struct
		 identifier ignored_any
	}

	fn deserialize_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value, Error> {
		match self {
			Val::Num(n) => visit_num(n, v),
			Val::Str(s) => v.visit_str(&s),
			Val::Bool(b) => v.visit_bool(b),
			Val::Null | Val::Undef => v.visit_unit(),
			Val::Arr(a) => {
				let items = a.borrow().clone();
				SeqDeserializer::new(items.into_iter()).deserialize_any(v)
			},
			Val::Obj(o) => {
				let props = o.borrow().clone();
				MapDeserializer::new(props.into_iter()).deserialize_any(v)
			},
			Val::Probe(path, _) => {
				Err(de::Error::custom(format!("`{path}` is an unassigned host path, not data")))
			},
			Val::Func(..) | Val::Native(_) => Err(de::Error::custom("functions aren't data")),
			Val::Doc | Val::Elem(_) => Err(de::Error::custom("DOM objects aren't data")),
		}
	}

	fn deserialize_option<V: Visitor<'de>>(self, v: V) -> Result<V::Value, Error> {
		match self {
			Val::Null | Val::Undef => v.visit_none(),
			other => v.visit_some(other),
		}
	}

	fn deserialize_newtype_struct<V: Visitor<'de>>(
		self,
		_name: &'static str,
		v: V,
	) -> Result<V::Value, Error> {
		v.visit_newtype_struct(self)
	}

	fn deserialize_enum<V: Visitor<'de>>(
		self,
		_name: &'static str,
		_variants: &'static [&'static str],
		v: V,
	) -> Result<V::Value, Error> {
		match self {
			Val::Str(s) => {
				let d: StringDeserializer<Error> = s.to_string().into_deserializer();
				v.visit_enum(d)
			},
			Val::Obj(o) if o.borrow().len() == 1 => {
				let (tag, payload) = o.borrow()[0].clone();
				v.visit_enum(Tagged(tag, payload))
			},
			other => other.deserialize_any(v),
		}
	}
}

struct Tagged(String, Val);

impl<'de> de::EnumAccess<'de> for Tagged {
	type Error = Error;
	type Variant = Val;

	fn variant_seed<S: DeserializeSeed<'de>>(self, seed: S) -> Result<(S::Value, Val), Error> {
		let tag: StringDeserializer<Error> = self.0.into_deserializer();
		Ok((seed.deserialize(tag)?, self.1))
	}
}

impl<'de> de::VariantAccess<'de> for Val {
	type Error = Error;

	fn unit_variant(self) -> Result<(), Error> {
		Ok(())
	}

	fn newtype_variant_seed<S: DeserializeSeed<'de>>(self, seed: S) -> Result<S::Value, Error> {
		seed.deserialize(self)
	}

	fn tuple_variant<V: Visitor<'de>>(self, _len: usize, v: V) -> Result<V::Value, Error> {
		self.deserialize_seq(v)
	}

	fn struct_variant<V: Visitor<'de>>(
		self,
		_fields: &'static [&'static str],
		v: V,
	) -> Result<V::Value, Error> {
		self.deserialize_map(v)
	}
}
