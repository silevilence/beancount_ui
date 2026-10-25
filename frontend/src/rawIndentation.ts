/** 选区末尾恰好位于下一行行首时，该行没有选中内容，不参与缩进。 */
export function indentRaw(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
) {
  const first = value.slice(0, start).lastIndexOf("\n") + 1;
  if (start === end && !/^ *$/.test(value.slice(first, start))) return;
  const edits: { at: number; removed: number; inserted: string }[] = [];
  let at = first;
  do {
    const spaces = value.slice(at).match(/^ */)![0].length;
    edits.push({
      at,
      removed: outdent ? Math.min(2, spaces) : 0,
      inserted: outdent ? "" : "  ",
    });
    const newline = value.indexOf("\n", at);
    if (newline === -1) break;
    at = newline + 1;
  } while (at < end);
  const move = (position: number) =>
    position +
    edits.reduce(
      (delta, edit) =>
        edit.at <= position
          ? delta +
            edit.inserted.length -
            Math.min(edit.removed, position - edit.at)
          : delta,
      0,
    );
  let text = value;
  for (const edit of [...edits].reverse()) {
    text =
      text.slice(0, edit.at) +
      edit.inserted +
      text.slice(edit.at + edit.removed);
  }
  return { text, start: move(start), end: move(end) };
}
