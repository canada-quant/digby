//! UIA node model + the compact linearization the MODEL reads (W3).
//!
//! The frozen wire shape (backend contract, 2026-09-25):
//! UiaNode { name, role, automation_id, runtime_id: number[], rect: {x,y,w,h},
//!           focused, value?, children: UiaNode[] }
//! and `text` = a compact indented linearization hard-bounded by max_nodes —
//! the payload the model reads. The recursion-bounded walker + the linearizer
//! are PURE (they operate on the serializable node shape, not on COM
//! objects), so their contracts (node-count bound, indentation, value
//! rendering, cycle-safe depth cap) unit-test on the Linux host. The Windows
//! side (src/win/uia.rs) fills the tree from IUIAutomation; this module owns
//! everything above it.

use serde::{Deserialize, Serialize};

/// Default and hard bounds for uia_tree params (frozen contract).
pub const DEFAULT_MAX_DEPTH: u32 = 6;
pub const DEFAULT_MAX_NODES: usize = 300;
/// Hard ceiling regardless of what the caller asks for — the tree is model
/// context, not an exhaustive dump.
pub const HARD_MAX_NODES: usize = 2_000;
pub const HARD_MAX_DEPTH: u32 = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiaNode {
    pub name: String,
    pub role: String,
    pub automation_id: String,
    #[serde(default)]
    pub runtime_id: Vec<i32>,
    pub rect: Rect,
    #[serde(default)]
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default)]
    pub children: Vec<UiaNode>,
}

/// Validate + clamp uia_tree params (pure). Returns (max_depth, max_nodes).
/// Mirrors the agent-side validation in commands.ts — keep in sync.
pub fn clamp_tree_params(root: &str, max_depth: Option<u32>, max_nodes: Option<usize>) -> Result<(u32, usize), String> {
    match root {
        "foreground" | "desktop" => {}
        other => return Err(format!("invalid root: {other} (expected 'foreground' or 'desktop')")),
    }
    let depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH).clamp(1, HARD_MAX_DEPTH);
    let nodes = max_nodes.unwrap_or(DEFAULT_MAX_NODES).clamp(1, HARD_MAX_NODES);
    Ok((depth, nodes))
}

/// Collect nodes depth-first up to the bounds, PRUNING (not truncating
/// mid-visit): once the node budget is spent, remaining siblings are cut
/// entirely — a half-rendered child list is worse than a marked elision.
/// Emits "[+N more children]" markers so the model knows the tree continues.
pub fn bound_tree(node: &mut UiaNode, max_depth: u32, max_nodes: usize) -> usize {
    /// Running budget. Returns the number of nodes actually taken.
    fn walk(n: &mut UiaNode, depth_left: u32, max_depth: u32, budget: &mut usize) -> usize {
        if *budget == 0 || depth_left == 0 {
            return 0;
        }
        *budget -= 1;
        let mut taken = 1;
        let mut child_states: Vec<bool> = Vec::with_capacity(n.children.len());
        for c in n.children.iter_mut() {
            if *budget == 0 {
                // Budget exhausted mid-sibling-list: mark elision on the PARENT.
                let remaining = n.children.len() - child_states.len();
                if remaining > 0 {
                    n.children.truncate(child_states.len());
                    n.children.push(UiaNode {
                        name: format!("[+{remaining} more children elided (node budget)]"),
                        role: "elision".to_string(),
                        automation_id: String::new(),
                        runtime_id: vec![],
                        rect: Rect { x: 0, y: 0, w: 0, h: 0 },
                        focused: false,
                value: None,
                        children: vec![],
                    });
                }
                return taken;
            }
            child_states.push(true);
            taken += walk(c, depth_left.saturating_sub(1), max_depth, budget);
        }
        // Depth-exhausted children are elided with a marker instead of being
        // silently dropped (the model must know the tree continues below).
        if depth_left == 1 && !n.children.is_empty() {
            let cnt = n.children.len();
            n.children.truncate(0);
            n.children.push(UiaNode {
                name: format!("[+{cnt} children below max_depth]"),
                role: "elision".to_string(),
                automation_id: String::new(),
                runtime_id: vec![],
                rect: Rect { x: 0, y: 0, w: 0, h: 0 },
                focused: false,
                value: None,
                children: vec![],
            });
        }
        taken
    }
    let mut budget = max_nodes;
    walk(node, max_depth, max_depth, &mut budget)
}

