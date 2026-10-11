//! Per-connection actor: one task owns the stream, drains the write queue and,
//! once started, reads and frames incoming bytes for JavaScript.
//!
//! Frames and the close notification share one threadsafe function, so they
//! reach JavaScript in order and the close always comes last.

use std::{
	collections::VecDeque,
	io::{self, IoSlice},
	mem,
	pin::pin,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use napi::{
	Env, Result, Status,
	bindgen_prelude::{Function, FunctionRef, Uint8Array},
	threadsafe_function::{
		ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
	},
};
use parking_lot::Mutex;
use tokio::sync::{
	Notify,
	mpsc::{UnboundedReceiver, UnboundedSender},
};

use super::{
	IpcError,
	lines::{FrameTooLarge, LineDecoder},
	platform::{Stream, WriteFinish},
};

/// Bytes read per `try_read`.
const READ_CHUNK: usize = 64 * 1024;
/// Queued-but-unwritten bytes above which `send` reports backpressure.
pub const HIGH_WATER_BYTES: usize = 1024 * 1024;
/// Frames gathered into one vectored write.
const MAX_IOV: usize = 64;

/// How received bytes are delivered to JavaScript.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Framing {
	/// UTF-8 lines delimited by `\n`.
	Lines,
	/// Byte chunks as received.
	Raw,
}

/// Instruction from JavaScript to the connection actor.
pub enum Command {
	/// Begin reading and delivering frames.
	Start,
	/// Append encoded bytes to the write queue.
	Write(Vec<u8>),
	/// Flush the queue, then close the write side.
	End,
	/// Close immediately, dropping queued writes.
	Destroy,
}

/// Item delivered to JavaScript through the connection's event sink.
pub enum Event {
	Lines(Vec<String>),
	Chunk(Vec<u8>),
	Close(Option<String>),
}

/// Ordered event channel into JavaScript; holds the loop unless unref'd.
type EventSink = ThreadsafeFunction<Event, (), (), Status, false>;

/// JavaScript frame callback for the connection's framing.
pub enum FrameCallback {
	Lines(FunctionRef<String, UnknownReturnValue>),
	Raw(FunctionRef<Uint8Array, UnknownReturnValue>),
}

enum Delivery {
	/// `start()` not called yet.
	Pending,
	/// Closed before `start()`; holds the close reason to deliver on start.
	ClosedUnstarted(Option<String>),
	/// Frames flow to JavaScript.
	Started(EventSink),
	/// `onClose` queued; nothing more is delivered.
	Done,
}

struct JsSide {
	delivery: Delivery,
	refed:    bool,
}

/// State shared between the JavaScript handle and the connection actor.
pub struct Shared {
	pub framing: Framing,
	commands:    UnboundedSender<Command>,
	queued:      AtomicUsize,
	/// Set by `destroy()` or when the actor finished.
	closed:      AtomicBool,
	/// Set by `end()`: further sends are dropped.
	ending:      AtomicBool,
	drained:     Notify,
	js:          Mutex<JsSide>,
}

impl Shared {
	pub fn new(framing: Framing, commands: UnboundedSender<Command>) -> Self {
		Self {
			framing,
			commands,
			queued: AtomicUsize::new(0),
			closed: AtomicBool::new(false),
			ending: AtomicBool::new(false),
			drained: Notify::new(),
			js: Mutex::new(JsSide { delivery: Delivery::Pending, refed: true }),
		}
	}

	pub fn is_closed(&self) -> bool {
		self.closed.load(Ordering::Acquire)
	}

	pub fn is_started(&self) -> bool {
		!matches!(self.js.lock().delivery, Delivery::Pending | Delivery::ClosedUnstarted(_))
	}

	/// Queue `frame`; returns whether the queue is still under the high-water
	/// mark. Frames after `end()`/close are dropped.
	pub fn send(&self, frame: Vec<u8>) -> bool {
		if self.closed.load(Ordering::Acquire) || self.ending.load(Ordering::Acquire) {
			return false;
		}
		let len = frame.len();
		let total = self.queued.fetch_add(len, Ordering::AcqRel) + len;
		if self.commands.send(Command::Write(frame)).is_err() {
			self.consume(len);
			return false;
		}
		total <= HIGH_WATER_BYTES
	}

	pub fn end(&self) {
		if !self.ending.swap(true, Ordering::AcqRel) {
			let _ = self.commands.send(Command::End);
		}
	}

	pub fn destroy(&self) {
		if !self.closed.swap(true, Ordering::AcqRel) {
			self.drained.notify_waiters();
			let _ = self.commands.send(Command::Destroy);
		}
	}

