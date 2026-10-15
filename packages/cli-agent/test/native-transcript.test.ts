import { expect, test } from "bun:test";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { nativeJsonlRows } from "../src/server/native-transcript.ts";

const rowValidator = Compile(Type.Object({ id: Type.String(), message: Type.Object({ text: Type.String() }) }));
const row = { id: "one", message: { text: "λ🦋" } };

test("native JSONL validates each row, keeps unknown fields, and ignores a torn last line", () => {
  const extended = { ...row, producerField: { retained: true } };
  const jsonl = [JSON.stringify(extended), "", "null", JSON.stringify({ id: "bad", message: { text: 42 } }), JSON.stringify(row), '{"id":'].join("\n");
  expect([...nativeJsonlRows(jsonl, rowValidator)]).toEqual([extended, row]);
  expect([...nativeJsonlRows(JSON.stringify(row), rowValidator)]).toEqual([row]);
  expect(() => [...nativeJsonlRows('{"id":\n' + JSON.stringify(row), rowValidator)]).toThrow();
});
