mod common;

use std::path::Path;

use pi_edit::{
	EditMode, ModeEngine, modes::hashline::HashlineEngine, path_policy::canonical_key,
	store::file_hash, stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn patcher_apply_cases() {
	common::run_fixture("hashline/patcher.json", EditMode::Hashline).await;
}

#[tokio::test]
async fn file_url_target_uses_live_hash_without_stored_snapshot() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let target = workspace.write("nested/a b.txt", "before\n");
	let absolute = canonical_key(&target);
	let encoded = absolute
		.to_str()
		.unwrap()
		.replace('\\', "/")
		.replace(' ', "%20");
	let url = if encoded.starts_with('/') {
		format!("file://{encoded}")
	} else {
		format!("file:///{encoded}")
	};
	let tag = file_hash("before\n");
	let writer = common::DiskWriter::default();
	let outcome = workspace
		.apply_json(&json!({ "input": format!("[{url}#{tag}]\nPUT 1.=1:\n+after\n") }), &writer)
		.await
		.expect("a native file URL resolves without snapshot-assisted path recovery");
	assert_eq!(workspace.read("nested/a b.txt").as_deref(), Some("after\n"));
	assert_eq!(outcome.files.len(), 1);
	assert_eq!(canonical_key(&outcome.files[0].absolute), absolute);
	let requests = writer.requests.lock();
	assert_eq!(requests.len(), 1);
	assert_eq!(canonical_key(&requests[0].absolute), absolute);
}

fn link_directory(target: &Path, link: &Path) {
	#[cfg(unix)]
	std::os::unix::fs::symlink(target, link).expect("directory symlink");
	#[cfg(windows)]
	{
		// Junctions do not require Windows Developer Mode or symlink privileges.
		let output = std::process::Command::new("cmd")
			.args(["/d", "/c", "mklink", "/J"])
			.arg(link)
			.arg(target)
			.output()
			.expect("create directory junction");
		assert!(
			output.status.success(),
			"junction creation failed: {}",
			String::from_utf8_lossy(&output.stderr)
		);
	}
}

#[tokio::test]
async fn tag_path_recovery_accepts_physical_cwd_aliases() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	let actual_root = canonical_key(workspace.cwd());
	let links = tempfile::tempdir().unwrap();
	let alias = links.path().join("cwd alias");
	link_directory(&actual_root, &alias);
	let aliases = std::iter::once(alias);
	#[cfg(windows)]
	let aliases = aliases.chain(std::iter::once(std::path::PathBuf::from(
		actual_root.to_str().unwrap().to_ascii_uppercase(),
	)));
	for cwd in aliases {
		workspace.config.policy.cwd = cwd;
		let target = workspace.write("nested/a b.txt", "before\n");
		let canonical = canonical_key(&target);
		let tag = workspace.snapshot("nested/a b.txt", "before\n", None);
		let args = json!({ "input": format!("[a b.txt#{tag}]\nPUT 1.=1:\n+after\n") });
		for finished in [false, true] {
			let mut session = workspace.session();
			session.set_args_json(&args.to_string());
			if finished {
				session.finish();
			}
			let batch = session.preview();
			assert_eq!(batch.streaming, !finished);
			assert_eq!(batch.files.len(), 1);
			assert!(batch.files[0].error.is_none(), "{:?}", batch.files[0].error);
			assert!(batch.files[0].diff.is_some());
			assert_eq!(canonical_key(Path::new(&batch.files[0].display)), canonical);
		}
		let writer = common::DiskWriter::default();
		let outcome = workspace
			.apply_json(&args, &writer)
			.await
			.expect("recovery follows the physical cwd rather than its spelling");
		assert_eq!(workspace.read("nested/a b.txt").as_deref(), Some("after\n"));
		assert!(workspace.read("a b.txt").is_none());
		assert_eq!(outcome.files.len(), 1);
		assert_eq!(canonical_key(&outcome.files[0].absolute), canonical);
		assert_eq!(writer.requests.lock().len(), 1);
	}
}