	/// Resolve once nothing is queued or the connection closed.
	pub async fn wait_drained(&self) {
		loop {
			let mut notified = pin!(self.drained.notified());
			notified.as_mut().enable();
			if self.queued.load(Ordering::Acquire) == 0 || self.closed.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}

	/// Begin delivery to `on_frame`/`on_close`. The caller checked
	/// [`Self::is_started`] on the JS thread, the only thread that starts.
	pub fn start(
		&self,
		env: &Env,
		on_frame: FrameCallback,
		on_close: &Function<'_, Option<String>, UnknownReturnValue>,
	) -> Result<()> {
		let mut sink = build_sink(env, on_frame, on_close.create_ref()?)?;
		let mut js = self.js.lock();
		if !js.refed {
			#[allow(deprecated, reason = "explicit loop ref toggling is the documented intent")]
			sink.unref(env)?;
		}
		if let Delivery::ClosedUnstarted(reason) = mem::replace(&mut js.delivery, Delivery::Done) {
			sink.call(Event::Close(reason), ThreadsafeFunctionCallMode::NonBlocking);
			return Ok(());
		}
		js.delivery = Delivery::Started(sink);
		let _ = self.commands.send(Command::Start);
		Ok(())
	}

	/// Toggle whether this connection keeps the event loop alive.
	#[allow(deprecated, reason = "explicit loop ref toggling is the documented intent")]
	pub fn set_ref(&self, env: &Env, refed: bool) -> Result<()> {
		let mut js = self.js.lock();
		js.refed = refed;
		if let Delivery::Started(sink) = &mut js.delivery {
			if refed {
				sink.refer(env)?;
			} else {
				sink.unref(env)?;
			}
		}
		Ok(())
	}

	fn emit(&self, event: Event) {
		if let Delivery::Started(sink) = &self.js.lock().delivery {
			sink.call(event, ThreadsafeFunctionCallMode::NonBlocking);
		}
	}

	fn consume(&self, written: usize) {
		if self.queued.fetch_sub(written, Ordering::AcqRel) == written {
			self.drained.notify_waiters();
		}
	}

	fn finish(&self, reason: Option<String>) {
		self.closed.store(true, Ordering::Release);
		self.queued.store(0, Ordering::Release);
		self.drained.notify_waiters();
		let mut js = self.js.lock();
		match mem::replace(&mut js.delivery, Delivery::Done) {
			// Dropping the sink releases it after the queued close is delivered.
			Delivery::Started(sink) => {
				sink.call(Event::Close(reason), ThreadsafeFunctionCallMode::NonBlocking);
			},
			Delivery::Pending => js.delivery = Delivery::ClosedUnstarted(reason),
			Delivery::ClosedUnstarted(earlier) => js.delivery = Delivery::ClosedUnstarted(earlier),
			Delivery::Done => {},
		}
	}
}

/// Build the ordered event sink. The threadsafe function wraps a native no-op
/// so its call-JS callback can dispatch each event to the right JS callback.
fn build_sink(
	env: &Env,
	on_frame: FrameCallback,
	on_close: FunctionRef<Option<String>, UnknownReturnValue>,
) -> Result<EventSink> {
	let dispatcher = env.create_function_from_closure::<(), (), _>("ipcDispatch", |_| Ok(()))?;
	dispatcher
		.build_threadsafe_function::<Event>()
		.build_callback(move |ctx: ThreadsafeCallContext<Event>| {
			dispatch(&ctx.env, &on_frame, &on_close, ctx.value)
		})
}

fn dispatch(
	env: &Env,
	on_frame: &FrameCallback,
	on_close: &FunctionRef<Option<String>, UnknownReturnValue>,
	event: Event,
) -> Result<()> {
	match (event, on_frame) {
		(Event::Lines(lines), FrameCallback::Lines(callback)) => {
			let callback = callback.borrow_back(env)?;
			// A throwing callback must not swallow the rest of the batch; the
			// first exception is rethrown once every line was delivered.
			let mut first_error = None;
			for line in lines {
				if let Err(error) = callback.call(line) {
					first_error.get_or_insert(error);
				}
			}
			first_error.map_or(Ok(()), Err)
		},
		(Event::Chunk(chunk), FrameCallback::Raw(callback)) => callback
			.borrow_back(env)?
			.call(Uint8Array::from(chunk))
			.map(drop),
		(Event::Close(reason), _) => on_close.borrow_back(env)?.call(reason).map(drop),
		_ => Ok(()),
	}
}

/// Drive `stream` until it closes, then publish the close outcome.
pub async fn run(
	stream: Stream,
	shared: Arc<Shared>,
	mut commands: UnboundedReceiver<Command>,
	max_frame_bytes: usize,
) {
	let reason = drive(&stream, &shared, &mut commands, max_frame_bytes).await;
	// Refuse new commands before publishing the close so a racing `send`
	// observes the dead channel and rolls its byte count back.
	drop(commands);
	drop(stream);
	shared.finish(reason);
}

struct WriteQueue {
	frames: VecDeque<Vec<u8>>,
	/// Bytes of the front frame already written.
	offset: usize,
}

impl WriteQueue {
	/// Write until the queue empties or the stream would block.
	fn flush(&mut self, stream: &Stream, shared: &Shared) -> io::Result<()> {
		while !self.frames.is_empty() {
			let mut slices = [IoSlice::new(&[]); MAX_IOV];
			let mut count = 0;
			for (slot, frame) in slices.iter_mut().zip(&self.frames) {
				let bytes = if count == 0 {
					&frame[self.offset..]
				} else {
					frame
				};
				*slot = IoSlice::new(bytes);
				count += 1;
			}
			let mut written = match stream.try_write_vectored(&slices[..count]) {
				Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
				Ok(written) => written,
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
				Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
				Err(error) => return Err(error),
			};
			shared.consume(written);
			while written > 0 {
				let remaining = self.frames[0].len() - self.offset;
				if written < remaining {
					self.offset += written;
					break;
				}
				written -= remaining;
				self.offset = 0;
				self.frames.pop_front();
			}
		}
		Ok(())
	}

