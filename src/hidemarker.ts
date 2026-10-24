import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/** Matches the task marker (new %% form and legacy ^ form) together with the space before it. */
const MARK_RE = /[ \t]*(?:%%thc?:[a-z0-9-]+%%|\^th-[a-z0-9-]+)[ \t]*$/gm;

/**
 * Editor extension: collapses Focus Hub markers so lines read as plain checkboxes.
 * Applies in both Live Preview and Source mode (the two differ per device, and a
 * marker showing on one machine but not another is just confusing). The marker
 * reappears whenever the cursor is on its line, so it can still be edited.
 */
class HideMarkerPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(u: ViewUpdate) {
		if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
	}

	private build(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		const doc = view.state.doc;
		const cursorLines = new Set(view.state.selection.ranges.map((r) => doc.lineAt(r.head).number));
		for (const { from, to } of view.visibleRanges) {
			const text = doc.sliceString(from, to);
			MARK_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = MARK_RE.exec(text))) {
				const start = from + m.index;
				const end = start + m[0].length;
				if (cursorLines.has(doc.lineAt(start).number)) continue;
				builder.add(start, end, Decoration.replace({}));
			}
		}
		return builder.finish();
	}
}

export const hideMarkerExtension = ViewPlugin.fromClass(HideMarkerPlugin, {
	decorations: (v) => v.decorations,
});