/// Render the bounded tree as the compact indented text the model reads.
/// One line per node: `role "name" [aid] (x,y w×h) runtime_id [focused] value`.
pub fn linearize(node: &UiaNode) -> String {
    fn fmt_rect(r: &Rect) -> String {
        format!("({},{}) {}x{}", r.x, r.y, r.w, r.h)
    }
    fn line(n: &UiaNode, indent: usize, out: &mut String) {
        let pad = "  ".repeat(indent);
        let mut s = format!("{pad}- {} \"{}\"", n.role, n.name);
        if !n.automation_id.is_empty() {
            s.push_str(&format!(" [{}]", n.automation_id));
        }
        s.push_str(&format!(" {}", fmt_rect(&n.rect)));
        if !n.runtime_id.is_empty() {
            s.push_str(&format!(" #{}", n.runtime_id.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(".")));
        }
        if n.focused {
            s.push_str(" *focused*");
        }
        if let Some(v) = &n.value {
            if !v.is_empty() {
                if v.len() > 120 {
                    // Long values are truncated with a marker, not dumped raw.
                    let cut: String = v.chars().take(120).collect();
                    s.push_str(&format!(" =\"{cut}…\" (truncated)"));
                } else {
                    s.push_str(&format!(" =\"{v}\""));
                }
            }
        }
        out.push_str(&s);
        out.push('\n');
        for c in &n.children {
            line(c, indent + 1, out);
        }
    }
    let mut out = String::new();
    line(node, 0, &mut out);
    out
}

/// The full uia_tree result: the bounded tree + its linearization + count.
pub fn tree_result(mut root: UiaNode, root_kind: &str, max_depth: u32, max_nodes: usize) -> (UiaNode, String, usize) {
    let taken = bound_tree(&mut root, max_depth, max_nodes);
    let text = linearize(&root);
    let _ = root_kind;
    (root, text, taken)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(name: &str, role: &str) -> UiaNode {
        UiaNode {
            name: name.into(),
            role: role.into(),
            automation_id: String::new(),
            runtime_id: vec![42, 7],
            rect: Rect { x: 1, y: 2, w: 100, h: 40 },
            focused: false,
            value: None,
            children: vec![],
        }
    }

    #[test]
    fn params_validate_and_clamp() {
        assert_eq!(clamp_tree_params("foreground", None, None).unwrap(), (6, 300));
        assert_eq!(clamp_tree_params("desktop", Some(1), Some(1)).unwrap(), (1, 1));
        assert_eq!(clamp_tree_params("foreground", Some(99), Some(99_999)).unwrap(), (32, 2000));
        assert_eq!(clamp_tree_params("foreground", Some(0), Some(0)).unwrap(), (1, 1));
        assert!(clamp_tree_params("root", None, None).is_err());
        assert!(clamp_tree_params("", None, None).is_err());
    }

    #[test]
    fn tree_is_pruned_with_elision_markers_not_truncated() {
        // 1 root + 10 children, budget 5 → 4 children kept + an elision
        // marker node (the marker is METADATA — it renders in the tree/text
        // but does not count against the node budget).
        let mut root = leaf("win", "window");
        for i in 0..10 {
            root.children.push(leaf(&format!("c{i}"), "button"));
        }
        let taken = bound_tree(&mut root, 6, 5);
        assert_eq!(taken, 5, "5 real nodes counted (root + 4 children)");
        assert_eq!(root.children.len(), 5, "4 real children + 1 elision marker");
        let last = root.children.last().unwrap();
        assert_eq!(last.role, "elision");
        assert_eq!(last.name, "[+6 more children elided (node budget)]");
        // The linearization includes the marker line — the model sees the cut.
        let text = linearize(&root);
        assert!(text.contains("[+6 more children elided (node budget)]"));
    }

    #[test]
    fn depth_cap_elides_children_with_a_marker() {
        let mut root = leaf("win", "window");
        let mut mid = leaf("panel", "pane");
        for i in 0..3 {
            mid.children.push(leaf(&format!("deep{i}"), "text"));
        }
        root.children.push(mid);
        let taken = bound_tree(&mut root, 2, 300);
        assert_eq!(taken, 2); // root + panel; the panel's children elided
        let panel = &root.children[0];
        assert_eq!(panel.children.len(), 1);
        assert_eq!(panel.children[0].name, "[+3 children below max_depth]");
    }

    #[test]
    fn linearize_renders_role_name_rect_rid_focus_value() {
        let mut n = leaf("Save", "button");
        n.automation_id = "btnSave".into();
        n.focused = true;
        n.value = Some("Save now".into());
        let text = linearize(&n);
        assert!(text.contains("- button \"Save\""));
        assert!(text.contains("[btnSave]"));
        assert!(text.contains("(1,2) 100x40"));
        assert!(text.contains("#42.7"));
        assert!(text.contains("*focused*"));
        assert!(text.contains("=\"Save now\""));
        assert!(text.ends_with('\n'));
        // Indentation grows one level per depth.
        let mut p = leaf("p", "pane");
        p.children.push(n);
        let t2 = linearize(&p);
        let lines: Vec<&str> = t2.lines().collect();
        assert!(lines[1].starts_with("  - "), "child indented two spaces: {}", lines[1]);
    }

    #[test]
    fn node_count_is_the_bounded_size() {
        let mut root = leaf("win", "window");
        for i in 0..50 {
            root.children.push(leaf(&format!("c{i}"), "button"));
        }
        let (tree, text, count) = tree_result(root, "foreground", 6, 300);
        assert_eq!(count, 51);
        assert_eq!(count, count_nodes(&tree));
        assert_eq!(text.lines().count(), 51);
    }

    fn count_nodes(n: &UiaNode) -> usize {
        1 + n.children.iter().map(count_nodes).sum::<usize>()
    }
}