#[tokio::test]
async fn tag_path_recovery_rejects_links_outside_physical_scope() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let outside = tempfile::tempdir().unwrap();
	let target = outside.path().join("a.txt");
	std::fs::write(&target, "before\n").unwrap();
	let link = canonical_key(workspace.cwd()).join("linked");
	link_directory(&canonical_key(outside.path()), &link);
	assert!(
		!workspace
			.config
			.policy
			.allow_tag_path_recovery("a.txt", &link.join("a.txt"))
	);
	let tag = workspace
		.store
		.record(&canonical_key(&target), "before\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+after\n") });
	for finished in [false, true] {
		let mut session = workspace.session();
		session.set_args_json(&args.to_string());
		if finished {
			session.finish();
		}
		let batch = session.preview();
		if finished {
			assert_eq!(batch.files.len(), 1);
			assert!(batch.files[0].error.is_some());
			assert!(batch.files[0].diff.is_none());
			assert_eq!(batch.files[0].display, "a.txt");
		} else {
			assert!(batch.files.is_empty());
		}
	}
	let writer = common::DiskWriter::default();
	assert!(workspace.apply_json(&args, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert_eq!(std::fs::read_to_string(&target).unwrap(), "before\n");
	assert!(workspace.read("a.txt").is_none());
}

#[test]
fn tag_path_recovery_rejects_ambiguous_snapshots_in_previews() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("first/a.txt", "before\n");
	workspace.write("second/a.txt", "before\n");
	let tag = workspace.snapshot("first/a.txt", "before\n", None);
	assert_eq!(workspace.snapshot("second/a.txt", "before\n", None), tag);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+after\n") });
	for finished in [false, true] {
		let mut session = workspace.session();
		session.set_args_json(&args.to_string());
		if finished {
			session.finish();
		}
		let batch = session.preview();
		if finished {
			assert_eq!(batch.files.len(), 1);
			assert!(batch.files[0].error.is_some());
			assert!(batch.files[0].diff.is_none());
			assert_eq!(batch.files[0].display, "a.txt");
		} else {
			assert!(batch.files.is_empty());
		}
	}
}

#[test]
fn matcher_paths_accept_partial_sections_and_header_noise() {
	let engine = HashlineEngine { enforce_seen_lines: false };
	let inspected = engine.inspect(&ArgSnapshot {
		input: Some(
			"[one.ts#ABCD]\nPUT 1.=1:\n+one\n[*** Update File: dir with spaces/two.ts#1234]\nPUT \
			 2.=2:\n+two"
				.into(),
		),
		..ArgSnapshot::default()
	});
	assert_eq!(inspected.paths, ["one.ts", "dir with spaces/two.ts"]);
	assert_eq!(inspected.entries, [
		("one.ts".into(), "one".into()),
		("dir with spaces/two.ts".into(), "two".into())
	]);
}

#[tokio::test]
async fn identical_noop_escalates_on_third_attempt() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let outcome = workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.expect("soft no-op");
		assert!(outcome.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("third no-op must fail");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);
}

#[test]
fn streaming_preview_keeps_completed_section_when_trailing_header_arrives() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	workspace.write("b.txt", "b\n");
	let tag_a = workspace.snapshot("a.txt", "a\n", None);
	let tag_b = workspace.snapshot("b.txt", "b\n", None);
	let input = format!("[a.txt#{tag_a}]\nPUT 1.=1:\n+A\n[b.txt#{tag_b}]");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	let batch = session.preview();
	assert!(batch.streaming);
	assert_eq!(batch.files.len(), 1);
	assert_eq!(batch.files[0].display, "a.txt");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|A"))
	);
}

#[tokio::test]
async fn rejection_names_the_path_a_foreign_tag_was_issued_for() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let worktree = workspace.write("wt/crates/a/mcp.rs", "worktree\n");
	workspace.write("crates/a/mcp.rs", "parent\n");
	let tag = workspace.snapshot("wt/crates/a/mcp.rs", "worktree\n", None);
	let writer = common::DiskWriter::default();
	let input = format!("[crates/a/mcp.rs#{tag}]\nPUT 1.=1:\n+changed\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("foreign tag must be rejected")
		.to_string();
	let origin = pi_edit::path_policy::canonical_key(&worktree);
	assert!(
		error.contains(&format!("Hash #{tag} was issued in this session for {}.", origin.display())),
		"{error}"
	);
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("crates/a/mcp.rs").as_deref(), Some("parent\n"));
	assert_eq!(workspace.read("wt/crates/a/mcp.rs").as_deref(), Some("worktree\n"));
}

#[test]
fn completed_preview_surfaces_stale_hash_error() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#FFFF]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	assert!(!batch.streaming);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);
}
