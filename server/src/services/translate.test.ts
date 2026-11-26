import { describe, expect, it } from "vitest";
import { batchIndexes, fitsBudget, MAX_TRANSLATE_CHARS, needsTranslation, parseText, redistribute } from "./translate-utils.js";

const seg = (text: string, start = 0) => ({ text, start });

describe("when a transcript needs translating", () => {
  const hindi = [seg("थ्री इंपॉर्टेंट ड्रैग आर्किटेक्चर्स यू"), seg("मस्ट नो एस एन एआई इंजीनियर")];
  it("does for non-English text that YouTube did not translate", () => {
    expect(needsTranslation(hindi, { lang: "hi", translated: false })).toBe(true);
  });
  it("does not for English tracks, already translated text, or Latin text under a foreign label", () => {
    expect(needsTranslation(hindi, { lang: "en", translated: false })).toBe(false);
    expect(needsTranslation(hindi, { lang: "hi", translated: true })).toBe(false);
    expect(needsTranslation([seg("this is already english text")], { lang: "hi", translated: false })).toBe(false);
  });
  it("is skipped for transcripts too large for the free token budget", () => {
    expect(fitsBudget([seg("x".repeat(MAX_TRANSLATE_CHARS))])).toBe(true);
    expect(fitsBudget([seg("x".repeat(MAX_TRANSLATE_CHARS + 1))])).toBe(false);
  });
});

describe("batching lines for the model", () => {
  it("covers every line once, in order, within the limits", () => {
    const texts = Array.from({ length: 100 }, (_, i) => `line ${i} ` + "x".repeat(90));
    const batches = batchIndexes(texts, 40, 3500);
    expect(batches.flat()).toEqual(texts.map((_, i) => i));
    for (const b of batches) { expect(b.length).toBeLessThanOrEqual(40); expect(b.reduce((n, i) => n + texts[i].length, 0)).toBeLessThanOrEqual(3500 + 100); }
  });
  it("puts an oversized line in a batch of its own instead of dropping it", () => {
    expect(batchIndexes(["a", "x".repeat(5000), "b"], 40, 3500)).toEqual([[0], [1], [2]]);
    expect(batchIndexes([])).toEqual([]);
  });
});

describe("the model's reply", () => {
  it("is accepted when it has a non-empty text, with whitespace tidied", () => {
    expect(parseText('{"text": " Three   important RAG architectures "}')).toBe("Three important RAG architectures");
    for (const bad of ['{"text": ""}', '{"text": 5}', '{"lines": ["a"]}', "not json"]) expect(parseText(bad)).toBeNull();
  });
});

describe("spreading translated text back over the timestamps", () => {
  const words = (s: string) => s.split(" ").filter(Boolean);
  it("keeps every word, in order, one piece per original line", () => {
    const text = "Three important RAG architectures you must know as an AI engineer. Now when you send a question to a model";
    const pieces = redistribute(text, [30, 10, 60, 25]);
    expect(pieces).toHaveLength(4);
    expect(pieces.join(" ")).toBe(text);
  });
  it("gives longer lines more words", () => {
    const pieces = redistribute("a b c d e f g h i j k l", [10, 90]);
    expect(words(pieces[1]).length).toBeGreaterThan(words(pieces[0]).length * 3);
  });
  it("does not lose words or crash with more lines than words, or no words", () => {
    const few = redistribute("one two", [5, 5, 5, 5]);
    expect(few).toHaveLength(4);
    expect(few.filter(Boolean).join(" ")).toBe("one two");
    expect(redistribute("", [5, 5])).toEqual(["", ""]);
    expect(redistribute("x y z", [])).toEqual([]);
  });
});
