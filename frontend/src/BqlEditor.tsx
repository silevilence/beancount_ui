import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  snippet,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { bqlCompletion, bqlLanguage } from "./bql";

export interface BqlEditorHandle {
  insert: (text: string) => void;
  complete: () => void;
}
const colors = HighlightStyle.define([
  { tag: tags.keyword, color: "#ffb454", fontWeight: "600" },
  { tag: tags.string, color: "#91d6a5" },
  { tag: tags.number, color: "#dfb7ff" },
  { tag: tags.comment, color: "#97a5b8", fontStyle: "italic" },
  { tag: tags.propertyName, color: "#8bc5ff" },
  { tag: tags.function(tags.variableName), color: "#79ded0" },
  { tag: tags.operator, color: "#ffb59f" },
]);

export default function BqlEditor({
  value,
  onChange,
  onRun,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  ref?: Ref<BqlEditorHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };
  const initialValue = useRef(value);
  useImperativeHandle(
    ref,
    () => ({
      insert(text) {
        const view = editor.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        snippet(text)(
          {
            state: view.state,
            dispatch: (transaction) =>
              view.dispatch(transaction, {
                annotations: isolateHistory.of("full"),
              }),
          },
          null,
          from,
          to,
        );
        view.focus();
      },
      complete() {
        if (editor.current) {
          editor.current.focus();
          startCompletion(editor.current);
        }
      },
    }),
    [],
  );
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bqlLanguage,
          syntaxHighlighting(colors),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ override: [bqlCompletion] }),
          keymap.of([
            {
              key: "Mod-Enter",
              run: (v) => {
                if (!v.composing) callbacks.current.onRun();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": "BQL 查询",
            "aria-describedby": "bql-editor-help",
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.theme(
            { "&": { color: "var(--ink)", backgroundColor: "var(--bg)" } },
            { dark: true },
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: 0 },
        annotations: isolateHistory.of("full"),
      });
    }
  }, [value]);
  return <div className="bql-editor" ref={host} />;
}
