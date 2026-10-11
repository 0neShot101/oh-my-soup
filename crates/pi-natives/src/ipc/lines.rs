//! Incremental `\n`-delimited line decoder for `lines` framing.

use std::mem;

/// A received line exceeded the connection's `maxFrameBytes`.
#[derive(Debug, PartialEq, Eq)]
pub struct FrameTooLarge;

/// Splits a byte stream into UTF-8 lines.
///
/// Each line drops its `\n` and one trailing `\r`; empty lines are skipped and
/// invalid UTF-8 is replaced lossily. A line longer than `max` bytes (after
/// stripping the terminator) is a protocol error.
pub struct LineDecoder {
	partial: Vec<u8>,
	max:     usize,
}

impl LineDecoder {
	/// Decoder enforcing `max` bytes per line.
	pub const fn new(max: usize) -> Self {
		Self { partial: Vec::new(), max }
	}

	/// Feed `chunk`, appending every completed line to `out`.
	///
	/// Lines completed before an oversize one are still appended, so callers
	/// can deliver them before closing.
	pub fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) -> Result<(), FrameTooLarge> {
		let mut rest = chunk;
		while let Some(newline) = rest.iter().position(|&byte| byte == b'\n') {
			let (line, tail) = (&rest[..newline], &rest[newline + 1..]);
			rest = tail;
			if self.partial.is_empty() {
				self.emit_borrowed(line, out)?;
			} else {
				if self.partial.len() + line.len() > self.max + 1 {
					return Err(FrameTooLarge);
				}
				self.partial.extend_from_slice(line);
				let owned = mem::take(&mut self.partial);
				self.emit_owned(owned, out)?;
			}
		}
		// The pending fragment may still gain a `\r` that gets stripped, hence
		// the one byte of slack.
		if self.partial.len() + rest.len() > self.max + 1 {
			return Err(FrameTooLarge);
		}
		self.partial.extend_from_slice(rest);
		Ok(())
	}

	/// Flush an unterminated final line at orderly end of stream.
	pub fn finish(&mut self, out: &mut Vec<String>) -> Result<(), FrameTooLarge> {
		if self.partial.is_empty() {
			return Ok(());
		}
		let owned = mem::take(&mut self.partial);
		self.emit_owned(owned, out)
	}

	fn emit_borrowed(&self, line: &[u8], out: &mut Vec<String>) -> Result<(), FrameTooLarge> {
		let line = line.strip_suffix(b"\r").unwrap_or(line);
		if line.len() > self.max {
			return Err(FrameTooLarge);
		}
		if !line.is_empty() {
			out.push(String::from_utf8_lossy(line).into_owned());
		}
		Ok(())
	}

	fn emit_owned(&self, mut line: Vec<u8>, out: &mut Vec<String>) -> Result<(), FrameTooLarge> {
		if line.last() == Some(&b'\r') {
			line.pop();
		}
		if line.len() > self.max {
			return Err(FrameTooLarge);
		}
		if !line.is_empty() {
			out.push(match String::from_utf8(line) {
				Ok(text) => text,
				Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
			});
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::{FrameTooLarge, LineDecoder};

	fn feed(decoder: &mut LineDecoder, chunks: &[&[u8]]) -> Result<Vec<String>, FrameTooLarge> {
		let mut out = Vec::new();
		for chunk in chunks {
			decoder.push(chunk, &mut out)?;
		}
		Ok(out)
	}

	#[test]
	fn joins_lines_split_across_chunks() {
		let mut decoder = LineDecoder::new(1024);
		let lines = feed(&mut decoder, &[b"he", b"llo\nwor", b"ld", b"\n", b"tail"]).unwrap();
		assert_eq!(lines, ["hello", "world"]);
		let mut out = Vec::new();
		decoder.finish(&mut out).unwrap();
		assert_eq!(out, ["tail"]);
	}

	#[test]
	fn strips_one_trailing_cr_including_across_chunks() {
		let mut decoder = LineDecoder::new(1024);
		let lines = feed(&mut decoder, &[b"a\r\nb\r", b"\nc\r\r\n"]).unwrap();
		assert_eq!(lines, ["a", "b", "c\r"]);
	}

	#[test]
	fn skips_empty_lines() {
		let mut decoder = LineDecoder::new(1024);
		let lines = feed(&mut decoder, &[b"\n\r\n\nx\n\n"]).unwrap();
		assert_eq!(lines, ["x"]);
		let mut out = Vec::new();
		decoder.finish(&mut out).unwrap();
		assert!(out.is_empty());
	}

	#[test]
	fn rejects_complete_line_over_max() {
		let mut decoder = LineDecoder::new(4);
		assert_eq!(feed(&mut decoder, &[b"abcd\nabcde\n"]), Err(FrameTooLarge));
		let mut decoder = LineDecoder::new(4);
		assert_eq!(feed(&mut decoder, &[b"abcd\r\n"]).unwrap(), ["abcd"]);
	}

	#[test]
	fn keeps_lines_before_overflow() {
		let mut decoder = LineDecoder::new(4);
		let mut out = Vec::new();
		assert_eq!(decoder.push(b"ok\ntoolong\n", &mut out), Err(FrameTooLarge));
		assert_eq!(out, ["ok"]);
	}

	#[test]
	fn rejects_unterminated_fragment_over_max() {
		let mut decoder = LineDecoder::new(4);
		assert_eq!(feed(&mut decoder, &[b"abc", b"de", b"f"]), Err(FrameTooLarge));
		let mut decoder = LineDecoder::new(4);
		assert_eq!(feed(&mut decoder, &[b"ab", b"cd", b"e\n"]), Err(FrameTooLarge));
	}

	#[test]
	fn replaces_invalid_utf8_lossily() {
		let mut decoder = LineDecoder::new(1024);
		let lines = feed(&mut decoder, &[b"a\xffb\n", b"\xe2\x82", b"\xac\xc3\n"]).unwrap();
		assert_eq!(lines, ["a\u{fffd}b", "\u{20ac}\u{fffd}"]);
	}
}