	/// Drop everything queued (write side is gone).
	fn discard(&mut self, shared: &Shared) {
		let mut bytes = 0;
		for (index, frame) in self.frames.drain(..).enumerate() {
			bytes += if index == 0 {
				frame.len() - self.offset
			} else {
				frame.len()
			};
		}
		self.offset = 0;
		if bytes > 0 {
			shared.consume(bytes);
		}
	}
}

/// Event loop of one connection; returns the close reason (`None` = orderly).
async fn drive(
	stream: &Stream,
	shared: &Shared,
	commands: &mut UnboundedReceiver<Command>,
	max_frame_bytes: usize,
) -> Option<String> {
	let mut decoder = (shared.framing == Framing::Lines).then(|| LineDecoder::new(max_frame_bytes));
	let mut read_buf: Vec<u8> = Vec::new();
	let mut queue = WriteQueue { frames: VecDeque::new(), offset: 0 };
	let mut reading = false;
	let mut end_requested = false;
	let mut write_closed = false;
	loop {
		if end_requested && !write_closed && queue.frames.is_empty() {
			write_closed = true;
			match stream.finish_write() {
				Ok(WriteFinish::HalfClosed) | Err(_) => {},
				Ok(WriteFinish::Closed) => return None,
			}
		}
		tokio::select! {
			biased;
			command = commands.recv() => match command {
				None | Some(Command::Destroy) => return None,
				Some(Command::Start) => {
					reading = true;
					read_buf.resize(READ_CHUNK, 0);
				},
				Some(Command::Write(frame)) => {
					if write_closed {
						shared.consume(frame.len());
					} else {
						queue.frames.push_back(frame);
					}
				},
				Some(Command::End) => end_requested = true,
			},
			ready = stream.writable(), if !write_closed && !queue.frames.is_empty() => {
				// A failed write side (peer gone) is not a close by itself: keep
				// reading so frames the peer sent before leaving still arrive.
				if ready.and_then(|()| queue.flush(stream, shared)).is_err() {
					write_closed = true;
					queue.discard(shared);
				}
			},
			ready = stream.readable(), if reading => {
				let read = ready.and_then(|()| stream.try_read(&mut read_buf));
				match read {
					Ok(0) => return finish_lines(decoder.as_mut(), shared, max_frame_bytes),
					Ok(len) => {
						if let Some(reason) = deliver(&read_buf[..len], decoder.as_mut(), shared, max_frame_bytes) {
							return Some(reason);
						}
					},
					Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {},
					Err(error) if super::platform::is_orderly_eof(&error) => {
						return finish_lines(decoder.as_mut(), shared, max_frame_bytes);
					},
					Err(error) => return Some(IpcError::io(&error, "read failed").reason()),
				}
			},
		}
	}
}

fn oversize_reason(max_frame_bytes: usize) -> String {
	format!("EMSGSIZE: line exceeds maxFrameBytes ({max_frame_bytes} bytes)")
}

fn deliver(
	bytes: &[u8],
	decoder: Option<&mut LineDecoder>,
	shared: &Shared,
	max_frame_bytes: usize,
) -> Option<String> {
	let Some(decoder) = decoder else {
		shared.emit(Event::Chunk(bytes.to_vec()));
		return None;
	};
	let mut lines = Vec::new();
	let outcome = decoder.push(bytes, &mut lines);
	if !lines.is_empty() {
		shared.emit(Event::Lines(lines));
	}
	outcome
		.err()
		.map(|FrameTooLarge| oversize_reason(max_frame_bytes))
}

fn finish_lines(
	decoder: Option<&mut LineDecoder>,
	shared: &Shared,
	max_frame_bytes: usize,
) -> Option<String> {
	let decoder = decoder?;
	let mut lines = Vec::new();
	let outcome = decoder.finish(&mut lines);
	if !lines.is_empty() {
		shared.emit(Event::Lines(lines));
	}
	outcome
		.err()
		.map(|FrameTooLarge| oversize_reason(max_frame_bytes))
}
